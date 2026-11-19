// Обработчики HTTP-API (Task 14). Без Next: route.ts парсит запрос и вызывает handle* с Deps.
// Отказ — ApiError(status, текст по-русски). handleChat отдаёт статус объектом и не бросает.
// Роль зрителя проверяется здесь, а не в UI. Блокировки и дедупликация живут в БД: на serverless общей памяти нет.
import type { Config } from './config'
import type { Db } from './db'
import { localDayKey, pickFeed, recordDelivered, type FeedCard } from './feed'
import { generateChatThread } from './generate'
import { lookupLemma } from './ingest/glosses'
import type { LlmClient } from './llm'
import { nfc } from './ko'
import { applyEvent, getState, retrievability, saveState, type ItemState, type MemEvent } from './memory'
import { loadCheck } from './posts'
import type { Item, Level, Source, Thread } from './types'
import { pickViewerFeed } from './viewer-feed'

export const API = { CHAT_PER_MIN: 5, CHAT_PER_DAY: 100, DEDUP_MS: 5000, CHAT_LOCK_MS: 300000, CHAT_MAX_CHARS: 1000 } as const

// верхняя граница n в одном запросе ленты
const FEED_MAX_N = 50
const MINUTE_MS = 60000
const DAY_MS = 86400000
const CONFIRM_WINDOW_MS = 30 * DAY_MS
const LEARNED_DAYS = 7
const LEARNED_RETRIEVABILITY = 0.8
const CHAT_LOCK_ID = 'chat'
const ATTRIBUTION = 'Значения: 한국어기초사전, CC BY-SA 2.0 KR'
// память (item_state) только у слов 1–4급; у 5–6급 пишется лишь журнал events
const MEMORY_MAX_LEVEL = 4
// события от клиента; check_right и check_wrong пишет только handleCheckAnswer
type ClientEvent = 'tap' | 'viewed'
const EVENT_TYPES: readonly string[] = ['tap', 'viewed'] satisfies ClientEvent[]

export const TEXT = {
  forbidden: 'нет доступа',
  badFields: 'неверные поля запроса',
  noItem: 'слово не найдено',
  noCheck: 'проверка не найдена',
  emptyChat: 'сообщение пустое',
  longChat: `сообщение длиннее ${API.CHAT_MAX_CHARS} знаков`,
  busy: 'подожди ответа',
  tooOften: 'слишком часто, подожди немного',
  chatFailed: 'не получилось ответить, попробуй ещё раз',
  lemmaFailed: 'не получилось найти значение',
} as const

export interface Deps {
  db: Db
  llm: LlmClient
  cfg: Config
  now: () => number
  rng: () => number
  role: 'owner' | 'viewer'
}

// Отказ с HTTP-статусом; текст короткий, по-русски, без стека и внутренних имён
export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export interface ItemView {
  item: Item
  glossRu: string | null
  explanationRu: string | null
  examples: { ko: string; ru: string }[]
  source: 'krdict' | 'ai' | null
  sources: Source[]
  attribution: string | null
}

export type LemmaGloss = { glossRu: string | null; source: 'krdict' | 'ai' | null }
export type CheckResult = { correct: boolean; answerIndex: number }
export interface LevelProgress { level: 1 | 2 | 3 | 4; total: number; learned: number; confirmed: number }
export interface Progress { perLevel: LevelProgress[]; daysToExam: number | null }

export interface ChatOk { status: 200; thread: Thread }
export interface ChatFail { status: 400 | 403 | 409 | 429 | 502; error: string }
export type ChatOutcome = ChatOk | ChatFail

// ---- лента ----

export async function handleFeed(d: Deps, n: number): Promise<{ cards: FeedCard[] }> {
  if (!Number.isInteger(n) || n < 1 || n > FEED_MAX_N) throw new ApiError(400, TEXT.badFields)
  // всё, кроме владельца, идёт как зритель: случайные ветки банка, без записи
  if (d.role !== 'owner') return { cards: await pickViewerFeed(d.db, { n, rng: d.rng }) }
  const now = d.now()
  const cards = await pickFeed(d.db, { now, n, rng: d.rng, tz: d.cfg.tz })
  await recordDelivered(d.db, cards, now, d.cfg.tz)
  return { cards }
}

