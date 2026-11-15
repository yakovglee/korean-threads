import type { Db } from './db'
import type { Item, Level } from './types'

// Модель забывания. Время в миллисекундах; стабильность в днях.
// Касания ослабляют, верные проверки укрепляют, время ослабляет; viewed без касания — выбор плана.
export const MEMORY = { TAP_FACTOR: 0.5, MIN_DAYS: 0.5, CHECK_RIGHT_FACTOR: 2, CHECK_RIGHT_FLOOR_DAYS: 1, CHECK_WRONG_FACTOR: 0.4, UNTAPPED_BOOST: 1.15, MAX_DAYS: 180 } as const
export const LEVEL_WEIGHT: Record<Level, number> = { 1: 0.2, 2: 0.3, 3: 1, 4: 1, 5: 0, 6: 0 }

// Стартовая стабильность: 1–2급 и 3급. 1–3급 при посеве получают last_event_at = now, 4급 — null.
// 4급 стартует новым (stability 0, isNew true), 5–6급 строк нет.
export const SEED = { STABILITY_LEVEL_1_2_DAYS: 60, STABILITY_LEVEL_3_DAYS: 4 } as const

export interface ItemState { itemId: string; stabilityDays: number; lastEventAt: number | null; isNew: boolean; tapCount: number }
export type MemEvent = 'tap' | 'viewed' | 'check_right' | 'check_wrong'

const DAY_MS = 86400000

export function retrievability(s: ItemState, now: number): number {
  if (s.isNew) return 0
  if (s.stabilityDays <= 0) return 0
  if (s.lastEventAt === null) return 1
  const deltaDays = Math.max(0, now - s.lastEventAt) / DAY_MS
  return Math.exp(-deltaDays / s.stabilityDays)
}

// Возвращает новое состояние и не меняет входной объект.
export function applyEvent(s: ItemState, ev: MemEvent, now: number): ItemState {
  switch (ev) {
    case 'tap':
      return {
        ...s,
        stabilityDays: Math.max(MEMORY.MIN_DAYS, s.stabilityDays * MEMORY.TAP_FACTOR),
        isNew: false,
        tapCount: s.tapCount + 1,
        lastEventAt: now,
      }
    case 'check_right':
      return {
        ...s,
        stabilityDays: Math.min(MEMORY.MAX_DAYS, Math.max(MEMORY.CHECK_RIGHT_FLOOR_DAYS, s.stabilityDays) * MEMORY.CHECK_RIGHT_FACTOR),
        isNew: false,
        lastEventAt: now,
      }
    case 'check_wrong':
      return {
        ...s,
        stabilityDays: Math.max(MEMORY.MIN_DAYS, s.stabilityDays * MEMORY.CHECK_WRONG_FACTOR),
        isNew: false,
        lastEventAt: now,
      }
    case 'viewed':
      // Новое слово просмотром не меняется.
      if (s.isNew) return { ...s }
      return {
        ...s,
        stabilityDays: Math.min(MEMORY.MAX_DAYS, s.stabilityDays * MEMORY.UNTAPPED_BOOST),
        lastEventAt: now,
      }
  }
}

export function priority(item: Item, s: ItemState, now: number): number {
  return (1 - retrievability(s, now)) * LEVEL_WEIGHT[item.level]
}

interface StateRow { stability_days: number; last_event_at: number | null; is_new: boolean; tap_count: number }

// Создаёт строки item_state для слов 1–4급, которых ещё нет. Возвращает число созданных строк.
// Существующие строки не трогаются (on conflict do nothing).
export async function seedItemState(db: Db, now: number): Promise<number> {
  const rows = await db.query<{ item_id: string }>(
    `insert into item_state (item_id, stability_days, last_event_at, is_new, tap_count)
     select id,
            case when level <= 2 then $1::double precision when level = 3 then $2::double precision else 0 end,
            case when level <= 3 then $3::bigint else null end,
            level = 4,
            0
       from items
      where level <= 4
     on conflict (item_id) do nothing
     returning item_id`,
    [SEED.STABILITY_LEVEL_1_2_DAYS, SEED.STABILITY_LEVEL_3_DAYS, now],
  )
  return rows.length
}

// Если строки нет (5–6급 или ещё не посеяно), возвращает состояние нового слова; в базу не пишет.
export async function getState(db: Db, itemId: string): Promise<ItemState> {
  const rows = await db.query<StateRow>(
    'select stability_days, last_event_at, is_new, tap_count from item_state where item_id = $1',
    [itemId],
  )
  const row = rows[0]
  if (!row) return { itemId, stabilityDays: 0, lastEventAt: null, isNew: true, tapCount: 0 }
  return {
    itemId,
    stabilityDays: row.stability_days,
    lastEventAt: row.last_event_at === null ? null : Number(row.last_event_at),
    isNew: row.is_new,
    tapCount: row.tap_count,
  }
}

// Upsert по item_id. Колонку introduced_day не трогает.
export async function saveState(db: Db, s: ItemState): Promise<void> {
  await db.query(
    `insert into item_state (item_id, stability_days, last_event_at, is_new, tap_count)
     values ($1, $2, $3, $4, $5)
     on conflict (item_id) do update set
       stability_days = excluded.stability_days,
       last_event_at = excluded.last_event_at,
       is_new = excluded.is_new,
       tap_count = excluded.tap_count`,
    [s.itemId, s.stabilityDays, s.lastEventAt, s.isNew, s.tapCount],
  )
}
