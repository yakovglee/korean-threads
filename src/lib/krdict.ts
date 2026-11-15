// Клиент открытого API словаря 한국어기초사전: точный поиск по заглавному слову, выбор значения, русские переводы.
// Ключ уходит только в query-параметре key и вырезается из текстов ошибок; адрес запроса в ошибки не попадает.
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { nfc } from './ko'

const ENDPOINT = 'https://krdict.korean.go.kr/api/search'
const TIMEOUT_MS = 20000
const RUSSIAN_LANG = '10'
const REDACTED = '[ключ скрыт]'
const GLOSS_LIMIT = 3
const COMBINED_LIMIT = 4

export interface DictEntry {
  targetCode: string
  headword: string
  supNo: number
  pos: string
  senses: { order: number; definitionKo: string; definitionRu: string | null; translationRu: string | null }[]
}

export class KrdictError extends Error {
  code: string | undefined

  constructor(message: string, code?: string) {
    super(message)
    this.name = 'KrdictError'
    this.code = code
  }
}

type Raw = Record<string, unknown>

// item, sense и translation бывают по одному и несколько: всегда массивы; значения остаются строками
const parser = new XMLParser({
  ignoreAttributes: true,
  ignoreDeclaration: true,
  parseTagValue: false,
  trimValues: true,
  isArray: name => name === 'item' || name === 'sense' || name === 'translation',
})

export async function fetchKrdictEntries(headword: string, apiKey: string, fetchImpl?: typeof fetch): Promise<DictEntry[]> {
  const doFetch = fetchImpl ?? fetch
  const url = new URL(ENDPOINT)
  const params: Record<string, string> = {
    key: apiKey,
    // API ищет без дефисов по краям; сами дефисы значимы и проверяются в pickEntry
    q: headword.trim().replace(/^-+|-+$/g, ''),
    translated: 'y',
    trans_lang: RUSSIAN_LANG,
    advanced: 'y',
    method: 'exact',
    num: '100',
  }
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)

  const text = await getText(doFetch, url.toString())
  return parseEntries(text, apiKey)
}

// Один GET с тайм-аутом на весь запрос, включая чтение тела
async function getText(doFetch: typeof fetch, url: string): Promise<string> {
  const signal = AbortSignal.timeout(TIMEOUT_MS)
  let res: Response
  let text: string
  try {
    res = await doFetch(url, { signal })
    text = await res.text()
  } catch {
    // текст исходной ошибки не используем: он может содержать адрес запроса с ключом
    if (signal.aborted) throw new KrdictError(`словарь не ответил за ${TIMEOUT_MS / 1000} с`)
    throw new KrdictError('сеть недоступна')
  }
  if (!res.ok) throw new KrdictError(`словарь ответил HTTP ${res.status}`, `HTTP ${res.status}`)
  return text
}

function parseEntries(text: string, apiKey: string): DictEntry[] {
  if (XMLValidator.validate(text) !== true) throw new KrdictError('ответ словаря не XML')
  const doc = parser.parse(text) as Raw
  if ('error' in doc) {
    const err = obj(doc.error)
    const code = str(err.error_code)
    const detail = redact(str(err.message), apiKey)
    throw new KrdictError(`словарь вернул ошибку${code ? ` ${code}` : ''}${detail ? `: ${detail}` : ''}`, code || undefined)
  }
  if (!('channel' in doc)) throw new KrdictError('ответ словаря без channel')
  return list(obj(doc.channel).item).map(item => toEntry(obj(item)))
}

function toEntry(item: Raw): DictEntry {
  return {
    targetCode: str(item.target_code),
    headword: str(item.word),
    supNo: num(item.sup_no),
    pos: str(item.pos),
    senses: list(item.sense).map(sense => toSense(obj(sense))),
  }
}

function toSense(sense: Raw): DictEntry['senses'][number] {
  const translation = obj(list(sense.translation)[0])
  return {
    order: num(sense.sense_order),
    definitionKo: str(sense.definition),
    definitionRu: orNull(str(translation.trans_dfn)),
    translationRu: orNull(str(translation.trans_word)),
  }
}

