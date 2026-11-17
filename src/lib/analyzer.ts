// Анализатор (mecab-ko-fastapi): HTTP-клиент, разбор ответа в морфемы и сопоставление морфем со списками 1–6급.
// Адрес и секрет в тексты ошибок не попадают: сообщения фиксированные.
import type { Db } from './db'
import { compatJamo, nfc, normGrammarForm } from './ko'
import type { Item, Level, Segment } from './types'

export interface MecabToken {
  surface: string
  pos: string
  entryType: string
  expression: string
  parts: { lemma: string; pos: string }[]
}

// lemma: джамо совместимые; глагольные теги (VV VA VX VCP VCN XSV XSA) дают лемму на «다».
// alt: вторая лемма из единственной части того же pos (сервис мог ошибиться, выбирает resolveMorphs по списку)
export interface Morph {
  lemma: string
  pos: string
  alt?: string
}

export class AnalyzerError extends Error {}

type PosGroup = 'noun' | 'verb' | 'adj' | 'adv' | 'det' | 'interj' | 'num' | 'pron' | 'func' | 'skip'

const DEFAULT_TIMEOUT_MS = 30000
// у этих тегов лемма — основа плюс «다»
const VERB_TAGS = new Set(['VV', 'VA', 'VX', 'VCP', 'VCN', 'XSV', 'XSA'])
// знаки препинания: многословная конструкция через них не идёт
const BREAK_TAGS = new Set(['SF', 'SE', 'SC', 'SSO', 'SSC', 'SY'])
// разрыв в ленте морфем всего текста (см. tapeOf). Пробела нет ни в одном слове формы, поэтому цепочка с разрывом
// не совпадает ни с одним словом; тег SF — не частица и не служебная морфема, её не пропускают и с ней не сцепляют.
const BREAK: Morph = { lemma: ' ', pos: 'SF' }
const POS_GROUPS = new Map<string, PosGroup>([
  ['NNG', 'noun'], ['NNB', 'noun'], ['NNBC', 'noun'],
  ['NR', 'num'], ['NP', 'pron'],
  ['VV', 'verb'], ['VX', 'verb'], ['VA', 'adj'],
  ['MAG', 'adv'], ['MAJ', 'adv'], ['MM', 'det'], ['IC', 'interj'],
  ['JX', 'func'], ['JC', 'func'], ['EP', 'func'], ['EF', 'func'], ['EC', 'func'],
  ['ETN', 'func'], ['ETM', 'func'], ['VCP', 'func'], ['VCN', 'func'],
  ['XSV', 'func'], ['XSA', 'func'], ['XSN', 'func'], ['XPN', 'func'],
  ['NNP', 'skip'], ['SL', 'skip'], ['SH', 'skip'], ['SN', 'skip'], ['SY', 'skip'], ['SF', 'skip'],
  ['SE', 'skip'], ['SSO', 'skip'], ['SSC', 'skip'], ['SC', 'skip'], ['XR', 'skip'], ['UNKNOWN', 'skip'],
])
// части речи в списке (через «/» в поле pos) по группе морфемы
const LIST_POS = new Map<PosGroup, string[]>([
  ['noun', ['명사', '의존명사']], ['verb', ['동사']], ['adj', ['형용사']], ['adv', ['부사']],
  ['det', ['관형사']], ['interj', ['감탄사']], ['num', ['수사']], ['pron', ['대명사']],
])
// класс служебной конструкции по тегу морфемы
const CLASS_OF_HEAD = new Map<string, string>([
  ['JX', '조사'], ['JC', '조사'], ['VCP', '조사'],
  ['EP', '선어말어미'], ['EF', '종결어미'], ['EC', '연결어미'], ['ETN', '전성어미'], ['ETM', '전성어미'],
])

