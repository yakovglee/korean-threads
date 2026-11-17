// Генерация веток. Банк: цели (слова и конструкции) уходят модели, ответ проверяется по правилам постов и вопросов.
// Чат: ответ на вопрос ученика с фрагментами базы знаний, которые становятся источниками постов.
// Годная ветка сохраняется целиком. planBank выбирает цели, у которых веток банка меньше нормы.
// draftBankThread собирает ветку банка без записи; generateBankThread добавляет запись.
import { randomUUID } from 'node:crypto'
import { AnalyzerError } from './analyzer'
import type { Config } from './config'
import type { Db } from './db'
import { searchKb, type KbHit, type KbKind } from './kb/search'
import { nfc, normGrammarForm } from './ko'
import { LlmError, type LlmClient, type Usage } from './llm'
import {
  buildCheck, buildPost, POST_RULES, saveThread, validatePost,
  type AnalyzeOpts, type BuiltPost, type RawCheck, type RawPost, type RawThread,
} from './posts'
import {
  BANK_SCHEMA, BANK_SCHEMA_NAME, BANK_SYSTEM, bankUserPrompt, CHAT_SCHEMA, CHAT_SCHEMA_NAME, CHAT_SYSTEM, chatUserPrompt,
  type PromptFragment, type PromptTarget,
} from './prompts'
import type { Check, Item, Post, Source, Thread } from './types'

export const GEN = { MAX_RETRIES: 2, STRETCH_RATE: 0.12, TARGETS_PER_CALL: 3, POSTS_PER_THREAD: { min: 1, max: 4 } } as const

// потолок ответа модели: ветка из четырёх постов с вопросами у многословных моделей не помещалась в 4000 токенов
const MAX_TOKENS = 8000
// фрагменты базы знаний в подсказке банка: не больше четырёх, только грамматика и учебник
const KB_FRAGMENTS = 4
// норма веток банка на цель: 3–4급 — две, 1–2급 — одна
const NORM_HIGH = 2
const NORM_LOW = 1
// чат: до шести фрагментов по тексту сообщения, экзаменные виды не берутся
const CHAT_FRAGMENTS = 6
const CHAT_KB_KINDS: KbKind[] = ['grammar', 'textbook', 'dict', 'generated']

export interface BankDeps { llm: LlmClient; cfg: Config; role?: 'write' | 'light' | 'verify' }
export interface BankOpts { stretch?: Item; rng: () => number }
// fatal — отказ анализатора: прогон банка дальше не идёт (каждая следующая ветка упадёт так же, а вызов модели платный)
export type BankResult =
  | { ok: true; threadId: string; usage: Usage }
  | { ok: false; errors: string[]; usage: Usage; fatal?: true }
// Ветка банка до записи. extraItems — id постов → id записей для post_items (см. grammarOnlyItems)
export type BankDraft =
  | { ok: true; thread: Thread; checks: Check[]; extraItems: Record<string, string[]>; usage: Usage }
  | { ok: false; errors: string[]; usage: Usage; fatal?: true }

export interface ChatDeps { llm: LlmClient; cfg: Config }
export type ChatResult = { ok: true; thread: Thread; usage: Usage } | { ok: false; errors: string[]; usage: Usage }

// текст ошибки в повторе после обрезанного по maxTokens ответа
const TRUNCATED_RETRY = 'ответ обрезан, пиши короче'

