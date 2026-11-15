import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../src/lib/db'
import { classifySource, indexDocument, ocrPlan, parseIngestArgs, runLimited, type PlanDoc } from '../src/lib/kb/index'
import { nfc } from '../src/lib/ko'
import { LlmError, type LlmClient } from '../src/lib/llm'
import { openTestDb } from './helpers/testDb'

// 84 непробельных символа: выше порога minChars по умолчанию (80), страница берётся из текстового слоя
const LONG = '가나다라마바사 '.repeat(12)
const nfd = (s: string): string => s.normalize('NFD')
const sha1 = (buf: Buffer): string => createHash('sha1').update(buf).digest('hex')

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kb-index-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// Файл во временной папке книг. rel может быть в NFD: так имена приходят с диска на macOS
function writeBook(rel: string, content: string): string {
  const abs = join(dir, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
  return abs
}

const cacheDir = (): string => join(dir, 'cache')

// LlmClient с подменённым vision: запоминает вызовы; json и embed при индексации не нужны
function fakeLlm(vision: () => string | Promise<string> = () => '# OCR') {
  const calls: unknown[] = []
  const llm: LlmClient = {
    json: () => Promise.reject(new Error('json не ожидался')),
    async vision(args) {
      calls.push(args)
      return { text: await vision(), usage: { inputTokens: 0, outputTokens: 0 } }
    },
    embed: () => Promise.reject(new Error('embed не ожидался')),
  }
  return { llm, calls }
}

async function countRows(db: Db, table: 'kb_docs' | 'kb_chunks'): Promise<number> {
  const [row] = await db.query<{ n: number }>(`select count(*)::int as n from ${table}`)
  return row.n
}

describe('indexDocument', () => {
  it('indexDocument идемпотентен по sha1', async () => {
    const db = await openTestDb()
    const pdf = writeBook('TOPIK/2023.pdf', 'байты документа')
    const { llm, calls } = fakeLlm()
    let reads = 0
    const deps = {
      llm,
      cacheDir: cacheDir(),
      readTexts: async () => {
        reads++
        return [LONG]
      },
    }
    expect(await indexDocument(db, deps, { path: pdf, kind: 'exam' })).toEqual({ chunks: 1, ocrPages: 0, skipped: false })
    expect(await indexDocument(db, deps, { path: pdf, kind: 'exam' })).toEqual({ chunks: 0, ocrPages: 0, skipped: true })
    expect(reads).toBe(1)
    expect(calls).toHaveLength(0)
    expect(await countRows(db, 'kb_docs')).toBe(1)
    expect(await countRows(db, 'kb_chunks')).toBe(1)
  })

  it('путь в базе относительный и в NFC', async () => {
    const db = await openTestDb()
    const abs = writeBook(nfd('md/문법 노트.md'), '# 노트\n\n본문')
    const { llm } = fakeLlm()
    await indexDocument(db, { llm, cacheDir: cacheDir(), baseDir: dir }, { path: abs, kind: 'grammar' })
    const rows = await db.query<{ path: string }>('select path from kb_docs')
    expect(rows).toEqual([{ path: nfc('md/문법 노트.md') }])
    expect(rows[0].path).not.toBe(nfd('md/문법 노트.md'))
    expect(rows[0].path.startsWith('/')).toBe(false)
    expect(rows[0].path).not.toContain(dir)
  })

  it('без baseDir в базу попадает только имя файла в NFC', async () => {
    const db = await openTestDb()
    const abs = writeBook(nfd('md/문법.md'), '# 문법')
    const { llm } = fakeLlm()
    await indexDocument(db, { llm, cacheDir: cacheDir() }, { path: abs, kind: 'grammar' })
    const rows = await db.query<{ path: string }>('select path from kb_docs')
    expect(rows).toEqual([{ path: nfc('문법.md') }])
  })

  it('тот же файл под другим именем пропускается: в kb_docs одна строка', async () => {
    const db = await openTestDb()
    const { llm, calls } = fakeLlm()
    const deps = { llm, cacheDir: cacheDir(), baseDir: dir }
    const first = writeBook('md/a.md', '# 노트\n\n본문')
    const copy = writeBook('md/копия.md', '# 노트\n\n본문')
    expect(await indexDocument(db, deps, { path: first, kind: 'grammar' })).toEqual({ chunks: 1, ocrPages: 0, skipped: false })
    expect(await indexDocument(db, deps, { path: copy, kind: 'grammar' })).toEqual({ chunks: 0, ocrPages: 0, skipped: true })
    expect(await db.query<{ path: string }>('select path from kb_docs')).toEqual([{ path: 'md/a.md' }])
    expect(await countRows(db, 'kb_docs')).toBe(1)
    expect(await countRows(db, 'kb_chunks')).toBe(1)
    expect(calls).toHaveLength(0)
  })

  it('страница в kb_chunks: у .md пусто, у одностраничного PDF 1', async () => {
    const db = await openTestDb()
    const deps = { llm: fakeLlm().llm, cacheDir: cacheDir(), baseDir: dir, readTexts: async () => [LONG] }
    const md = writeBook('md/노트.md', '# 노트\n\n본문')
    await indexDocument(db, deps, { path: md, kind: 'grammar' })
    const pdf = writeBook('TOPIK/one.pdf', 'байты одностраничного')
    await indexDocument(db, deps, { path: pdf, kind: 'exam' })
    const rows = await db.query<{ doc: string; page: number | null }>(
      'select d.path as doc, c.page from kb_chunks c join kb_docs d on d.id = c.doc_id order by c.id',
    )
    expect(rows).toEqual([
      { doc: 'md/노트.md', page: null },
      { doc: 'TOPIK/one.pdf', page: 1 },
    ])
  })

  it('файл вне baseDir: ошибка, в базе ничего нет', async () => {
    const db = await openTestDb()
    const abs = writeBook('md/x.md', 'текст')
    const { llm } = fakeLlm()
    await expect(
      indexDocument(db, { llm, cacheDir: cacheDir(), baseDir: join(dir, 'books') }, { path: abs, kind: 'grammar' }),
    ).rejects.toThrow('вне папки книг')
    expect(await countRows(db, 'kb_docs')).toBe(0)
    expect(await countRows(db, 'kb_chunks')).toBe(0)
  })

  it('изменённый файл с тем же путём заменяет старые чанки', async () => {
    const db = await openTestDb()
    const { llm } = fakeLlm()
    const file = writeBook('md/노트.md', 'старый А\n\nстарый Б')
    const deps = { llm, cacheDir: cacheDir(), baseDir: dir }
    expect(await indexDocument(db, deps, { path: file, kind: 'grammar' })).toEqual({ chunks: 1, ocrPages: 0, skipped: false })

    writeFileSync(file, 'новый В')
    expect(await indexDocument(db, deps, { path: file, kind: 'grammar' })).toEqual({ chunks: 1, ocrPages: 0, skipped: false })

    const docs = await db.query<{ path: string; sha1: string }>('select path, sha1 from kb_docs')
    expect(docs).toEqual([{ path: nfc('md/노트.md'), sha1: sha1(readFileSync(file)) }])
    const chunks = await db.query<{ text: string }>('select text from kb_chunks order by id')
    expect(chunks.map(c => c.text)).toEqual(['новый В'])
  })

  it('ошибка извлечения не оставляет строк', async () => {
    const db = await openTestDb()
    const pdf = writeBook('TOPIK/bad.pdf', 'байты')
    // первая страница с текстом, вторая без текстового слоя: распознавание падает уже после чтения первой
    const { llm } = fakeLlm(() => Promise.reject(new LlmError('OpenRouter 500: сбой', 500)))
    await expect(
      indexDocument(
        db,
        { llm, cacheDir: cacheDir(), readTexts: async () => [LONG, ''], render: async () => Buffer.from('png') },
        { path: pdf, kind: 'exam' },
      ),
    ).rejects.toThrow(LlmError)
    expect(await countRows(db, 'kb_docs')).toBe(0)
    expect(await countRows(db, 'kb_chunks')).toBe(0)
  })

  it('forceOcr: страницы с текстовым слоем тоже идут в распознавание', async () => {
    const db = await openTestDb()
    const pdf = writeBook('RESIPI_4.pdf', 'байты учебника')
    const { llm, calls } = fakeLlm(() => '# OCR')
    const deps = { llm, cacheDir: cacheDir(), readTexts: async () => [LONG, LONG], render: async () => Buffer.from('png') }
    expect(await indexDocument(db, deps, { path: pdf, kind: 'textbook', forceOcr: true })).toEqual({
      chunks: 2,
      ocrPages: 2,
      skipped: false,
    })
    expect(calls).toHaveLength(2)
  })

  it('без forceOcr страницы с текстовым слоем берутся из текста, модель не вызывается', async () => {
    const db = await openTestDb()
    const pdf = writeBook('RESIPI_5.pdf', 'другие байты учебника')
    const { llm, calls } = fakeLlm(() => '# OCR')
    const deps = { llm, cacheDir: cacheDir(), readTexts: async () => [LONG, LONG], render: async () => Buffer.from('png') }
    expect(await indexDocument(db, deps, { path: pdf, kind: 'textbook' })).toEqual({ chunks: 2, ocrPages: 0, skipped: false })
    expect(calls).toHaveLength(0)
  })

  it('больше 200 чанков вставляются полностью', async () => {
    const db = await openTestDb()
    // 250 абзацев по 1000 символов: два абзаца в один чанк не влезают в 1500, значит чанков 250
    const body = Array.from({ length: 250 }, (_, i) => `${i}-`.padEnd(1000, 'а')).join('\n\n')
    const file = writeBook('md/большой.md', body)
    const { llm } = fakeLlm()
    const result = await indexDocument(db, { llm, cacheDir: cacheDir(), baseDir: dir }, { path: file, kind: 'grammar' })
    expect(result).toEqual({ chunks: 250, ocrPages: 0, skipped: false })
    expect(await countRows(db, 'kb_chunks')).toBe(250)
    const rows = await db.query<{ text: string; kind: string; vec: unknown }>('select text, kind, vec from kb_chunks order by id')
    expect(rows[0].text.startsWith('0-')).toBe(true)
    expect(rows[249].text.startsWith('249-')).toBe(true)
    expect(rows.every(r => r.kind === 'grammar' && r.vec === null)).toBe(true)
  })
})

describe('ocrPlan', () => {
  // Скан без чтения PDF: три страницы; без текстового слоя страницы 2 и 3, при minChars = Infinity все три
  const fakeScan = async (_path: string, opts?: { minChars?: number }) => ({
    pages: 3,
    ocrPages: opts?.minChars === Infinity ? [1, 2, 3] : [2, 3],
  })
  const doc = (rel: string, abs: string, forceOcr = false): PlanDoc => ({ rel, abs, forceOcr })

  it('считает страницы без текстового слоя, которых нет в кэше', async () => {
    const db = await openTestDb()
    const pdf = writeBook('TOPIK/2023.pdf', 'байты экзамена')
    expect(await ocrPlan(db, [doc('TOPIK/2023.pdf', pdf)], cacheDir(), fakeScan)).toEqual({ pages: 2, docs: ['TOPIK/2023.pdf'] })
  })

  it('страницы из кэша не считаются', async () => {
    const db = await openTestDb()
    const pdf = writeBook('TOPIK/2023.pdf', 'байты экзамена')
    const folder = join(cacheDir(), sha1(readFileSync(pdf)))
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, '2.md'), '# 2')
    expect(await ocrPlan(db, [doc('TOPIK/2023.pdf', pdf)], cacheDir(), fakeScan)).toEqual({ pages: 1, docs: ['TOPIK/2023.pdf'] })
    writeFileSync(join(folder, '3.md'), '# 3')
    expect(await ocrPlan(db, [doc('TOPIK/2023.pdf', pdf)], cacheDir(), fakeScan)).toEqual({ pages: 0, docs: [] })
  })

  it('документ, уже лежащий в базе, не считается и не сканируется', async () => {
    const db = await openTestDb()
    const pdf = writeBook('TOPIK/2023.pdf', 'байты экзамена')
    const id = sha1(readFileSync(pdf))
    await db.query('insert into kb_docs (id, path, kind, sha1, pages, ocr_pages) values ($1, $2, $3, $4, $5, $6)', [
      id,
      'TOPIK/2023.pdf',
      'exam',
      id,
      3,
      2,
    ])
    const notScanned = async (): Promise<never> => {
      throw new Error('скан не ожидался')
    }
    expect(await ocrPlan(db, [doc('TOPIK/2023.pdf', pdf)], cacheDir(), notScanned)).toEqual({ pages: 0, docs: [] })
  })

  it('forceOcr: считаются все страницы, и с текстовым слоем тоже; кэш учитывается', async () => {
    const db = await openTestDb()
    const pdf = writeBook('RESIPI_4.pdf', 'байты учебника')
    expect(await ocrPlan(db, [doc('RESIPI_4.pdf', pdf, true)], cacheDir(), fakeScan)).toEqual({ pages: 3, docs: ['RESIPI_4.pdf'] })
    expect(await ocrPlan(db, [doc('RESIPI_4.pdf', pdf)], cacheDir(), fakeScan)).toEqual({ pages: 2, docs: ['RESIPI_4.pdf'] })

    const folder = join(cacheDir(), sha1(readFileSync(pdf)))
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, '1.md'), '# 1')
    expect(await ocrPlan(db, [doc('RESIPI_4.pdf', pdf, true)], cacheDir(), fakeScan)).toEqual({ pages: 2, docs: ['RESIPI_4.pdf'] })
  })
})