// Ответ сервиса: [{ word: { surface, pos, entry_type, expression, … }, parsed_expression: null | [{ lemma, pos }] }]
export async function analyze(
  text: string,
  baseUrl: string,
  fetchImpl?: typeof fetch,
  opts: { secret?: string; timeoutMs?: number } = {},
): Promise<MecabToken[]> {
  if (text.trim() === '') return []
  if (opts.secret) assertSecretTransport(baseUrl)
  const doFetch = fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.secret) headers['X-Analyzer-Secret'] = opts.secret
  const url = `${baseUrl.replace(/\/+$/, '')}/`
  const signal = AbortSignal.timeout(timeoutMs)
  const timeoutError = (): AnalyzerError => new AnalyzerError(`анализатор не ответил за ${timeoutMs / 1000} с`)

  let res: Response
  try {
    // redirect: error — при редиректе заголовок с секретом не уйдёт на новый адрес
    res = await doFetch(url, {
      method: 'POST', headers, body: JSON.stringify({ text: nfc(text) }), signal, redirect: 'error',
    })
  } catch {
    if (signal.aborted) throw timeoutError()
    throw new AnalyzerError('анализатор недоступен')
  }
  if (res.redirected || (res.status >= 300 && res.status < 400)) {
    throw new AnalyzerError('анализатор ответил редиректом: адрес изменился, запрос не повторён')
  }
  if (res.status === 404) return notFoundResult(res, signal, timeoutError)
  if (!res.ok) throw new AnalyzerError(`анализатор ответил HTTP ${res.status}`)

  let body: unknown
  try {
    body = await res.json()
  } catch {
    if (signal.aborted) throw timeoutError()
    throw new AnalyzerError('ответ анализатора не JSON')
  }
  if (!Array.isArray(body)) throw new AnalyzerError('ответ анализатора не массив')
  return body.map(toToken).filter((t): t is MecabToken => t !== null)
}

const NOT_FOUND_MESSAGE = 'анализатор: адрес не найден (404)'

// 404 с detail «Not Found» — маршрута нет (ошибка в адресе) и 404 с телом не JSON — тоже ошибка;
// любой другой 404 — пустой результат, как у неразборчивого текста
async function notFoundResult(res: Response, signal: AbortSignal, timeoutError: () => AnalyzerError): Promise<MecabToken[]> {
  let body: unknown
  try {
    body = JSON.parse(await res.text())
  } catch {
    if (signal.aborted) throw timeoutError()
    throw new AnalyzerError(NOT_FOUND_MESSAGE)
  }
  const detail = isRecord(body) ? body.detail : undefined
  if (detail === 'Not Found') throw new AnalyzerError(NOT_FOUND_MESSAGE)
  return []
}

// Секрет уходит только по https или на локальный адрес (127.0.0.1, localhost); иначе запрос не делается
function assertSecretTransport(baseUrl: string): void {
  let u: URL
  try {
    u = new URL(baseUrl)
  } catch {
    throw new AnalyzerError('адрес анализатора не разобран')
  }
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost'
  if (u.protocol !== 'https:' && !local) throw new AnalyzerError('секрет анализатора передаётся только по https')
}

// Морфемы токена. Слитная (pos с «+») раскладывается по parts. Без «+» и при одной части того же pos
// лемма строится из surface, а лемма части идёт в alt, если отличается.
export function toMorphs(token: MecabToken): Morph[] {
  const hasPlus = token.pos.includes('+')
  if (hasPlus && token.parts.length > 0) {
    return token.parts.map(p => ({ lemma: lemmaOf(p.lemma, p.pos), pos: p.pos }))
  }
  const lemma = lemmaOf(token.surface, token.pos)
  const only = !hasPlus && token.parts.length === 1 && token.parts[0].pos === token.pos ? token.parts[0] : null
  const alt = only === null ? lemma : lemmaOf(only.lemma, only.pos)
  return alt === lemma ? [{ lemma, pos: token.pos }] : [{ lemma, pos: token.pos, alt }]
}

