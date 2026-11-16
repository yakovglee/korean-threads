// Посты и мини-проверки: сборка из сырого текста (разметку делает анализатор), проверка по правилам,
// хранение веток и вопросов. Все функции async; запись ветки и вопроса идёт в одной транзакции.
import { analyzeFull, analyzeToSegments, grammarMatches, loadLexicon, type Lexicon, type Morph } from './analyzer'
import type { Db } from './db'
import { nfc } from './ko'
import type { Check, Item, Paragraph, Post, Segment, Source, Thread } from './types'

export const POST_RULES = { UNLISTED_MAX_RATIO: 0.1, MAX_LEVEL: 4 } as const

export interface RawPost {
  authorName: string
  authorHandle: string
  title?: string
  paragraphs: { lang: 'ko' | 'ru'; text: string }[]
  stretchLemma?: string
}
export interface RawCheck { stem: string; options: string[]; answerIndex: number }
export interface RawThread { posts: RawPost[]; check?: RawCheck }

export interface BuiltPost {
  post: Omit<Post, 'id' | 'threadId'>
  itemIds: string[]
  grammarIds: string[]
  unlistedRatio: number
}

export type Verdict = { ok: true } | { ok: false; errors: string[] }
export type AnalyzeOpts = { secret?: string; timeoutMs?: number }

// Ко-абзацы размечаются анализатором, ru-абзацы идут как есть.
// itemIds — id из сегментов без повторов по порядку появления; grammarIds — все конструкции, найденные grammarMatches
// хотя бы в одном ко-абзаце (включая те, что уже в itemIds).
export async function buildPost(
  db: Db,
  raw: RawPost,
  analyzerUrl: string,
  fetchImpl?: typeof fetch,
  opts: AnalyzeOpts = {},
): Promise<BuiltPost> {
  const paragraphs: Paragraph[] = []
  const koSegments: Segment[] = []
  const koMorphs: Morph[][] = []
  for (const p of raw.paragraphs) {
    if (p.lang === 'ru') {
      paragraphs.push({ lang: 'ru', text: nfc(p.text) })
      continue
    }
    const { segments, morphs } = await analyzeFull(db, p.text, analyzerUrl, fetchImpl, opts)
    paragraphs.push({ lang: 'ko', segments })
    koSegments.push(...segments)
    koMorphs.push(morphs)
  }

  const lex = await loadLexicon(db)
  const byId = indexItems(lex)
  const itemIds = unique(koSegments.flatMap(s => s.itemIds))
  const grammarIds = [...lex.grammar]
    .sort((a, b) => a.item.level - b.item.level || a.item.seq - b.item.seq)
    .filter(({ item }) => koMorphs.some(morphs => grammarMatches(item, morphs)))
    .map(({ item }) => item.id)

  // доля: вхождения вне списков среди вхождений слов из списков (конструкции в знаменатель не входят)
  let unlisted = 0
  let vocabHits = 0
  for (const s of koSegments) {
    unlisted += s.unlisted.length
    vocabHits += s.itemIds.filter(id => byId.get(id)?.kind === 'vocab').length
  }
  const denom = unlisted + vocabHits
  const unlistedRatio = denom === 0 ? 0 : unlisted / denom

  const post: Omit<Post, 'id' | 'threadId'> = {
    author: { name: nfc(raw.authorName), handle: raw.authorHandle },
    paragraphs,
  }
  if (raw.title !== undefined) post.title = nfc(raw.title)
  const stretchItemId = raw.stretchLemma === undefined ? undefined : findStretch(itemIds, byId, nfc(raw.stretchLemma))
  if (stretchItemId !== undefined) post.stretchItemId = stretchItemId

  return { post, itemIds, grammarIds, unlistedRatio }
}