// Запись для слова: точный headword (дефисы значимы) и ровно одна запись с подходящей частью речи; иначе null.
// Номер омонима не используется: в списках он другой, чем в словаре. Одна запись с чужой частью речи тоже null.
export function pickEntry(entries: DictEntry[], item: { headword: string; pos: string }): DictEntry | null {
  const head = nfc(item.headword.trim())
  // часть речи в списке может быть составной («명사/부사»); части сравниваем целиком, а не подстрокой:
  // «명사» есть в «의존명사» как подстрока, но это другая часть речи
  const wanted = item.pos.split('/').map(posKey).filter(p => p !== '')
  const byPos = entries.filter(e => nfc(e.headword) === head && wanted.includes(posKey(e.pos)))
  return byPos.length === 1 ? byPos[0] : null
}

// Кандидаты для выбора по подсказке: записи с точно таким заглавным словом (дефисы значимы); если среди них есть
// подходящие по части речи, только они. Порядок по supNo. Номер омонима здесь не используется: в списках он другой.
export function candidateEntries(entries: DictEntry[], item: { headword: string; pos: string }): DictEntry[] {
  const head = nfc(item.headword.trim())
  const same = entries.filter(e => nfc(e.headword) === head)
  const wanted = item.pos.split('/').map(posKey).filter(p => p !== '')
  const byPos = same.filter(e => wanted.includes(posKey(e.pos)))
  const chosen = byPos.length > 0 ? byPos : same
  return chosen.sort((a, b) => a.supNo - b.supNo)
}

// Часть речи без пробелов и точек: «의존 명사» и «의존명사» совпадают
function posKey(s: string): string {
  return nfc(s).replace(/[\s.]/g, '')
}

// Русский перевод: слова значений без повторов (три первых различных); если слов нет ни у одного значения, определение первого значения без точки
export function glossFromEntry(entry: DictEntry): { glossRu: string | null; explanationRu: string | null } {
  const translations = entry.senses.map(s => s.translationRu).filter((t): t is string => t !== null)
  const words = [...new Set(translations)].slice(0, GLOSS_LIMIT)
  const explanationRu = entry.senses[0]?.definitionRu ?? null
  if (words.length > 0) return { glossRu: words.join(' · '), explanationRu }
  return { glossRu: explanationRu === null ? null : orNull(explanationRu.replace(/\.$/, '')), explanationRu }
}

// Русский текст слова из нескольких записей: записи по порядку supNo, не больше четырёх пунктов.
// От каждой берётся перевод первого значения; нет слова-перевода — русское толкование без точки в конце;
// запись без русского текста пропускается. Одна запись → её текст; несколько → «1) … 2) …»; текста нет → null.
export function combinedGloss(entries: DictEntry[]): string | null {
  const texts = [...entries]
    .sort((a, b) => a.supNo - b.supNo)
    .map(entryGlossText)
    .filter((t): t is string => t !== null)
    .slice(0, COMBINED_LIMIT)
  if (texts.length === 0) return null
  if (texts.length === 1) return texts[0]
  return texts.map((t, i) => `${i + 1}) ${t}`).join(' ')
}

function entryGlossText(entry: DictEntry): string | null {
  const first = entry.senses[0]
  if (!first) return null
  if (first.translationRu !== null) return first.translationRu
  return first.definitionRu === null ? null : orNull(first.definitionRu.replace(/\.$/, ''))
}

// Текст ошибки не должен содержать ключ, даже если словарь его вернул
function redact(text: string, apiKey: string): string {
  return apiKey === '' ? text : text.split(apiKey).join(REDACTED)
}

function obj(v: unknown): Raw {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Raw) : {}
}

// Только объекты: пустой элемент (строка '') и отсутствующий элемент (undefined) отбрасываются
function list(v: unknown): Raw[] {
  return (Array.isArray(v) ? v : [v]).filter((x): x is Raw => typeof x === 'object' && x !== null)
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function num(v: unknown): number {
  const n = Number(str(v))
  return Number.isFinite(n) ? n : 0
}

function orNull(s: string): string | null {
  return s === '' ? null : s
}