// Одна ветка банка по целям, без записи в базу. Ответ модели проверяется; при ошибке формы или правил, невалидном JSON
// или обрезанном ответе запрос повторяется (всего до MAX_RETRIES повторов), в повтор идёт текст ошибок.
// AnalyzerError не повторяется: ok:false с её текстом и fatal. Прочие LlmError не повторяются: ok:false с их текстом.
// usage — сумма всех вызовов, включая упавшие с usage. Прочие ошибки идут наверх.
export async function draftBankThread(db: Db, deps: BankDeps, targets: Item[], opts: BankOpts): Promise<BankDraft> {
  const usage: Usage = { inputTokens: 0, outputTokens: 0 }
  try {
    const role = deps.role ?? 'write'
    const notes = await notesOf(db, opts.stretch ? [...targets, opts.stretch] : targets)
    const fragments = await fragmentsOf(db, deps.llm, targets)
    const base = {
      targets: shuffle(targets, opts.rng).map(it => promptTarget(it, notes)),
      stretch: opts.stretch ? promptTarget(opts.stretch, notes) : undefined,
      fragments,
    }

    let errors: string[] = []
    for (let attempt = 0; attempt <= GEN.MAX_RETRIES; attempt++) {
      const reply = await askJson(deps.llm, {
        role,
        system: BANK_SYSTEM,
        user: bankUserPrompt({ ...base, errors: attempt === 0 ? undefined : errors }),
        schema: BANK_SCHEMA,
        schemaName: BANK_SCHEMA_NAME,
        maxTokens: MAX_TOKENS,
      }, usage)
      if (!reply.ok) {
        errors = reply.errors
        continue
      }

      const shaped = readRawThread(reply.value)
      if (!shaped.ok) {
        errors = shaped.errors
        continue
      }
      const built = await buildPosts(db, deps.cfg, shaped.raw, 'bank', targets, opts.stretch)
      if (!built.ok) {
        errors = built.errors
        continue
      }
      // вопросы после проверки постов: негодные и без цели отбрасываются без ошибки
      const checks = await buildChecks(db, deps.cfg, shaped.raw, targets)
      const threadId = randomUUID()
      const posts: Post[] = built.built.map(b => ({ id: randomUUID(), threadId, ...b.post }))
      const thread: Thread = { id: threadId, origin: 'bank', posts }
      return { ok: true, thread, checks, extraItems: grammarOnlyItems(built.built, posts, targets), usage }
    }
    return { ok: false, errors, usage }
  } catch (e) {
    if (e instanceof AnalyzerError) return { ok: false, errors: [e.message], usage, fatal: true }
    if (e instanceof LlmError) return { ok: false, errors: [e.message], usage: withErrorUsage(usage, e) }
    throw e
  }
}

// Одна ветка банка: черновик из draftBankThread и запись в базу через saveThread (одна транзакция)
export async function generateBankThread(db: Db, deps: BankDeps, targets: Item[], opts: BankOpts): Promise<BankResult> {
  const draft = await draftBankThread(db, deps, targets, opts)
  if (!draft.ok) return draft
  await saveThread(db, draft.thread, { checks: draft.checks, extraItems: draft.extraItems })
  return { ok: true, threadId: draft.thread.id, usage: draft.usage }
}

// Ответ на вопрос ученика: до CHAT_FRAGMENTS фрагментов по тексту сообщения (без экзаменов), модель пишет тред,
// посты проверяются в режиме chat. Источники поста — doc и page тех фрагментов, на которые он опирается (поле fragments,
// номера с 1), без повторов; пустой итог — без поля sources. Повторы, usage и ошибки — как в банке, но без fatal.
// Абзацы на русском и правила банка (уровень, доля слов вне списков) в чате не проверяются. Годная ветка origin 'chat'
// сохраняется целиком.
export async function generateChatThread(db: Db, deps: ChatDeps, message: string): Promise<ChatResult> {
  const usage: Usage = { inputTokens: 0, outputTokens: 0 }
  try {
    const hits = await hitsOf(db, deps.llm, message, { k: CHAT_FRAGMENTS, kinds: CHAT_KB_KINDS })
    const fragments = hits.map(toFragment)

    let errors: string[] = []
    for (let attempt = 0; attempt <= GEN.MAX_RETRIES; attempt++) {
      const reply = await askJson(deps.llm, {
        role: 'write',
        system: CHAT_SYSTEM,
        user: chatUserPrompt({ message, fragments, errors: attempt === 0 ? undefined : errors }),
        schema: CHAT_SCHEMA,
        schemaName: CHAT_SCHEMA_NAME,
        maxTokens: MAX_TOKENS,
      }, usage)
      if (!reply.ok) {
        errors = reply.errors
        continue
      }

      const shaped = readChatThread(reply.value)
      if (!shaped.ok) {
        errors = shaped.errors
        continue
      }
      const built = await buildPosts(db, deps.cfg, shaped.raw, 'chat', [])
      if (!built.ok) {
        errors = built.errors
        continue
      }
      const threadId = randomUUID()
      // built.built идёт в том же порядке, что shaped.raw.posts: fragments[i] — номера поста i
      const posts: Post[] = built.built.map((b, i) => {
        const sources = sourcesOf(hitsByNumbers(hits, shaped.fragments[i]))
        return { id: randomUUID(), threadId, ...b.post, ...(sources.length > 0 ? { sources } : {}) }
      })
      const thread: Thread = { id: threadId, origin: 'chat', posts }
      await saveThread(db, thread)
      return { ok: true, thread, usage }
    }
    return { ok: false, errors, usage }
  } catch (e) {
    if (e instanceof AnalyzerError) return { ok: false, errors: [e.message], usage }
    if (e instanceof LlmError) return { ok: false, errors: [e.message], usage: withErrorUsage(usage, e) }
    throw e
  }
}