// ---- события памяти ----

interface EventInput { itemId: string; type: ClientEvent; postId?: string; checkId?: string }

// Только tap и viewed. tap по тому же itemId, если последний записанный tap был меньше DEDUP_MS назад → deduped,
// ничего не пишется. Иначе строка в events, а у слов 1–4급 ещё applyEvent и saveState.
// Одна транзакция; строка items блокируется, у 1–4급 и строка item_state.
export async function handleEvent(d: Deps, body: unknown): Promise<{ ok: true; deduped: boolean }> {
  ownerOnly(d)
  const ev = eventOf(body)
  return d.db.tx(async tx => {
    const level = await lockItem(tx, ev.itemId)
    if (level === null) throw new ApiError(404, TEXT.noItem)
    if (ev.checkId !== undefined && !(await hasCheck(tx, ev.checkId))) throw new ApiError(404, TEXT.noCheck)
    const now = d.now()
    if (ev.type === 'tap' && (await tapWithin(tx, ev.itemId, now, API.DEDUP_MS))) return { ok: true, deduped: true }
    await applyAndLog(tx, ev.itemId, level, ev.type, now, { postId: ev.postId, checkId: ev.checkId })
    return { ok: true, deduped: false }
  })
}

// ---- проверки ----

interface AnswerInput { checkId: string; choice: number }

// Верно → check_right, неверно → check_wrong для itemIds проверки (память только у 1–4급); last_answered_at = now.
// Повтор на ту же проверку в окне DEDUP_MS после её события ничего не пишет и отдаёт тот же результат.
export async function handleCheckAnswer(d: Deps, body: unknown): Promise<CheckResult> {
  ownerOnly(d)
  const ans = answerOf(body)
  return d.db.tx(async tx => {
    // строка проверки блокируется: два ответа подряд идут по очереди
    const locked = await tx.query<{ id: string }>('select id from checks where id = $1 for update', [ans.checkId])
    if (locked.length === 0) throw new ApiError(404, TEXT.noCheck)
    const check = await loadCheck(tx, ans.checkId)
    if (check === null) throw new ApiError(404, TEXT.noCheck)

    const now = d.now()
    const last = await tx.query<{ type: string; at: number }>(
      `select type, at from events
        where check_id = $1 and type in ('check_right', 'check_wrong')
        order by at desc limit 1`,
      [ans.checkId],
    )
    if (last.length > 0 && now - Number(last[0].at) < API.DEDUP_MS) {
      return { correct: last[0].type === 'check_right', answerIndex: check.answerIndex }
    }

    const correct = ans.choice === check.answerIndex
    const type: MemEvent = correct ? 'check_right' : 'check_wrong'
    // порядок блокировок фиксирован (по id), чтобы две проверки с общими словами не встали друг на друга
    for (const itemId of [...new Set(check.itemIds)].sort()) {
      const level = await lockItem(tx, itemId)
      await applyAndLog(tx, itemId, level, type, now, { checkId: ans.checkId })
    }
    await tx.query('update checks set last_answered_at = $2::bigint where id = $1', [ans.checkId, now])
    return { correct, answerIndex: check.answerIndex }
  })
}

// Тот же ответ без записи для обеих ролей. Не владелец на проверку source 'exam' получает 404.
export async function handleCheckPeek(d: Deps, body: unknown): Promise<CheckResult> {
  const ans = answerOf(body)
  const check = await loadCheck(d.db, ans.checkId)
  if (check === null || (d.role !== 'owner' && check.source === 'exam')) throw new ApiError(404, TEXT.noCheck)
  return { correct: ans.choice === check.answerIndex, answerIndex: check.answerIndex }
}

// ---- значения ----

