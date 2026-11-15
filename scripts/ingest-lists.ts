// Загрузка списков 어휘/문법 등급 목록 (1–6급) из папки книг в таблицу items и стартовое состояние памяти (item_state) для 1–4급.
// Запуск из корня проекта: npx tsx scripts/ingest-lists.ts
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { loadConfig } from '../src/lib/config'
import { openDb } from '../src/lib/db'
import { countLists, ingestLists, loadListCsvs } from '../src/lib/ingest/lists'
import { seedItemState } from '../src/lib/memory'

for (const f of ['.env.local', '.env']) if (existsSync(f)) process.loadEnvFile(f)

async function main(): Promise<void> {
  const booksDir = process.env.KB_SOURCE_DIR || path.resolve(process.cwd(), '../books')
  const { vocabCsv, grammarCsv } = await loadListCsvs(booksDir)

  const db = await openDb(loadConfig().databaseUrl)
  try {
    const { warnings } = await ingestLists(db, vocabCsv, grammarCsv)
    const c = await countLists(db)

    const warningsFile = path.join(process.cwd(), 'data', 'ingest-warnings.json')
    await mkdir(path.dirname(warningsFile), { recursive: true })
    await writeFile(warningsFile, JSON.stringify(warnings, null, 2) + '\n', 'utf8')

    // Посев памяти идёт после записи предупреждений: если он упадёт, файл уже на диске.
    const seeded = await seedItemState(db, Date.now())

    console.log(`vocab ${c.vocab14} / grammar ${c.grammar14} (1–4급), всего ${c.vocabAll} / ${c.grammarAll}`)
    console.log(`стартовое состояние памяти: создано строк ${seeded}`)
  } finally {
    await db.close()
  }
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})