describe('classifySource', () => {
  it('md/ и GRAMMAR_MAIN.md — grammar, PDF в корне с нужным именем — textbook, PDF в TOPIK/ — exam', () => {
    expect(classifySource('md/문법/-거든.md')).toEqual({ ok: true, kind: 'grammar' })
    expect(classifySource('GRAMMAR_MAIN.md')).toEqual({ ok: true, kind: 'grammar' })
    expect(classifySource('합격 레시피 4급.pdf')).toEqual({ ok: true, kind: 'textbook' })
    expect(classifySource('RESIPI_4.pdf')).toEqual({ ok: true, kind: 'textbook' })
    expect(classifySource('TOPIK/2022/기출 듣기.pdf')).toEqual({ ok: true, kind: 'exam' })
  })

  it('имена в NFD классифицируются так же', () => {
    expect(classifySource(nfd('합격 레시피 4급.pdf'))).toEqual({ ok: true, kind: 'textbook' })
    expect(classifySource(nfd('TOPIK/2023년 1회.pdf'))).toEqual({ ok: true, kind: 'exam' })
    expect(classifySource(nfd('md/문법.md'))).toEqual({ ok: true, kind: 'grammar' })
  })

  it('пропуски с причиной', () => {
    const cases: [string, string][] = [
      ['- 어휘 (1).csv', 'формат .csv не индексируется'],
      ['TOPIK/듣기.mp3', 'формат .mp3 не индексируется'],
      ['TOPIK/책.djvu', 'формат .djvu не индексируется'],
      ['md/메모.hwp', 'формат .hwp не индексируется'],
      ['TOPIK/설정.ini', 'формат .ini не индексируется'],
      ['.DS_Store', 'служебный файл'],
      ['Другая книга.pdf', 'PDF вне TOPIK/ и не учебник'],
      ['md/черновик.pdf', 'PDF вне TOPIK/ и не учебник'],
      ['Другое.md', 'markdown вне md/ и не GRAMMAR_MAIN.md'],
    ]
    for (const [rel, reason] of cases) expect(classifySource(rel)).toEqual({ ok: false, reason })
  })

  it('пропуск с именем в NFD тоже с причиной', () => {
    expect(classifySource(nfd('TOPIK/듣기.mp3'))).toEqual({ ok: false, reason: 'формат .mp3 не индексируется' })
  })
})

