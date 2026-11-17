import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/lib/config'
import type { Db } from '../src/lib/db'
import {
  GEN, draftBankThread, generateBankThread, generateChatThread, planBank,
  type BankDraft, type BankResult, type ChatResult,
} from '../src/lib/generate'
import { nfc } from '../src/lib/ko'
import { LlmError, type LlmClient, type Usage } from '../src/lib/llm'
import { loadThread, saveThread } from '../src/lib/posts'
import type { Item, Level } from '../src/lib/types'
import { openTestDb } from './helpers/testDb'

const ANALYZER = 'http://analyzer.test'
const cfg = loadConfig({ ANALYZER_URL: ANALYZER })
const ZERO = { threads: 0, posts: 0, post_items: 0, checks: 0, check_items: 0 }

// ---- записи списков: та же форма, что в tests/posts.test.ts ----
const vocab = (id: string, headword: string, pos: string, level: Level, seq: number): Item =>
  ({ id, kind: 'vocab', headword, homograph: 0, pos, hint: '', related: '', level, seq })

const grammar = (
  id: string,
  headword: string,
  o: { pos: string; level: Level; seq: number; related?: string; homograph?: number },
): Item => ({
  id, kind: 'grammar', headword, homograph: o.homograph ?? 0, pos: o.pos, hint: '', related: o.related ?? '',
  level: o.level, seq: o.seq,
})

const BI = vocab('v:1', '비', '명사', 1, 1)
const ODA = vocab('v:2', '오다', '동사', 1, 2)
const ODA5 = vocab('v:9', '오다', '동사', 5, 9)
const SCHOOL = vocab('v:3', '학교', '명사', 1, 3)
const SHOP = vocab('v:4', '가게', '명사', 1, 4)
const CHAEYOUNG = vocab('v:5', '채영', '명사', 1, 5)
const GEODEUN = grammar('g:6', '-거든', { pos: '종결어미', level: 2, seq: 6, related: '거든요', homograph: 2 })
const GEODEUN_YO = grammar('g:70', '-거든요', { pos: '종결어미', level: 1, seq: 70 })

async function dbWith(items: Item[]): Promise<Db> {
  const db = await openTestDb()
  for (const it of items) {
    await db.query(
      'insert into items (id, kind, level, headword, homograph, pos, hint, related, seq) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [it.id, it.kind, it.level, it.headword, it.homograph, it.pos, it.hint, it.related, it.seq],
    )
  }
  return db
}

// ---- анализатор: фикстуры tests/fixtures/mecab/; текст вне фикстур разбирается по пробелам как существительные ----
// Глобальный fetch подменяется: buildPost и buildCheck ходят в анализатор через него
interface Fixture { text: string; tokens: unknown[] }
const fixture = (name: string): Fixture =>
  JSON.parse(readFileSync(new URL(`./fixtures/mecab/${name}.json`, import.meta.url), 'utf8')) as Fixture

const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function wordTokens(text: string): unknown[] {
  return text.split(/\s+/).filter(w => w !== '').map(surface => ({
    word: { surface, pos: 'NNG', entry_type: '*', expression: '*' },
    parsed_expression: null,
  }))
}

function analyzerStub(...names: string[]): void {
  const byText = new Map(names.map(n => {
    const fx = fixture(n)
    return [nfc(fx.text), fx.tokens] as const
  }))
  vi.stubGlobal('fetch', (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const { text } = JSON.parse(String(init?.body)) as { text: string }
    return jsonRes(byText.get(nfc(text)) ?? wordTokens(text))
  }) as unknown as typeof fetch)
}

// ---- фейковый LlmClient: json отдаёт ответы по очереди (после последнего — он же); Error вместо ответа бросается ----
type JsonArgs = Parameters<LlmClient['json']>[0]
interface Call { role: string; system: string; user: string; schemaName: string }
interface Reply { value: unknown; usage?: Usage }
interface FakeLlm extends LlmClient { calls: Call[] }

function fakeLlm(replies: (Reply | Error)[]): FakeLlm {
  const calls: Call[] = []
  return {
    calls,
    async json<T>(args: JsonArgs): Promise<{ value: T; usage: Usage }> {
      calls.push({ role: args.role, system: args.system, user: args.user, schemaName: args.schemaName })
      const r = replies[Math.min(calls.length, replies.length) - 1]
      if (r instanceof Error) throw r
      return { value: r.value as T, usage: r.usage ?? { inputTokens: 0, outputTokens: 0 } }
    },
    async vision() {
      throw new Error('vision в тестах банка не нужен')
    },
    async embed() {
      return []
    },
  }
}

// ---- ответы модели в форме RawThread ----
const post = (text: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  authorName: '민지', authorHandle: 'minji', title: null, paragraphs: [{ lang: 'ko', text }], stretchLemma: null, ...extra,
})
const question = (stem: string, options: string[], answerIndex: number): Record<string, unknown> => ({ stem, options, answerIndex })
const replyOf = (posts: unknown[], checks: unknown[] = []): { posts: unknown[]; checks: unknown[] } => ({ posts, checks })

// детерминированный rng (Park–Miller) для перемешивания
function seeded(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 16807) % 2147483647
    return s / 2147483647
  }
}