type JsonArgs = Parameters<LlmClient['json']>[0]

// Один вызов модели. Невалидный JSON и обрезанный ответ (LlmError с kind) дают текст ошибки для повтора, их usage
// прибавляется к сумме. Прочие ошибки идут наверх (usage прочих LlmError прибавляет вызывающий, см. withErrorUsage).
async function askJson(
  llm: LlmClient,
  args: JsonArgs,
  usage: Usage,
): Promise<{ ok: true; value: unknown } | { ok: false; errors: string[] }> {
  try {
    const reply = await llm.json<unknown>(args)
    addUsage(usage, reply.usage)
    return { ok: true, value: reply.value }
  } catch (e) {
    if (!(e instanceof LlmError) || e.kind === undefined) throw e
    if (e.usage) addUsage(usage, e.usage)
    return { ok: false, errors: [e.kind === 'truncated' ? TRUNCATED_RETRY : e.message] }
  }
}

// Сумма вызовов плюс usage неповторяемой LlmError, если он у неё есть
function withErrorUsage(usage: Usage, e: LlmError): Usage {
  if (e.usage) addUsage(usage, e.usage)
  return usage
}

// Цели для банка: слова и конструкции 1–4급, у которых веток банка меньше нормы. Группы до TARGETS_PER_CALL целей,
// в группе не больше одной конструкции, пока они есть. Сначала 3–4급, затем 1–2급; порядок внутри яруса — от rng.
// Каждая цель попадает в план один раз. limit — число групп.
export async function planBank(db: Db, opts: { rng: () => number; limit?: number }): Promise<Item[][]> {
  const items = await db.query<Item>(
    'select id, kind, level, headword, homograph, pos, hint, related, seq from items where level <= $1 order by id',
    [POST_RULES.MAX_LEVEL],
  )
  // ветки банка считаются по post_items; чаты не учитываются
  const done = await db.query<{ item_id: string; n: number }>(
    `select pi.item_id, count(distinct t.id)::int as n
     from post_items pi
     join posts p on p.id = pi.post_id
     join threads t on t.id = p.thread_id
     where t.origin = 'bank'
     group by pi.item_id`,
  )
  const have = new Map(done.map(r => [r.item_id, r.n]))
  const need = items.filter(it => (have.get(it.id) ?? 0) < (it.level >= 3 ? NORM_HIGH : NORM_LOW))
  const groups = [
    ...groupsOf(need.filter(it => it.level >= 3), opts.rng),
    ...groupsOf(need.filter(it => it.level <= 2), opts.rng),
  ]
  return opts.limit === undefined ? groups : groups.slice(0, opts.limit)
}

// Группы одного яруса: в каждой не больше TARGETS_PER_CALL целей и не больше одной конструкции, пока конструкции есть
function groupsOf(items: Item[], rng: () => number): Item[][] {
  const grammar = shuffle(items.filter(it => it.kind === 'grammar'), rng)
  const vocab = shuffle(items.filter(it => it.kind === 'vocab'), rng)
  const groups: Item[][] = []
  while (grammar.length > 0 || vocab.length > 0) {
    const group: Item[] = []
    const g = grammar.shift()
    if (g !== undefined) group.push(g)
    while (group.length < GEN.TARGETS_PER_CALL) {
      const v = vocab.shift()
      if (v === undefined) break
      group.push(v)
    }
    groups.push(group)
  }
  return groups
}

