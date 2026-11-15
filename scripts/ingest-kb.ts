// Загрузка базы знаний из папки книг: документы → kb_docs и kb_chunks, затем векторы (embedMissing).
// Запуск из корня проекта: npx tsx scripts/ingest-kb.ts [--dry-run] [--only <подстрока>] [--exclude <подстрока>] [--force-ocr <подстрока>] [--jobs <1–8>] [--ocr-page <путь>:<номер>] [--yes] [--no-embed]
// Папка книг: KB_SOURCE_DIR или ../books. Кэш распознавания и data/ocr/usage.json лежат в data/ocr (на Mac, в облако не идут).
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { loadConfig } from '../src/lib/config'
import { openDb } from '../src/lib/db'
import { cachePath, OCR_MAX_TOKENS, OCR_PROMPT, renderPdfPage, writeCachedPage } from '../src/lib/kb/extract'
import {
  classifySource,
  indexDocument,
  ocrPlan,
  parseIngestArgs,
  runLimited,
  scanSource,
  type IngestArgs,
  type SourceKind,
} from '../src/lib/kb/index'
import { embedMissing } from '../src/lib/kb/search'
import { nfc } from '../src/lib/ko'
import { openRouterClient, type LlmClient } from '../src/lib/llm'

for (const f of ['.env.local', '.env']) if (existsSync(f)) process.loadEnvFile(f)

interface Candidate { rel: string; abs: string } // rel — NFC с «/», abs — путь, как он лежит на диске
// forceOcr: --force-ocr подошёл к PDF, все его страницы распознаются моделью
interface Doc extends Candidate { kind: SourceKind; forceOcr: boolean }
interface OcrUsage { pages: number; inputTokens: number; outputTokens: number }

async function main(): Promise<void> {
  const args = parseIngestArgs(process.argv.slice(2))
  const cfg = loadConfig()
  const booksDir = path.resolve(cfg.kbSourceDir ?? path.join(process.cwd(), '..', 'books'))
  const cacheDir = path.join(process.cwd(), 'data', 'ocr')

  const { docs, skipped, excluded } = await collectDocs(booksDir, args)
  printScan(docs, skipped, excluded)

  const usage: OcrUsage = { pages: 0, inputTokens: 0, outputTokens: 0 }
  const llm = countingLlm(openRouterClient(cfg), usage)
  try {
    if (args.ocrPages.length > 0) {
      await ocrPagesOnly(args, docs, cacheDir, llm)
    } else if (args.dryRun) {
      await dryRun(docs, cacheDir)
    } else {
      await ingest(args, cfg.databaseUrl, docs, booksDir, cacheDir, llm)
    }
  } finally {
    if (usage.pages > 0) await addUsage(cacheDir, usage)
  }
}

// Файлы трёх мест: корень (только файлы), md/ и TOPIK/ рекурсивно. Остальные папки не просматриваются.
async function listFiles(booksDir: string): Promise<Candidate[]> {
  const out: Candidate[] = []
  const root = await readdir(booksDir, { withFileTypes: true })
  for (const e of root) {
    if (e.isFile()) out.push({ rel: nfc(e.name), abs: path.join(booksDir, e.name) })
  }
  for (const e of root) {
    const top = nfc(e.name)
    if (e.isDirectory() && (top === 'md' || top === 'TOPIK')) await walk(path.join(booksDir, e.name), top, out)
  }
  return out
}

async function walk(absDir: string, relDir: string, out: Candidate[]): Promise<void> {
  for (const e of await readdir(absDir, { withFileTypes: true })) {
    const rel = `${relDir}/${nfc(e.name)}`
    const abs = path.join(absDir, e.name)
    if (e.isDirectory()) await walk(abs, rel, out)
    else if (e.isFile()) out.push({ rel, abs })
  }
}

// Документы в детерминированном порядке (по относительному пути), счётчик пропусков по причинам
// и число документов, отсеянных --exclude. --exclude считается по документам: файлы, которые и так не индексируются, сюда не входят.
async function collectDocs(
  booksDir: string,
  args: IngestArgs,
): Promise<{ docs: Doc[]; skipped: Map<string, number>; excluded: number }> {
  const found = (await listFiles(booksDir))
    .filter(c => args.only === undefined || c.rel.includes(args.only))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  const docs: Doc[] = []
  const skipped = new Map<string, number>()
  let excluded = 0
  for (const c of found) {
    const cls = classifySource(c.rel)
    if (!cls.ok) {
      skipped.set(cls.reason, (skipped.get(cls.reason) ?? 0) + 1)
      continue
    }
    if (args.exclude.some(s => c.rel.includes(s))) {
      excluded += 1
      continue
    }
    const forceOcr = path.extname(c.abs).toLowerCase() === '.pdf' && args.forceOcr.some(s => c.rel.includes(s))
    docs.push({ ...c, kind: cls.kind, forceOcr })
  }
  return { docs, skipped, excluded }
}

