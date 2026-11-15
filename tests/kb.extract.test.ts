import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chunkPages, extractDocument, OCR_PROMPT, scanDocument, writeCachedPage, type PageText } from '../src/lib/kb/extract'
import { LlmError, type LlmClient } from '../src/lib/llm'

type VisionArgs = { imagePng: Buffer; prompt: string; maxTokens?: number }
const USAGE = { inputTokens: 0, outputTokens: 0 }
// 84 непробельных символа: выше порога minChars по умолчанию (80)
const LONG = '가나다라마바사 '.repeat(12)

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kb-extract-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const cacheDir = (): string => join(dir, 'cache')
const sha1 = (file: string): string => createHash('sha1').update(readFileSync(file)).digest('hex')

// Файл-заглушка: настоящий PDF не нужен, рендер подменён; нужны только байты для sha1
function makePdf(name = 'book.pdf'): string {
  const file = join(dir, name)
  writeFileSync(file, 'заглушка вместо PDF')
  return file
}

// LlmClient с подменённым vision: запоминает вызовы, текст ответа берёт у answer
function fakeLlm(answer: () => string | Promise<string> = () => '# OCR') {
  const calls: VisionArgs[] = []
  const llm: LlmClient = {
    json: () => Promise.reject(new Error('json не ожидался')),
    async vision(args) {
      calls.push(args)
      return { text: await answer(), usage: USAGE }
    },
    embed: () => Promise.reject(new Error('embed не ожидался')),
  }
  return { llm, calls }
}

// render без настоящего PDF: возвращает маленький буфер и запоминает номера страниц
function fakeRender() {
  const pages: number[] = []
  const render = async (_file: string, page: number): Promise<Buffer> => {
    pages.push(page)
    return Buffer.from(`png-${page}`)
  }
  return { render, pages }
}

describe('chunkPages', () => {
  it('chunkPages режет по пустым строкам и держит ref заголовка', () => {
    const chunks = chunkPages(
      [{ page: 1, text: '# Глава 1\n\n가나다\n\n라마바\n\n## Раздел\n\n사아자', via: 'text' }],
      { maxChars: 10, noPages: true },
    )
    expect(chunks).toEqual([
      { page: null, ref: 'Глава 1', text: '# Глава 1' },
      { page: null, ref: 'Глава 1', text: '가나다\n\n라마바' },
      { page: null, ref: 'Раздел', text: '## Раздел' },
      { page: null, ref: 'Раздел', text: '사아자' },
    ])
  })

  it('chunkPages: длинный абзац и длинная строка режутся, чанки не длиннее maxChars', () => {
    // абзац длиннее 10 режется по строкам, строка из 20 символов режется по символам
    const text = 'AAAAAAAAAA\nBBBBBBBBBBBBBBBBBBBB\nCC\n\nDDDDD'
    const chunks = chunkPages([{ page: 1, text, via: 'text' }], { maxChars: 10 })
    expect(chunks.map(c => c.text)).toEqual(['AAAAAAAAAA', 'BBBBBBBBBB', 'BBBBBBBBBB', 'CC\n\nDDDDD'])
    expect(chunks.every(c => c.text.length <= 10)).toBe(true)
  })

  it('chunkPages: ref до первого заголовка — «стр. N», чанки не смешивают страницы', () => {
    const chunks = chunkPages([
      { page: 1, text: '첫 문장\n\n둘째 문장', via: 'text' },
      { page: 2, text: '# Заголовок\n\n본문', via: 'text' },
      { page: 3, text: '후속', via: 'text' },
    ])
    expect(chunks).toEqual([
      { page: 1, ref: 'стр. 1', text: '첫 문장\n\n둘째 문장' },
      { page: 2, ref: 'Заголовок', text: '# Заголовок\n\n본문' },
      { page: 3, ref: 'Заголовок', text: '후속' },
    ])
  })

  it('chunkPages: noPages (документ из .md) даёт page = null, даже у страницы 1', () => {
    const chunks = chunkPages([{ page: 1, text: 'текст', via: 'text' }], { noPages: true })
    expect(chunks).toEqual([{ page: null, ref: 'стр. 1', text: 'текст' }])
  })

  it('chunkPages: одностраничный PDF без noPages сохраняет page = 1', () => {
    const chunks = chunkPages([{ page: 1, text: 'текст', via: 'text' }])
    expect(chunks).toEqual([{ page: 1, ref: 'стр. 1', text: 'текст' }])
  })

  it('chunkPages: пустые страницы не дают чанков', () => {
    expect(chunkPages([{ page: 1, text: ' \n\n  ', via: 'text' }, { page: 2, text: '', via: 'text' }])).toEqual([])
  })
})

