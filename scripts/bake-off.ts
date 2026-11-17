// Сравнение моделей для банка: одни и те же группы целей (planBank) и подтяжки для всех моделей, ветки через draftBankThread.
// В базу ничего не пишется. Запуск из корня проекта: npx tsx scripts/bake-off.ts [--threads N] [--models a,b,c,d] [--seed N] [--yes]
// Без --yes печатает план и выходит с кодом 1: прогон платный. Отчёт: data/review/bake-off.md.
// Ключи, адрес базы и адрес анализатора в выводе не печатаются.
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  bakeOffReport, maskText, parseBakeOffArgs, pickStretch, secretValues, seededRng,
  type BakeOffCell, type BakeOffRow,
} from '../src/lib/bank-run'
import { loadConfig } from '../src/lib/config'
import { openDb } from '../src/lib/db'
import { draftBankThread, planBank } from '../src/lib/generate'
import { modelPrices, openRouterClient, type ModelPrice } from '../src/lib/llm'
import type { Item } from '../src/lib/types'

for (const f of ['.env.local', '.env']) if (existsSync(f)) process.loadEnvFile(f)

// Значения, которые нельзя печатать: попадают в текст ошибок драйверов и клиентов
let secrets: string[] = []
const mask = (text: string): string => maskText(text, secrets)

function safeMessage(err: unknown): string {
  const text = mask(err instanceof Error ? err.message : String(err))
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? `${text} (код ${code})` : text
}

async function main(): Promise<void> {
  const args = parseBakeOffArgs(process.argv.slice(2))
  const cfg = loadConfig()
  secrets = secretValues(cfg)
  const seed = args.seed ?? Math.floor(Math.random() * 2 ** 31)
  console.log(`зерно: ${seed}`)

  const prices = await modelPrices(cfg)
  const models: { id: string; price: ModelPrice }[] = []
  for (const id of args.models) {
    const price = prices.get(id)
    if (price === undefined) console.log(`модель ${id}: нет в списке OpenRouter или без цены, пропущена`)
    else models.push({ id, price })
  }

  const db = await openDb(cfg.databaseUrl)
  try {
    const rng = seededRng(seed)
    const groups = await planBank(db, { rng, limit: args.threads })
    // подтяжка выбирается один раз на группу: все модели получают одни и те же цели
    const plan: { targets: Item[]; stretch: Item | undefined }[] = []
    for (const targets of groups) plan.push({ targets, stretch: await pickStretch(db, rng) })
    console.log(`групп: ${plan.length}; моделей с ценой: ${models.length}`)

    if (!args.yes) {
      console.log(`полный прогон платный: ${models.length} моделей × ${plan.length} веток. Запусти с --yes.`)
      process.exitCode = 1
      return
    }
    if (plan.length === 0) {
      console.log('нечего сравнивать: все цели набрали норму веток')
      return
    }
    if (models.length === 0) {
      console.log('ни одной модели с ценой: сравнивать нечего')
      process.exitCode = 1
      return
    }

    const rows: BakeOffRow[] = []
    for (const m of models) {
      // модель подменяется только в клиенте; анализатор и секреты берутся из общего cfg
      const llm = openRouterClient({ ...cfg, models: { ...cfg.models, write: m.id } })
      const cells: BakeOffCell[] = []
      for (let i = 0; i < plan.length; i++) {
        const { targets, stretch } = plan[i]
        const draft = await draftBankThread(db, { llm, cfg }, targets, { stretch, rng: seededRng(seed + i) })
        cells.push({ targets, draft })
        const verdict = draft.ok ? 'годна' : mask(`не годна: ${draft.errors.join('; ')}`)
        console.log(`${m.id}, группа ${i + 1}: ${verdict}`)
      }
      rows.push({ model: m.id, price: m.price, cells })
    }

    const file = path.join(process.cwd(), 'data', 'review', 'bake-off.md')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, bakeOffReport(rows, mask), 'utf8')
    console.log(`отчёт записан: ${file}`)
  } finally {
    await db.close()
  }
}

main().catch(err => {
  console.error(`ошибка: ${safeMessage(err)}`)
  process.exitCode = 1
})
