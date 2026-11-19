// Загрузка базы знаний из папки книг: документы → kb_docs и kb_chunks, затем векторы (embedMissing).
// Запуск из корня проекта: npx tsx scripts/ingest-kb.ts [--dry-run] [--only <подстрока>] [--exclude <подстрока>] [--force-ocr <подстрока>] [--jobs <1–8>] [--ocr-page <путь>:<номер>] [--ocr-engine vision|llm] [--ocr-report] [--yes] [--no-embed]
// Папка книг: KB_SOURCE_DIR или ../books. Кэш распознавания и data/ocr/usage.json лежат в data/ocr (на Mac, в облако не идут).
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { loadConfig } from '../src/lib/config'
import { openDb } from '../src/lib/db'
import {
  cachePath,
  extractDocument,
  OCR_MAX_TOKENS,
  OCR_PROMPT,
  renderPdfPage,
  visionCachePath,
  writeCachedPage,
} from '../src/lib/kb/extract'
import {
  classifySource,
  indexDocument,
  ocrPlan,
  pageVerdict,
  parseIngestArgs,
  runLimited,
  scanSource,
  type IngestArgs,
  type SourceKind,
} from '../src/lib/kb/index'
import { embedMissing } from '../src/lib/kb/search'
import { nfc } from '../src/lib/ko'
import { openRouterClient, type LlmClient } from '../src/lib/llm'
import { appleVision, type VisionOcr, type VisionPage } from '../src/lib/kb/vision'
import { checkVisionPage, type PageFlag } from '../src/lib/kb/vision-text'

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

  if (args.ocrReport) {
    await ocrReport(args, docs, cacheDir)
    return
  }

  // встроенный OCR macOS: бесплатный и без выхода страниц с Mac; при llm распознаёт визуальная модель
  const vision = args.ocrEngine === 'vision' ? appleVision() : undefined
  const usage: OcrUsage = { pages: 0, inputTokens: 0, outputTokens: 0 }
  const llm = countingLlm(openRouterClient(cfg), usage)
  try {
    if (args.ocrPages.length > 0) {
      await ocrPagesOnly(args, docs, cacheDir, llm)
    } else if (args.dryRun) {
      await dryRun(docs, cacheDir)
    } else {
      await ingest(args, cfg.databaseUrl, docs, booksDir, cacheDir, llm, vision)
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
  vision: VisionOcr | undefined,
): Promise<void> {
  const db = await openDb(databaseUrl)
  try {
    // Без --yes проверяется только модельное распознавание: Vision бесплатный и на проверку не ставится
    if (!args.yes && args.ocrEngine === 'llm') {
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
          { llm, vision, cacheDir, baseDir: booksDir },
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

interface ReportRow { rel: string; page: number; verdict: string; flags: string }
interface ReportDoc { pages: number; rows: ReportRow[] }
const VERDICTS = ['уже платно', 'платно: таблица ответов', 'не нужно', 'можно платно', 'ok'] as const

// --ocr-report: Vision по страницам без текстового слоя всех PDF (с --only, --exclude, --force-ocr). База не открывается,
// модель не вызывается. Пишет data/ocr/report.tsv, печатает строку по каждому документу и сводку по вердиктам.
async function ocrReport(args: IngestArgs, docs: Doc[], cacheDir: string): Promise<void> {
  const vision = appleVision()
  const llm = noModel()
  const pdfs = docs.filter(d => path.extname(d.abs).toLowerCase() === '.pdf')
  const results = new Map<string, ReportDoc>()
  let failed = 0
  await runLimited(
    pdfs,
    args.jobs,
    async d => {
      results.set(d.rel, await reportDoc(d, vision, llm, cacheDir))
    },
    (d, err) => {
      failed += 1
      console.error(`${d.rel}: ${errorText(err)}`)
    },
  )

  const rows: ReportRow[] = []
  for (const d of pdfs) {
    const r = results.get(d.rel)
    if (!r) continue
    rows.push(...r.rows)
    if (r.rows.length > 0) console.log(`${d.rel} | стр. ${r.pages} | ${verdictCounts(r.rows)}`)
  }
  rows.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : a.page - b.page))

  await mkdir(cacheDir, { recursive: true })
  const file = path.join(cacheDir, 'report.tsv')
  const tsv = ['путь\tстр\tвердикт\tфлаги', ...rows.map(r => [r.rel, r.page, r.verdict, r.flags].join('\t'))]
  await writeFile(file, tsv.join('\n') + '\n', 'utf8')

  console.log(`страниц без текстового слоя: ${rows.length}`)
  for (const v of VERDICTS) console.log(`  ${v}: ${rows.filter(r => r.verdict === v).length}`)
  console.log(`отчёт: ${path.resolve(file)}`)
  if (failed > 0) {
    console.error(`документов с ошибкой: ${failed}`)
    process.exitCode = 1
  }
}

// Страницы PDF: распознавание Vision (или ответ из кэша), по каждой странице без .md — флаги проверки
async function reportDoc(d: Doc, vision: VisionOcr, llm: LlmClient, cacheDir: string): Promise<ReportDoc> {
  const sha = sha1Of(await readFile(d.abs))
  const pages = await extractDocument(d.abs, {
    llm,
    vision,
    cacheDir,
    minChars: d.forceOcr ? Infinity : undefined,
  })
  const rows: ReportRow[] = []
  for (const p of pages) {
    if (p.via !== 'ocr') continue
    // <стр>.md — платный результат, Vision его не перекрывает; без него .vision.json записал extractDocument
    const paid = existsSync(cachePath(cacheDir, sha, p.page))
    const flags: PageFlag[] = paid
      ? []
      : checkVisionPage(JSON.parse(await readFile(visionCachePath(cacheDir, sha, p.page), 'utf8')) as VisionPage, p.text)
    rows.push({
      rel: d.rel,
      page: p.page,
      verdict: pageVerdict(d.rel, d.kind, flags, paid),
      flags: flags.map(f => `${f.code}: ${f.detail}`).join('; '),
    })
  }
  return { pages: pages.length, rows }
}

// «вердикт×число» по вердиктам, в которых есть страницы
function verdictCounts(rows: ReportRow[]): string {
  return VERDICTS.map(v => [v, rows.filter(r => r.verdict === v).length] as const)
    .filter(([, n]) => n > 0)
    .map(([v, n]) => `${v}×${n}`)
    .join(', ')
}

// В --ocr-report модель не нужна: если кто-то её вызовет, это ошибка
function noModel(): LlmClient {
  const fail = (): Promise<never> => Promise.reject(new Error('модель не вызывается в --ocr-report'))
  return { json: fail, vision: fail, embed: fail }
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
