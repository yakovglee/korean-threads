// Индексация документов базы знаний: файл → kb_docs и kb_chunks (векторы заполняет embedMissing).
// Чистые функции classifySource и parseIngestArgs нужны скрипту scripts/ingest-kb.ts и покрыты тестами.
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { Db } from '../db'
import { nfc } from '../ko'
import { cachePath, chunkPages, extractDocument, scanDocument, type ExtractDeps } from './extract'
import type { KbKind } from './search'

// Чанки вставляются многострочными insert по 200 строк (5 параметров на строку)
const INSERT_BATCH = 200

export interface IndexResult {
  chunks: number
  ocrPages: number
  skipped: boolean
}

// Документ с диска в базу знаний. id документа — sha1 байтов файла: уже загруженный файл пропускается
// без чтения страниц и без вызова модели. Извлечение идёт до транзакции, поэтому при его ошибке в базе ничего не остаётся.
// Строка с тем же path и другим sha1 (файл изменился) удаляется вместе с чанками в той же транзакции.
// forceOcr: все страницы распознаются моделью, текстовый слой не используется (minChars = Infinity).
export async function indexDocument(
  db: Db,
  deps: ExtractDeps & { baseDir?: string },
  doc: { path: string; kind: KbKind; forceOcr?: boolean },
): Promise<IndexResult> {
  const { baseDir, ...extractDeps } = deps
  const path = docPath(doc.path, baseDir)
  const id = sha1(await readFile(doc.path))

  const known = await db.query<{ id: string }>('select id from kb_docs where id = $1', [id])
  if (known.length > 0) return { chunks: 0, ocrPages: 0, skipped: true }

  const pages = await extractDocument(doc.path, doc.forceOcr ? { ...extractDeps, minChars: Infinity } : extractDeps)
  // .md — документ без страниц: номер страницы в чанках не пишется
  const chunks = chunkPages(pages, { noPages: extname(doc.path).toLowerCase() === '.md' })
  const ocrPages = pages.filter(p => p.via === 'ocr').length

  await db.tx(async tx => {
    await tx.query('delete from kb_chunks where doc_id in (select id from kb_docs where path = $1 and id <> $2)', [path, id])
    await tx.query('delete from kb_docs where path = $1 and id <> $2', [path, id])
    await tx.query(
      'insert into kb_docs (id, path, kind, sha1, pages, ocr_pages) values ($1, $2, $3, $4, $5, $6)',
      [id, path, doc.kind, id, pages.length, ocrPages],
    )
    for (let i = 0; i < chunks.length; i += INSERT_BATCH) {
      await insertChunks(tx, id, doc.kind, chunks.slice(i, i + INSERT_BATCH))
    }
  })
  return { chunks: chunks.length, ocrPages, skipped: false }
}

export interface PlanDoc { rel: string; abs: string; forceOcr: boolean }

// Скан документа с учётом forceOcr: при нём все страницы без текстового слоя (minChars = Infinity)
export function scanSource(doc: PlanDoc, scan: typeof scanDocument = scanDocument): Promise<{ pages: number; ocrPages: number[] }> {
  return scan(doc.abs, doc.forceOcr ? { minChars: Infinity } : {})
}

// Сколько страниц модель распознала бы при загрузке с --yes: страницы без текстового слоя, которых нет в кэше.
// Документ, уже лежащий в базе (по sha1), не считается и не сканируется. Возвращает страницы и имена документов.
export async function ocrPlan(
  db: Db,
  docs: PlanDoc[],
  cacheDir: string,
  scan: typeof scanDocument = scanDocument,
): Promise<{ pages: number; docs: string[] }> {
  let pages = 0
  const names: string[] = []
  for (const d of docs) {
    const id = sha1(await readFile(d.abs))
    const known = await db.query<{ id: string }>('select id from kb_docs where id = $1', [id])
    if (known.length > 0) continue
    const info = await scanSource(d, scan)
    const missing = info.ocrPages.filter(p => !existsSync(cachePath(cacheDir, id, p))).length
    if (missing > 0) {
      pages += missing
      names.push(d.rel)
    }
  }
  return { pages, docs: names }
}

// Путь в kb_docs: относительно baseDir, в NFC, с «/». Без baseDir — только имя файла.
// Абсолютный путь в базу не пишется: файл вне baseDir — ошибка.
function docPath(file: string, baseDir: string | undefined): string {
  const abs = resolve(file)
  if (baseDir === undefined) return nfc(basename(abs))
  const rel = relative(resolve(baseDir), abs)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`документ вне папки книг: ${file}`)
  }
  return nfc(rel.split(sep).join('/'))
}

function sha1(bytes: Buffer): string {
  return createHash('sha1').update(bytes).digest('hex')
}

