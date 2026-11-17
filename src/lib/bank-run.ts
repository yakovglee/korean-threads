// Логика запуска банка и сравнения моделей: разбор флагов, генератор, подтяжка, оценка, прогон групп,
// текст ветки, отчёт и маскировка секретов. Скрипты scripts/generate-bank.ts и scripts/bake-off.ts читают .env,
// печатают и пишут файлы; всё, что можно проверить без сети, — здесь.
import type { Config } from './config'
import type { Db } from './db'
import { type BankDeps, type BankDraft, type BankResult, GEN, generateBankThread } from './generate'
import type { ModelPrice, Usage } from './llm'
import type { Check, Item, Thread } from './types'

// Оценка на одну группу: цифры из одного замера на настоящей модели. Скрипт печатает их с этой оговоркой.
export const ESTIMATE_PER_GROUP = { inputTokens: 7000, outputTokens: 2000 } as const
// Прогон останавливается после стольких неудач подряд (так ловится неработающая модель); отказ анализатора
// (неудача с fatal) останавливает прогон сразу
export const STOP_AFTER_FAILURES = 3
export const DEFAULT_THREADS = 10
export const BAKE_OFF_MODELS: readonly string[] = [
  'anthropic/claude-sonnet-5.5',
  'anthropic/claude-haiku-5.5',
  'google/gemini-3.8-flash',
  'openai/gpt-6.1-terra',
]

// ---- разбор флагов ----

export interface BankArgs { limit: number | undefined; dryRun: boolean; yes: boolean; seed: number | undefined }
export interface BakeOffArgs { threads: number; models: string[]; seed: number | undefined; yes: boolean }

export function parseBankArgs(argv: readonly string[]): BankArgs {
  const out: BankArgs = { limit: undefined, dryRun: false, yes: false, seed: undefined }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') out.dryRun = true
    else if (arg === '--yes') out.yes = true
    else if (arg === '--limit') out.limit = positiveInt(argv[++i], '--limit')
    else if (arg === '--seed') out.seed = nonNegativeInt(argv[++i], '--seed')
    else throw unknownArg(arg)
  }
  return out
}

export function parseBakeOffArgs(argv: readonly string[]): BakeOffArgs {
  const out: BakeOffArgs = { threads: DEFAULT_THREADS, models: [...BAKE_OFF_MODELS], seed: undefined, yes: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--yes') out.yes = true
    else if (arg === '--threads') out.threads = positiveInt(argv[++i], '--threads')
    else if (arg === '--seed') out.seed = nonNegativeInt(argv[++i], '--seed')
    else if (arg === '--models') out.models = modelList(argv[++i])
    else throw unknownArg(arg)
  }
  return out
}

function unknownArg(arg: string): Error {
  return new Error(`неизвестный аргумент: ${arg}`)
}

function intOf(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined
  const n = Number(raw)
  return Number.isSafeInteger(n) ? n : undefined
}

function positiveInt(raw: string | undefined, flag: string): number {
  const n = intOf(raw)
  if (n === undefined || n <= 0) throw new Error(`${flag}: нужно целое число больше нуля`)
  return n
}

function nonNegativeInt(raw: string | undefined, flag: string): number {
  const n = intOf(raw)
  if (n === undefined) throw new Error(`${flag}: нужно целое число 0 или больше`)
  return n
}

function modelList(raw: string | undefined): string[] {
  const ids = (raw ?? '').split(',').map(s => s.trim()).filter(s => s !== '')
  if (ids.length === 0) throw new Error('--models: нужен хотя бы один id модели через запятую')
  return [...new Set(ids)]
}

// ---- генератор случайных чисел и подтяжка ----

// mulberry32: одно зерно — одна последовательность, значения в [0, 1); зерно 0 тоже работает
export function seededRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// С вероятностью GEN.STRETCH_RATE — случайное слово 5–6급 (подтяжка), иначе undefined
export async function pickStretch(db: Db, rng: () => number): Promise<Item | undefined> {
  if (rng() >= GEN.STRETCH_RATE) return undefined
  const pool = await db.query<Item>(
    `select id, kind, level, headword, homograph, pos, hint, related, seq
     from items where kind = 'vocab' and level in (5, 6) order by id`,
  )
  if (pool.length === 0) return undefined
  return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))]
}

// ---- оценка ----

export interface BankEstimate { groups: number; targets: number; inputTokens: number; outputTokens: number }

export function estimateBank(groups: Item[][]): BankEstimate {
  return {
    groups: groups.length,
    targets: groups.reduce((n, g) => n + g.length, 0),
    inputTokens: groups.length * ESTIMATE_PER_GROUP.inputTokens,
    outputTokens: groups.length * ESTIMATE_PER_GROUP.outputTokens,
  }
}

// ---- прогон групп банка ----

export interface GroupResult { index: number; targets: Item[]; stretch: Item | undefined; result: BankResult }
export interface BankRun {
  processed: number
  ok: number
  failed: number
  usage: Usage
  stopped: boolean
  // тексты ошибок последних неудачных групп (до STOP_AFTER_FAILURES), без повторов
  lastErrors: string[]
}

