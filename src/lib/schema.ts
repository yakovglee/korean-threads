import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Db } from './db'

// Выполняет все supabase/migrations/*.sql по порядку имён. Каждый файл идёт в своей транзакции.
// Таблицы учёта нет, поэтому миграции должны быть идемпотентны (IF NOT EXISTS).
export async function migrate(db: Db): Promise<void> {
  const dir = join(process.cwd(), 'supabase', 'migrations')
  const files = (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()
  for (const file of files) {
    const sql = await readFile(join(dir, file), 'utf8')
    await db.tx(inner => inner.query(sql))
  }
}
