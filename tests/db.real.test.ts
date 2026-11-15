import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { openDb, type Db } from '../src/lib/db'

// Контракт Db на настоящем Postgres (postgres.js через openDb).
// Идёт только при TEST_DATABASE_URL. Ничего постоянного не создаёт:
// только select и временные таблицы внутри db.tx (on commit drop).
const url = process.env.TEST_DATABASE_URL ?? ''

describe.skipIf(!url)('контракт Db на настоящем Postgres', () => {
  let db: Db

  beforeAll(async () => {
    db = await openDb(url)
  })

  afterAll(async () => {
    await db?.close()
  })

  it('bigint-литерал и count(*) возвращаются number', async () => {
    const rows = await db.query<{ at: number; n: number }>(
      'select 1763190000000::bigint as at, count(*) as n from pg_namespace')
    expect(typeof rows[0]?.at).toBe('number')
    expect(rows[0]?.at).toBe(1763190000000)
    expect(typeof rows[0]?.n).toBe('number')
  })

  it('параметры number, string и boolean проходят без искажений', async () => {
    const rows = await db.query<{ n: unknown; s: unknown; b: unknown }>(
      'select $1::int8 as n, $2::text as s, $3::boolean as b', [1763190000000, '한국어', true])
    expect(rows[0]).toEqual({ n: 1763190000000, s: '한국어', b: true })
  })

  it('JSON через $n::text::jsonb: объект и массив с верным jsonb_typeof', async () => {
    const obj = { stem: '다음 글을 읽으십시오', options: ['가', '나'] }
    const arr = [{ doc: 'topik-4', page: 12 }, { doc: 'topik-4', page: 13 }]
    const sql = 'select $1::text::jsonb as v, jsonb_typeof($1::text::jsonb) as t'

    const o = await db.query<{ v: unknown; t: string }>(sql, [JSON.stringify(obj)])
    expect(o[0]?.t).toBe('object')
    expect(typeof o[0]?.v).toBe('object')
    expect(o[0]?.v).toEqual(obj)

    const a = await db.query<{ v: unknown; t: string }>(sql, [JSON.stringify(arr)])
    expect(a[0]?.t).toBe('array')
    expect(Array.isArray(a[0]?.v)).toBe(true)
    expect(a[0]?.v).toEqual(arr)
  })

  it('строки временной таблицы внутри tx читаются с теми же типами', async () => {
    const row = await db.tx(async tx => {
      await tx.query(`create temp table rt_types (
        n bigint, s text, b boolean, j jsonb
      ) on commit drop`)
      await tx.query('insert into rt_types (n, s, b, j) values ($1, $2, $3, $4::text::jsonb)',
        [1763190000000, '한국어', true, JSON.stringify({ stem: '가' })])
      const res = await tx.query<{ n: unknown; s: unknown; b: unknown; j: unknown; jt: string; cnt: unknown }>(
        'select n, s, b, j, jsonb_typeof(j) as jt, (select count(*) from rt_types) as cnt from rt_types')
      return res[0]
    })
    expect(typeof row?.n).toBe('number')
    expect(row?.n).toBe(1763190000000)
    expect(row?.s).toBe('한국어')
    expect(row?.b).toBe(true)
    expect(row?.j).toEqual({ stem: '가' })
    expect(row?.jt).toBe('object')
    expect(typeof row?.cnt).toBe('number')
    expect(row?.cnt).toBe(1)
  })

  it('исключение внутри tx доходит наружу, соединение после этого работает', async () => {
    await expect(db.tx(async tx => {
      await tx.query('create temp table rt_rb (id int) on commit drop')
      await tx.query('insert into rt_rb (id) values ($1)', [1])
      throw new Error('boom')
    })).rejects.toThrow('boom')
    const rows = await db.query<{ one: number }>('select 1 as one')
    expect(rows[0]?.one).toBe(1)
  })

  it('вложенный tx бросает «вложенные tx не поддерживаются»', async () => {
    await expect(db.tx(tx => tx.tx(async () => 1))).rejects.toThrow('вложенные tx не поддерживаются')
  })
})