// Сегмент с разрывами: breaks — позиции в morphs, перед которыми стоит разрыв (позиция morphs.length — после последней морфемы).
// Знак препинания в сегменте даёт разрыв на своём месте; сегмент без выравнивания — разрыв в позиции 0.
interface Parsed { text: string; morphs: Morph[]; breaks: number[] }

// Сегменты по пробелам (текст сегмента сохраняет знаки препинания); морфемы токенов раскладываются
// по сегментам последовательным сопоставлением surface. Не стыкуется — сегмент без morphs, следующие
// сегменты ищутся среди токенов заново. Исключений не бросает.
function parseSegments(text: string, tokens: MecabToken[]): Parsed[] {
  const segments = nfc(text).split(/\s+/).filter(s => s !== '')
  const surfaces = tokens.map(t => nfc(t.surface))
  let cursor = 0 // первый токен, который ещё не отдан сегментам
  let lost = false // предыдущий сегмент не стыкуется
  return segments.map(seg => {
    const span = locate(surfaces, seg, cursor, lost)
    if (span === null) {
      lost = true
      return { text: seg, morphs: [], breaks: [0] }
    }
    const [from, end] = span
    cursor = end
    lost = false
    const morphs: Morph[] = []
    const breaks: number[] = []
    for (const t of tokens.slice(from, end)) {
      if (BREAK_TAGS.has(headOf(t.pos))) breaks.push(morphs.length)
      else morphs.push(...toMorphs(t).filter(m => posGroup(m.pos) !== 'skip'))
    }
    return { text: seg, morphs, breaks }
  })
}

export function segmentText(text: string, tokens: MecabToken[]): { text: string; morphs: Morph[] }[] {
  return parseSegments(text, tokens).map(({ text, morphs }) => ({ text, morphs }))
}

export function posGroup(pos: string): PosGroup {
  if (headOf(pos).startsWith('JK')) return 'func'
  return POS_GROUPS.get(headOf(pos)) ?? 'skip'
}

// Словарь в памяти: слова по ключу headword, конструкции с формами. Строится один раз на объект db.
export interface Form { text: string; words: string[]; fromHeadword: boolean }
export interface Lexicon {
  vocab: Map<string, Item[]>
  grammar: { item: Item; forms: Form[] }[]
}

const lexicons = new WeakMap<Db, Promise<Lexicon>>()

export function loadLexicon(db: Db): Promise<Lexicon> {
  let lex = lexicons.get(db)
  if (!lex) {
    lex = db.query<ItemRow>('select id, kind, level, headword, homograph, pos, hint, related, seq from items')
      .then(rows => buildLexicon(rows.map(toItem)))
    lexicons.set(db, lex)
    // ошибка не должна оставаться в кэше: следующий вызов попробует заново
    lex.catch(() => lexicons.delete(db))
  }
  return lex
}

// Незнакомая морфема сегмента: лемма и тег для выдачи; at — индекс морфемы в morphs (по нему analyzeFull снимает её по месту конструкции)
interface Unlisted { lemma: string; pos: string; at: number }
interface Resolved { itemIds: string[]; unlisted: Unlisted[] }

// Морфемы сегмента → id найденных слов и конструкций (без повторов, по порядку) и незнакомые леммы.
// prefer — предпочитаемые id: при омонимах и конструкциях с одной формой выбирается запись из этого списка.
export async function resolveMorphs(
  db: Db,
  morphs: Morph[],
  prefer?: readonly string[],
): Promise<{ itemIds: string[]; unlisted: { lemma: string; pos: string }[] }> {
  const r = await resolveIndexed(db, morphs, prefer)
  return { itemIds: r.itemIds, unlisted: r.unlisted.map(({ lemma, pos }) => ({ lemma, pos })) }
}

