// Генерация банка постов: группы целей из planBank, по одной ветке на группу через generateBankThread (запись в базу).
// Запуск из корня проекта: npx tsx scripts/generate-bank.ts [--limit N] [--dry-run] [--yes] [--seed N]
// --dry-run: план и грубая оценка, модель не вызывается. Без --limit полный прогон платный и требует --yes.
// До первого платного вызова анализатор проверяется одним запросом: не отвечает — выход с кодом 1.
// После каждой группы печатается накопленный расход токенов. Отказ анализатора в прогоне останавливает его сразу.
// Ключи, адрес базы и адрес анализатора в выводе не печатаются.
import { existsSync } from 'node:fs'
import { analyze } from '../src/lib/analyzer'
import {
  ESTIMATE_PER_GROUP, estimateBank, maskText, parseBankArgs, runBank, secretValues, seededRng,
  STOP_AFTER_FAILURES, type GroupResult,
} from '../src/lib/bank-run'
import { type Config, loadConfig } from '../src/lib/config'
import { openDb } from '../src/lib/db'
import { planBank } from '../src/lib/generate'
import { openRouterClient, type Usage } from '../src/lib/llm'
import type { Item } from '../src/lib/types'

// короткий текст для проверки анализатора до прогона
const ANALYZER_PROBE = '비가 와요'

for (const f of ['.env.local', '.env']) if (existsSync(f)) process.loadEnvFile(f)

// Значения, которые нельзя печатать: попадают в текст ошибок драйверов и клиентов
let secrets: string[] = []
const mask = (text: string): string => maskText(text, secrets)

function safeMessage(err: unknown): string {
  const text = mask(err instanceof Error ? err.message : String(err))
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? `${text} (код ${code})` : text
}

function printEstimate(groups: Item[][]): void {
  const e = estimateBank(groups)
  console.log(`групп: ${e.groups}, целей: ${e.targets}`)
  console.log(
    `грубая оценка по одному замеру на настоящей модели (${ESTIMATE_PER_GROUP.inputTokens} входных и ` +
      `${ESTIMATE_PER_GROUP.outputTokens} выходных токенов на группу): вход ≈ ${e.inputTokens}, выход ≈ ${e.outputTokens}`,
  )
}

// Группа и её токены, затем расход с начала прогона (total уже включает эту группу)
function printGroup(r: GroupResult, total: Usage): void {
  const stretch = r.stretch === undefined ? '' : `; подтяжка: ${r.stretch.headword}`
  console.log(`группа ${r.index + 1}: ${r.targets.map(t => t.headword).join(', ')}${stretch}`)
  const u = r.result.usage
  const tokens = `токены: вход ${u.inputTokens}, выход ${u.outputTokens}`
  if (r.result.ok) console.log(`  ок, ветка ${r.result.threadId}; ${tokens}`)
  else console.log(`  не прошла: ${mask(r.result.errors.join('; '))}; ${tokens}`)
  console.log(`  расход с начала прогона: вход ${total.inputTokens}, выход ${total.outputTokens} токенов`)
}

// Один запрос к анализатору: текст ошибки (замаскированный) или undefined, если разбор пришёл.
// Пустой разбор проверочного текста тоже ошибка: с ним ни одна ветка не пройдёт проверку целей.
async function analyzerProblem(cfg: Config): Promise<string | undefined> {
  try {
    const tokens = await analyze(ANALYZER_PROBE, cfg.analyzerUrl, undefined, { secret: cfg.analyzerSecret })
    return tokens.length === 0 ? 'пустой разбор проверочного текста' : undefined
  } catch (err) {
    return safeMessage(err)
  }
}

async function main(): Promise<void> {
  const args = parseBankArgs(process.argv.slice(2))
  const cfg = loadConfig()
  secrets = secretValues(cfg)
  const seed = args.seed ?? Math.floor(Math.random() * 2 ** 31)
  console.log(`зерно: ${seed}`)
  const rng = seededRng(seed)

  const db = await openDb(cfg.databaseUrl)
  try {
    const groups = await planBank(db, { rng, limit: args.limit })
    printEstimate(groups)
    if (args.dryRun) return
    if (groups.length === 0) {
      console.log('нечего генерировать: все цели набрали норму веток')
      return
    }
    if (args.limit === undefined && !args.yes) {
      console.log('полный прогон платный: запусти с --limit N для пробы или с --yes для полного прогона')
      process.exitCode = 1
      return
    }

    const problem = await analyzerProblem(cfg)
    if (problem !== undefined) {
      console.error(`анализатор не работает: ${problem}. Прогон не начат, модель не вызывалась.`)
      process.exitCode = 1
      return
    }

    const llm = openRouterClient(cfg)
    // накопленный расход и признак остановки по отказу анализатора (fatal)
    const tally: { usage: Usage; fatal: boolean } = { usage: { inputTokens: 0, outputTokens: 0 }, fatal: false }
    const onResult = (r: GroupResult): void => {
      tally.usage.inputTokens += r.result.usage.inputTokens
      tally.usage.outputTokens += r.result.usage.outputTokens
      if (!r.result.ok && r.result.fatal) tally.fatal = true
      printGroup(r, tally.usage)
    }
    const run = await runBank(db, { llm, cfg }, groups, { rng, onResult })
    console.log(`итог: групп ${run.processed}, годных веток ${run.ok}, не прошло ${run.failed}`)
    console.log(`расход: вход ${run.usage.inputTokens}, выход ${run.usage.outputTokens} токенов`)
    if (run.stopped) {
      const why = tally.fatal ? 'отказ анализатора' : `${STOP_AFTER_FAILURES} неудачи подряд`
      console.log(`остановлено: ${why}; тексты последних ошибок:`)
      for (const e of run.lastErrors) console.log(`  - ${mask(e)}`)
      process.exitCode = 1
    }
  } finally {
    await db.close()
  }
}

main().catch(err => {
  console.error(`ошибка: ${safeMessage(err)}`)
  process.exitCode = 1
})