async function counts(db: Db): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const table of ['threads', 'posts', 'post_items', 'checks', 'check_items']) {
    const rows = await db.query<{ n: number }>(`select count(*)::int as n from ${table}`)
    out[table] = rows[0].n
  }
  return out
}

async function postItemIds(db: Db): Promise<string[]> {
  const rows = await db.query<{ item_id: string }>('select item_id from post_items order by item_id')
  return rows.map(r => r.item_id)
}

// ветка банка с готовыми post_items (без анализатора) — для planBank
async function seedThread(db: Db, id: string, origin: 'bank' | 'chat', itemIds: string[]): Promise<void> {
  await saveThread(db, {
    id,
    origin,
    posts: [{
      id: `${id}-p`, threadId: id, author: { name: 'Тест', handle: 'test' },
      paragraphs: [{ lang: 'ko', segments: [{ text: '글', itemIds, unlisted: [] }] }],
    }],
  }, { now: 1 })
}

function okOf(r: BankResult): { threadId: string; usage: Usage } {
  if (!r.ok) throw new Error(`генерация не прошла: ${r.errors.join('; ')}`)
  return r
}

function draftOf(r: BankDraft): Extract<BankDraft, { ok: true }> {
  if (!r.ok) throw new Error(`черновик не собран: ${r.errors.join('; ')}`)
  return r
}

function chatOk(r: ChatResult): Extract<ChatResult, { ok: true }> {
  if (!r.ok) throw new Error(`ответ чата не прошёл: ${r.errors.join('; ')}`)
  return r
}

// ответ модели в чате: только посты, вопросов нет
const chatReplyOf = (posts: unknown[]): { posts: unknown[] } => ({ posts })
const chatPost = (paragraphs: { lang: 'ko' | 'ru'; text: string }[], fragments: unknown = []): Record<string, unknown> => ({
  authorName: '선생님', authorHandle: 'teacher', title: null, paragraphs, fragments,
})

// документы базы знаний для чата; один фрагмент документа (вид фрагмента — вид документа)
const GRAMMAR = { id: 'g', path: 'GRAMMAR_MAIN.md', kind: 'grammar' }
const TEXTBOOK = { id: 't', path: 'TEXTBOOK_4.md', kind: 'textbook' }
async function kbChunk(db: Db, doc: { id: string; path: string; kind: string }, page: number, text: string): Promise<void> {
  await db.query('insert into kb_docs (id, path, kind) values ($1, $2, $3) on conflict (id) do nothing', [doc.id, doc.path, doc.kind])
  await db.query('insert into kb_chunks (doc_id, kind, page, text) values ($1, $2, $3, $4)', [doc.id, doc.kind, page, text])
}