// То же, что resolveMorphs, но у незнакомых морфем сохраняется индекс
async function resolveIndexed(db: Db, morphs: Morph[], prefer: readonly string[] = []): Promise<Resolved> {
  const lex = await loadLexicon(db)
  const itemIds: string[] = []
  const unlisted: Unlisted[] = []
  const add = (id: string): void => {
    if (!itemIds.includes(id)) itemIds.push(id)
  }
  for (let i = 0; i < morphs.length; i++) {
    const m = morphs[i]
    const group = posGroup(m.pos)
    if (group === 'skip') continue
    if (group === 'func') {
      const hit = bestGrammar(lex, m, prefer)
      if (hit) add(hit.id)
      continue
    }
    // существительное + XSV/XSA: сначала слитное слово (공부하다), оно заменяет оба токена
    const next = morphs[i + 1]
    if (group === 'noun' && next !== undefined && (headOf(next.pos) === 'XSV' || headOf(next.pos) === 'XSA')) {
      const compound = bestCompound(lex, m.lemma + next.lemma)
      if (compound) {
        add(compound.id)
        i++
        continue
      }
    }
    const hit = bestVocab(lex, m, group, prefer)
    if (hit) add(hit.id)
    else unlisted.push({ lemma: m.alt ?? m.lemma, pos: m.pos, at: i })
  }
  return { itemIds, unlisted }
}

export interface Span { start: number; end: number }

// Все места, где конструкция совпала с цепочкой морфем: [start, end) по индексам morphs, end не включается.
// Одно и то же место из разных форм или путей сопоставления возвращается один раз.
export function grammarSpans(item: Item, morphs: Morph[]): Span[] {
  return spansOfForms(formsOf(item), morphs, item.pos)
}

// Конструкция найдена в морфемах, если есть хотя бы одно место
export function grammarMatches(item: Item, morphs: Morph[]): boolean {
  return grammarSpans(item, morphs).length > 0
}

// Текст целиком: сегменты с id слов и конструкций и морфемы всего текста подряд, с разрывами (BREAK) на знаках
// препинания и на сегментах без выравнивания. Так их видит grammarSpans: через разрыв конструкция не совпадает.
export async function analyzeFull(
  db: Db,
  text: string,
  baseUrl: string,
  fetchImpl?: typeof fetch,
  opts: { secret?: string; timeoutMs?: number; prefer?: readonly string[] } = {},
): Promise<{ segments: Segment[]; morphs: Morph[] }> {
  const tokens = await analyze(text, baseUrl, fetchImpl, opts)
  const segs = parseSegments(text, tokens)
  const out: Resolved[] = []
  for (const seg of segs) out.push(await resolveIndexed(db, seg.morphs, opts.prefer))
  const tape = tapeOf(segs)
  await addMultiwordIds(db, tape, out)
  const segments: Segment[] = segs.map((seg, i) => ({
    text: seg.text,
    itemIds: out[i].itemIds,
    unlisted: out[i].unlisted.map(({ lemma, pos }) => ({ lemma, pos })),
  }))
  return { segments, morphs: tape.morphs }
}

// Анализатор → сегменты → id слов и конструкций по каждому сегменту
export async function analyzeToSegments(
  db: Db,
  text: string,
  baseUrl: string,
  fetchImpl?: typeof fetch,
  opts: { secret?: string; timeoutMs?: number; prefer?: readonly string[] } = {},
): Promise<Segment[]> {
  return (await analyzeFull(db, text, baseUrl, fetchImpl, opts)).segments
}

// Лента морфем всего текста: морфемы сегментов подряд, на месте разрыва — BREAK. owner и inSeg — сегмент и индекс
// морфемы в нём; у BREAK оба −1.
interface Tape { morphs: Morph[]; owner: number[]; inSeg: number[] }