// Все посты через buildPost и validatePost (правила режима mode), затем наличие каждой цели хотя бы в одном посте.
// В чате целей и подтяжки нет. Подтяжка идёт по плану: stretchItemId поста — id подтяжки, если он есть в itemIds поста,
// иначе поля нет; stretchLemma из ответа модели не учитывается.
async function buildPosts(
  db: Db,
  cfg: Config,
  raw: RawThread,
  mode: 'bank' | 'chat',
  targets: Item[],
  stretch?: Item,
): Promise<{ ok: true; built: BuiltPost[] } | { ok: false; errors: string[] }> {
  const prefer = preferOf(targets, stretch)
  const built: BuiltPost[] = []
  for (const rp of raw.posts) {
    const b = await buildPost(db, { ...rp, stretchLemma: undefined }, cfg.analyzerUrl, undefined, analyzeOpts(cfg, prefer))
    if (stretch !== undefined && b.itemIds.includes(stretch.id)) b.post.stretchItemId = stretch.id
    built.push(b)
  }

  const errors: string[] = []
  for (let i = 0; i < built.length; i++) {
    const v = await validatePost(db, built[i], { mode, stretchLemma: stretch?.headword })
    if (!v.ok) errors.push(...v.errors.map(e => `пост ${i + 1}: ${e}`))
  }
  for (const t of targets) {
    const found = built.some(b => b.itemIds.includes(t.id) || (t.kind === 'grammar' && b.grammarIds.includes(t.id)))
    if (!found) errors.push(`нет цели: ${t.headword}`)
  }
  return errors.length === 0 ? { ok: true, built } : { ok: false, errors }
}

// Конструкция цели, которой нет в itemIds ни одного поста, но которая найдена в grammarIds какого-то поста.
// Она дописывается в post_items первого такого поста: иначе planBank не видит её покрытой и планирует снова.
function grammarOnlyItems(built: BuiltPost[], posts: Post[], targets: Item[]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const t of targets) {
    if (t.kind !== 'grammar' || built.some(b => b.itemIds.includes(t.id))) continue
    const i = built.findIndex(b => b.grammarIds.includes(t.id))
    if (i === -1) continue
    const postId = posts[i].id
    out[postId] = [...(out[postId] ?? []), t.id]
  }
  return out
}

// Вопрос годен, если он проходит buildCheck и хотя бы один его различающийся id — цель (prefer только из целей)
async function buildChecks(db: Db, cfg: Config, raw: RawThread, targets: Item[]): Promise<Check[]> {
  const targetIds = new Set(targets.map(t => t.id))
  const prefer = preferOf(targets)
  const out: Check[] = []
  for (const rc of raw.checks ?? []) {
    const r = await buildCheck(db, rc, cfg.analyzerUrl, 'post', undefined, analyzeOpts(cfg, prefer))
    if (!r.ok) continue
    if (!r.check.itemIds.some(id => targetIds.has(id))) continue
    out.push({ id: randomUUID(), ...r.check })
  }
  return out
}

type Shaped = { ok: true; raw: RawThread } | { ok: false; errors: string[] }
// Ответ чата: посты и список номеров фрагментов каждого (в порядке постов raw; диапазон проверяется позже, в generateChatThread)
type ChatShaped = { ok: true; raw: RawThread; fragments: unknown[][] } | { ok: false; errors: string[] }
interface ChatPost { post: RawPost; fragments: unknown[] }
type PostsShape<T> = { ok: true; posts: T[] } | { ok: false; errors: string[] }

// Форма ответа банка: число постов и поля постов. Пост с битой формой — ошибка (повтор); вопрос с битой формой отбрасывается.
function readRawThread(value: unknown): Shaped {
  if (!isRecord(value)) return { ok: false, errors: ['ответ модели не объект'] }
  const posts = readPosts(value, readBankPost)
  if (!posts.ok) return posts
  if (value.checks !== undefined && !Array.isArray(value.checks)) return { ok: false, errors: ['checks не список'] }
  return { ok: true, raw: { posts: posts.posts, checks: readChecks(value.checks) } }
}