// Слово из items; значения из item_notes. Нет строки в items → null; нет значения → glossRu null.
export async function handleItem(d: Deps, id: string): Promise<ItemView | null> {
  const rows = await d.db.query<ItemViewRow>(
    `select i.id, i.kind, i.level, i.headword, i.homograph, i.pos, i.hint, i.related, i.seq,
            n.gloss_ru, n.explanation_ru, n.examples_json, n.source, n.sources_json
       from items i
       left join item_notes n on n.item_id = i.id
      where i.id = $1`,
    [id],
  )
  const r = rows[0]
  if (!r) return null
  const glossRu = r.gloss_ru ?? null
  const source = glossRu !== null && (r.source === 'krdict' || r.source === 'ai') ? r.source : null
  return {
    item: {
      id: r.id, kind: r.kind, level: r.level, headword: r.headword, homograph: r.homograph,
      pos: r.pos, hint: r.hint, related: r.related, seq: r.seq,
    },
    glossRu,
    explanationRu: r.explanation_ru ?? null,
    examples: examplesOf(r.examples_json),
    source,
    sources: sourcesOf(r.sources_json),
    attribution: source === 'krdict' ? ATTRIBUTION : null,
  }
}

// Слово вне списков. ИИ только владельцу: зрителю при промахе отдаётся null.
// Сбой модели (или базы) → ApiError(502) с коротким текстом; сбой словаря lookupLemma гасит сам.
export async function handleLemma(d: Deps, lemma: string, pos: string): Promise<LemmaGloss> {
  if (typeof lemma !== 'string' || lemma.trim() === '' || typeof pos !== 'string') throw new ApiError(400, TEXT.badFields)
  const llm = d.role === 'owner' ? d.llm : null
  try {
    return await lookupLemma(d.db, llm, lemma.trim(), pos, d.cfg.krdictApiKey)
  } catch {
    throw new ApiError(502, TEXT.lemmaFailed)
  }
}

// ---- чат ----

// Блокировка в chat_lock, лимит по rate_limits, затем генерация. Не бросает: сбой базы в блокировке или лимитах → 502.
// Свою блокировку снимаем в finally.
export async function handleChat(d: Deps, body: unknown): Promise<ChatOutcome> {
  if (d.role !== 'owner') return { status: 403, error: TEXT.forbidden }
  const text = chatTextOf(body)
  if (text === null) return { status: 400, error: TEXT.emptyChat }
  if (Array.from(text).length > API.CHAT_MAX_CHARS) return { status: 400, error: TEXT.longChat }

  const now = d.now()
  const until = now + API.CHAT_LOCK_MS
  let locked = false
  try {
    locked = await lockChat(d.db, now, until)
    if (!locked) return { status: 409, error: TEXT.busy }
    if (await hitRateLimit(d.db, 'chat:min', MINUTE_MS, API.CHAT_PER_MIN, now)) return { status: 429, error: TEXT.tooOften }
    if (await hitRateLimit(d.db, 'chat:day', DAY_MS, API.CHAT_PER_DAY, now)) return { status: 429, error: TEXT.tooOften }
    return await askModel(d, text)
  } catch {
    // сбой базы; подробности наружу не отдаём
    return { status: 502, error: TEXT.chatFailed }
  } finally {
    // снимаем только захваченную блокировку (при 409 строка чужая); best-effort: если не вышло, её закроет until
    if (locked) await unlockChat(d.db, until).catch(() => undefined)
  }
}

// Лимит по окну: true, если счётчик окна после этого запроса больше max. Счётчик растёт атомарно (upsert).
export async function hitRateLimit(db: Db, key: string, windowMs: number, max: number, now: number): Promise<boolean> {
  const windowStart = Math.floor(now / windowMs) * windowMs
  const rows = await db.query<{ n: number }>(
    `insert into rate_limits (key, window_start, count) values ($1, $2::bigint, 1)
     on conflict (key, window_start) do update set count = rate_limits.count + 1
     returning count as n`,
    [key, windowStart],
  )
  return rows[0].n > max
}

// ---- прогресс ----