function tapeOf(segs: Parsed[]): Tape {
  const tape: Tape = { morphs: [], owner: [], inSeg: [] }
  const add = (m: Morph, owner: number, inSeg: number): void => {
    tape.morphs.push(m)
    tape.owner.push(owner)
    tape.inSeg.push(inSeg)
  }
  segs.forEach((seg, i) => {
    for (let j = 0; j <= seg.morphs.length; j++) {
      // разрыв в начале ленты и подряд идущие разрывы не добавляются
      const needBreak = seg.breaks.includes(j) && tape.morphs.length > 0 && tape.morphs[tape.morphs.length - 1] !== BREAK
      if (needBreak) add(BREAK, -1, -1)
      if (j < seg.morphs.length) add(seg.morphs[j], i, j)
    }
  })
  return tape
}

// Многословные конструкции (форма из двух и более слов): места ищутся по ленте морфем всего текста, место не
// переходит через разрыв. id дописывается в itemIds каждого сегмента, чьи морфемы попали в место. Однословные формы
// в этом шаге не участвуют: служебные морфемы с ними разбирает resolveIndexed.
// Порядок — по началу места, затем level и seq.
// Морфемы места, которых нет в списках, снимаются из unlisted этих сегментов; itemIds при этом не меняются.
async function addMultiwordIds(db: Db, tape: Tape, out: Resolved[]): Promise<void> {
  if (tape.morphs.length === 0) return
  const lex = await loadLexicon(db)
  const hits: { item: Item; span: Span }[] = []
  for (const { item, forms } of lex.grammar) {
    const multi = forms.filter(f => f.words.length >= 2)
    if (multi.length === 0) continue
    for (const span of spansOfForms(multi, tape.morphs, item.pos)) hits.push({ item, span })
  }
  hits.sort((a, b) => a.span.start - b.span.start || byLevelSeq(a.item, b.item))
  for (const { item, span } of hits) {
    for (const i of new Set(tape.owner.slice(span.start, span.end))) {
      if (!out[i].itemIds.includes(item.id)) out[i].itemIds.push(item.id)
    }
    for (let g = span.start; g < span.end; g++) {
      const r = out[tape.owner[g]]
      r.unlisted = r.unlisted.filter(u => u.at !== tape.inSeg[g])
    }
  }
}

// Токен с индекса cursor (при сбое — с любого индекса вперёд) начинает сегмент: [начало, конец) или null
function locate(surfaces: string[], seg: string, cursor: number, lost: boolean): [number, number] | null {
  if (!lost) {
    const end = alignAt(surfaces, cursor, seg)
    return end === null ? null : [cursor, end]
  }
  for (let from = cursor; from < surfaces.length; from++) {
    const end = alignAt(surfaces, from, seg)
    if (end !== null) return [from, end]
  }
  return null
}

// Токены, склеенные подряд с индекса from, дают ровно seg: индекс конца (не включительно) или null
function alignAt(surfaces: string[], from: number, seg: string): number | null {
  let acc = ''
  for (let j = from; j < surfaces.length; j++) {
    acc += surfaces[j]
    if (!seg.startsWith(acc)) return null
    if (acc === seg) return j + 1
  }
  return null
}

const headOf = (pos: string): string => pos.split('+')[0]

function lemmaOf(text: string, pos: string): string {
  const base = compatJamo(nfc(text))
  return VERB_TAGS.has(headOf(pos)) ? `${base}다` : base
}

const keyOf = (s: string): string => nfc(compatJamo(s))

function isFunc(m: Morph): boolean {
  return posGroup(m.pos) === 'func'
}

function isParticle(m: Morph): boolean {
  return m.pos.startsWith('J')
}

// Класс служебной морфемы: JK*, JX, JC, VCP → 조사; EP, EF, EC, ETN/ETM
function classOf(pos: string): string | null {
  const head = headOf(pos)
  if (head.startsWith('JK')) return '조사'
  return CLASS_OF_HEAD.get(head) ?? null
}

function classFits(itemPos: string, cls: string | null): boolean {
  return cls !== null && itemPos.replace(/\s+/g, '') === cls
}