describe('generateBankThread', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('сохраняет валидный тред: цели в post_items, русское значение в подсказке, вопрос с целью сохранён', async () => {
    const db = await dbWith([BI, ODA, GEODEUN_YO])
    await db.query('insert into item_notes (item_id, gloss_ru) values ($1, $2)', ['v:1', 'дождь'])
    analyzerStub('biga-ogeodeunyo')
    const llm = fakeLlm([{ value: replyOf([post('비가 오거든요')], [question('___ 가 오거든요', ['비', '학교', '가게', '채영'], 0)]) }])
    const r = okOf(await generateBankThread(db, { llm, cfg }, [BI, GEODEUN_YO], { rng: seeded(1) }))

    const ids = await postItemIds(db)
    expect(ids).toEqual(expect.arrayContaining(['v:1', 'g:70']))
    expect(await counts(db)).toMatchObject({ threads: 1, posts: 1, checks: 1 })
    expect(await loadThread(db, r.threadId)).toMatchObject({ origin: 'bank', posts: [{ author: { name: '민지' } }] })

    const user = llm.calls[0].user
    expect(user).toContain('-거든요')
    expect(user).toContain('дождь')
    // база знаний пуста: блока фрагментов нет
    expect(user).not.toContain('Фрагменты из учебника')
  })

  it('невалидный первый ответ повторяется, второй сохраняется; в повтор идёт текст ошибки', async () => {
    const db = await dbWith([BI, ODA, GEODEUN_YO])
    analyzerStub('biga-ogeodeunyo')
    const llm = fakeLlm([
      { value: replyOf([]) },
      { value: replyOf([post('비가 오거든요')]) },
    ])
    okOf(await generateBankThread(db, { llm, cfg }, [BI, GEODEUN_YO], { rng: seeded(1) }))
    expect(llm.calls).toHaveLength(2)
    expect(llm.calls[0].user).not.toContain('Прошлый ответ')
    expect(llm.calls[1].user).toContain('постов должно быть от 1 до 4, получено 0')
    expect(await counts(db)).toMatchObject({ threads: 1, posts: 1 })
  })

  it('после MAX_RETRIES+1 неудач ok:false, usage всех попыток, в базе пусто', async () => {
    const db = await dbWith([BI, ODA, GEODEUN_YO])
    analyzerStub('biga-ogeodeunyo')
    const bad: Reply = { value: replyOf([]), usage: { inputTokens: 10, outputTokens: 1 } }
    const llm = fakeLlm([bad, bad, bad])
    const r = await generateBankThread(db, { llm, cfg }, [BI, GEODEUN_YO], { rng: seeded(1) })
    expect(r).toEqual({
      ok: false,
      errors: ['постов должно быть от 1 до 4, получено 0'],
      usage: { inputTokens: 30, outputTokens: 3 },
    })
    expect(llm.calls).toHaveLength(GEN.MAX_RETRIES + 1)
    expect(await counts(db)).toEqual(ZERO)
  })

  it('AnalyzerError останавливает генерацию с понятной ошибкой и ничего не сохраняет', async () => {
    const db = await dbWith([BI, ODA, GEODEUN_YO])
    vi.stubGlobal('fetch', (async () => jsonRes({ detail: 'Internal Server Error' }, 500)) as unknown as typeof fetch)
    const llm = fakeLlm([{ value: replyOf([post('비가 오거든요')]) }])
    const r = await generateBankThread(db, { llm, cfg }, [BI, GEODEUN_YO], { rng: seeded(1) })
    expect(r).toMatchObject({ ok: false, errors: ['анализатор ответил HTTP 500'] })
    expect(llm.calls).toHaveLength(1)
    expect(await counts(db)).toEqual(ZERO)
  })

  it('LlmError не повторяется: ok:false с текстом ошибки, в базе пусто', async () => {
    const db = await dbWith([BI, ODA, GEODEUN_YO])
    analyzerStub('biga-ogeodeunyo')
    const llm = fakeLlm([new LlmError('OpenRouter 503: сервис недоступен', 503), { value: replyOf([post('비가 오거든요')]) }])
    const r = await generateBankThread(db, { llm, cfg }, [BI, GEODEUN_YO], { rng: seeded(1) })
    expect(r).toMatchObject({ ok: false, errors: ['OpenRouter 503: сервис недоступен'] })
    expect(llm.calls).toHaveLength(1)
    expect(await counts(db)).toEqual(ZERO)
  })

  it('prefer передан в разметку: цель-омоним (уровень 2) выбрана вместо записи уровня 1', async () => {
    const B1 = vocab('v:b1', '배', '명사', 1, 1)
    const B2 = vocab('v:b2', '배', '명사', 2, 2)
    const db = await dbWith([B1, B2])
    analyzerStub()
    const llm = fakeLlm([{ value: replyOf([post('배')]) }])
    okOf(await generateBankThread(db, { llm, cfg }, [B2], { rng: seeded(1) }))
    // без prefer разметка взяла бы v:b1 (меньший уровень); здесь в post_items только цель
    expect(await postItemIds(db)).toEqual(['v:b2'])
  })

  it('вопрос без цели отбрасывается без ошибки; вопрос с целью сохраняется', async () => {
    const db = await dbWith([BI, ODA, GEODEUN_YO, SCHOOL, SHOP, CHAEYOUNG])
    analyzerStub('biga-ogeodeunyo')
    const llm = fakeLlm([{
      value: replyOf([post('비가 오거든요')], [
        question('___ 가 오거든요', ['비', '학교', '가게', '채영'], 0),
        // в вариантах нет ни одного слова цели (비): вопрос не проходит отбор
        question('___ 가 오거든요', ['학교', '가게', '채영', '저것'], 0),
      ]),
    }])
    okOf(await generateBankThread(db, { llm, cfg }, [BI, GEODEUN_YO], { rng: seeded(1) }))
    expect(await counts(db)).toMatchObject({ threads: 1, checks: 1 })
    const rows = await db.query<{ item_id: string }>('select item_id from check_items')
    expect(rows.map(r => r.item_id)).toContain('v:1')
  })

  it('цель-конструкция найдена только через grammarIds: -거든 засчитана, хотя разметка дала -거든요', async () => {
    // -거든요 совпадает с формой точнее (headword), поэтому в itemIds попадает g:70; g:6 остаётся в grammarIds
    const db = await dbWith([BI, ODA, GEODEUN, GEODEUN_YO])
    analyzerStub('biga-ogeodeunyo')
    const llm = fakeLlm([{ value: replyOf([post('비가 오거든요')]) }])
    okOf(await generateBankThread(db, { llm, cfg }, [GEODEUN, GEODEUN_YO], { rng: seeded(1) }))
    expect(await postItemIds(db)).toContain('g:70')
    expect(await counts(db)).toMatchObject({ threads: 1, posts: 1 })
  })

  it('цель, засчитанная по grammarIds, попадает в post_items и уходит из planBank', async () => {
    const db = await dbWith([BI, ODA, GEODEUN, GEODEUN_YO])
    analyzerStub('biga-ogeodeunyo')
    const llm = fakeLlm([{ value: replyOf([post('비가 오거든요')]) }])
    okOf(await generateBankThread(db, { llm, cfg }, [GEODEUN, GEODEUN_YO], { rng: seeded(1) }))
    expect(await postItemIds(db)).toContain('g:6')
    const groups = await planBank(db, { rng: seeded(1) })
    expect(groups.flat().map(it => it.id)).not.toContain('g:6')
  })

  it('draftBankThread: ветка и вопросы собираются, в базе ничего не появляется', async () => {
    const db = await dbWith([BI, ODA, GEODEUN, GEODEUN_YO, SCHOOL, SHOP, CHAEYOUNG])
    analyzerStub('biga-ogeodeunyo')
    const llm = fakeLlm([{ value: replyOf([post('비가 오거든요')], [question('___ 가 오거든요', ['비', '학교', '가게', '채영'], 0)]) }])
    const r = draftOf(await draftBankThread(db, { llm, cfg }, [BI, GEODEUN, GEODEUN_YO], { rng: seeded(1) }))

    expect(await counts(db)).toEqual(ZERO)
    expect(r.thread).toMatchObject({ origin: 'bank', posts: [{ author: { name: '민지' } }] })
    expect(r.checks).toHaveLength(1)
    expect(r.checks[0].itemIds).toContain('v:1')
    // конструкция -거든 засчитана только по grammarIds: дописывается к единственному посту
    expect(r.extraItems).toEqual({ [r.thread.posts[0].id]: ['g:6'] })
  })

  it('usage суммируется по успешным и повторным вызовам json', async () => {
    const db = await dbWith([BI, ODA, GEODEUN_YO])
    analyzerStub('biga-ogeodeunyo')
    const llm = fakeLlm([
      { value: replyOf([]), usage: { inputTokens: 1000, outputTokens: 200 } },
      { value: replyOf([post('비가 오거든요')]), usage: { inputTokens: 1100, outputTokens: 300 } },
    ])
    const r = okOf(await generateBankThread(db, { llm, cfg }, [BI, GEODEUN_YO], { rng: seeded(1) }))
    expect(r.usage).toEqual({ inputTokens: 2100, outputTokens: 500 })
  })

  it('фрагменты базы знаний попадают в подсказку (grammar и textbook)', async () => {
    const db = await dbWith([BI, ODA, GEODEUN_YO])
    await db.query('insert into kb_docs (id, path, kind) values ($1, $2, $3)', ['g', 'GRAMMAR_MAIN.md', 'grammar'])
    await db.query(
      'insert into kb_chunks (doc_id, kind, page, text) values ($1, $2, $3, $4)',
      ['g', 'grammar', 12, '-거든요는 이유를 덧붙일 때 씁니다.'],
    )
    analyzerStub('biga-ogeodeunyo')
    const llm = fakeLlm([{ value: replyOf([post('비가 오거든요')]) }])
    okOf(await generateBankThread(db, { llm, cfg }, [GEODEUN_YO], { rng: seeded(1) }))
    expect(llm.calls[0].user).toContain('Фрагменты из учебника')
    expect(llm.calls[0].user).toContain('GRAMMAR_MAIN.md, стр. 12: -거든요는 이유를 덧붙일 때 씁니다.')
  })

  it('подтяжка: её слово становится stretchItemId поста, а в подсказке есть блок подтяжки', async () => {
    const db = await dbWith([BI, ODA5, GEODEUN_YO])
    analyzerStub('biga-ogeodeunyo')
    const llm = fakeLlm([{ value: replyOf([post('비가 오거든요', { stretchLemma: '오다' })]) }])
    const r = okOf(await generateBankThread(db, { llm, cfg }, [BI, GEODEUN_YO], { stretch: ODA5, rng: seeded(1) }))
    expect((await loadThread(db, r.threadId))?.posts[0].stretchItemId).toBe('v:9')
    expect(llm.calls[0].user).toContain('Подтяжка (одно слово 5–6급')
  })

  it('подтяжка по плану: stretchLemma в ответе нет, stretch_item_id поста всё равно записан', async () => {
    const db = await dbWith([BI, ODA5, GEODEUN_YO])
    analyzerStub('biga-ogeodeunyo')
    const llm = fakeLlm([{ value: replyOf([post('비가 오거든요')]) }])
    const r = okOf(await generateBankThread(db, { llm, cfg }, [BI, GEODEUN_YO], { stretch: ODA5, rng: seeded(1) }))
    const rows = await db.query<{ stretch_item_id: string | null }>('select stretch_item_id from posts where thread_id = $1', [r.threadId])
    expect(rows).toEqual([{ stretch_item_id: 'v:9' }])
  })

  it('подтяжка по плану: слова подтяжки в посте нет — поля нет, хотя stretchLemma в ответе её называет', async () => {
    const RADIO5 = vocab('v:r5', '라디오', '명사', 5, 10)
    const db = await dbWith([BI, ODA, GEODEUN_YO, RADIO5])
    analyzerStub('biga-ogeodeunyo')
    const llm = fakeLlm([{ value: replyOf([post('비가 오거든요', { stretchLemma: '라디오' })]) }])
    const r = okOf(await generateBankThread(db, { llm, cfg }, [BI, GEODEUN_YO], { stretch: RADIO5, rng: seeded(1) }))
    const rows = await db.query<{ stretch_item_id: string | null }>('select stretch_item_id from posts where thread_id = $1', [r.threadId])
    expect(rows).toEqual([{ stretch_item_id: null }])
  })

  it('невалидный JSON, затем годный ответ: повтор с текстом ошибки, ветка сохранена, usage обоих вызовов в сумме', async () => {
    const db = await dbWith([BI, ODA, GEODEUN_YO])
    analyzerStub('biga-ogeodeunyo')
    const invalid = new LlmError('модель вернула невалидный JSON', undefined, { kind: 'invalid', usage: { inputTokens: 900, outputTokens: 150 } })
    const llm = fakeLlm([invalid, { value: replyOf([post('비가 오거든요')]), usage: { inputTokens: 1000, outputTokens: 200 } }])
    const r = okOf(await generateBankThread(db, { llm, cfg }, [BI, GEODEUN_YO], { rng: seeded(1) }))
    expect(r.usage).toEqual({ inputTokens: 1900, outputTokens: 350 })
    expect(llm.calls).toHaveLength(2)
    expect(llm.calls[1].user).toContain('модель вернула невалидный JSON')
    expect(await counts(db)).toMatchObject({ threads: 1, posts: 1 })
  })

  it('обрезанный ответ во всех попытках: ok:false, usage всех вызовов, в базе пусто; в повторе «пиши короче»', async () => {
    const db = await dbWith([BI, ODA, GEODEUN_YO])
    analyzerStub('biga-ogeodeunyo')
    const cut = new LlmError('ответ модели обрезан: не хватило maxTokens', undefined, {
      kind: 'truncated', usage: { inputTokens: 500, outputTokens: 8000 },
    })
    const llm = fakeLlm([cut])
    const r = await generateBankThread(db, { llm, cfg }, [BI, GEODEUN_YO], { rng: seeded(1) })
    expect(r).toEqual({ ok: false, errors: ['ответ обрезан, пиши короче'], usage: { inputTokens: 1500, outputTokens: 24000 } })
    expect(llm.calls).toHaveLength(GEN.MAX_RETRIES + 1)
    expect(llm.calls[1].user).toContain('ответ обрезан, пиши короче')
    expect(await counts(db)).toEqual(ZERO)
  })

  it('AnalyzerError: неудача с fatal у черновика и у генерации, usage вызова сохранён', async () => {
    const db = await dbWith([BI, ODA, GEODEUN_YO])
    vi.stubGlobal('fetch', (async () => jsonRes({ detail: 'Internal Server Error' }, 500)) as unknown as typeof fetch)
    const llm = fakeLlm([{ value: replyOf([post('비가 오거든요')]), usage: { inputTokens: 10, outputTokens: 1 } }])
    const draft = await draftBankThread(db, { llm, cfg }, [BI, GEODEUN_YO], { rng: seeded(1) })
    expect(draft).toEqual({ ok: false, errors: ['анализатор ответил HTTP 500'], usage: { inputTokens: 10, outputTokens: 1 }, fatal: true })
    expect(await generateBankThread(db, { llm, cfg }, [BI, GEODEUN_YO], { rng: seeded(1) })).toMatchObject({ ok: false, fatal: true })
    expect(await counts(db)).toEqual(ZERO)
  })

  it('абзац lang ru в банке — ошибка формы: повтор с текстом ошибки, сохранён только корейский пост', async () => {
    const db = await dbWith([BI, ODA, GEODEUN_YO])
    analyzerStub('biga-ogeodeunyo')
    const withRu = post('비가 오거든요', { paragraphs: [{ lang: 'ko', text: '비가 오거든요' }, { lang: 'ru', text: 'Идёт дождь.' }] })
    const llm = fakeLlm([{ value: replyOf([withRu]) }, { value: replyOf([post('비가 오거든요')]) }])
    const r = okOf(await generateBankThread(db, { llm, cfg }, [BI, GEODEUN_YO], { rng: seeded(1) }))
    expect(llm.calls).toHaveLength(2)
    expect(llm.calls[1].user).toContain('пост 1: абзац с lang "ru"')
    expect((await loadThread(db, r.threadId))?.posts[0].paragraphs.map(p => p.lang)).toEqual(['ko'])
  })

  it('ошибка validatePost (слово 5급 без подтяжки) повторяется с её текстом; второй ответ сохраняется', async () => {
    const RADIO5 = vocab('v:r5', '라디오', '명사', 5, 10)
    const db = await dbWith([BI, ODA, GEODEUN_YO, RADIO5])
    analyzerStub('biga-ogeodeunyo')
    const llm = fakeLlm([
      { value: replyOf([post('비가 오거든요'), post('라디오')]) },
      { value: replyOf([post('비가 오거든요')]) },
    ])
    okOf(await generateBankThread(db, { llm, cfg }, [BI, GEODEUN_YO], { rng: seeded(1) }))
    expect(llm.calls).toHaveLength(2)
    expect(llm.calls[1].user).toContain('пост 2: слова выше 4급: 라디오')
    expect(await counts(db)).toMatchObject({ threads: 1, posts: 1 })
  })

  it('«нет цели» повторяется с её текстом; второй ответ с целью сохраняется', async () => {
    const db = await dbWith([BI, ODA, GEODEUN_YO, SCHOOL])
    analyzerStub('biga-ogeodeunyo')
    const llm = fakeLlm([
      { value: replyOf([post('비가 오거든요')]) },
      { value: replyOf([post('비가 오거든요'), post('학교')]) },
    ])
    okOf(await generateBankThread(db, { llm, cfg }, [BI, SCHOOL], { rng: seeded(1) }))
    expect(llm.calls).toHaveLength(2)
    expect(llm.calls[1].user).toContain('нет цели: 학교')
    expect(await postItemIds(db)).toContain('v:3')
    expect(await counts(db)).toMatchObject({ threads: 1, posts: 2 })
  })
})