// Один многострочный insert; vec не трогаем (его заполняет embedMissing). В params только примитивы.
async function insertChunks(
  db: Db,
  docId: string,
  kind: KbKind,
  rows: { page: number | null; ref: string; text: string }[],
): Promise<void> {
  const params: unknown[] = []
  const tuples = rows.map((r, i) => {
    params.push(docId, kind, r.page, r.ref, r.text)
    const b = i * 5
    return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5})`
  })
  await db.query(`insert into kb_chunks (doc_id, kind, page, ref, text) values ${tuples.join(', ')}`, params)
}

export type SourceKind = 'grammar' | 'textbook' | 'exam'
export type SourceClass = { ok: true; kind: SourceKind } | { ok: false; reason: string }

const GRAMMAR_MAIN = 'GRAMMAR_MAIN.md'
const TEXTBOOK_TITLE = nfc('합격 레시피')
const TEXTBOOK_PREFIX = 'RESIPI'

// Классификация файла по пути относительно папки книг (с «/»). Имена сравниваются в NFC.
// Пропуск возвращает причину: скрипт считает пропуски по причинам.
export function classifySource(relPath: string): SourceClass {
  const rel = nfc(relPath)
  const parts = rel.split('/')
  const name = parts[parts.length - 1]
  if (name.startsWith('.')) return skip('служебный файл')
  const ext = extname(name).toLowerCase()
  const top = parts.length > 1 ? parts[0] : null

  if (top !== null && top !== 'md' && top !== 'TOPIK') return skip('файл вне md/, TOPIK/ и корня')
  if (top === null && rel === GRAMMAR_MAIN) return keep('grammar')
  if (top === 'md' && ext === '.md') return keep('grammar')
  if (top === 'TOPIK' && ext === '.pdf') return keep('exam')
  if (top === null && ext === '.pdf' && isTextbookName(name)) return keep('textbook')
  if (ext === '.pdf') return skip('PDF вне TOPIK/ и не учебник')
  if (ext === '.md') return skip('markdown вне md/ и не GRAMMAR_MAIN.md')
  return skip(`формат ${ext || 'без расширения'} не индексируется`)
}

function isTextbookName(name: string): boolean {
  return name.includes(TEXTBOOK_TITLE) || name.startsWith(TEXTBOOK_PREFIX)
}

function keep(kind: SourceKind): SourceClass {
  return { ok: true, kind }
}

function skip(reason: string): SourceClass {
  return { ok: false, reason }
}

export interface IngestArgs {
  dryRun: boolean
  yes: boolean
  noEmbed: boolean
  only: string | undefined
  ocrPages: { path: string; page: number }[]
  exclude: string[]
  forceOcr: string[]
  jobs: number
}

// Разбор флагов scripts/ingest-kb.ts. Неизвестный флаг, лишний аргумент и флаг без значения — ошибка.
export function parseIngestArgs(argv: string[]): IngestArgs {
  const args: IngestArgs = {
    dryRun: false,
    yes: false,
    noEmbed: false,
    only: undefined,
    ocrPages: [],
    exclude: [],
    forceOcr: [],
    jobs: 1,
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--dry-run') {
      args.dryRun = true
    } else if (flag === '--yes') {
      args.yes = true
    } else if (flag === '--no-embed') {
      args.noEmbed = true
    } else if (flag === '--only') {
      i += 1
      args.only = nfc(valueAt(argv, i, flag))
    } else if (flag === '--ocr-page') {
      i += 1
      args.ocrPages.push(parseOcrPage(valueAt(argv, i, flag)))
    } else if (flag === '--exclude') {
      i += 1
      args.exclude.push(nfc(valueAt(argv, i, flag)))
    } else if (flag === '--force-ocr') {
      i += 1
      args.forceOcr.push(nfc(valueAt(argv, i, flag)))
    } else if (flag === '--jobs') {
      i += 1
      args.jobs = parseJobs(valueAt(argv, i, flag))
    } else {
      throw new Error(`неизвестный аргумент: ${flag}`)
    }
  }
  if (args.dryRun && args.ocrPages.length > 0) throw new Error('--dry-run и --ocr-page вместе не используются')
  return args
}

function valueAt(argv: string[], i: number, flag: string): string {
  const v = argv[i]
  if (v === undefined || v === '' || v.startsWith('--')) throw new Error(`${flag}: нужно значение`)
  return v
}

// --jobs: целое от 1 до 8
function parseJobs(v: string): number {
  const n = Number(v)
  if (!/^\d+$/.test(v) || n < 1 || n > 8) throw new Error(`--jobs: нужно целое число от 1 до 8, получено «${v}»`)
  return n
}

// Задачи по одной, но не больше limit одновременно. Ошибка задачи уходит в onError и не останавливает остальные.
export async function runLimited<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
  onError: (item: T, err: unknown) => void,
): Promise<void> {
  let next = 0
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next]
      next += 1
      try {
        await task(item)
      } catch (err) {
        onError(item, err)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
}

// «<относительный путь>:<номер страницы>»: номер берётся после последнего двоеточия, путь приводится к NFC
function parseOcrPage(v: string): { path: string; page: number } {
  const colon = v.lastIndexOf(':')
  const pageText = v.slice(colon + 1)
  if (colon <= 0 || !/^\d+$/.test(pageText) || Number(pageText) < 1) {
    throw new Error(`--ocr-page: нужен формат <относительный путь>:<номер страницы>, получено «${v}»`)
  }
  return { path: nfc(v.slice(0, colon)), page: Number(pageText) }
}