function printScan(docs: Doc[], skipped: Map<string, number>, excluded: number): void {
  console.log(`документов: ${docs.length}`)
  const total = [...skipped.values()].reduce((a, b) => a + b, 0)
  console.log(`пропущено файлов: ${total}`)
  for (const [reason, count] of skipped) console.log(`  ${count} — ${reason}`)
  console.log(`исключено --exclude: ${excluded}`)
}

// --dry-run: только чтение PDF. Модель не вызывается, база не открывается, кэш не пишется.
async function dryRun(docs: Doc[], cacheDir: string): Promise<void> {
  console.log('путь | страниц | без текстового слоя')
  let pages = 0
  let noText = 0
  let uncached = 0
  for (const d of docs) {
    const info = await scanSource(d)
    const forced = d.forceOcr ? ' | принудительно' : ''
    console.log(`${d.rel} | ${info.pages} | ${info.ocrPages.length}${forced}`)
    pages += info.pages
    noText += info.ocrPages.length
    if (info.ocrPages.length > 0) {
      const sha = sha1Of(await readFile(d.abs))
      uncached += info.ocrPages.filter(p => !existsSync(cachePath(cacheDir, sha, p))).length
    }
  }
  console.log(`итого: документов ${docs.length}, страниц ${pages}, без текстового слоя ${noText}, из них не в кэше ${uncached}`)
  const usage = await readUsage(path.join(cacheDir, 'usage.json'))
  if (usage.pages > 0) {
    const inPerPage = usage.inputTokens / usage.pages
    const outPerPage = usage.outputTokens / usage.pages
    console.log(
      `оценка OCR, токенов на вход: ${uncached} стр. × ${Math.round(inPerPage)} ≈ ${Math.round(uncached * inPerPage)}`,
    )
    console.log(
      `оценка OCR, токенов на выход: ${uncached} стр. × ${Math.round(outPerPage)} ≈ ${Math.round(uncached * outPerPage)} ` +
        `(по data/ocr/usage.json, ${usage.pages} стр.; уже загруженные документы базой не проверялись)`,
    )
  }
}

// Обычный запуск: без --yes модель не вызывается вовсе (ни OCR, ни эмбеддинги). Документы индексируются по одному,
// затем векторы: с --yes считаются, без --yes только считается, сколько чанков ждут вектора.
async function ingest(
  args: IngestArgs,
  databaseUrl: string,
  docs: Doc[],
  booksDir: string,
  cacheDir: string,
  llm: LlmClient,
): Promise<void> {
  const db = await openDb(databaseUrl)
  try {
    if (!args.yes) {
      const pending = await ocrPlan(db, docs, cacheDir)
      if (pending.pages > 0) {
        console.log(`не из кэша нужно распознать ${pending.pages} стр. в документах: ${pending.docs.join(', ')}`)
        console.log('запусти с --yes, чтобы распознать; ничего не загружено')
        process.exitCode = 1
        return
      }
    }

    // --jobs: сколько документов идут одновременно; ошибка одного документа не останавливает остальные
    let failed = 0
    await runLimited(
      docs,
      args.jobs,
      async d => {
        const r = await indexDocument(
          db,
          { llm, cacheDir, baseDir: booksDir },
          { path: d.abs, kind: d.kind, forceOcr: d.forceOcr },
        )
        let state = 'загружен'
        if (r.skipped) {
          state = d.forceOcr ? 'пропущен (уже в базе, --force-ocr не применён)' : 'пропущен (уже в базе)'
        }
        console.log(`${d.rel} | чанков ${r.chunks} | распознано ${r.ocrPages} | ${state}`)
      },
      (d, err) => {
        failed += 1
        console.error(`${d.rel}: ${errorText(err)}`)
      },
    )

    if (!args.noEmbed) {
      if (args.yes) {
        const added = await embedMissing(db, llm)
        const [{ total }] = await db.query<{ total: number }>('select count(*)::int as total from kb_chunks where vec is not null')
        console.log(`векторов добавлено ${added}, всего с вектором ${total}`)
      } else {
        const [{ missing }] = await db.query<{ missing: number }>('select count(*)::int as missing from kb_chunks where vec is null')
        if (missing > 0) {
          console.log(`без вектора ${missing} чанков; запусти с --yes, чтобы посчитать векторы`)
          process.exitCode = 1
        }
      }
    }

    if (failed > 0) {
      console.error(`документов с ошибкой: ${failed}`)
      process.exitCode = 1
    }
  } finally {
    await db.close()
  }
}

