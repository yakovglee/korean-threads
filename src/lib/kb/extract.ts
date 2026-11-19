// Извлечение текста из документов базы знаний: .md целиком, PDF по страницам.
// Страница с текстовым слоем берётся как есть; без текстового слоя распознаётся визуальной моделью
// и кэшируется на диске (<cacheDir>/<sha1 файла>/<страница>.md). Весь текст приводится к NFC.
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import type * as MuPdf from 'mupdf'
import { nfc } from '../ko'
import type { LlmClient } from '../llm'
import type { VisionOcr, VisionPage } from './vision'
import { visionText } from './vision-text'

export interface PageText { page: number; text: string; via: 'text' | 'ocr' }

const DEFAULT_MIN_CHARS = 80
const DEFAULT_MAX_CHARS = 1500
export const OCR_MAX_TOKENS = 8000
const HEADING = /^\s{0,3}#+\s+(.*\S)\s*$/

export const OCR_PROMPT = 'Перепиши текст этой страницы дословно в Markdown. Сохрани номера вопросов и варианты ①–④. Таблицы оформи как таблицы Markdown. Ничего не пояснять и не добавлять.'

function kindOf(path: string): 'md' | 'pdf' {
  const ext = extname(path).toLowerCase()
  if (ext === '.md') return 'md'
  if (ext === '.pdf') return 'pdf'
  throw new Error(`неподдерживаемый формат файла: ${path}`)
}

// mupdf — ESM с top-level await: статический импорт падает, когда проект идёт через tsx (там .ts становится CJS),
// поэтому модуль грузится лениво через import()
let mupdfModule: Promise<typeof MuPdf> | undefined
function loadMupdf(): Promise<typeof MuPdf> {
  if (!mupdfModule) mupdfModule = import('mupdf')
  return mupdfModule
}

function openPdf(mupdf: typeof MuPdf, path: string): MuPdf.Document {
  return mupdf.Document.openDocument(readFileSync(path), 'application/pdf')
}

// Страница PDF (нумерация с единицы) в PNG
export async function renderPdfPage(path: string, page: number, dpi = 150): Promise<Buffer> {
  const mupdf = await loadMupdf()
  const doc = openPdf(mupdf, path)
  try {
    const pg = doc.loadPage(page - 1)
    try {
      const pix = pg.toPixmap(mupdf.Matrix.scale(dpi / 72, dpi / 72), mupdf.ColorSpace.DeviceRGB, false, true)
      try {
        return Buffer.from(pix.asPNG())
      } finally {
        pix.destroy()
      }
    } finally {
      pg.destroy()
    }
  } finally {
    doc.destroy()
  }
}

// Текстовый слой каждой страницы PDF по порядку
export async function readPdfTexts(path: string): Promise<string[]> {
  const doc = openPdf(await loadMupdf(), path)
  try {
    const texts: string[] = []
    for (let i = 0; i < doc.countPages(); i++) {
      const pg = doc.loadPage(i)
      try {
        const st = pg.toStructuredText('preserve-whitespace')
        try {
          texts.push(st.asText())
        } finally {
          st.destroy()
        }
      } finally {
        pg.destroy()
      }
    }
    return texts
  } finally {
    doc.destroy()
  }
}

// Непробельные символы (кодовые точки) текста; текст должен быть в NFC
function visibleLength(text: string): number {
  return [...text.replace(/\s/g, '')].length
}

function sha1OfFile(path: string): string {
  return createHash('sha1').update(readFileSync(path)).digest('hex')
}

// Файл кэша распознавания одной страницы: <cacheDir>/<sha1 файла>/<страница>.md
export function cachePath(cacheDir: string, sha: string, page: number): string {
  return join(cacheDir, sha, `${page}.md`)
}

// Сырой ответ Vision одной страницы: <cacheDir>/<sha1 файла>/<страница>.vision.json
export function visionCachePath(cacheDir: string, sha: string, page: number): string {
  return join(cacheDir, sha, `${page}.vision.json`)
}

// Запись страницы в кэш атомарно: временный файл в той же папке, затем rename.
// Оборванная запись не оставляет битого <страница>.md, а существующая страница заменяется целиком.
export async function writeCachedPage(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, file)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

// Без модели: какие страницы PDF без текстового слоя (нумерация с единицы) и сколько их всего
export async function scanDocument(
  path: string,
  opts: { minChars?: number; readTexts?: typeof readPdfTexts } = {},
): Promise<{ pages: number; ocrPages: number[] }> {
  if (kindOf(path) === 'md') return { pages: 1, ocrPages: [] }
  const minChars = opts.minChars ?? DEFAULT_MIN_CHARS
  const texts = await (opts.readTexts ?? readPdfTexts)(path)
  const ocrPages: number[] = []
  texts.forEach((text, i) => {
    if (visibleLength(nfc(text)) < minChars) ocrPages.push(i + 1)
  })
  return { pages: texts.length, ocrPages }
}

