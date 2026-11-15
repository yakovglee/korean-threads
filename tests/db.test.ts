import { describe, it, expect } from 'vitest'
import { migrate } from '../src/lib/schema'
import { openTestDb } from './helpers/testDb'

describe('слой БД', () => {
  it('migrate создаёт все таблицы и идемпотентна', async () => {
    const db = await openTestDb(); await migrate(db); await migrate(db)
    const rows = await db.query<{ tablename: string }>("select tablename from pg_tables where schemaname = 'public'")
    const names = rows.map(r => r.tablename)
    for (const t of ['items','item_notes','lemma_cache','item_state','events','threads','posts','post_items','checks','check_items','kb_docs','kb_chunks','rate_limits','chat_lock','login_attempts']) expect(names).toContain(t)
  })

  it('на каждой таблице public включён RLS и политик нет', async () => {
    const db = await openTestDb()
    const tables = await db.query<{ relname: string; relrowsecurity: boolean }>(
      "select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'"
    )
    expect(tables.length).toBeGreaterThan(0)
    for (const t of tables) expect(t.relrowsecurity, t.relname).toBe(true)
    const policies = await db.query<{ tablename: string }>("select tablename from pg_policies where schemaname = 'public'")
    expect(policies).toEqual([])
  })

  it('расширения vector и pg_trgm установлены', async () => {
    const db = await openTestDb()
    const ext = await db.query<{ extname: string }>('select extname from pg_extension')
    const names = ext.map(e => e.extname)
    expect(names).toContain('vector')
    expect(names).toContain('pg_trgm')
  })

  it('events.at (мс) возвращается числом', async () => {
    const db = await openTestDb()
    await db.query('insert into events (at, item_id, type) values ($1, $2, $3)', [1763190000000, 'v:1', 'tap'])
    const rows = await db.query<{ at: number }>('select at from events where item_id = $1', ['v:1'])
    expect(typeof rows[0]?.at).toBe('number')
    expect(rows[0]?.at).toBe(1763190000000)
  })

  it('jsonb-колонка возвращается объектом', async () => {
    const db = await openTestDb()
    const body = { stem: '다음 글을 읽으십시오', options: ['가', '나'] }
    await db.query('insert into checks (id, source, body_json, created_at) values ($1, $2, $3::jsonb, $4)', ['c-json-1', 'exam', JSON.stringify(body), 1763190000000])
    const rows = await db.query<{ body_json: unknown }>('select body_json from checks where id = $1', ['c-json-1'])
    expect(typeof rows[0]?.body_json).toBe('object')
    expect(rows[0]?.body_json).toEqual(body)
  })

  it('item_state: значения по умолчанию', async () => {
    const db = await openTestDb()
    await db.query('insert into item_state (item_id) values ($1)', ['v:1'])
    const rows = await db.query<{ stability_days: number; is_new: boolean; tap_count: number; last_event_at: number | null }>(
      'select stability_days, is_new, tap_count, last_event_at from item_state where item_id = $1', ['v:1'])
    expect(rows[0]?.stability_days).toBe(0)
    expect(rows[0]?.is_new).toBe(true)
    expect(rows[0]?.tap_count).toBe(0)
    expect(rows[0]?.last_event_at).toBeNull()
  })

  it('items: значения по умолчанию', async () => {
    const db = await openTestDb()
    await db.query('insert into items (id, kind, level, headword) values ($1, $2, $3, $4)', ['v:1', 'vocab', 1, '가게'])
    const rows = await db.query<{ homograph: number; pos: string; hint: string; related: string; seq: number }>(
      'select homograph, pos, hint, related, seq from items where id = $1', ['v:1'])
    expect(rows[0]).toEqual({ homograph: 0, pos: '', hint: '', related: '', seq: 0 })
  })

  it('items: kind вне списка и level вне 1–6 отклоняются', async () => {
    const db = await openTestDb()
    await expect(db.query('insert into items (id, kind, level, headword) values ($1, $2, $3, $4)', ['v:2', 'x', 1, '가'])).rejects.toThrow()
    await expect(db.query('insert into items (id, kind, level, headword) values ($1, $2, $3, $4)', ['v:3', 'vocab', 7, '나'])).rejects.toThrow()
  })

  it('events: вставка без at отклоняется', async () => {
    const db = await openTestDb()
    await expect(db.query('insert into events (item_id, type) values ($1, $2)', ['v:1', 'tap'])).rejects.toThrow()
  })

  it('tx откатывается при исключении внутри', async () => {
    const db = await openTestDb()
    await expect(db.tx(async tx => {
      await tx.query('insert into threads (id, origin, created_at) values ($1, $2, $3)', ['t-rb', 'bank', 1763190000000])
      throw new Error('boom')
    })).rejects.toThrow('boom')
    const rows = await db.query<{ id: string }>('select id from threads where id = $1', ['t-rb'])
    expect(rows).toEqual([])
  })

  it('вложенный tx внутри tx бросает ошибку', async () => {
    const db = await openTestDb()
    await expect(db.tx(tx => tx.tx(async () => 1))).rejects.toThrow('вложенные tx не поддерживаются')
  })
})
