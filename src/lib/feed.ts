// Выбор карточек ленты владельца (Task 13, TECH.md пункт 3). Все функции async и принимают Db.
// Ветки любого origin. Оценка ветки = сумма priority её слов и конструкций 1–4급 (каждое считается один раз).
import type { Db } from './db'
import { priority, type ItemState } from './memory'
import { loadCheck, loadThread } from './posts'
import type { Check, Item, Level, Thread } from './types'

export const FEED = { NEW_PER_DAY: 6, CHECK_EVERY: 12, STRETCH_RATE: 0.12, RECENT_DAYS: 7, CHECK_COOLDOWN_DAYS: 3, EXAM_BOOST: 1.5 } as const

export type FeedCard = { type: 'thread'; thread: Thread } | { type: 'check'; check: Check }

const DAY_MS = 86400000
// Нижняя граница веса в выборке: ветка с нулевой оценкой (всё выучено) тоже может выпасть
const MIN_WEIGHT = 1e-6

// Локальный день 'YYYY-MM-DD' в часовом поясе tz
export function localDayKey(ts: number, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(ts))
  const get = (type: string): string => parts.find(p => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

// Выбор n веток с проверками между ними. Порядок: (1) взвешенная выборка из топ-3n свежих с лимитом новых
// и слотами stretch; (2) показанные раньше всех с лимитом; (3) остальные без лимита, с наименьшим числом новых.
export async function pickFeed(
  db: Db,
  opts: { now: number; n: number; rng: () => number; tz: string },
): Promise<FeedCard[]> {
  const { now, n, rng, tz } = opts
  if (n < 1) return []
  const cands = await loadCandidates(db, now)
  if (cands.length === 0) return []
  const introducedToday = await countIntroduced(db, localDayKey(now, tz))

  const fresh = cands.filter(c => c.shown === null || now - c.shown >= FEED.RECENT_DAYS * DAY_MS)
  const pool = [...fresh].sort(byScore).slice(0, 3 * n)
  const stretchFresh = fresh.filter(c => c.stretchItemId !== null)
  const byShown = [...cands].sort(byShownAsc)

  const picked: Cand[] = []
  const taken = new Set<string>()
  const batchNew = new Set<string>()
  const take = (c: Cand): void => {
    picked.push(c)
    taken.add(c.id)
    for (const id of c.newIds) batchNew.add(id)
  }
  // Новые слова, которых ещё нет в порции, добавят к числу введённых сегодня не больше лимита
  const fits = (c: Cand): boolean => {
    const add = c.newIds.filter(id => !batchNew.has(id)).length
    return add === 0 || introducedToday + batchNew.size + add <= FEED.NEW_PER_DAY
  }

  // (1) взвешенная выборка из пула; слот со вероятностью STRETCH_RATE отдаётся свежей ветке со stretch_item_id
  while (picked.length < n) {
    let next = rng() < FEED.STRETCH_RATE
      ? weightedPick(stretchFresh.filter(c => !taken.has(c.id) && fits(c)), rng)
      : undefined
    if (next === undefined) next = weightedPick(pool.filter(c => !taken.has(c.id) && fits(c)), rng)
    if (next === undefined) break
    take(next)
  }
  // (2) показанные раньше всех, с лимитом новых
  for (const c of byShown) {
    if (picked.length >= n) break
    if (!taken.has(c.id) && fits(c)) take(c)
  }
  // (3) оставшиеся без лимита: сначала с наименьшим числом новых слов
  if (picked.length < n) {
    const rest = byShown
      .filter(c => !taken.has(c.id))
      .sort((a, b) => a.newIds.length - b.newIds.length)
    for (const c of rest) {
      if (picked.length >= n) break
      take(c)
    }
  }

  const cards: FeedCard[] = []
  const checkIds = new Set<string>()
  const pushCheck = async (): Promise<void> => {
    const check = await pickCheck(db, { now, rng, exclude: checkIds })
    if (check === null) return
    checkIds.add(check.id)
    cards.push({ type: 'check', check })
  }
  let delivered = 0
  for (const c of picked) {
    const thread = await loadThread(db, c.id)
    if (thread === null) continue
    cards.push({ type: 'thread', thread })
    delivered++
    // после каждой CHECK_EVERY-й ветки проверка
    if (delivered % FEED.CHECK_EVERY === 0) await pushCheck()
  }
  if (cards.length === 0) return []
  // в конце — с вероятностью остатка от деления на CHECK_EVERY
  const tail = (n % FEED.CHECK_EVERY) / FEED.CHECK_EVERY
  if (tail > 0 && rng() < tail) await pushCheck()
  return cards
}

// Проверка с наибольшим суммарным приоритетом слов; не отвеченная за CHECK_COOLDOWN_DAYS.
// Приоритет exam и topik-style умножается на FEED.EXAM_BOOST. При равном итоговом приоритете exam и topik-style
// раньше post; из равных выбирается случайная (rng).
export async function pickCheck(
  db: Db,
  opts: { now: number; rng: () => number; exclude?: ReadonlySet<string> },
): Promise<Check | null> {
  const { now, rng, exclude } = opts
  const cutoff = now - FEED.CHECK_COOLDOWN_DAYS * DAY_MS
  const eligible = await db.query<{ id: string; source: Check['source'] }>(
    'select id, source from checks where last_answered_at is null or last_answered_at <= $1::bigint',
    [cutoff],
  )
  const open = eligible.filter(c => !exclude?.has(c.id))
  if (open.length === 0) return null

  const rows = await db.query<ItemRow & { check_id: string }>(
    `select c.id as check_id, ${ITEM_COLS}
       from checks c
       join check_items ci on ci.check_id = c.id
       join items i on i.id = ci.item_id
       left join item_state s on s.item_id = i.id
      where c.last_answered_at is null or c.last_answered_at <= $1::bigint`,
    [cutoff],
  )
  const sums = new Map<string, number>()
  for (const r of rows) sums.set(r.check_id, (sums.get(r.check_id) ?? 0) + wordOf(r, now).prio)

  const ranked = open
    .map(c => {
      const boost = c.source === 'exam' || c.source === 'topik-style' ? FEED.EXAM_BOOST : 1
      return { id: c.id, prio: (sums.get(c.id) ?? 0) * boost, rank: c.source === 'post' ? 1 : 0 }
    })
    .sort((a, b) => b.prio - a.prio || a.rank - b.rank)
  const top = ranked[0]
  const tied = ranked.filter(c => c.prio === top.prio && c.rank === top.rank)
  const chosen = tied[Math.min(tied.length - 1, Math.floor(rng() * tied.length))]
  return loadCheck(db, chosen.id)
}

// Одна транзакция: last_delivered_at у постов веток; introduced_day у новых слов этих веток (один раз).
export async function recordDelivered(db: Db, cards: FeedCard[], now: number, tz: string): Promise<void> {
  const threadIds = [...new Set(cards.flatMap(c => (c.type === 'thread' ? [c.thread.id] : [])))]
  if (threadIds.length === 0) return
  const day = localDayKey(now, tz)
  await db.tx(async tx => {
    for (const threadId of threadIds) {
      await tx.query('update posts set last_delivered_at = $2::bigint where thread_id = $1', [threadId, now])
      await tx.query(
        `update item_state set introduced_day = $2::text
          where is_new = true and introduced_day is null
            and item_id in (
              select pi.item_id from post_items pi join posts p on p.id = pi.post_id where p.thread_id = $1
            )`,
        [threadId, day],
      )
    }
  })
}

interface Cand {
  id: string
  shown: number | null
  stretchItemId: string | null
  score: number
  newIds: string[]
}

interface ItemRow {
  id: string
  kind: Item['kind']
  level: Level
  headword: string
  homograph: number
  pos: string
  hint: string
  related: string
  seq: number
  stability_days: number | null
  last_event_at: number | null
  is_new: boolean | null
  tap_count: number | null
  introduced_day: string | null
}

const ITEM_COLS = `i.id, i.kind, i.level, i.headword, i.homograph, i.pos, i.hint, i.related, i.seq,
  s.stability_days, s.last_event_at, s.is_new, s.tap_count, s.introduced_day`

// Приоритет слова и признак «новое» (is_new и ещё не введено). Слово без строки item_state
// считается новым для приоритета (как getState), но в лимит новых не входит.
function wordOf(r: ItemRow, now: number): { prio: number; isNew: boolean } {
  const item: Item = {
    id: r.id, kind: r.kind, level: r.level, headword: r.headword, homograph: r.homograph,
    pos: r.pos, hint: r.hint, related: r.related, seq: r.seq,
  }
  const state: ItemState = r.is_new === null
    ? { itemId: r.id, stabilityDays: 0, lastEventAt: null, isNew: true, tapCount: 0 }
    : {
        itemId: r.id,
        stabilityDays: r.stability_days ?? 0,
        lastEventAt: r.last_event_at === null ? null : Number(r.last_event_at),
        isNew: r.is_new,
        tapCount: r.tap_count ?? 0,
      }
  return { prio: priority(item, state, now), isNew: r.is_new === true && r.introduced_day === null }
}

async function loadCandidates(db: Db, now: number): Promise<Cand[]> {
  const threads = await db.query<{ id: string; shown: number | null; stretch_item_id: string | null }>(
    `select t.id, max(p.last_delivered_at) as shown, min(p.stretch_item_id) as stretch_item_id
       from threads t
       join posts p on p.thread_id = t.id
      group by t.id`,
  )
  const sums = await loadThreadSums(db, now)
  return threads.map(t => {
    const s = sums.get(t.id)
    return {
      id: t.id,
      shown: t.shown === null ? null : Number(t.shown),
      stretchItemId: t.stretch_item_id,
      score: s?.score ?? 0,
      newIds: s?.newIds ?? [],
    }
  })
}

// Оценка и новые слова по веткам. Слова 1–4급 из постов читаются одним запросом, приоритеты и признак «новое»
// уходят в SQL одним JSON-параметром; суммы по веткам считаются одним SQL-запросом.
async function loadThreadSums(db: Db, now: number): Promise<Map<string, { score: number; newIds: string[] }>> {
  const words = await db.query<ItemRow>(
    `select ${ITEM_COLS}
       from items i
       left join item_state s on s.item_id = i.id
      where i.level <= 4
        and exists (select 1 from post_items pi where pi.item_id = i.id)`,
  )
  const out = new Map<string, { score: number; newIds: string[] }>()
  if (words.length === 0) return out
  const payload = words.map(r => {
    const w = wordOf(r, now)
    return { item_id: r.id, prio: w.prio, is_new: w.isNew }
  })
  const sums = await db.query<{ thread_id: string; score: number; new_ids: string[] }>(
    `with pr as (
       select item_id, prio, is_new
         from jsonb_to_recordset($1::text::jsonb) as x(item_id text, prio double precision, is_new boolean)
     ), tw as (
       select distinct p.thread_id, pi.item_id
         from post_items pi
         join posts p on p.id = pi.post_id
         join pr on pr.item_id = pi.item_id
     )
     select tw.thread_id,
            sum(pr.prio) as score,
            coalesce(jsonb_agg(pr.item_id) filter (where pr.is_new), '[]'::jsonb) as new_ids
       from tw
       join pr on pr.item_id = tw.item_id
      group by tw.thread_id`,
    [JSON.stringify(payload)],
  )
  for (const s of sums) {
    if (!Array.isArray(s.new_ids)) {
      throw new Error(`loadThreadSums: new_ids ветки ${s.thread_id} пришёл не массивом; лимит новых слов не посчитать`)
    }
    out.set(s.thread_id, { score: Number(s.score), newIds: s.new_ids })
  }
  return out
}

async function countIntroduced(db: Db, day: string): Promise<number> {
  const rows = await db.query<{ n: number }>(
    'select cast(count(*) as int) as n from item_state where introduced_day = $1::text',
    [day],
  )
  return rows[0].n
}

// Взвешенный выбор одной ветки по оценке. rng в [0, 1); при нулевых весах — последняя.
function weightedPick(xs: Cand[], rng: () => number): Cand | undefined {
  if (xs.length === 0) return undefined
  const weights = xs.map(x => Math.max(x.score, MIN_WEIGHT))
  const total = weights.reduce((a, b) => a + b, 0)
  let r = rng() * total
  for (let i = 0; i < xs.length; i++) {
    r -= weights[i]
    if (r < 0) return xs[i]
  }
  return xs[xs.length - 1]
}

function byScore(a: Cand, b: Cand): number {
  return b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

// Раньше всех: никогда не показанные, затем давно показанные; при равенстве — по оценке
function byShownAsc(a: Cand, b: Cand): number {
  const sa = a.shown ?? -Infinity
  const sb = b.shown ?? -Infinity
  if (sa !== sb) return sa < sb ? -1 : 1
  return byScore(a, b)
}
