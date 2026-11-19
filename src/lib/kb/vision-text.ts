// Сборка текста страницы из строк Vision: порядок колонок, рядов и пустых строк, исправление кружков-вариантов.
// Правила подобраны по пробному прогону на книгах и проверяются фикстурами tests/fixtures/vision/*.json → *.txt.
// Длина строки здесь — число кодовых точек, а не UTF-16 единиц.
import type { VisionLine, VisionPage } from './vision'

export interface PageFlag { code: 'empty' | 'pictures' | 'options'; detail: string }

const CIRCLES = ['①', '②', '③', '④']

// Число кодовых точек
const len = (s: string): number => [...s].length

// Строки без текста отбрасываем; медиана высот берётся по индексу floor(n / 2)
function nonEmpty(lines: VisionLine[]): VisionLine[] {
  return lines.filter((l) => l.t.trim() !== '')
}

function medianHeight(lines: VisionLine[]): number {
  const hs = lines.map((l) => l.h).sort((a, b) => a - b)
  return hs[Math.floor(hs.length / 2)]
}

// Страница двухколоночная, если «перекрытых» строк почти нет и в обеих колонках есть текст,
// а ряд вариантов «① ② | ③ ④» колонкой не считается
function isTwoColumns(lines: VisionLine[]): boolean {
  const long = lines.filter((l) => len(l.t.trim()) > 3)
  if (long.length === 0) return false
  const cross = long.filter((l) => l.x < 0.45 && l.x + l.w > 0.55).length
  const left = long.filter((l) => l.x + l.w <= 0.52).length
  const right = long.filter((l) => l.x >= 0.48)
  const marked = right.filter((l) => CIRCLES.some((c) => l.t.trim().startsWith(c))).length
  return cross <= 0.05 * long.length && left >= 6 && right.length >= 6 && marked <= 0.5 * right.length
}

// Ряды внутри группы: строки по возрастанию центра по y, строка входит в последний ряд, если центры близки
function buildRows(group: VisionLine[]): VisionLine[][] {
  const sorted = [...group].sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2))
  const rows: VisionLine[][] = []
  for (const line of sorted) {
    const row = rows[rows.length - 1]
    if (row) {
      const first = row[0]
      const cy = line.y + line.h / 2
      const firstCy = first.y + first.h / 2
      if (Math.abs(cy - firstCy) < 0.5 * Math.min(first.h, line.h)) {
        row.push(line)
        continue
      }
    }
    rows.push([line])
  }
  // внутри ряда слева направо
  for (const row of rows) row.sort((a, b) => a.x - b.x)
  return rows
}

export function visionText(page: VisionPage): string {
  const lines = nonEmpty(page.lines)
  if (lines.length === 0) return ''
  const mh = medianHeight(lines)

  // Группы: для двух колонок A (левая) идёт перед B (правая), иначе одна группа
  let groups: VisionLine[][]
  if (isTwoColumns(lines)) {
    groups = [
      lines.filter((l) => l.x + l.w / 2 < 0.5),
      lines.filter((l) => l.x + l.w / 2 >= 0.5),
    ]
  } else {
    groups = [lines]
  }

  const result: string[] = []
  for (const group of groups) {
    let prevBottom: number | undefined
    for (const row of buildRows(group)) {
      const top = Math.min(...row.map((l) => l.y))
      const bottom = Math.max(...row.map((l) => l.y + l.h))
      // большой зазор между рядами группы — пустая строка
      if (prevBottom !== undefined && result.length > 0 && top - prevBottom > 1.5 * mh) result.push('')
      result.push(row.map((l) => l.t.trim()).join(' '))
      prevBottom = bottom
    }
    // после каждой группы — пустая строка, если результат ещё не кончается ею
    if (result.length > 0 && result[result.length - 1] !== '') result.push('')
  }

  return fixMarkers(result.join('\n').trim())
}

// Исправление распознанных вместо кружков цифр и букв: 1, 2, 3, 4, l, I, | перед корейским словом
export function fixMarkers(text: string): string {
  const lines = text.split('\n')

  // Шаг 1: ⑧ → ③, если рядом (в строке или в двух строках до и после) есть ② или ④
  const afterEight = lines.map((s, i) => {
    if (!s.includes('⑧')) return s
    const window = lines.slice(Math.max(0, i - 2), i + 3).join('\n')
    return window.includes('②') || window.includes('④') ? s.replace(/⑧/g, '③') : s
  })

  // Шаг 2: токены-цифры и похожие на них символы, по строкам после шага 1
  return afterEight.map((s, i) => {
    const near = [afterEight[i - 1] ?? '', s, afterEight[i + 1] ?? ''].join('\n')
    const has = (d: number): boolean => d >= 1 && d <= 4 && near.includes(CIRCLES[d - 1])
    const edits: { idx: number; token: string; to: string }[] = []

    for (const m of s.matchAll(/(?<!\S)([1-4lI|])(?=\s+[가-힣(])/g)) {
      const token = m[1]
      const idx = m.index ?? 0
      const d = /[lI|]/.test(token) ? 1 : Number(token)
      const before = s.slice(0, idx)
      const after = s.slice(idx + token.length)

      if (/^\s*(\d{1,2}\.?\s*)?$/.test(before)) {
        // начало строки или номер вопроса: меняем, если рядом есть соседний кружок
        if (has(d - 1) || has(d + 1)) edits.push({ idx, token, to: CIRCLES[d - 1] })
        continue
      }
      // токен после кружка («② 3 가지») не трогаем
      if (/[①②③④]\s*$/.test(before)) continue
      // иначе меняем, когда слева есть d − 1 и (d = 4 или справа есть d + 1)
      if (d > 1 && before.includes(CIRCLES[d - 2]) && (d === 4 || after.includes(CIRCLES[d]))) {
        edits.push({ idx, token, to: CIRCLES[d - 1] })
      }
    }

    // правки применяем с конца строки, чтобы индексы не сдвигались
    let out = s
    for (const e of edits.reverse()) {
      out = out.slice(0, e.idx) + e.to + out.slice(e.idx + e.token.length)
    }
    return out
  }).join('\n')
}

export function checkVisionPage(page: VisionPage, text: string): PageFlag[] {
  // Почти пустая страница: меньше 15 знаков без пробелов
  const bare = len(text.replace(/\s/g, ''))
  if (bare < 15) return [{ code: 'empty', detail: `${bare} зн.` }]

  const flags: PageFlag[] = []

  // Картинки с вариантами без текста: строки, где есть только кружок
  const pictures = page.lines.filter((l) => /^\s*[①②③④][\s.]*$/.test(l.t)).length
  if (pictures >= 2) flags.push({ code: 'pictures', detail: `${pictures} вариантов без текста` })

  // Варианты: если кружки встречаются неодинаково часто, страница распознана с ошибками
  const counts = CIRCLES.map((c) => text.split(c).length - 1)
  const max = Math.max(...counts)
  const min = Math.min(...counts)
  if (max >= 2 && max !== min) {
    flags.push({ code: 'options', detail: `①×${counts[0]} ②×${counts[1]} ③×${counts[2]} ④×${counts[3]}` })
  }

  return flags
}
