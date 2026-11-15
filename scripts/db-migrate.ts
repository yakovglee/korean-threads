// Применяет supabase/migrations к базе из DATABASE_URL. ПИШЕТ В НАСТОЯЩУЮ БАЗУ.
// Запускать из корня проекта: migrate ищет папку миграций от process.cwd().

import { existsSync } from 'node:fs'
import { loadConfig } from '../src/lib/config'
import { openDb } from '../src/lib/db'
import { migrate } from '../src/lib/schema'

for (const f of ['.env.local', '.env']) if (existsSync(f)) process.loadEnvFile(f)

async function main(): Promise<void> {
  const db = await openDb(loadConfig().databaseUrl)
  try {
    await migrate(db)
    const rows = await db.query<{ n: unknown }>("select count(*) as n from pg_tables where schemaname = 'public'")
    console.log(`миграции применены, таблиц в схеме public: ${rows[0]?.n ?? 0}`)
  } finally {
    await db.close()
  }
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})