describe('extractDocument', () => {
  it('extractDocument: страница с текстом не вызывает llm.vision, пустая вызывает', async () => {
    const pdf = makePdf()
    const { llm, calls } = fakeLlm(() => '# Распознано')
    const { render, pages } = fakeRender()
    const seen: PageText[] = []
    const out = await extractDocument(pdf, {
      llm,
      cacheDir: cacheDir(),
      render,
      readTexts: async () => [LONG, ''],
      onPage: p => seen.push(p),
    })
    expect(out).toEqual([
      { page: 1, text: LONG, via: 'text' },
      { page: 2, text: '# Распознано', via: 'ocr' },
    ])
    expect(seen).toEqual(out)
    expect(pages).toEqual([2])
    expect(calls).toEqual([{ imagePng: Buffer.from('png-2'), prompt: OCR_PROMPT, maxTokens: 8000 }])
  })

  it('extractDocument: OCR кэшируется, второй запуск не вызывает vision', async () => {
    const pdf = makePdf()
    const { llm, calls } = fakeLlm(() => '# Страница 2')
    const deps = { llm, cacheDir: cacheDir(), render: fakeRender().render, readTexts: async () => [LONG, ''] }
    const first = await extractDocument(pdf, deps)
    const second = await extractDocument(pdf, deps)
    expect(first[1]).toEqual({ page: 2, text: '# Страница 2', via: 'ocr' })
    expect(second).toEqual(first)
    expect(calls).toHaveLength(1)
    expect(readFileSync(join(cacheDir(), sha1(pdf), '2.md'), 'utf8')).toBe('# Страница 2')
    // после записи в папке страницы нет временных файлов
    expect(readdirSync(join(cacheDir(), sha1(pdf)))).toEqual(['2.md'])
  })

  it('extractDocument: ошибка vision не пишет кэш', async () => {
    const pdf = makePdf()
    const { llm } = fakeLlm(() => Promise.reject(new LlmError('OpenRouter 500: сбой', 500)))
    await expect(
      extractDocument(pdf, { llm, cacheDir: cacheDir(), render: fakeRender().render, readTexts: async () => [''] }),
    ).rejects.toThrow(LlmError)
    expect(existsSync(join(cacheDir(), sha1(pdf), '1.md'))).toBe(false)
  })

  it('extractDocument: .md отдаётся одной страницей без распознавания', async () => {
    const md = join(dir, 'grammar.md')
    writeFileSync(md, '# 문법\n\n-거든 용법')
    const { llm, calls } = fakeLlm()
    const out = await extractDocument(md, {
      llm,
      cacheDir: cacheDir(),
      readTexts: () => Promise.reject(new Error('для .md чтение PDF не ожидалось')),
    })
    expect(out).toEqual([{ page: 1, text: '# 문법\n\n-거든 용법', via: 'text' }])
    expect(calls).toHaveLength(0)
  })

  it('порог minChars считает непробельные символы', async () => {
    const pdf = makePdf()
    const text = '가 나 다\n\n라 마' // 5 непробельных символов
    const { llm, calls } = fakeLlm(() => '# OCR')
    const base = { llm, cacheDir: cacheDir(), render: fakeRender().render, readTexts: async () => [text] }
    expect(await extractDocument(pdf, { ...base, minChars: 5 })).toEqual([{ page: 1, text, via: 'text' }])
    expect(calls).toHaveLength(0)
    expect(await extractDocument(pdf, { ...base, minChars: 6 })).toEqual([{ page: 1, text: '# OCR', via: 'ocr' }])
    expect(calls).toHaveLength(1)
  })

  it('NFD-текст страницы возвращается в NFC', async () => {
    const pdf = makePdf()
    const nfdText = LONG.normalize('NFD')
    expect(nfdText).not.toBe(LONG)
    const { llm } = fakeLlm(() => '# 제목'.normalize('NFD'))
    const out = await extractDocument(pdf, {
      llm,
      cacheDir: cacheDir(),
      render: fakeRender().render,
      readTexts: async () => [nfdText, ''],
    })
    expect(out).toEqual([
      { page: 1, text: LONG, via: 'text' },
      { page: 2, text: '# 제목', via: 'ocr' },
    ])
  })
})

describe('writeCachedPage', () => {
  it('создаёт папку и пишет страницу, рядом не остаётся временных файлов', async () => {
    const file = join(cacheDir(), 'abc', '1.md')
    await writeCachedPage(file, '# Один')
    expect(readFileSync(file, 'utf8')).toBe('# Один')
    expect(readdirSync(join(cacheDir(), 'abc'))).toEqual(['1.md'])
  })

  it('перезаписывает существующую страницу целиком', async () => {
    const file = join(cacheDir(), 'abc', '1.md')
    await writeCachedPage(file, 'длинный текст')
    await writeCachedPage(file, 'коротко')
    expect(readFileSync(file, 'utf8')).toBe('коротко')
    expect(readdirSync(join(cacheDir(), 'abc'))).toEqual(['1.md'])
  })
})

describe('scanDocument', () => {
  it('scanDocument: считает страницы без текстового слоя и не вызывает модель', async () => {
    const pdf = makePdf()
    const info = await scanDocument(pdf, { readTexts: async () => [LONG, '   ', '짧음'] })
    expect(info).toEqual({ pages: 3, ocrPages: [2, 3] })

    const md = join(dir, 'notes.md')
    writeFileSync(md, 'текст')
    const mdInfo = await scanDocument(md, { readTexts: () => Promise.reject(new Error('для .md чтение PDF не ожидалось')) })
    expect(mdInfo).toEqual({ pages: 1, ocrPages: [] })
  })
})
