import { it, expect } from 'vitest'
import type { Db } from '../src/lib/db'
import type { Item, Level } from '../src/lib/types'
import { retrievability, applyEvent, priority, seedItemState, getState, saveState, type ItemState } from '../src/lib/memory'
import { openTestDb } from './helpers/testDb'

const DAY = 86400000
const NOW = 1763190000000

const s = (o: Partial<ItemState> = {}): ItemState => ({ itemId: 'v:1', stabilityDays: 4, lastEventAt: 0, isNew: false, tapCount: 0, ...o })
it('retrievability', () => expect(retrievability(s(), 4 * 86400000)).toBeCloseTo(Math.exp(-1), 4))
it('retrievability нового слова = 0', () => expect(retrievability(s({ isNew: true, stabilityDays: 0 }), 0)).toBe(0))
it('tap: 4 → 2 → 1 → 0.5 → 0.5', () => { let x = s(); const seq = [] as number[]; for (let i = 0; i < 4; i++) { x = applyEvent(x, 'tap', 1); seq.push(x.stabilityDays) } expect(seq).toEqual([2, 1, 0.5, 0.5]) })
it('check_right 4 → 8, cap 180', () => { expect(applyEvent(s(), 'check_right', 1).stabilityDays).toBe(8); expect(applyEvent(s({ stabilityDays: 150 }), 'check_right', 1).stabilityDays).toBe(180) })
it('check_wrong 4 → 1.6', () => expect(applyEvent(s(), 'check_wrong', 1).stabilityDays).toBeCloseTo(1.6))
it('viewed 4 → 4.6; на новом ничего', () => { expect(applyEvent(s(), 'viewed', 1).stabilityDays).toBeCloseTo(4.6); expect(applyEvent(s({ isNew: true, stabilityDays: 0 }), 'viewed', 1).isNew).toBe(true) })
it('tap по новому слову: isNew=false, stability 0.5', () => expect(applyEvent(s({ isNew: true, stabilityDays: 0 }), 'tap', 1)).toMatchObject({ isNew: false, stabilityDays: 0.5 }))

async function insertItem(db: Db, id: string, level: number): Promise<void> {
  await db.query('insert into items (id, kind, level, headword) values ($1, $2, $3, $4)', [id, 'vocab', level, '가게'])
}

type StateRow = { item_id: string; stability_days: number; last_event_at: number | null; is_new: boolean; tap_count: number }

it('seedItemState: 1–2급 60, 3급 4, 4급 новое, 5–6급без строки', async () => {
  const db = await openTestDb()
  for (const level of [1, 2, 3, 4, 5, 6]) await insertItem(db, `v:${level}`, level)
  expect(await seedItemState(db, NOW)).toBe(4)
  const rows = await db.query<StateRow>('select item_id, stability_days, last_event_at, is_new, tap_count from item_state order by item_id')
  expect(rows).toEqual([
    { item_id: 'v:1', stability_days: 60, last_event_at: NOW, is_new: false, tap_count: 0 },
    { item_id: 'v:2', stability_days: 60, last_event_at: NOW, is_new: false, tap_count: 0 },
    { item_id: 'v:3', stability_days: 4, last_event_at: NOW, is_new: false, tap_count: 0 },
    { item_id: 'v:4', stability_days: 0, last_event_at: null, is_new: true, tap_count: 0 },
  ])
  expect(await seedItemState(db, NOW)).toBe(0)
})

it('seedItemState: повторный вызов возвращает 0 и не затирает изменённую строку', async () => {
  const db = await openTestDb()
  await insertItem(db, 'v:1', 1)
  await seedItemState(db, NOW)
  await saveState(db, { itemId: 'v:1', stabilityDays: 7, lastEventAt: NOW + DAY, isNew: false, tapCount: 3 })
  expect(await seedItemState(db, NOW + 2 * DAY)).toBe(0)
  expect(await getState(db, 'v:1')).toEqual({ itemId: 'v:1', stabilityDays: 7, lastEventAt: NOW + DAY, isNew: false, tapCount: 3 })
})

it('getState для отсутствующего id: состояние нового слова, строка не создаётся', async () => {
  const db = await openTestDb()
  expect(await getState(db, 'v:999')).toEqual({ itemId: 'v:999', stabilityDays: 0, lastEventAt: null, isNew: true, tapCount: 0 })
  const rows = await db.query<{ n: number }>('select count(*)::int as n from item_state')
  expect(rows[0]?.n).toBe(0)
})

it('saveState → getState туда-обратно; introduced_day не трогается', async () => {
  const db = await openTestDb()
  await db.query('insert into item_state (item_id, introduced_day) values ($1, $2)', ['v:1', '2026-11-01'])
  const st: ItemState = { itemId: 'v:1', stabilityDays: 2.5, lastEventAt: NOW, isNew: false, tapCount: 4 }
  await saveState(db, st)
  expect(await getState(db, 'v:1')).toEqual(st)
  const next: ItemState = { ...st, stabilityDays: 9, tapCount: 5 }
  await saveState(db, next)
  expect(await getState(db, 'v:1')).toEqual(next)
  const rows = await db.query<{ introduced_day: string | null }>('select introduced_day from item_state where item_id = $1', ['v:1'])
  expect(rows[0]?.introduced_day).toBe('2026-11-01')
})

