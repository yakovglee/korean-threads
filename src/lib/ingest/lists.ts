import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'csv-parse/sync'
import type { Db } from '../db'
import { nfc, splitHomograph } from '../ko'
import type { Item, ItemKind, Level } from '../types'

// Колонки исходных CSV (списки 어휘/문법 등급 목록 из папки книг).
// В словаре колонка «등급» встречается дважды: берётся первая.
const COLUMNS: Record<ItemKind, { headword: string; pos: string; hint: string; related?: string }> = {
  vocab: { headword: '어휘', pos: '품사', hint: '길잡이말' },
  grammar: { headword: '대표형', pos: '분류', hint: '의미', related: '관련형' },
}

// Разделители вариантов одного слова в «어휘»: U+2219, U+00B7, U+2027, U+30FB и «/».
const VARIANT_SEP = /[\u2219\u00b7\u2027\u30fb\/]/
// В «품사» те же разделители, плюс «.» (встречается как в «수사.관형사/명사»).
const POS_SEP = /[\u2219\u00b7\u2027\u30fb\/.]/

const BATCH = 500
const LIST_SUFFIX = { vocab: nfc('- 어휘 (1).csv'), grammar: nfc('- 문법.csv') }

// «어휘»: одно слово — как есть. Несколько вариантов через разделители — у них общая основа:
// headword = основа, homograph = номер первого варианта, related = все варианты через «/», пробелы по краям убраны.
// Если основы разные, ячейка оставляется как есть, с предупреждением.
function parseVocabHeadword(cell: string, warnings: string[]): { headword: string; homograph: number; related: string } {
  const parts = cell.split(VARIANT_SEP)
  if (parts.length === 1) {
    const { base, homograph } = splitHomograph(cell)
    return { headword: base, homograph, related: '' }
  }
  // Пробелы и переводы строк по краям варианта убираются: ячейка может переноситься после разделителя. Внутренние сохраняются.
  const variants = parts.map(p => p.trim()).filter(p => p !== '')
  if (variants.length <= 1) {
    const { base, homograph } = splitHomograph(variants[0] ?? '')
    return { headword: base, homograph, related: '' }
  }
  const parsed = variants.map(v => splitHomograph(v))
  if (new Set(parsed.map(p => p.base)).size > 1) {
    warnings.push(`vocab: у вариантов разные основы, ячейка оставлена как есть: «${cell.replace(/\s+/g, ' ')}»`)
    return { headword: cell, homograph: 0, related: '' }
  }
  return { headword: parsed[0].base, homograph: parsed[0].homograph, related: variants.join('/') }
}

// «품사»: части через разделители, в результате через «/».
function joinPos(cell: string): string {
  return cell.split(POS_SEP).map(p => p.trim()).filter(p => p !== '').join('/')
}

// «대표형» и «관련형»: мягкий перенос U+00AD → «-», хвостовая запятая убирается.
function fixGrammarText(s: string): string {
  return nfc(s).replace(/\u00ad/g, '-').replace(/\s*,\s*$/, '').trim()
}

// «대표형»: «X1(1)» → X, омоним 1 (вложенный номер не нужен). «A(B)»: если B — окончание A (из двух слогов и больше),
// headword = A, B в начало related. Иначе B — необязательное продолжение: headword = A, в начало related A+B.
// Один слог в скобках («-기에 앞서(서)») окончанием не считается: им заканчивается почти любая основа.
function parseGrammarHeadword(raw: string): { headword: string; homograph: number; prefix: string } {
  const m = /^(.+?)\(([^()]+)\)$/.exec(raw)
  if (!m) {
    const { base, homograph } = splitHomograph(raw)
    return { headword: base, homograph, prefix: '' }
  }
  const { base, homograph } = splitHomograph(m[1])
  const paren = m[2]
  if (/^\d+$/.test(paren)) return { headword: base, homograph, prefix: '' }
  if (paren.length >= 2 && base.endsWith(paren)) return { headword: base, homograph, prefix: paren }
  return { headword: base, homograph, prefix: base + paren }
}

// Строка грамматики: headword из «대표형», related из «관련형» с префиксом из скобок (через «, », как в самом столбце).
function parseGrammarFields(row: string[], idx: { headword: number; pos: number; related: number }): { headword: string; homograph: number; related: string; pos: string } {
  const head = parseGrammarHeadword(fixGrammarText(row[idx.headword] ?? ''))
  const rel = fixGrammarText(row[idx.related] ?? '')
  const related = head.prefix && rel ? `${head.prefix}, ${rel}` : head.prefix || rel
  return { headword: head.headword, homograph: head.homograph, related, pos: nfc((row[idx.pos] ?? '').trim()) }
}