// --ocr-page: распознать указанные страницы через тот же кэш и напечатать текст. База не открывается и не пишется.
async function ocrPagesOnly(args: IngestArgs, docs: Doc[], cacheDir: string, llm: LlmClient): Promise<void> {
  const items: { doc: Doc; page: number; file: string; cached: boolean }[] = []
  for (const req of args.ocrPages) {
    const doc = docs.find(d => d.rel === req.path)
    if (!doc) throw new Error(`нет документа среди источников: ${req.path}`)
    if (path.extname(doc.abs).toLowerCase() !== '.pdf') throw new Error(`--ocr-page: только PDF, получено ${req.path}`)
    const info = await scanSource(doc)
    if (req.page > info.pages) throw new Error(`${req.path}: страниц ${info.pages}, запрошена ${req.page}`)
    const file = cachePath(cacheDir, sha1Of(await readFile(doc.abs)), req.page)
    items.push({ doc, page: req.page, file, cached: existsSync(file) })
  }

  const missing = items.filter(i => !i.cached).length
  if (missing > 0 && !args.yes) {
    console.log(`не из кэша нужно распознать ${missing} стр.; запусти с --yes, чтобы распознать`)
    process.exitCode = 1
    return
  }

  for (const item of items) {
    const text = item.cached
      ? nfc(await readFile(item.file, 'utf8'))
      : await recognizePage(item.doc.abs, item.page, item.file, llm)
    console.log(`== ${item.doc.rel}, стр. ${item.page} (${item.cached ? 'кэш' : 'распознано'}) ==`)
    console.log(text)
  }
}

// Распознавание одной страницы той же командой и тем же файлом кэша, что и extractDocument
async function recognizePage(abs: string, page: number, file: string, llm: LlmClient): Promise<string> {
  const imagePng = await renderPdfPage(abs, page)
  const { text } = await llm.vision({ imagePng, prompt: OCR_PROMPT, maxTokens: OCR_MAX_TOKENS })
  const clean = nfc(text)
  await writeCachedPage(file, clean)
  return clean
}

// Обёртка над клиентом: считает распознанные страницы и токены vision. Остальные методы идут как есть.
function countingLlm(inner: LlmClient, usage: OcrUsage): LlmClient {
  return {
    ...inner,
    async vision(args) {
      const r = await inner.vision(args)
      usage.pages += 1
      usage.inputTokens += r.usage.inputTokens
      usage.outputTokens += r.usage.outputTokens
      return r
    },
  }
}

async function readUsage(file: string): Promise<OcrUsage> {
  if (!existsSync(file)) return { pages: 0, inputTokens: 0, outputTokens: 0 }
  const raw = JSON.parse(await readFile(file, 'utf8')) as Partial<OcrUsage>
  return {
    pages: Number(raw.pages) || 0,
    inputTokens: Number(raw.inputTokens) || 0,
    outputTokens: Number(raw.outputTokens) || 0,
  }
}

// Расход дописывается к data/ocr/usage.json между запусками
async function addUsage(cacheDir: string, add: OcrUsage): Promise<void> {
  const file = path.join(cacheDir, 'usage.json')
  const prev = await readUsage(file)
  await mkdir(cacheDir, { recursive: true })
  const next: OcrUsage = {
    pages: prev.pages + add.pages,
    inputTokens: prev.inputTokens + add.inputTokens,
    outputTokens: prev.outputTokens + add.outputTokens,
  }
  await writeFile(file, JSON.stringify(next, null, 2) + '\n', 'utf8')
}

function sha1Of(bytes: Buffer): string {
  return createHash('sha1').update(bytes).digest('hex')
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

main().catch(err => {
  console.error(errorText(err))
  process.exitCode = 1
})