// Все ошибки собираются, а не останавливаются на первой.
// Везде: есть абзацы и нет пустых; цели из ctx.targets присутствуют (слово — в itemIds, конструкция — в itemIds или grammarIds).
// Режим bank дополнительно: доля вне списков не выше порога; нет items выше 4급, кроме одного слова 5–6급 из подтяжки.
export async function validatePost(
  db: Db,
  built: BuiltPost,
  ctx: { mode: 'bank' | 'chat'; targets?: Item[]; stretchLemma?: string },
): Promise<Verdict> {
  const errors: string[] = []
  const { paragraphs } = built.post
  if (paragraphs.length === 0) errors.push('нет ни одного абзаца')
  paragraphs.forEach((p, i) => {
    const empty = p.lang === 'ko' ? p.segments.length === 0 : p.text.trim() === ''
    if (empty) errors.push(`абзац ${i + 1} пустой`)
  })

  if (ctx.mode === 'bank') {
    if (built.unlistedRatio > POST_RULES.UNLISTED_MAX_RATIO) {
      const pct = Math.round(built.unlistedRatio * 100)
      errors.push(`слова вне списков: ${pct}% (допустимо не больше ${POST_RULES.UNLISTED_MAX_RATIO * 100}%)`)
    }
    const byId = indexItems(await loadLexicon(db))
    const high = built.itemIds
      .map(id => byId.get(id))
      .filter((it): it is Item => it !== undefined && it.level > POST_RULES.MAX_LEVEL)
    const stretchOk = high.length === 1
      && high[0].kind === 'vocab'
      && ctx.stretchLemma !== undefined
      && nfc(high[0].headword) === nfc(ctx.stretchLemma)
    if (high.length > 0 && !stretchOk) {
      errors.push(`слова выше ${POST_RULES.MAX_LEVEL}급: ${high.map(it => it.headword).join(', ')}; допустимо только одно слово 5–6급 из подтяжки`)
    }
  }

  for (const t of ctx.targets ?? []) {
    const found = built.itemIds.includes(t.id) || (t.kind === 'grammar' && built.grammarIds.includes(t.id))
    if (!found) errors.push(`нет цели: ${t.headword}`)
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}

// Варианты размечаются анализатором; itemIds — объединение минус пересечение по вариантам. Текст вопроса не размечается.
export async function buildCheck(
  db: Db,
  raw: RawCheck,
  analyzerUrl: string,
  source: Check['source'],
  fetchImpl?: typeof fetch,
  opts: AnalyzeOpts = {},
): Promise<{ ok: true; check: Omit<Check, 'id'> } | { ok: false; errors: string[] }> {
  const errors: string[] = []
  const rawStem = nfc(raw.stem)
  // пропуск — серия из трёх и более подчёркиваний: серия должна быть одна, в сохранённом вопросе она становится «___»
  if ((rawStem.match(/_{3,}/g) ?? []).length !== 1) errors.push('в вопросе должен быть ровно один пропуск ___')
  const stem = rawStem.replace(/_{3,}/g, '___')

  const options = raw.options.map(o => nfc(o).trim())
  if (options.length !== 4) errors.push('вариантов должно быть ровно 4')
  if (options.some(o => o === '')) errors.push('есть пустой вариант')
  if (new Set(options).size !== options.length) errors.push('варианты повторяются')
  if (!Number.isInteger(raw.answerIndex) || raw.answerIndex < 0 || raw.answerIndex > 3) {
    errors.push('номер правильного варианта — целое от 0 до 3')
  }

  let itemIds: string[] = []
  const analyzable = options.length === 4 && options.every(o => o !== '')
  if (analyzable) {
    const perOption: Set<string>[] = []
    for (const o of options) {
      const segments = await analyzeToSegments(db, o, analyzerUrl, fetchImpl, opts)
      perOption.push(new Set(segments.flatMap(s => s.itemIds)))
    }
    const union = unique(perOption.flatMap(s => [...s]))
    itemIds = union.filter(id => !perOption.every(s => s.has(id)))
    if (itemIds.length === 0) errors.push('в вариантах нет различающихся слов или конструкций из списков')
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, check: { source, stem, options, answerIndex: raw.answerIndex, itemIds } }
}

// Ветка, её посты (position по порядку), post_items из ко-сегментов и, при наличии, вопросы — одной транзакцией.
// Повторный id любой строки даёт ошибку, и тогда в базе ничего не остаётся. threadId поста должен совпадать с id ветки:
// иначе ошибка до записи.
export async function saveThread(
  db: Db,
  thread: Thread,
  opts: { checks?: Check[]; now?: number } = {},
): Promise<void> {
  for (const post of thread.posts) {
    if (post.threadId !== thread.id) throw new Error(`пост ${post.id}: threadId не совпадает с id ветки`)
  }
  const now = opts.now ?? Date.now()
  await db.tx(async tx => {
    await tx.query(
      'insert into threads (id, origin, created_at) values ($1, $2, $3::bigint)',
      [thread.id, thread.origin, now],
    )
    for (let position = 0; position < thread.posts.length; position++) {
      const post = thread.posts[position]
      await tx.query(
        `insert into posts (id, thread_id, position, body_json, stretch_item_id, sources_json)
         values ($1, $2, $3::integer, $4::text::jsonb, $5, $6::text::jsonb)`,
        [
          post.id,
          thread.id,
          position,
          JSON.stringify({ author: post.author, title: post.title, paragraphs: post.paragraphs }),
          post.stretchItemId ?? null,
          post.sources === undefined ? null : JSON.stringify(post.sources),
        ],
      )
      for (const itemId of koItemIds(post.paragraphs)) {
        await tx.query('insert into post_items (post_id, item_id) values ($1, $2)', [post.id, itemId])
      }
    }
    for (const check of opts.checks ?? []) await insertCheck(tx, check, now)
  })
}

// Посты по position; результат глубоко равен сохранённому
export async function loadThread(db: Db, id: string): Promise<Thread | null> {
  const threads = await db.query<{ id: string; origin: Thread['origin'] }>(
    'select id, origin from threads where id = $1',
    [id],
  )
  const thread = threads[0]
  if (!thread) return null
  const rows = await db.query<PostRow>(
    'select id, body_json, stretch_item_id, sources_json from posts where thread_id = $1 order by position',
    [id],
  )
  return {
    id: thread.id,
    origin: thread.origin,
    posts: rows.map(r => {
      const post: Post = { id: r.id, threadId: thread.id, author: r.body_json.author, paragraphs: r.body_json.paragraphs }
      if (r.body_json.title !== undefined) post.title = r.body_json.title
      if (r.stretch_item_id !== null) post.stretchItemId = r.stretch_item_id
      if (r.sources_json !== null) post.sources = r.sources_json
      return post
    }),
  }
}

export async function saveCheck(db: Db, check: Check, now?: number): Promise<void> {
  const at = now ?? Date.now()
  await db.tx(tx => insertCheck(tx, check, at))
}

// itemIds возвращаются в сохранённом порядке: check_items порядка не хранит, поэтому порядок лежит в body_json
export async function loadCheck(db: Db, id: string): Promise<Check | null> {
  const rows = await db.query<{ id: string; source: Check['source']; body_json: CheckBody }>(
    'select id, source, body_json from checks where id = $1',
    [id],
  )
  const row = rows[0]
  if (!row) return null
  const b = row.body_json
  return {
    id: row.id,
    source: row.source,
    stem: b.stem,
    ...(b.passage !== undefined ? { passage: b.passage } : {}),
    options: b.options,
    answerIndex: b.answerIndex,
    itemIds: b.itemIds,
    ...(b.label !== undefined ? { label: b.label } : {}),
  }
}

interface CheckBody {
  stem: string
  passage?: string
  options: string[]
  answerIndex: number
  label?: string
  itemIds: string[]
}

interface PostRow {
  id: string
  body_json: { author: Post['author']; title?: string; paragraphs: Paragraph[] }
  stretch_item_id: string | null
  sources_json: Source[] | null
}

// Вызывается внутри транзакции (и из saveThread, и из saveCheck): вложенных tx нет
async function insertCheck(q: Db, check: Check, now: number): Promise<void> {
  const body: CheckBody = {
    stem: check.stem,
    passage: check.passage,
    options: check.options,
    answerIndex: check.answerIndex,
    label: check.label,
    itemIds: check.itemIds,
  }
  await q.query(
    'insert into checks (id, source, body_json, created_at, last_answered_at) values ($1, $2, $3::text::jsonb, $4::bigint, null)',
    [check.id, check.source, JSON.stringify(body), now],
  )
  for (const itemId of unique(check.itemIds)) {
    await q.query('insert into check_items (check_id, item_id) values ($1, $2)', [check.id, itemId])
  }
}

function indexItems(lex: Lexicon): Map<string, Item> {
  const byId = new Map<string, Item>()
  for (const list of lex.vocab.values()) for (const item of list) byId.set(item.id, item)
  for (const { item } of lex.grammar) byId.set(item.id, item)
  return byId
}

// id слова уровня 5–6 из itemIds, чей headword равен подтяжке
function findStretch(itemIds: string[], byId: Map<string, Item>, lemma: string): string | undefined {
  return itemIds.find(id => {
    const it = byId.get(id)
    return it !== undefined && it.kind === 'vocab' && it.level > POST_RULES.MAX_LEVEL && nfc(it.headword) === lemma
  })
}

function koItemIds(paragraphs: Paragraph[]): string[] {
  return unique(paragraphs.flatMap(p => (p.lang === 'ko' ? p.segments.flatMap(s => s.itemIds) : [])))
}

function unique(xs: string[]): string[] {
  return [...new Set(xs)]
}