export async function handleProgress(d: Deps): Promise<Progress> {
  ownerOnly(d)
  const now = d.now()
  const totalRows = await d.db.query<{ level: number; n: number }>(
    'select level, count(*)::int as n from items where level <= 4 group by level',
  )
  const stateRows = await d.db.query<StateRow>(
    `select i.level, s.stability_days, s.last_event_at, s.is_new, s.tap_count
       from items i
       join item_state s on s.item_id = i.id
      where i.level <= 4`,
  )
  const confirmedRows = await d.db.query<{ level: number; n: number }>(
    `select i.level, count(distinct e.item_id)::int as n
       from events e
       join items i on i.id = e.item_id
      where e.type = 'check_right' and e.at >= $1::bigint and i.level <= 4
      group by i.level`,
    [now - CONFIRM_WINDOW_MS],
  )

  const total = new Map(totalRows.map(r => [r.level, r.n] as const))
  const confirmed = new Map(confirmedRows.map(r => [r.level, r.n] as const))
  const learned = new Map<number, number>()
  for (const r of stateRows) {
    const s: ItemState = {
      itemId: '',
      stabilityDays: r.stability_days,
      lastEventAt: r.last_event_at === null ? null : Number(r.last_event_at),
      isNew: r.is_new,
      tapCount: r.tap_count,
    }
    if (s.stabilityDays >= LEARNED_DAYS && retrievability(s, now) >= LEARNED_RETRIEVABILITY) {
      learned.set(r.level, (learned.get(r.level) ?? 0) + 1)
    }
  }

  const levels: (1 | 2 | 3 | 4)[] = [1, 2, 3, 4]
  return {
    perLevel: levels.map(level => ({
      level,
      total: total.get(level) ?? 0,
      learned: learned.get(level) ?? 0,
      confirmed: confirmed.get(level) ?? 0,
    })),
    daysToExam: daysUntilExam(d.cfg.examDate, now, d.cfg.tz),
  }
}

// ---- внутреннее ----

interface ItemViewRow {
  id: string
  kind: Item['kind']
  level: Level
  headword: string
  homograph: number
  pos: string
  hint: string
  related: string
  seq: number
  gloss_ru: string | null
  explanation_ru: string | null
  examples_json: unknown
  source: string | null
  sources_json: unknown
}

interface StateRow {
  level: number
  stability_days: number
  last_event_at: number | null
  is_new: boolean
  tap_count: number
}

function ownerOnly(d: Deps): void {
  if (d.role !== 'owner') throw new ApiError(403, TEXT.forbidden)
}

function objectOf(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new ApiError(400, TEXT.badFields)
  return v as Record<string, unknown>
}

function idOf(v: unknown): string {
  if (typeof v !== 'string' || v.trim() === '') throw new ApiError(400, TEXT.badFields)
  return v
}

function optionalIdOf(v: unknown): string | undefined {
  return v === undefined || v === null ? undefined : idOf(v)
}

function eventOf(v: unknown): EventInput {
  const o = objectOf(v)
  const type = o.type
  if (typeof type !== 'string' || !EVENT_TYPES.includes(type)) throw new ApiError(400, TEXT.badFields)
  return {
    itemId: idOf(o.itemId),
    type: type as ClientEvent,
    postId: optionalIdOf(o.postId),
    checkId: optionalIdOf(o.checkId),
  }
}

function answerOf(v: unknown): AnswerInput {
  const o = objectOf(v)
  const choice = o.choice
  if (typeof choice !== 'number' || !Number.isInteger(choice) || choice < 0 || choice > 3) {
    throw new ApiError(400, TEXT.badFields)
  }
  return { checkId: idOf(o.checkId), choice }
}

// Текст сообщения после NFC и trim; null — пусто или не строка. Не бросает: handleChat отдаёт статус.
function chatTextOf(v: unknown): string | null {
  const msg = typeof v === 'object' && v !== null ? (v as { message?: unknown }).message : undefined
  if (typeof msg !== 'string') return null
  const text = nfc(msg).trim()
  return text === '' ? null : text
}

// Уровень слова или null, если его нет в items. Строка items блокируется до конца транзакции: события одного слова
// идут по очереди, в том числе у 5–6급, где строки item_state нет (дедупликация касаний по events)
async function lockItem(tx: Db, id: string): Promise<number | null> {
  const rows = await tx.query<{ level: number }>('select level from items where id = $1 for update', [id])
  return rows.length > 0 ? Number(rows[0].level) : null
}

async function hasCheck(db: Db, id: string): Promise<boolean> {
  const rows = await db.query<{ id: string }>('select id from checks where id = $1', [id])
  return rows.length > 0
}