// Форма ответа чата: только посты, у каждого список fragments. Вопросов нет, подтяжки нет: stretchLemma из ответа не используется.
function readChatThread(value: unknown): ChatShaped {
  if (!isRecord(value)) return { ok: false, errors: ['ответ модели не объект'] }
  const posts = readPosts(value, readChatPost)
  if (!posts.ok) return posts
  return {
    ok: true,
    raw: { posts: posts.posts.map(p => ({ ...p.post, stretchLemma: undefined })) },
    fragments: posts.posts.map(p => p.fragments),
  }
}

// Пост банка: поля как у readPost; абзац lang 'ru' — ошибка формы (повтор): в банке весь текст по-корейски
function readBankPost(v: unknown): RawPost | string {
  const post = readPost(v)
  if (typeof post === 'string') return post
  if (post.paragraphs.some(p => p.lang !== 'ko')) return 'абзац с lang "ru": в банке все абзацы на корейском (lang "ko")'
  return post
}

// Пост чата: поля как у readPost (абзацы lang 'ru' допустимы) и список fragments. Нет списка или не список — ошибка формы (повтор)
function readChatPost(v: unknown): ChatPost | string {
  const post = readPost(v)
  if (typeof post === 'string') return post
  if (!isRecord(v) || !Array.isArray(v.fragments)) return 'нет списка fragments'
  return { post, fragments: v.fragments }
}

// Посты ответа: их число и поля каждого (поля читает readOne). Пост с битой формой — ошибка (повтор)
function readPosts<T>(value: Record<string, unknown>, readOne: (v: unknown) => T | string): PostsShape<T> {
  const rawPosts = value.posts
  if (!Array.isArray(rawPosts)) return { ok: false, errors: ['в ответе нет списка posts'] }
  const { min, max } = GEN.POSTS_PER_THREAD
  if (rawPosts.length < min || rawPosts.length > max) {
    return { ok: false, errors: [`постов должно быть от ${min} до ${max}, получено ${rawPosts.length}`] }
  }
  const posts: T[] = []
  const errors: string[] = []
  rawPosts.forEach((p: unknown, i: number) => {
    const r = readOne(p)
    if (typeof r === 'string') errors.push(`пост ${i + 1}: ${r}`)
    else posts.push(r)
  })
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, posts }
}

// Строка, пустая строка и null — «поля нет»; не строка — ошибка формы (false)
function optionalText(v: unknown): string | undefined | false {
  if (v === null || v === undefined) return undefined
  if (typeof v !== 'string') return false
  return v.trim() === '' ? undefined : v
}

function readPost(v: unknown): RawPost | string {
  if (!isRecord(v)) return 'не объект'
  const { authorName, authorHandle, paragraphs } = v
  if (typeof authorName !== 'string' || authorName.trim() === '') return 'нет authorName'
  if (typeof authorHandle !== 'string' || authorHandle.trim() === '') return 'нет authorHandle'
  if (!Array.isArray(paragraphs)) return 'нет списка paragraphs'
  const out: RawPost['paragraphs'] = []
  for (const p of paragraphs) {
    if (!isRecord(p)) return 'абзац не объект'
    const { lang, text } = p
    if ((lang !== 'ko' && lang !== 'ru') || typeof text !== 'string') return 'абзац не по схеме'
    out.push({ lang, text })
  }
  const post: RawPost = { authorName, authorHandle, paragraphs: out }
  const title = optionalText(v.title)
  const stretchLemma = optionalText(v.stretchLemma)
  if (title === false || stretchLemma === false) return 'title или stretchLemma не строка'
  if (title !== undefined) post.title = title
  if (stretchLemma !== undefined) post.stretchLemma = stretchLemma
  return post
}

