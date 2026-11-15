// Проверка моделей OpenRouter: все id из Config.models есть в списках, у vision есть вход image; печатает цены за 1M токенов.
// Запуск из корня проекта: npx tsx scripts/check-models.ts
import { existsSync } from 'node:fs'
import { loadConfig } from '../src/lib/config'
import { checkModels } from '../src/lib/llm'

for (const f of ['.env.local', '.env']) if (existsSync(f)) process.loadEnvFile(f)

async function main(): Promise<void> {
  const result = await checkModels(loadConfig())
  for (const line of result.lines) console.log(line)
  if (result.ok) {
    console.log('все модели найдены')
    return
  }
  console.log(`проблемы с моделями: ${result.missing.join('; ')}`)
  process.exitCode = 1
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