// Допустимость тега морфемы для класса конструкции (жёсткое условие). Классы вне списка (표현 и др.) — без ограничения.
// Сервис путает EF и EC, поэтому 종결어미 и 연결어미 принимают оба; точный класс выбирается раньше (bestGrammar).
function classCompatible(itemPos: string, morphPos: string): boolean {
  const head = headOf(morphPos)
  switch (itemPos.replace(/\s+/g, '')) {
    case '조사': return head.startsWith('J') || head === 'VCP'
    case '선어말어미': return head === 'EP'
    case '종결어미':
    case '연결어미': return head === 'EF' || head === 'EC'
    case '전성어미': return head === 'ETN' || head === 'ETM'
    default: return true
  }
}

// Часть речи списка подходит группе морфемы; в поле pos бывает несколько через «/»
function posFits(itemPos: string, group: PosGroup): boolean {
  const names = LIST_POS.get(group) ?? []
  return itemPos.split('/').some(p => names.includes(p.replace(/\s+/g, '')))
}

function byLevelSeq(a: Item, b: Item): number {
  return a.level - b.level || a.seq - b.seq
}

function lessKey(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i]
  }
  return false
}

interface ItemRow {
  id: string
  kind: 'vocab' | 'grammar'
  level: number
  headword: string
  homograph: number
  pos: string
  hint: string
  related: string
  seq: number
}

function toItem(r: ItemRow): Item {
  return {
    id: r.id, kind: r.kind, level: r.level as Level, headword: r.headword, homograph: r.homograph,
    pos: r.pos, hint: r.hint, related: r.related, seq: r.seq,
  }
}

function buildLexicon(items: Item[]): Lexicon {
  const vocab = new Map<string, Item[]>()
  const grammar: Lexicon['grammar'] = []
  for (const item of items) {
    if (item.kind === 'vocab') {
      const key = keyOf(item.headword)
      vocab.set(key, [...(vocab.get(key) ?? []), item])
    } else {
      grammar.push({ item, forms: formsOf(item) })
    }
  }
  return { vocab, grammar }
}

// Формы конструкции: headword и варианты из related. Всё после первого «<» отбрасывается;
// разделители «,» и «.»; «A(B)» в конце записи даёт формы A и B, скобки внутри записи — необязательная вставка
// (см. expandParens).
function formsOf(item: Item): Form[] {
  const out: Form[] = []
  const seen = new Set<string>()
  const add = (raw: string, fromHeadword: boolean): void => {
    for (const variant of expandParens(raw)) {
      const text = normalizeForm(variant)
      if (text === '' || seen.has(text)) continue
      seen.add(text)
      out.push({ text, words: text.split(' '), fromHeadword })
    }
  }
  add(item.headword, true)
  for (const raw of item.related.split('<')[0].split(/[,.]/)) add(raw, false)
  return out
}

// «A(B)» в самом конце записи — две формы: A и B (에서부터(서부터) → 에서부터, 서부터).
// Скобки внутри («-(으)니까») — необязательная вставка: без скобок и со скобками.
function expandParens(s: string): string[] {
  const tail = /\(([^()]*)\)\s*$/.exec(s)
  if (tail) return [...expandParens(s.slice(0, tail.index)), ...expandParens(tail[1])]
  const m = /\(([^()]*)\)/.exec(s)
  if (!m) return [s]
  const before = s.slice(0, m.index)
  const after = s.slice(m.index + m[0].length)
  return [...expandParens(before + after), ...expandParens(before + m[1] + after)]
}

function normalizeForm(raw: string): string {
  return normGrammarForm(raw.trim()).replace(/-+$/, '').trim().split(/\s+/).filter(w => w !== '').join(' ')
}

// Гласная совместимая джамо (U+314F–U+3163) → слог с начальной ㅇ: ㅏ → 아, ㅔ → 에, ㅣ → 이.
// Код вычисляется по диапазону, литералов сочетаемых джамо в исходнике нет.
function vowelSyllable(ch: string): string | null {
  const c = ch.charCodeAt(0)
  if (c < 0x314f || c > 0x3163) return null
  // слог = 0xAC00 + (начальная × 21 + гласная) × 28 + конечная; ㅇ — начальная с номером 11, конечной нет
  return String.fromCharCode(0xac00 + (11 * 21 + (c - 0x314f)) * 28)
}