describe('parseIngestArgs', () => {
  it('без флагов всё выключено', () => {
    expect(parseIngestArgs([])).toEqual({
      dryRun: false,
      yes: false,
      noEmbed: false,
      only: undefined,
      ocrPages: [],
      exclude: [],
      forceOcr: [],
      jobs: 1,
    })
  })

  it('--yes, --no-embed, --only, --dry-run', () => {
    expect(parseIngestArgs(['--yes', '--no-embed', '--only', 'TOPIK/2023'])).toEqual({
      dryRun: false,
      yes: true,
      noEmbed: true,
      only: 'TOPIK/2023',
      ocrPages: [],
      exclude: [],
      forceOcr: [],
      jobs: 1,
    })
    expect(parseIngestArgs(['--dry-run', '--only', '합격 레시피'])).toEqual({
      dryRun: true,
      yes: false,
      noEmbed: false,
      only: '합격 레시피',
      ocrPages: [],
      exclude: [],
      forceOcr: [],
      jobs: 1,
    })
  })

  it('--exclude и --force-ocr повторяются, значения в NFC', () => {
    const args = parseIngestArgs(['--exclude', 'TOPIK1', '--exclude', nfd('2023년 1회'), '--force-ocr', nfd('합격 레시피')])
    expect(args.exclude).toEqual(['TOPIK1', nfc('2023년 1회')])
    expect(args.forceOcr).toEqual([nfc('합격 레시피')])
  })

  it('--jobs: целое от 1 до 8', () => {
    expect(parseIngestArgs(['--jobs', '1']).jobs).toBe(1)
    expect(parseIngestArgs(['--jobs', '4']).jobs).toBe(4)
    expect(parseIngestArgs(['--jobs', '8']).jobs).toBe(8)
  })

  it('--jobs вне 1–8 или не целое — ошибка', () => {
    for (const v of ['0', '9', '-1', '2.5', '3a', '1e1', 'x']) {
      expect(() => parseIngestArgs(['--jobs', v])).toThrow('--jobs: нужно целое число от 1 до 8')
    }
  })

  it('--exclude, --force-ocr и --jobs без значения — ошибка', () => {
    expect(() => parseIngestArgs(['--exclude'])).toThrow('--exclude: нужно значение')
    expect(() => parseIngestArgs(['--exclude', '--yes'])).toThrow('--exclude: нужно значение')
    expect(() => parseIngestArgs(['--force-ocr'])).toThrow('--force-ocr: нужно значение')
    expect(() => parseIngestArgs(['--force-ocr', ''])).toThrow('--force-ocr: нужно значение')
    expect(() => parseIngestArgs(['--jobs'])).toThrow('--jobs: нужно значение')
    expect(() => parseIngestArgs(['--jobs', ''])).toThrow('--jobs: нужно значение')
    expect(() => parseIngestArgs(['--jobs', '--yes'])).toThrow('--jobs: нужно значение')
  })

  it('--only приводится к NFC', () => {
    expect(parseIngestArgs(['--only', nfd('합격 레시피')]).only).toBe(nfc('합격 레시피'))
  })

  it('несколько --ocr-page по порядку, путь в NFC, номер страницы числом', () => {
    const args = parseIngestArgs([
      '--ocr-page',
      'TOPIK/a.pdf:3',
      '--ocr-page',
      `${nfd('합격 레시피 4급.pdf')}:10`,
      '--ocr-page',
      'TOPIK/a:b.pdf:2',
    ])
    expect(args.ocrPages).toEqual([
      { path: 'TOPIK/a.pdf', page: 3 },
      { path: nfc('합격 레시피 4급.pdf'), page: 10 },
      { path: 'TOPIK/a:b.pdf', page: 2 },
    ])
  })

  it('неизвестный флаг и лишний аргумент — ошибка', () => {
    expect(() => parseIngestArgs(['--bogus'])).toThrow('неизвестный')
    expect(() => parseIngestArgs(['лишнее'])).toThrow('неизвестный')
  })

  it('пустое или отсутствующее значение, плохой номер страницы, dry-run вместе с ocr-page — ошибка', () => {
    expect(() => parseIngestArgs(['--only'])).toThrow()
    expect(() => parseIngestArgs(['--only', ''])).toThrow()
    expect(() => parseIngestArgs(['--ocr-page', 'TOPIK/a.pdf'])).toThrow()
    expect(() => parseIngestArgs(['--ocr-page', 'TOPIK/a.pdf:0'])).toThrow()
    expect(() => parseIngestArgs(['--ocr-page', 'TOPIK/a.pdf:x'])).toThrow()
    expect(() => parseIngestArgs(['--ocr-page', ':3'])).toThrow()
    expect(() => parseIngestArgs(['--dry-run', '--ocr-page', 'TOPIK/a.pdf:1'])).toThrow()
  })
})

describe('runLimited', () => {
  it('одновременно не больше limit задач, все элементы обработаны', async () => {
    let running = 0
    let peak = 0
    const done: number[] = []
    await runLimited(
      [1, 2, 3, 4, 5, 6],
      3,
      async n => {
        running += 1
        peak = Math.max(peak, running)
        await new Promise(resolve => setTimeout(resolve, 5))
        running -= 1
        done.push(n)
      },
      () => {},
    )
    expect(peak).toBe(3)
    expect(done.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('ошибка одной задачи не останавливает остальные и уходит в onError', async () => {
    const done: number[] = []
    const errors: [number, string][] = []
    await runLimited(
      [1, 2, 3],
      2,
      async n => {
        if (n === 1) throw new Error('сбой 1')
        done.push(n)
      },
      (n, err) => errors.push([n, (err as Error).message]),
    )
    expect(done.sort((a, b) => a - b)).toEqual([2, 3])
    expect(errors).toEqual([[1, 'сбой 1']])
  })

  it('limit больше числа элементов: каждый элемент обрабатывается один раз', async () => {
    const done: string[] = []
    await runLimited(['a', 'b'], 8, async s => {
      done.push(s)
    }, () => {})
    expect(done.sort()).toEqual(['a', 'b'])
  })
})