// Строка item_state создаётся, если её нет (значения как у getState), и блокируется до конца транзакции
async function lockItemState(tx: Db, itemId: string): Promise<void> {
  await tx.query(
    `insert into item_state (item_id, stability_days, last_event_at, is_new, tap_count)
     values ($1, 0, null, true, 0)
     on conflict (item_id) do nothing`,
    [itemId],
  )
  await tx.query('select item_id from item_state where item_id = $1 for update', [itemId])
}

// Был ли последний tap этого слова меньше windowMs назад (по журналу events)
async function tapWithin(tx: Db, itemId: string, now: number, windowMs: number): Promise<boolean> {
  const rows = await tx.query<{ at: number }>(
    `select at from events where item_id = $1 and type = 'tap' order by at desc limit 1`,
    [itemId],
  )
  return rows.length > 0 && now - Number(rows[0].at) < windowMs
}

// Строка в events всегда; у слов 1–4급 ещё applyEvent и saveState. У 5–6급 и у id вне items строка item_state
// не создаётся и не меняется (память только для 1–4급). Вызывается внутри транзакции.
async function applyAndLog(
  tx: Db,
  itemId: string,
  level: number | null,
  type: MemEvent,
  now: number,
  refs: { postId?: string; checkId?: string },
): Promise<void> {
  if (level !== null && level <= MEMORY_MAX_LEVEL) {
    await lockItemState(tx, itemId)
    const state = await getState(tx, itemId)
    await saveState(tx, applyEvent(state, type, now))
  }
  await tx.query(
    'insert into events (at, item_id, type, post_id, check_id) values ($1::bigint, $2, $3, $4, $5)',
    [now, itemId, type, refs.postId ?? null, refs.checkId ?? null],
  )
}

// Захват блокировки чата одним запросом: строка создаётся или перехватывается, если прежняя уже истекла
async function lockChat(db: Db, now: number, until: number): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `insert into chat_lock (id, until) values ($1, $2::bigint)
     on conflict (id) do update set until = excluded.until
     where chat_lock.until < $3::bigint
     returning id`,
    [CHAT_LOCK_ID, until, now],
  )
  return rows.length === 1
}

// Снимаем только свою блокировку: если наш until уже перехватили, строку не трогаем
async function unlockChat(db: Db, until: number): Promise<void> {
  await db.query('delete from chat_lock where id = $1 and until = $2::bigint', [CHAT_LOCK_ID, until])
}

// Модель и разбор ответа. Любой сбой (ok:false или исключение) — 502 с общим текстом.
async function askModel(d: Deps, text: string): Promise<ChatOutcome> {
  try {
    const r = await generateChatThread(d.db, { llm: d.llm, cfg: d.cfg }, text)
    return r.ok ? { status: 200, thread: r.thread } : { status: 502, error: TEXT.chatFailed }
  } catch {
    return { status: 502, error: TEXT.chatFailed }
  }
}

function daysUntilExam(examDate: string | null, now: number, tz: string): number | null {
  if (examDate === null) return null
  return Math.round((dayStart(examDate) - dayStart(localDayKey(now, tz))) / DAY_MS)
}

// Полночь UTC для даты 'YYYY-MM-DD': разница дат без сдвигов часового пояса
function dayStart(day: string): number {
  const [y, m, d] = day.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

// examples_json — массив { ko, ru }; прочее отбрасывается
function examplesOf(v: unknown): { ko: string; ru: string }[] {
  if (!Array.isArray(v)) return []
  return v.flatMap((e: unknown) => {
    if (typeof e !== 'object' || e === null) return []
    const { ko, ru } = e as { ko?: unknown; ru?: unknown }
    return typeof ko === 'string' && typeof ru === 'string' ? [{ ko, ru }] : []
  })
}

// sources_json — массив { doc, page }; прочее отбрасывается
function sourcesOf(v: unknown): Source[] {
  if (!Array.isArray(v)) return []
  return v.flatMap((s: unknown) => {
    if (typeof s !== 'object' || s === null) return []
    const { doc, page } = s as { doc?: unknown; page?: unknown }
    if (typeof doc !== 'string') return []
    if (page !== null && typeof page !== 'number') return []
    return [{ doc, page }]
  })
}