it('priority: уровень 5 → 0; новое слово 4급 → 1', () => {
  const item5: Item = { id: 'v:5', kind: 'vocab', level: 5, headword: '가게', homograph: 0, pos: '', hint: '', related: '', seq: 0 }
  const item4: Item = { ...item5, id: 'v:4', level: 4 }
  const fresh: ItemState = { itemId: 'v:4', stabilityDays: 0, lastEventAt: null, isNew: true, tapCount: 0 }
  expect(priority(item5, s({ itemId: 'v:5' }), NOW)).toBe(0)
  expect(priority(item4, fresh, NOW)).toBe(1)
})

it('applyEvent не меняет входной объект', () => {
  const input = s({ stabilityDays: 4 })
  const copy = { ...input }
  applyEvent(input, 'tap', NOW)
  applyEvent(input, 'check_right', NOW)
  applyEvent(input, 'check_wrong', NOW)
  applyEvent(input, 'viewed', NOW)
  expect(input).toEqual(copy)
})

it('после tap lastEventAt равен now', () => {
  expect(applyEvent(s({ lastEventAt: 0 }), 'tap', NOW).lastEventAt).toBe(NOW)
})

it('retrievability: неновое слово с lastEventAt null → 1; с stabilityDays 0 → 0', () => {
  expect(retrievability(s({ lastEventAt: null }), NOW)).toBe(1)
  expect(retrievability(s({ stabilityDays: 0 }), NOW)).toBe(0)
})

it('retrievability: now раньше lastEventAt → 1 (интервал считается нулём)', () => {
  expect(retrievability(s({ lastEventAt: NOW }), NOW - DAY)).toBe(1)
})

it('check_right по новому слову → stability 2, isNew false; при stability 0.3 → 2 (пол 1 день)', () => {
  expect(applyEvent(s({ isNew: true, stabilityDays: 0 }), 'check_right', NOW)).toMatchObject({ stabilityDays: 2, isNew: false })
  expect(applyEvent(s({ stabilityDays: 0.3 }), 'check_right', NOW).stabilityDays).toBe(2)
})

it('check_wrong по новому слову → stability 0.5, isNew false; при stability 1 → 0.5 (пол)', () => {
  expect(applyEvent(s({ isNew: true, stabilityDays: 0 }), 'check_wrong', NOW)).toMatchObject({ stabilityDays: 0.5, isNew: false })
  expect(applyEvent(s({ stabilityDays: 1 }), 'check_wrong', NOW).stabilityDays).toBe(0.5)
})

it('viewed при stability 170 → 180 (потолок); viewed по новому слову равен входному по всем полям', () => {
  expect(applyEvent(s({ stabilityDays: 170 }), 'viewed', NOW).stabilityDays).toBe(180)
  const fresh = s({ isNew: true, stabilityDays: 0, lastEventAt: null, tapCount: 2 })
  expect(applyEvent(fresh, 'viewed', NOW)).toEqual(fresh)
})

it('lastEventAt равен now после check_right, check_wrong и viewed (неновое слово)', () => {
  for (const ev of ['check_right', 'check_wrong', 'viewed'] as const) {
    expect(applyEvent(s({ lastEventAt: 0 }), ev, NOW).lastEventAt, ev).toBe(NOW)
  }
})

it('priority при R = e⁻¹: уровень 1 → (1 − e⁻¹) × 0.2, уровень 2 → × 0.3, уровень 3 → × 1', () => {
  const item = (level: Level): Item => ({ id: `v:${level}`, kind: 'vocab', level, headword: '가게', homograph: 0, pos: '', hint: '', related: '', seq: 0 })
  const st = s({ stabilityDays: 4, lastEventAt: 0 })
  const base = 1 - Math.exp(-1)
  expect(priority(item(1), st, 4 * DAY)).toBeCloseTo(base * 0.2, 10)
  expect(priority(item(2), st, 4 * DAY)).toBeCloseTo(base * 0.3, 10)
  expect(priority(item(3), st, 4 * DAY)).toBeCloseTo(base * 1, 10)
})

it('saveState с lastEventAt null → getState возвращает null', async () => {
  const db = await openTestDb()
  await saveState(db, { itemId: 'v:1', stabilityDays: 0, lastEventAt: null, isNew: true, tapCount: 0 })
  expect(await getState(db, 'v:1')).toEqual({ itemId: 'v:1', stabilityDays: 0, lastEventAt: null, isNew: true, tapCount: 0 })
})

it('getState для 4급 после seedItemState: новое слово с lastEventAt null', async () => {
  const db = await openTestDb()
  await insertItem(db, 'v:4', 4)
  await seedItemState(db, NOW)
  expect(await getState(db, 'v:4')).toEqual({ itemId: 'v:4', stabilityDays: 0, lastEventAt: null, isNew: true, tapCount: 0 })
})
