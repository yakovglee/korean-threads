import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkVisionPage, fixMarkers, visionText } from '../src/lib/kb/vision-text'
import type { VisionPage } from '../src/lib/kb/vision'

const FIXTURES = join(__dirname, 'fixtures/vision')
const readFixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')
const loadPage = (name: string): VisionPage => JSON.parse(readFixture(`${name}.json`)) as VisionPage

// Пары X.json / X.txt: имена берём из папки, чтобы новые фикстуры подхватывались сами
const names = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.slice(0, -'.json'.length))
  .sort()

describe('visionText', () => {
  it.each(names)('%s: текст совпадает с фикстурой без завершающего перевода строки', (name) => {
    const expected = readFixture(`${name}.txt`).replace(/\n$/, '')
    expect(visionText(loadPage(name))).toBe(expected)
  })

  it('страница без строк даёт пустой текст', () => {
    expect(visionText({ lines: [] })).toBe('')
  })

  it('строки из одних пробелов отбрасываются', () => {
    const page: VisionPage = {
      lines: [
        { t: '   ', c: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.02 },
        { t: '가나다', c: 1, x: 0.1, y: 0.2, w: 0.2, h: 0.02 },
      ],
    }
    expect(visionText(page)).toBe('가나다')
  })
})

describe('fixMarkers', () => {
  it('цифра в начале строки с номером вопроса становится кружком, если рядом есть ②', () => {
    expect(fixMarkers('21. 1 방에\n② 여자는')).toBe('21. ① 방에\n② 여자는')
  })

  it('цифра 3 между ② и ④ становится кружком ③', () => {
    expect(fixMarkers('① A ② B 3 날씨 ④ D')).toBe('① A ② B ③ 날씨 ④ D')
  })

  it('цифра после кружка не меняется', () => {
    expect(fixMarkers('② 3 가지')).toBe('② 3 가지')
  })

  it('⑧ становится ③, если рядом есть ② или ④', () => {
    expect(fixMarkers('② 가\n⑧ 나')).toBe('② 가\n③ 나')
  })
})

describe('checkVisionPage', () => {
  it('картинки с вариантами без текста и неровные варианты', () => {
    const page = loadPage('exam-pictures')
    const text = visionText(page)
    expect(checkVisionPage(page, text)).toEqual([
      { code: 'pictures', detail: '5 вариантов без текста' },
      { code: 'options', detail: '①×1 ②×2 ③×1 ④×1' },
    ])
  })

  it('сетка ответов без флагов', () => {
    const page = loadPage('exam-grid')
    expect(checkVisionPage(page, visionText(page))).toEqual([])
  })

  it('страница без строк — только empty «0 зн.»', () => {
    const page: VisionPage = { lines: [] }
    expect(checkVisionPage(page, visionText(page))).toEqual([{ code: 'empty', detail: '0 зн.' }])
  })
})
