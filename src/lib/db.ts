// Слой БД поверх postgres.js (Supavisor, transaction mode, порт 6543).
//
// Соглашение проекта:
// - В params передаются только примитивы: string, number, boolean, null.
//   Время в миллисекундах помещается в number, bigint не нужен.
// - JSON передаётся строкой с приведением ::jsonb:
//   db.query('insert into checks (id, body_json) values ($1, $2::jsonb)', [id, JSON.stringify(body)])
// - int8 (bigint) читается как number.
// - query без params идёт простым протоколом и допускает несколько операторов (миграции).
//   Результат запроса с несколькими операторами не использовать: у postgres.js и PGlite он разный.

import postgres from 'postgres'

export interface Db {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>
  close(): Promise<void>
}

export async function openDb(url: string): Promise<Db> {
  if (!url || !url.trim()) {
    throw new Error('DATABASE_URL не задан: укажи строку подключения к Postgres (пулер Supavisor, порт 6543)')
  }
  const sql = postgres(url, {
    prepare: false,
    types: {
      int8: { to: 20, from: [20], serialize: (v: number) => String(v), parse: (raw: string) => Number(raw) },
    },
  })
  return makeDb(sql, true)
}

function makeDb(sql: postgres.Sql | postgres.TransactionSql, root: boolean): Db {
  const db: Db = {
    async query<T>(text: string, params?: unknown[]): Promise<T[]> {
      const rows = params && params.length > 0
        ? await sql.unsafe(text, params as postgres.ParameterOrJSON<never>[])
        : await sql.unsafe(text)
      return Array.from(rows) as T[]
    },
    async tx<T>(fn: (inner: Db) => Promise<T>): Promise<T> {
      if (!root) throw new Error('вложенные tx не поддерживаются')
      return (sql as postgres.Sql).begin((trx) => fn(makeDb(trx, false))) as Promise<T>
    },
    async close(): Promise<void> {
      if (!root) throw new Error('close() нельзя вызывать внутри tx')
      await (sql as postgres.Sql).end()
    },
  }
  return db
}