export function parseGradeList(csvText: string, kind: ItemKind): { items: Item[]; warnings: string[] } {
  const warnings: string[] = []

  // Строки с U+FFFD содержат битые байты UTF-8 (текст уже декодирован с заменой). Записи всё равно грузим.
  csvText.split('\n').forEach((line, i) => {
    if (line.includes('\ufffd')) {
      warnings.push(`${kind}: строка ${i + 1} содержит \ufffd (битые байты UTF-8): ${line.trim().slice(0, 120)}`)
    }
  })

  const rows = parse(csvText, { bom: true, skip_empty_lines: true }) as string[][]
  const [rawHeader = [], ...body] = rows
  // Заголовок приводится к NFC и без краевых пробелов: на macOS имена колонок могут прийти в NFD.
  const header = rawHeader.map(h => nfc(h).trim())
  const col = (name: string): number => {
    const i = header.indexOf(name)
    if (i < 0) throw new Error(`в списке ${kind} нет колонки «${name}»`)
    return i
  }
  const cols = COLUMNS[kind]
  const idx = {
    seq: col('전체 번호'),
    level: col('등급'),
    headword: col(cols.headword),
    pos: col(cols.pos),
    hint: col(cols.hint),
    related: cols.related ? col(cols.related) : -1,
  }
  const prefix = kind === 'vocab' ? 'v' : 'g'

  const items: Item[] = []
  for (const row of body) {
    const cell = (i: number): string => (i < 0 ? '' : nfc((row[i] ?? '').trim()))
    const seqText = cell(idx.seq)
    const levelText = cell(idx.level)
    const levelMatch = /^(\d)\s*급$/.exec(levelText)
    const level = levelMatch ? Number(levelMatch[1]) : 0
    if (!/^\d+$/.test(seqText) || level < 1 || level > 6) {
      warnings.push(`${kind}: строка пропущена (전체 번호 «${seqText}», уровень «${levelText}»)`)
      continue
    }
    const seq = Number(seqText)
    const fields = kind === 'vocab'
      ? { ...parseVocabHeadword(cell(idx.headword), warnings), pos: joinPos(cell(idx.pos)) }
      : parseGrammarFields(row, idx)
    items.push({
      id: `${prefix}:${seq}`,
      kind,
      level: level as Level,
      headword: fields.headword,
      homograph: fields.homograph,
      pos: fields.pos,
      hint: cell(idx.hint),
      related: fields.related,
      seq,
    })
  }
  return { items, warnings }
}

// Грузит оба списка в items одной транзакцией пачками. Повторный запуск обновляет строки (on conflict do update).
export async function ingestLists(
  db: Db,
  vocabCsv: string,
  grammarCsv: string,
): Promise<{ vocab: number; grammar: number; warnings: string[] }> {
  const vocab = parseGradeList(vocabCsv, 'vocab')
  const grammar = parseGradeList(grammarCsv, 'grammar')
  const all = [...vocab.items, ...grammar.items]

  await db.tx(async tx => {
    for (let start = 0; start < all.length; start += BATCH) {
      const params: unknown[] = []
      const tuples = all.slice(start, start + BATCH).map(item => {
        const values = [item.id, item.kind, item.level, item.headword, item.homograph, item.pos, item.hint, item.related, item.seq]
        const marks = values.map(v => {
          params.push(v)
          return `$${params.length}`
        })
        return `(${marks.join(', ')})`
      })
      await tx.query(
        `insert into items (id, kind, level, headword, homograph, pos, hint, related, seq)
         values ${tuples.join(', ')}
         on conflict (id) do update set
           kind = excluded.kind, level = excluded.level, headword = excluded.headword,
           homograph = excluded.homograph, pos = excluded.pos, hint = excluded.hint,
           related = excluded.related, seq = excluded.seq`,
        params,
      )
    }
  })

  return { vocab: vocab.items.length, grammar: grammar.items.length, warnings: [...vocab.warnings, ...grammar.warnings] }
}

// Находит оба CSV в папке книг и возвращает их текст. Имена сравниваются в NFC: на macOS readdir отдаёт NFD.
export async function loadListCsvs(dir: string): Promise<{ vocabCsv: string; grammarCsv: string }> {
  const names = await readdir(dir)
  const find = (suffix: string): string => {
    const name = names.find(n => nfc(n).endsWith(suffix))
    if (!name) throw new Error(`в ${dir} нет файла, оканчивающегося на «${suffix}»`)
    return path.join(dir, name)
  }
  // TextDecoder с заменой: неверные байты станут U+FFFD, и parseGradeList поднимет их в warnings.
  const decode = async (file: string): Promise<string> => new TextDecoder('utf-8').decode(await readFile(file))
  return {
    vocabCsv: await decode(find(LIST_SUFFIX.vocab)),
    grammarCsv: await decode(find(LIST_SUFFIX.grammar)),
  }
}

export async function countLists(db: Db): Promise<{ vocabAll: number; grammarAll: number; vocab14: number; grammar14: number }> {
  const [row] = await db.query<{ vocab_all: number; grammar_all: number; vocab_14: number; grammar_14: number }>(
    `select
       (select count(*)::int from items where kind = 'vocab') as vocab_all,
       (select count(*)::int from items where kind = 'grammar') as grammar_all,
       (select count(*)::int from items where kind = 'vocab' and level <= 4) as vocab_14,
       (select count(*)::int from items where kind = 'grammar' and level <= 4) as grammar_14`,
  )
  return { vocabAll: row.vocab_all, grammarAll: row.grammar_all, vocab14: row.vocab_14, grammar14: row.grammar_14 }
}