// Группы идут по порядку; каждой группе — подтяжка от pickStretch. Ветка записывается через generateBankThread.
// После STOP_AFTER_FAILURES неудач подряд или после первой неудачи с fatal (отказ анализатора) прогон останавливается,
// оставшиеся группы не вызываются.
export async function runBank(
  db: Db,
  deps: BankDeps,
  groups: Item[][],
  opts: { rng: () => number; onResult?: (r: GroupResult) => void },
): Promise<BankRun> {
  const run: BankRun = { processed: 0, ok: 0, failed: 0, usage: zeroUsage(), stopped: false, lastErrors: [] }
  const recent: string[][] = []
  let streak = 0
  for (let index = 0; index < groups.length; index++) {
    const targets = groups[index]
    const stretch = await pickStretch(db, opts.rng)
    const result = await generateBankThread(db, deps, targets, { stretch, rng: opts.rng })
    run.processed += 1
    run.usage = sumUsage([run.usage, result.usage])
    opts.onResult?.({ index, targets, stretch, result })

    if (result.ok) {
      run.ok += 1
      streak = 0
      continue
    }
    run.failed += 1
    streak += 1
    recent.push(result.errors)
    if (recent.length > STOP_AFTER_FAILURES) recent.shift()
    if (result.fatal || streak >= STOP_AFTER_FAILURES) {
      run.stopped = true
      break
    }
  }
  run.lastErrors = [...new Set(recent.flat())]
  return run
}

// ---- текст ветки ----

// Ветка обычным текстом: посты (автор, заголовок, абзацы), затем вопросы с вариантами и отметкой верного
export function renderThread(thread: Thread, checks: Check[]): string {
  const lines: string[] = []
  thread.posts.forEach((post, i) => {
    lines.push(`--- пост ${i + 1} ---`, `Автор: ${post.author.name} (@${post.author.handle})`)
    if (post.title !== undefined) lines.push(`Заголовок: ${post.title}`)
    for (const p of post.paragraphs) lines.push(p.lang === 'ko' ? p.segments.map(s => s.text).join(' ') : p.text)
    lines.push('')
  })
  if (checks.length > 0) {
    lines.push('Вопросы:')
    checks.forEach((c, i) => {
      lines.push(`${i + 1}. ${c.stem}`)
      c.options.forEach((o, j) => lines.push(`   ${j + 1}) ${o}${j === c.answerIndex ? ' (верный)' : ''}`))
    })
  }
  return lines.join('\n').trimEnd()
}

// ---- отчёт сравнения моделей ----

export interface BakeOffCell { targets: Item[]; draft: BankDraft }
export interface BakeOffRow { model: string; price: ModelPrice; cells: BakeOffCell[] }

// Таблица по моделям: годных веток из N, токены, расход и цена за годную ветку (весь расход делим на годные).
// Ниже — по разделу на модель, в нём ветки по группам целей; ветки в блоке ```text, чтобы разметка текста не ломала вид.
// Тексты ошибок идут в отчёт через mask: в них бывают адреса и ключи (см. maskText).
export function bakeOffReport(rows: BakeOffRow[], mask: (text: string) => string): string {
  const out: string[] = [
    '# Сравнение моделей для банка',
    '',
    '| Модель | Годных веток | Входных токенов | Выходных токенов | Расход, $ | Цена за годную ветку, $ |',
    '|---|---|---|---|---|---|',
  ]
  for (const row of rows) {
    const usage = sumUsage(row.cells.map(c => c.draft.usage))
    const cost = costOf(usage, row.price)
    const good = row.cells.filter(c => c.draft.ok).length
    const perGood = good === 0 ? 'н/д' : usd(cost / good)
    out.push(`| ${row.model} | ${good} из ${row.cells.length} | ${usage.inputTokens} | ${usage.outputTokens} | ${usd(cost)} | ${perGood} |`)
  }
  for (const row of rows) {
    out.push('', `## ${row.model}`)
    row.cells.forEach((cell, i) => {
      out.push('', `### Группа ${i + 1}: ${cell.targets.map(t => t.headword).join(', ')}`, '')
      if (cell.draft.ok) out.push('```text', renderThread(cell.draft.thread, cell.draft.checks), '```')
      else out.push(`Не годна: ${mask(cell.draft.errors.join('; '))}`)
    })
  }
  return out.join('\n') + '\n'
}

// ---- секреты в выводе ----

// Значения, которые нельзя печатать: ключи, строка подключения, адреса базы и анализатора (по хосту тоже),
// имя пользователя из строки подключения к базе (как есть и раскодированное)
export function secretValues(cfg: Config): string[] {
  const list: (string | undefined)[] = [cfg.openrouterKey, cfg.analyzerSecret, cfg.databaseUrl, cfg.analyzerUrl]
  for (const url of [cfg.databaseUrl, cfg.analyzerUrl]) list.push(hostOf(url))
  list.push(...usernameOf(cfg.databaseUrl))
  return [...new Set(list.filter((s): s is string => typeof s === 'string' && s !== ''))]
}

// Длинные значения заменяются раньше коротких (строка подключения раньше своего хоста); IP-адреса тоже скрываются
export function maskText(text: string, secrets: readonly string[]): string {
  let out = text
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) {
    if (s !== '') out = out.split(s).join('[скрыто]')
  }
  return out.replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '[адрес]')
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname || undefined
  } catch {
    return undefined
  }
}

// Имя пользователя из адреса: в виде из URL (с %-кодами) и раскодированное; нет имени или адрес не разобран — пусто
function usernameOf(url: string): string[] {
  let raw: string
  try {
    raw = new URL(url).username
  } catch {
    return []
  }
  if (raw === '') return []
  try {
    return [raw, decodeURIComponent(raw)]
  } catch {
    return [raw]
  }
}

// ---- мелочи ----

function zeroUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0 }
}

function sumUsage(list: Usage[]): Usage {
  return list.reduce(
    (t, u) => ({ inputTokens: t.inputTokens + u.inputTokens, outputTokens: t.outputTokens + u.outputTokens }),
    zeroUsage(),
  )
}

function costOf(usage: Usage, price: ModelPrice): number {
  return usage.inputTokens * price.prompt + usage.outputTokens * price.completion
}

function usd(x: number): string {
  return `$${x.toFixed(4)}`
}