describe('draftBankThread', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('extraItems: конструкция уходит к первому посту, где она есть в grammarIds; второй пост без дописки', async () => {
    const db = await dbWith([BI, ODA, GEODEUN, GEODEUN_YO])
    analyzerStub('biga-ogeodeunyo')
    const llm = fakeLlm([{ value: replyOf([post('비가 오거든요'), post('비가 오거든요')]) }])
    const r = draftOf(await draftBankThread(db, { llm, cfg }, [GEODEUN, GEODEUN_YO], { rng: seeded(1) }))
    expect(r.thread.posts).toHaveLength(2)
    expect(r.extraItems).toEqual({ [r.thread.posts[0].id]: ['g:6'] })
  })
})

describe('generateChatThread', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('ru-пояснение допустимо; sources из фрагментов без экзаменов сохраняются и читаются loadThread', async () => {
    const db = await dbWith([BI, ODA, GEODEUN_YO])
    await db.query('insert into kb_docs (id, path, kind) values ($1, $2, $3)', ['g', 'GRAMMAR_MAIN.md', 'grammar'])
    await db.query('insert into kb_docs (id, path, kind) values ($1, $2, $3)', ['e', 'EXAM_96.md', 'exam'])
    await db.query(
      'insert into kb_chunks (doc_id, kind, page, text) values ($1, $2, $3, $4)',
      ['g', 'grammar', 12, '-거든요는 이유를 덧붙일 때 씁니다.'],
    )
    await db.query(
      'insert into kb_chunks (doc_id, kind, page, text) values ($1, $2, $3, $4)',
      ['e', 'exam', 3, '거든요가 나오는 문제'],
    )
    analyzerStub('biga-ogeodeunyo')
    const llm = fakeLlm([{ value: chatReplyOf([
      chatPost([{ lang: 'ru', text: '-거든요 ставят в конце, когда объясняют причину.' }, { lang: 'ko', text: '비가 오거든요' }], [1]),
      chatPost([{ lang: 'ko', text: '비가 오거든요' }], [1]),
    ]) }])
    const r = chatOk(await generateChatThread(db, { llm, cfg }, '거든요 뜻이 뭐예요?'))

    expect(r.thread.origin).toBe('chat')
    expect(r.thread.posts.map(p => p.sources)).toEqual([
      [{ doc: 'GRAMMAR_MAIN.md', page: 12 }],
      [{ doc: 'GRAMMAR_MAIN.md', page: 12 }],
    ])
    expect(await loadThread(db, r.thread.id)).toEqual(r.thread)
    expect(await counts(db)).toMatchObject({ threads: 1, posts: 2 })
    // экзаменный фрагмент в подсказку не попадает
    expect(llm.calls[0].user).toContain('GRAMMAR_MAIN.md, стр. 12')
    expect(llm.calls[0].user).not.toContain('EXAM_96.md')
  })

  it('без фрагментов поля sources в постах нет', async () => {
    const db = await dbWith([BI, ODA, GEODEUN_YO])
    analyzerStub('biga-ogeodeunyo')
    const llm = fakeLlm([{ value: chatReplyOf([chatPost([{ lang: 'ko', text: '비가 오거든요' }])]) }])
    const r = chatOk(await generateChatThread(db, { llm, cfg }, '비'))
    expect(r.thread.posts[0]).not.toHaveProperty('sources')
    expect(await loadThread(db, r.thread.id)).toEqual(r.thread)
  })

  it('невалидный ответ повторяется с текстом ошибки; роль write, схема чата', async () => {
    const db = await dbWith([BI, ODA, GEODEUN_YO])
    analyzerStub('biga-ogeodeunyo')
    const llm = fakeLlm([
      { value: chatReplyOf([]) },
      { value: chatReplyOf([chatPost([{ lang: 'ko', text: '비가 오거든요' }])]) },
    ])
    chatOk(await generateChatThread(db, { llm, cfg }, '비가 오거든요'))
    expect(llm.calls).toHaveLength(2)
    expect(llm.calls[0]).toMatchObject({ role: 'write', schemaName: 'chat_thread' })
    expect(llm.calls[1].user).toContain('постов должно быть от 1 до 4, получено 0')
    expect(await counts(db)).toMatchObject({ threads: 1, posts: 1 })
  })

  it('ошибка анализатора: ok:false с текстом, в базе ничего не сохранено', async () => {
    const db = await dbWith([BI, ODA, GEODEUN_YO])
    vi.stubGlobal('fetch', (async () => jsonRes({ detail: 'Internal Server Error' }, 500)) as unknown as typeof fetch)
    const llm = fakeLlm([{ value: chatReplyOf([chatPost([{ lang: 'ko', text: '비가 오거든요' }])]) }])
    const r = await generateChatThread(db, { llm, cfg }, '비가 오거든요')
    expect(r).toMatchObject({ ok: false, errors: ['анализатор ответил HTTP 500'] })
    expect(llm.calls).toHaveLength(1)
    expect(await counts(db)).toEqual(ZERO)
  })

  it('источники поста — фрагменты по его номерам: пост с [2] получает второй фрагмент, пост с [] — без поля sources', async () => {
    const db = await dbWith([BI, ODA, GEODEUN_YO])
    await kbChunk(db, GRAMMAR, 12, '-거든요는 이유를 덧붙일 때 씁니다.')
    await kbChunk(db, TEXTBOOK, 40, '거든요 대화 예문')
    analyzerStub('biga-ogeodeunyo')
    const llm = fakeLlm([{ value: chatReplyOf([
      chatPost([{ lang: 'ko', text: '비가 오거든요' }], [2]),
      chatPost([{ lang: 'ko', text: '비가 오거든요' }], []),
    ]) }])
    const r = chatOk(await generateChatThread(db, { llm, cfg }, '거든요'))
    expect(llm.calls[0].user).toContain('[2] TEXTBOOK_4.md, стр. 40: 거든요 대화 예문')
    expect(r.thread.posts[0].sources).toEqual([{ doc: 'TEXTBOOK_4.md', page: 40 }])
    expect(r.thread.posts[1]).not.toHaveProperty('sources')
    expect(await loadThread(db, r.thread.id)).toEqual(r.thread)
  })

  it('номера 0, 99 и 1.5 отбрасываются молча: остаются верные номера; пост без верных номеров — без sources', async () => {
    const db = await dbWith([BI, ODA, GEODEUN_YO])
    await kbChunk(db, GRAMMAR, 12, '-거든요는 이유를 덧붙일 때 씁니다.')
    await kbChunk(db, TEXTBOOK, 40, '거든요 대화 예문')
    analyzerStub('biga-ogeodeunyo')
    const llm = fakeLlm([{ value: chatReplyOf([
      chatPost([{ lang: 'ko', text: '비가 오거든요' }], [0, 99, 1.5, 2]),
      chatPost([{ lang: 'ko', text: '비가 오거든요' }], [0, 99, 1.5]),
    ]) }])
    const r = chatOk(await generateChatThread(db, { llm, cfg }, '거든요'))
    expect(r.thread.posts[0].sources).toEqual([{ doc: 'TEXTBOOK_4.md', page: 40 }])
    expect(r.thread.posts[1]).not.toHaveProperty('sources')
  })

  it('два фрагмента с одинаковыми doc и page дают один источник', async () => {
    const db = await dbWith([BI, ODA, GEODEUN_YO])
    await kbChunk(db, GRAMMAR, 12, '-거든요는 이유를 덧붙일 때 씁니다.')
    await kbChunk(db, GRAMMAR, 12, '거든요는 문장 끝에 와요.')
    analyzerStub('biga-ogeodeunyo')
    const llm = fakeLlm([{ value: chatReplyOf([chatPost([{ lang: 'ko', text: '비가 오거든요' }], [1, 2])]) }])
    const r = chatOk(await generateChatThread(db, { llm, cfg }, '거든요'))
    expect(r.thread.posts[0].sources).toEqual([{ doc: 'GRAMMAR_MAIN.md', page: 12 }])
  })

  it('пост без поля fragments — ошибка формы: повтор с текстом ошибки', async () => {
    const db = await dbWith([BI, ODA, GEODEUN_YO])
    analyzerStub('biga-ogeodeunyo')
    const noFragments = { authorName: '선생님', authorHandle: 'teacher', title: null, paragraphs: [{ lang: 'ko', text: '비가 오거든요' }] }
    const llm = fakeLlm([
      { value: chatReplyOf([noFragments]) },
      { value: chatReplyOf([chatPost([{ lang: 'ko', text: '비가 오거든요' }], [])]) },
    ])
    chatOk(await generateChatThread(db, { llm, cfg }, '비가 오거든요'))
    expect(llm.calls).toHaveLength(2)
    expect(llm.calls[1].user).toContain('пост 1: нет списка fragments')
    expect(await counts(db)).toMatchObject({ threads: 1, posts: 1 })
  })

  it('fragments не список (число вместо списка) — ошибка формы: повтор', async () => {
    const db = await dbWith([BI, ODA, GEODEUN_YO])
    analyzerStub('biga-ogeodeunyo')
    const llm = fakeLlm([
      { value: chatReplyOf([chatPost([{ lang: 'ko', text: '비가 오거든요' }], 2)]) },
      { value: chatReplyOf([chatPost([{ lang: 'ko', text: '비가 오거든요' }], [])]) },
    ])
    chatOk(await generateChatThread(db, { llm, cfg }, '비가 오거든요'))
    expect(llm.calls).toHaveLength(2)
    expect(llm.calls[1].user).toContain('пост 1: нет списка fragments')
  })

  it('П-41: чат принимает слово 5급 и долю слов вне списков больше 10% с первой попытки', async () => {
    const RADIO5 = vocab('v:r5', '라디오', '명사', 5, 10)
    const db = await dbWith([BI, ODA, GEODEUN_YO, RADIO5])
    // текст вне фикстур: три существительных, 라디오 из списка 5급, два других вне списков (доля 2 из 3)
    analyzerStub()
    const llm = fakeLlm([{ value: chatReplyOf([chatPost([{ lang: 'ko', text: '라디오 컴퓨터 노트북' }])]) }])
    const r = chatOk(await generateChatThread(db, { llm, cfg }, '라디오'))
    expect(llm.calls).toHaveLength(1)
    const para = r.thread.posts[0].paragraphs[0]
    if (para.lang !== 'ko') throw new Error('ожидался корейский абзац')
    expect(para.segments.flatMap(s => s.itemIds)).toEqual(['v:r5'])
    expect(para.segments.filter(s => s.unlisted.length > 0)).toHaveLength(2)
    expect(await counts(db)).toMatchObject({ threads: 1, posts: 1 })
  })

  it('LlmError: ok:false с текстом ошибки, повтора нет, в базе пусто', async () => {
    const db = await dbWith([BI, ODA, GEODEUN_YO])
    analyzerStub('biga-ogeodeunyo')
    const llm = fakeLlm([
      new LlmError('OpenRouter 503: сервис недоступен', 503),
      { value: chatReplyOf([chatPost([{ lang: 'ko', text: '비가 오거든요' }])]) },
    ])
    const r = await generateChatThread(db, { llm, cfg }, '비가 오거든요')
    expect(r).toMatchObject({ ok: false, errors: ['OpenRouter 503: сервис недоступен'] })
    expect(llm.calls).toHaveLength(1)
    expect(await counts(db)).toEqual(ZERO)
  })

  it('после MAX_RETRIES+1 неудач ok:false, usage всех попыток, в базе пусто', async () => {
    const db = await dbWith([BI, ODA, GEODEUN_YO])
    analyzerStub('biga-ogeodeunyo')
    const llm = fakeLlm([{ value: chatReplyOf([]), usage: { inputTokens: 10, outputTokens: 1 } }])
    const r = await generateChatThread(db, { llm, cfg }, '비가 오거든요')
    expect(r).toEqual({
      ok: false,
      errors: ['постов должно быть от 1 до 4, получено 0'],
      usage: { inputTokens: 30, outputTokens: 3 },
    })
    expect(llm.calls).toHaveLength(GEN.MAX_RETRIES + 1)
    expect(await counts(db)).toEqual(ZERO)
  })
})