export interface ExtractDeps {
  llm: LlmClient
  vision?: VisionOcr
  cacheDir: string
  render?: typeof renderPdfPage
  minChars?: number
  readTexts?: typeof readPdfTexts
  onPage?: (p: PageText) => void
}

export async function extractDocument(path: string, deps: ExtractDeps): Promise<PageText[]> {
  if (kindOf(path) === 'md') {
    const page: PageText = { page: 1, text: nfc(readFileSync(path, 'utf8')), via: 'text' }
    deps.onPage?.(page)
    return [page]
  }

  const minChars = deps.minChars ?? DEFAULT_MIN_CHARS
  const render = deps.render ?? renderPdfPage
  const texts = await (deps.readTexts ?? readPdfTexts)(path)
  let hash: string | undefined
  const out: PageText[] = []

  for (let i = 0; i < texts.length; i++) {
    const page = i + 1
    const text = nfc(texts[i])
    let result: PageText
    if (visibleLength(text) >= minChars) {
      result = { page, text, via: 'text' }
    } else {
      if (hash === undefined) hash = sha1OfFile(path)
      const file = cachePath(deps.cacheDir, hash, page)
      if (existsSync(file)) {
        result = { page, text: nfc(readFileSync(file, 'utf8')), via: 'ocr' }
      } else if (deps.vision) {
        const visionFile = visionCachePath(deps.cacheDir, hash, page)
        let vp: VisionPage
        if (existsSync(visionFile)) {
          vp = JSON.parse(readFileSync(visionFile, 'utf8')) as VisionPage
        } else {
          const imagePng = await render(path, page, 200)
          // ошибка Vision пробрасывается наружу и до записи кэша не доходит
          vp = await deps.vision(imagePng)
          await writeCachedPage(visionFile, JSON.stringify(vp))
        }
        result = { page, text: nfc(visionText(vp)), via: 'ocr' }
      } else {
        const imagePng = await render(path, page)
        // ошибка модели пробрасывается наружу и до записи кэша не доходит
        const { text: ocr } = await deps.llm.vision({ imagePng, prompt: OCR_PROMPT, maxTokens: OCR_MAX_TOKENS })
        const clean = nfc(ocr)
        await writeCachedPage(file, clean)
        result = { page, text: clean, via: 'ocr' }
      }
    }
    out.push(result)
    deps.onPage?.(result)
  }
  return out
}

// Кусок текста, который можно дописать к чанку: sep ставится перед ним, если он не первый в чанке
interface Unit { text: string; sep: string }

// Строку длиннее max режем по кодовым точкам, суррогатные пары не разрываем
function sliceChars(s: string, max: number): string[] {
  if (s.length <= max) return [s]
  const pieces: string[] = []
  let cur = ''
  for (const ch of s) {
    if (cur !== '' && cur.length + ch.length > max) {
      pieces.push(cur)
      cur = ''
    }
    cur += ch
  }
  if (cur !== '') pieces.push(cur)
  return pieces
}

// Абзацы по пустым строкам; абзац длиннее max режем по строкам, строку длиннее max — по символам
function unitsOf(text: string, max: number): Unit[] {
  const units: Unit[] = []
  for (const para of text.replace(/\r\n?/g, '\n').split(/\n\s*\n/)) {
    const p = para.trim()
    if (p === '') continue
    if (p.length <= max) {
      units.push({ text: p, sep: '\n\n' })
      continue
    }
    p.split('\n')
      .map(line => line.trim())
      .filter(line => line !== '')
      .forEach((line, li) => {
        sliceChars(line, max).forEach((piece, pi) => {
          const sep = pi > 0 ? '' : li === 0 ? '\n\n' : '\n'
          units.push({ text: piece, sep })
        })
      })
  }
  return units
}

// noPages: документ без страниц (.md), page в чанках всегда null. Без него номер страницы берётся из PageText.
export function chunkPages(
  pages: PageText[],
  opts: { maxChars?: number; noPages?: boolean } = {},
): { page: number | null; ref: string; text: string }[] {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS
  const out: { page: number | null; ref: string; text: string }[] = []
  // ближайший заголовок «#» в пределах документа (переходит через страницы)
  let heading: string | undefined

  const push = (page: number, text: string): void => {
    if (text.trim() === '') return
    // заголовки внутри чанка тоже учитываются: ref — ближайший заголовок к концу чанка
    for (const line of text.split('\n')) {
      const m = HEADING.exec(line)
      if (m) heading = m[1].replace(/\s+#+$/, '').trim()
    }
    out.push({ page: opts.noPages ? null : page, ref: heading ?? `стр. ${page}`, text })
  }

  for (const p of pages) {
    // чанк не смешивает страницы: каждая страница собирается отдельно
    let cur = ''
    for (const unit of unitsOf(p.text, maxChars)) {
      if (cur !== '' && cur.length + unit.sep.length + unit.text.length <= maxChars) {
        cur += unit.sep + unit.text
      } else {
        if (cur !== '') push(p.page, cur)
        cur = unit.text
      }
    }
    if (cur !== '') push(p.page, cur)
  }
  return out
}
