// Русские значения слов 1–4급 из словаря 한국어기초사전 (нужен KRDICT_API_KEY); --ai заполняет оставшиеся пробелы ИИ.
// Запуск из корня проекта: npx tsx scripts/ingest-glosses.ts [--limit N] [--delay мс] [--ai]
// Ключ, адрес запроса к словарю и адрес базы в выводе не печатаются.
import { existsSync } from 'node:fs'
import { loadConfig, type Config } from '../src/lib/config'
import { openDb } from '../src/lib/db'
import { fillMissingGlossesWithAi, ingestGlosses } from '../src/lib/ingest/glosses'
import { openRouterClient } from '../src/lib/llm'

for (const f of ['.env.local', '.env']) if (existsSync(f)) process.loadEnvFile(f)

// Значения, которые нельзя печатать: попадают в текст ошибок драйверов и клиентов
let secrets: string[] = []

const KEY_HELP = [
  'Не задан KRDICT_API_KEY: нужен ключ открытого API 한국어기초사전.',
  'Регистрация бесплатная, на сайте krdict.korean.go.kr (открытый API).',
  'Получи ключ, добавь в .env строку KRDICT_API_KEY=... и запусти скрипт снова.',
]

function parseArgs(argv: string[]): { limit: number | undefined; ai: boolean; delay: number } {
  let limit: number | undefined
  let ai = false
  let delay = 300
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--ai') {
      ai = true
    } else if (arg === '--limit') {
      const n = Number(argv[++i])
      if (!Number.isInteger(n) || n <= 0) throw new Error('--limit: нужно целое число больше нуля')
      limit = n
    } else if (arg === '--delay') {
      const raw = argv[++i]
      if (raw === undefined || !/^\d+$/.test(raw)) throw new Error('--delay: нужно целое число миллисекунд, 0 или больше')
      delay = Number(raw)
    } else {
      throw new Error(`неизвестный аргумент: ${arg}`)
    }
  }
  return { limit, ai, delay }
}

function share(part: number, whole: number): string {
  return whole === 0 ? 'н/д' : `${((part / whole) * 100).toFixed(1)}% (${part} из ${whole})`
}

// Текст ошибки без секретов и без адреса базы; адреса вида IP тоже скрываем
function safeMessage(err: unknown): string {
  let text = err instanceof Error ? err.message : String(err)
  for (const s of secrets) if (s) text = text.split(s).join('[скрыто]')
  text = text.replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '[адрес]')
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? `${text} (код ${code})` : text
}

function secretsOf(cfg: Config): string[] {
  const list = [cfg.krdictApiKey, cfg.openrouterKey, cfg.databaseUrl]
  try {
    if (cfg.databaseUrl) list.push(new URL(cfg.databaseUrl).hostname)
  } catch {
    // адрес базы не разобрался: скрываем только строку подключения целиком
  }
  return list.filter((s): s is string => typeof s === 'string' && s !== '')
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const cfg = loadConfig()
  secrets = secretsOf(cfg)
  if (!cfg.krdictApiKey) {
    for (const line of KEY_HELP) console.log(line)
    process.exitCode = 1
    return
  }

  const llm = openRouterClient(cfg)
  const db = await openDb(cfg.databaseUrl)
  try {
    const result = await ingestGlosses(db, {
      apiKey: cfg.krdictApiKey,
      llm,
      delayMs: args.delay,
      limit: args.limit,
      onProgress: p => {
        if (p.index % 100 === 0 || p.index === p.total) console.log(`словарь: ${p.index} из ${p.total}`)
      },
    })
    console.log(`словарь: done ${result.done}, missing ${result.missing}, skipped ${result.skipped}`)
    console.log(`выбрано ИИ по подсказке: ${result.chosenByAi}`)
    if (result.lastModelError !== undefined) console.log(`последняя ошибка модели: ${safeMessage(result.lastModelError)}`)
    console.log(`в этом запуске с русским значением: ${share(result.done, result.done + result.missing + result.skipped)}`)

    if (args.ai) {
      const filled = await fillMissingGlossesWithAi(db, llm, { limit: args.limit })
      console.log(`ИИ заполнил: ${filled}`)
    }

    const [stats] = await db.query<{ total: number; with_gloss: number }>(
      `select count(*)::int as total, count(n.gloss_ru)::int as with_gloss
         from items i
         left join item_notes n on n.item_id = i.id
        where i.kind = 'vocab' and i.level <= 4`,
    )
    console.log(`по базе, слова 1–4급 с русским значением: ${share(stats.with_gloss, stats.total)}`)
  } finally {
    await db.close()
  }
}

main().catch(err => {
  console.error(`ошибка: ${safeMessage(err)}`)
  process.exitCode = 1
})
