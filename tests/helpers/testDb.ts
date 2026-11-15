import { PGlite, type Transaction } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite-pgvector'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import type { Db } from '../../src/lib/db'
import { migrate } from '../../src/lib/schema'

// Адаптер PGlite под интерфейс Db (тот же, что у openDb).
// query без params идёт через exec и допускает несколько операторов, как простой протокол postgres.js.
function wrap(pg: PGlite | Transaction, root: boolean): Db {
  const db: Db = {
    async query<T>(text: string, params?: unknown[]): Promise<T[]> {
      if (params && params.length > 0) {
        const res = await pg.query<T>(text, params)
        return res.rows
      }
      const results = await pg.exec(text)
      return (results.at(-1)?.rows ?? []) as T[]
    },
    async tx<T>(fn: (inner: Db) => Promise<T>): Promise<T> {
      if (!root) throw new Error('вложенные tx не поддерживаются')
      return (pg as PGlite).transaction(t => fn(wrap(t, false)))
    },
    async close(): Promise<void> {
      if (!root) throw new Error('close() нельзя вызывать внутри tx')
      await (pg as PGlite).close()
    },
  }
  return db
}

// PGlite в памяти с расширениями vector и pg_trgm; схема применена через migrate.
export async function openTestDb(): Promise<Db> {
  const pg = await PGlite.create({ extensions: { vector, pg_trgm } })
  const db = wrap(pg, true)
  await migrate(db)
  return db
}