describe('planBank', () => {
  it('цель с нужным числом веток банка в план не попадает; чаты не считаются; 5–6급 не берутся', async () => {
    const db = await dbWith([
      vocab('v:a3', '가게', '명사', 3, 1),
      vocab('v:b3', '나무', '명사', 3, 2),
      vocab('v:c1', '다리', '명사', 1, 3),
      grammar('g:d2', '-고 싶다', { pos: '관용 표현', level: 2, seq: 4 }),
      vocab('v:e5', '라디오', '명사', 5, 5),
    ])
    // норма: 3–4급 — 2 ветки банка; 1–2급 — 1. v:a3 имеет 2 (в план нет), g:d2 имеет 2 — t1 и t3 (норма 1, в план нет)
    await seedThread(db, 't1', 'bank', ['v:a3', 'v:b3', 'g:d2'])
    await seedThread(db, 't2', 'bank', ['v:a3'])
    await seedThread(db, 't3', 'bank', ['g:d2'])
    // чат с v:b3 и v:c1: не считается, поэтому v:b3 (1 ветка банка) всё ещё нужен
    await seedThread(db, 't4', 'chat', ['v:b3', 'v:c1'])

    const groups = await planBank(db, { rng: seeded(5) })
    expect(groups.map(g => g.map(it => it.id))).toEqual([['v:b3'], ['v:c1']])
  })

  it('группы не больше 3, цель в плане один раз, в группе не больше одной конструкции, 3–4급 раньше 1–2급; limit режет группы', async () => {
    const ALL = ['v:h1', 'v:h2', 'v:h3', 'v:h4', 'g:h1', 'g:h2', 'v:l1', 'v:l2', 'v:l3', 'g:l1']
    const db = await dbWith([
      vocab('v:h1', '가방', '명사', 3, 1),
      vocab('v:h2', '나비', '명사', 3, 2),
      vocab('v:h3', '다리미', '명사', 4, 3),
      vocab('v:h4', '라디오', '명사', 4, 4),
      grammar('g:h1', '-기 때문에', { pos: '관용 표현', level: 3, seq: 5 }),
      grammar('g:h2', '-을 수 있다', { pos: '관용 표현', level: 4, seq: 6 }),
      vocab('v:l1', '마음', '명사', 1, 7),
      vocab('v:l2', '바다', '명사', 2, 8),
      vocab('v:l3', '사과', '명사', 1, 9),
      grammar('g:l1', '-고', { pos: '연결어미', level: 1, seq: 10 }),
    ])

    const groups = await planBank(db, { rng: seeded(3) })
    expect(groups).toHaveLength(4)
    expect(groups.every(g => g.length >= 1 && g.length <= GEN.TARGETS_PER_CALL)).toBe(true)
    expect(groups.every(g => g.filter(it => it.kind === 'grammar').length <= 1)).toBe(true)

    const flat = groups.flat()
    expect(flat.map(it => it.id).sort()).toEqual([...ALL].sort())

    const lastHigh = Math.max(...flat.map((it, i) => (it.level >= 3 ? i : -1)))
    const firstLow = Math.min(...flat.map((it, i) => (it.level <= 2 ? i : Infinity)))
    expect(lastHigh).toBeLessThan(firstLow)

    expect(await planBank(db, { rng: seeded(3), limit: 2 })).toEqual(groups.slice(0, 2))
  })
})