// Вопрос с битой формой отбрасывается без ошибки, как вопрос без цели
function readChecks(v: unknown): RawCheck[] {
  if (!Array.isArray(v)) return []
  const out: RawCheck[] = []
  for (const c of v) {
    if (!isRecord(c)) continue
    const { stem, options, answerIndex } = c
    if (typeof stem !== 'string' || !Array.isArray(options) || typeof answerIndex !== 'number') continue
    if (!options.every(o => typeof o === 'string')) continue
    out.push({ stem, options: options as string[], answerIndex })
  }
  return out
}

interface NoteRow { item_id: string; gloss_ru: string | null; explanation_ru: string | null; examples_json: unknown }

async function notesOf(db: Db, items: Item[]): Promise<Map<string, NoteRow>> {
  if (items.length === 0) return new Map()
  const marks = items.map((_, i) => `$${i + 1}`).join(', ')
  const rows = await db.query<NoteRow>(
    `select item_id, gloss_ru, explanation_ru, examples_json from item_notes where item_id in (${marks})`,
    items.map(it => it.id),
  )
  return new Map(rows.map(r => [r.item_id, r] as const))
}

function promptTarget(item: Item, notes: Map<string, NoteRow>): PromptTarget {
  const note = notes.get(item.id)
  return {
    kind: item.kind,
    headword: nfc(item.headword),
    pos: item.pos,
    hint: item.hint,
    gloss: note?.gloss_ru ?? undefined,
    explanation: note?.explanation_ru ?? undefined,
    examples: examplesOf(note?.examples_json),
  }
}

// examples_json — массив { ko, ru } (пояснение грамматики, Task 8); в подсказку идёт строка «ко — ру»
function examplesOf(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.flatMap((e: unknown) => (isRecord(e) && typeof e.ko === 'string' && typeof e.ru === 'string' ? [`${e.ko} — ${e.ru}`] : []))
}

// Фрагменты searchKb по заглавным словам целей; ошибка поиска или пустая база — без фрагментов
async function fragmentsOf(db: Db, llm: LlmClient, targets: Item[]): Promise<PromptFragment[]> {
  const query = targets.map(t => normGrammarForm(t.headword)).join(' ')
  const hits = await hitsOf(db, llm, query, { k: KB_FRAGMENTS, kinds: ['grammar', 'textbook'] })
  return hits.map(toFragment)
}

// searchKb; ошибка поиска — без результатов
async function hitsOf(db: Db, llm: LlmClient, query: string, opts: { k: number; kinds: KbKind[] }): Promise<KbHit[]> {
  try {
    return await searchKb(db, llm, query, opts)
  } catch {
    return []
  }
}

function toFragment(h: KbHit): PromptFragment {
  return { source: h.page === null ? h.docPath : `${h.docPath}, стр. ${h.page}`, text: h.text }
}

// Фрагменты поста по его номерам (с 1, как в подсказке): целые от 1 до числа фрагментов, по возрастанию, без повторов.
// Всё прочее (0, номер сверх числа, дробное, не число) молча отбрасывается.
function hitsByNumbers(hits: KbHit[], numbers: unknown[]): KbHit[] {
  const picked = new Set<number>()
  for (const n of numbers) {
    if (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= hits.length) picked.add(n)
  }
  return [...picked].sort((a, b) => a - b).map(n => hits[n - 1])
}

// doc и page фрагментов без повторов, в порядке выдачи
function sourcesOf(hits: KbHit[]): Source[] {
  const seen = new Set<string>()
  const out: Source[] = []
  for (const h of hits) {
    const key = JSON.stringify([h.docPath, h.page])
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ doc: h.docPath, page: h.page })
  }
  return out
}

function preferOf(targets: Item[], stretch?: Item): string[] {
  return [...targets, ...(stretch ? [stretch] : [])].map(it => it.id)
}

function analyzeOpts(cfg: Config, prefer: string[]): AnalyzeOpts {
  return { secret: cfg.analyzerSecret, prefer }
}

function addUsage(total: Usage, u: Usage): void {
  total.inputTokens += u.inputTokens
  total.outputTokens += u.outputTokens
}

// Перемешивание Фишера–Йетса с внешним генератором
function shuffle<T>(xs: readonly T[], rng: () => number): T[] {
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = a[i]
    a[i] = a[j]
    a[j] = tmp
  }
  return a
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