// Варианты леммы для служебной морфемы: сама лемма и, если она начинается с гласной, слог с ㅇ (ㅔ요 → 에요)
function exactVariants(lemma: string): string[] {
  const syl = vowelSyllable(lemma.charAt(0))
  return syl === null ? [lemma] : [lemma, syl + lemma.slice(1)]
}

// 0 — точное совпадение, 1 — совпадение без конечного «요», null — нет
function matchQuality(lemma: string, form: string): 0 | 1 | null {
  const exact = exactVariants(lemma)
  if (exact.includes(form)) return 0
  const noYo = exact.filter(v => v.length > 1 && v.endsWith('요')).map(v => v.slice(0, -1))
  return noYo.includes(form) ? 1 : null
}

// Служебная морфема → конструкция. Порядок: точность совпадения, id из prefer, точный класс, headword раньше related,
// level, seq. Совпадение хуже лучшего по точности prefer не выигрывает.
function bestGrammar(lex: Lexicon, m: Morph, prefer: readonly string[]): Item | null {
  const cls = classOf(m.pos)
  let best: { key: number[]; item: Item } | null = null
  for (const { item, forms } of lex.grammar) {
    if (!classCompatible(item.pos, m.pos)) continue
    const preferred = prefer.includes(item.id) ? 0 : 1
    for (const f of forms) {
      if (f.words.length !== 1) continue
      const q = matchQuality(m.lemma, f.words[0])
      if (q === null) continue
      const key = [q, preferred, classFits(item.pos, cls) ? 0 : 1, f.fromHeadword ? 0 : 1, item.level, item.seq]
      if (best === null || lessKey(key, best.key)) best = { key, item }
    }
  }
  return best?.item ?? null
}

// Содержательная морфема → слово. Кандидаты по lemma и alt. Если есть подходящие по части речи, выбор только среди них;
// затем id из prefer (при нескольких — level, seq); иначе level, seq. Слово с другим headword сюда не попадает,
// неподходящая по части речи запись из prefer не выбирается.
function bestVocab(lex: Lexicon, m: Morph, group: PosGroup, prefer: readonly string[]): Item | null {
  const keys = m.alt === undefined ? [m.lemma] : [m.lemma, m.alt]
  const seen = new Set<string>()
  const cands: Item[] = []
  for (const k of keys) {
    for (const it of lex.vocab.get(keyOf(k)) ?? []) {
      if (seen.has(it.id)) continue
      seen.add(it.id)
      cands.push(it)
    }
  }
  const fitting = cands.filter(it => posFits(it.pos, group))
  const pool = fitting.length > 0 ? fitting : cands
  const preferred = fitting.filter(it => prefer.includes(it.id))
  const pick = preferred.length > 0 ? preferred : pool
  return [...pick].sort(byLevelSeq)[0] ?? null
}

// Слитное слово «существительное + 하다» среди глаголов и прилагательных
function bestCompound(lex: Lexicon, text: string): Item | null {
  const cands = (lex.vocab.get(keyOf(text)) ?? []).filter(it => posFits(it.pos, 'verb') || posFits(it.pos, 'adj'))
  cands.sort(byLevelSeq)
  return cands[0] ?? null
}

// Основа для склейки слов: у глагольных тегов лемма без «다»
function lemmaOptions(m: Morph): { lemma: string; base: string }[] {
  const verb = VERB_TAGS.has(headOf(m.pos))
  const lemmas = m.alt === undefined ? [m.lemma] : [m.lemma, m.alt]
  return lemmas.map(lemma => ({ lemma, base: verb && lemma.endsWith('다') ? lemma.slice(0, -1) : lemma }))
}

// Слово совпадает с цепочкой морфем: «основы всех, кроме последней, + лемма последней» или «основы всех» равны слову
function chainMatchesWord(word: string, chain: Morph[]): boolean {
  if (chain.length === 1) {
    const m = chain[0]
    const func = isFunc(m)
    return lemmaOptions(m).some(o =>
      o.lemma === word || o.base === word || (func && matchQuality(o.lemma, word) !== null))
  }
  return combinations(chain.map(lemmaOptions)).some(picks => {
    const bases = picks.map(p => p.base)
    const last = picks[picks.length - 1].lemma
    return bases.slice(0, -1).join('') + last === word || bases.join('') === word
  })
}

function combinations<T>(lists: T[][]): T[][] {
  return lists.reduce<T[][]>((acc, list) => acc.flatMap(prefix => list.map(x => [...prefix, x])), [[]])
}

// Места совпадения всех форм конструкции с морфемами, без повторов, по порядку начала.
// Слова формы по порядку, каждое — цепочка из 1–3 морфем. Первое слово может начинаться с любой морфемы;
// между соседними словами можно пропустить одну частицу; однословная форма — только служебными морфемами.
// Перебираются все пути: место — [первая морфема первого слова, конец последнего слова). Для последнего слова
// берётся самая короткая подходящая цепочка («있다» + «다» EC даёт то же место, что одно «있다»).
function spansOfForms(forms: Form[], morphs: Morph[], itemPos: string): Span[] {
  const found = new Map<string, Span>()
  for (const { words } of forms) {
    const single = words.length === 1
    const walk = (wi: number, start: number, first: number): void => {
      for (let n = 1; n <= 3 && start + n <= morphs.length; n++) {
        const chain = morphs.slice(start, start + n)
        if (single && !chain.every(isFunc)) continue
        // тег последней морфемы цепочки должен подходить классу конструкции
        if (!classCompatible(itemPos, chain[chain.length - 1].pos)) continue
        if (!chainMatchesWord(words[wi], chain)) continue
        const next = start + n
        if (wi === words.length - 1) {
          found.set(`${first}:${next}`, { start: first, end: next })
          break
        }
        walk(wi + 1, next, first)
        if (next < morphs.length && isParticle(morphs[next])) walk(wi + 1, next + 1, first)
      }
    }
    for (let s = 0; s < morphs.length; s++) walk(0, s, s)
  }
  return [...found.values()].sort((a, b) => a.start - b.start || a.end - b.end)
}

// Разбор сырого токена ответа сервиса: поля проверяются, неизвестная форма — AnalyzerError
interface RawToken { word?: unknown; parsed_expression?: unknown }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

const badShape = (): AnalyzerError => new AnalyzerError('ответ анализатора: неожиданный формат токена')

// null — токен без поверхностной формы (пустой surface): в результат не попадает
function toToken(raw: unknown): MecabToken | null {
  const r: RawToken = isRecord(raw) ? raw : {}
  const word = r.word
  if (!isRecord(word)) throw badShape()
  const { surface, pos, entry_type: entryType, expression } = word
  if (typeof surface !== 'string' || typeof pos !== 'string') throw badShape()
  const parsed = r.parsed_expression
  // отсутствие поля равнозначно null: частей нет
  if (parsed !== null && parsed !== undefined && !Array.isArray(parsed)) throw badShape()
  if (surface === '') return null
  return {
    surface,
    pos,
    entryType: typeof entryType === 'string' ? entryType : '',
    expression: typeof expression === 'string' ? expression : '',
    parts: Array.isArray(parsed) ? parsed.map(toPart) : [],
  }
}

function toPart(raw: unknown): { lemma: string; pos: string } {
  const lemma = isRecord(raw) ? raw.lemma : undefined
  const pos = isRecord(raw) ? raw.pos : undefined
  if (typeof lemma !== 'string' || typeof pos !== 'string') throw badShape()
  return { lemma, pos }
}
