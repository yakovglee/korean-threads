import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  API, ApiError, handleChat, handleCheckAnswer, handleCheckPeek, handleEvent, handleFeed, handleItem,
  handleLemma, handleProgress, hitRateLimit, type Deps,
} from '../src/lib/api'
import { loadConfig, type Config } from '../src/lib/config'
import type { Db } from '../src/lib/db'
import { getState, saveState } from '../src/lib/memory'
import { nfc } from '../src/lib/ko'
import { LlmError, type LlmClient, type Usage } from '../src/lib/llm'
import { loadThread, saveCheck, saveThread } from '../src/lib/posts'
import type { Item, Level, Thread } from '../src/lib/types'
import { openTestDb } from './helpers/testDb'

const DAY = 86400000
const NOW = Date.UTC(2026, 10, 16, 3) // 12:00 16.11.2026 по Джайапуре
const ANALYZER = 'http://analyzer.test'
const cfg = loadConfig({ ANALYZER_URL: ANALYZER })
const ATTRIBUTION = 'Значения: 한국어기초사전, CC BY-SA 2.0 KR'
const CHAT_FAILED = 'не получилось ответить, попробуй ещё раз'
const TOO_OFTEN = 'слишком часто, подожди немного'
const GRAMMAR = { id: 'g', path: 'GRAMMAR_MAIN.md', kind: 'grammar' }

// ---- записи списков ----
const vocab = (id: string, headword: string, pos: string, level: Level, seq: number): Item =>
  ({ id, kind: 'vocab', headword, homograph: 0, pos, hint: '', related: '', level, seq })
const grammar = (id: string, headword: string, level: Level, seq: number): Item =>
  ({ id, kind: 'grammar', headword, homograph: 0, pos: '종결어미', hint: '', related: '', level, seq })

const BI = vocab('v:1', '비', '명사', 1, 1)
const ODA = vocab('v:2', '오다', '동사', 1, 2)
const SCHOOL = vocab('v:3', '학교', '명사', 1, 3)
const GEODEUN_YO = grammar('g:70', '-거든요', 1, 70)

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

// ---- анализатор: фикстуры tests/fixtures/mecab/; текст вне фикстур разбирается по пробелам ----
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

// ---- фейковый LlmClient: json отдаёт ответы по очереди (после последнего — он же); Error бросается.
// onCall: если передан, вызывается сразу после записи вызова (тест узнаёт, что модель уже ждёт);
// gate: если передан, json ждёт его после записи вызова (нужно для проверки параллельного запроса) ----
type JsonArgs = Parameters<LlmClient['json']>[0]
interface Call { role: string; system: string; user: string; schemaName: string }
interface Reply { value: unknown; usage?: Usage }
interface FakeLlm extends LlmClient { calls: Call[] }

function fakeLlm(replies: (Reply | Error)[], gate?: Promise<void>, onCall?: () => void): FakeLlm {
  const calls: Call[] = []
  return {
    calls,
    async json<T>(args: JsonArgs): Promise<{ value: T; usage: Usage }> {
      calls.push({ role: args.role, system: args.system, user: args.user, schemaName: args.schemaName })
      onCall?.()
      if (gate) await gate
      const r = replies[Math.min(calls.length, replies.length) - 1]
      if (r instanceof Error) throw r
      return { value: r.value as T, usage: r.usage ?? { inputTokens: 0, outputTokens: 0 } }
    },
    async vision() {
      throw new Error('vision в тестах API не нужен')
    },
    async embed() {
      return []
    },
  }
}

// детерминированный rng (Park–Miller)
function seeded(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 16807) % 2147483647
    return s / 2147483647
  }
}

interface Clock { t: number }

function makeDeps(db: Db, o: { clock: Clock; role?: Deps['role']; llm?: LlmClient; cfg?: Config }): Deps {
  return {
    db,
    llm: o.llm ?? fakeLlm([]),
    cfg: o.cfg ?? cfg,
    now: () => o.clock.t,
    rng: seeded(1),
    role: o.role ?? 'owner',
  }
}

async function putState(db: Db, itemId: string, stab: number, last: number | null, isNew = false): Promise<void> {
  await saveState(db, { itemId, stabilityDays: stab, lastEventAt: last, isNew, tapCount: 0 })
}

// ветка с одним постом: каждое слово — отдельный сегмент
async function addThread(db: Db, id: string, itemIds: string[], origin: Thread['origin'] = 'bank'): Promise<void> {
  const thread: Thread = {
    id,
    origin,
    posts: [{
      id: `${id}-1`,
      threadId: id,
      author: { name: 'Автор', handle: 'author' },
      paragraphs: [{ lang: 'ko', segments: itemIds.map(i => ({ text: '단어', itemIds: [i], unlisted: [] })) }],
    }],
  }
  await saveThread(db, thread, { now: NOW })
}

async function addCheck(db: Db, id: string, source: 'exam' | 'post' | 'topik-style', itemIds: string[]): Promise<void> {
  await saveCheck(db, { id, source, stem: '___ 가', options: ['가', '나', '다', '라'], answerIndex: 0, itemIds }, NOW)
}

async function kbChunk(db: Db, doc: { id: string; path: string; kind: string }, page: number, text: string): Promise<void> {
  await db.query('insert into kb_docs (id, path, kind) values ($1, $2, $3) on conflict (id) do nothing', [doc.id, doc.path, doc.kind])
  await db.query('insert into kb_chunks (doc_id, kind, page, text) values ($1, $2, $3, $4)', [doc.id, doc.kind, page, text])
}

async function count(db: Db, sql: string): Promise<number> {
  const rows = await db.query<{ n: number }>(sql)
  return rows[0].n
}

async function stateSnapshot(db: Db): Promise<unknown[]> {
  return db.query('select item_id, stability_days, last_event_at, is_new, tap_count from item_state order by item_id')
}

// Промис должен отклониться ApiError с указанным статусом
async function rejectsWith(p: Promise<unknown>, status: number): Promise<void> {
  const err = await p.then(() => null, (e: unknown) => e)
  expect(err).toBeInstanceOf(ApiError)
  expect((err as ApiError).status).toBe(status)
}

// Обёртка базы: запрос, в тексте которого есть fragment, падает как при обрыве соединения
function failingDb(db: Db, fragment: string): Db {
  return {
    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      if (sql.includes(fragment)) throw new Error('connection terminated unexpectedly')
      return db.query<T>(sql, params)
    },
    tx: fn => db.tx(fn),
    close: () => db.close(),
  }
}

async function lastAnsweredAt(db: Db, checkId: string): Promise<number | null> {
  const rows = await db.query<{ t: number | null }>('select last_answered_at as t from checks where id = $1', [checkId])
  return rows[0].t === null ? null : Number(rows[0].t)
}

// ответ модели в чате: только посты; fragments — номера фрагментов базы знаний
const chatPost = (text: string, fragments: unknown = []): Record<string, unknown> => ({
  authorName: '선생님', authorHandle: 'teacher', title: null, paragraphs: [{ lang: 'ko', text }], fragments,
})
const CHAT_REPLY = { posts: [chatPost('비가 오거든요')] }

describe('handleEvent', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('двойной tap за 2 секунды считается один раз', async () => {
    const db = await dbWith([BI])
    const clock = { t: NOW }
    const d = makeDeps(db, { clock })
    expect(await handleEvent(d, { itemId: 'v:1', type: 'tap' })).toEqual({ ok: true, deduped: false })
    clock.t = NOW + 2000
    expect(await handleEvent(d, { itemId: 'v:1', type: 'tap' })).toEqual({ ok: true, deduped: true })
    expect((await getState(db, 'v:1')).tapCount).toBe(1)
    expect(await count(db, 'select count(*)::int as n from events')).toBe(1)
  })

  it('tap через 6 секунд считается снова', async () => {
    const db = await dbWith([BI])
    const clock = { t: NOW }
    const d = makeDeps(db, { clock })
    await handleEvent(d, { itemId: 'v:1', type: 'tap' })
    clock.t = NOW + 6000
    expect(await handleEvent(d, { itemId: 'v:1', type: 'tap' })).toEqual({ ok: true, deduped: false })
    expect((await getState(db, 'v:1')).tapCount).toBe(2)
    expect(await count(db, 'select count(*)::int as n from events')).toBe(2)
  })

  it('неизвестный itemId или checkId → 404, плохой type → 400', async () => {
    const db = await dbWith([BI])
    const d = makeDeps(db, { clock: { t: NOW } })
    await rejectsWith(handleEvent(d, { itemId: 'v:999', type: 'tap' }), 404)
    await rejectsWith(handleEvent(d, { itemId: 'v:1', type: 'tap', checkId: 'нет-такой' }), 404)
    await rejectsWith(handleEvent(d, { itemId: 'v:1', type: 'что-то' }), 400)
    expect(await count(db, 'select count(*)::int as n from events')).toBe(0)
    expect(await count(db, 'select count(*)::int as n from item_state')).toBe(0)
  })

  it('check_right и check_wrong через handleEvent → 400, ничего не записано', async () => {
    const db = await dbWith([BI])
    await putState(db, 'v:1', 10, NOW - DAY)
    await addCheck(db, 'C1', 'post', ['v:1'])
    const d = makeDeps(db, { clock: { t: NOW } })
    const before = await stateSnapshot(db)
    await rejectsWith(handleEvent(d, { itemId: 'v:1', type: 'check_right', checkId: 'C1' }), 400)
    await rejectsWith(handleEvent(d, { itemId: 'v:1', type: 'check_wrong', checkId: 'C1' }), 400)
    await rejectsWith(handleEvent(d, { itemId: 'v:1', type: 'check_right' }), 400)
    expect(await count(db, 'select count(*)::int as n from events')).toBe(0)
    expect(await stateSnapshot(db)).toEqual(before)
    expect(await lastAnsweredAt(db, 'C1')).toBeNull()
  })

  it('tap по слову 5급: событие записано, строки item_state нет', async () => {
    const db = await dbWith([vocab('v:50', '사', '명사', 5, 50)])
    const clock = { t: NOW }
    const d = makeDeps(db, { clock })
    expect(await handleEvent(d, { itemId: 'v:50', type: 'tap' })).toEqual({ ok: true, deduped: false })
    const events = await db.query<{ item_id: string; type: string }>('select item_id, type from events')
    expect(events).toEqual([{ item_id: 'v:50', type: 'tap' }])
    expect(await count(db, 'select count(*)::int as n from item_state')).toBe(0)
    // дедупликация касаний работает и без строки item_state
    clock.t = NOW + 2000
    expect(await handleEvent(d, { itemId: 'v:50', type: 'tap' })).toEqual({ ok: true, deduped: true })
    expect(await count(db, 'select count(*)::int as n from events')).toBe(1)
    expect(await count(db, 'select count(*)::int as n from item_state')).toBe(0)
  })
})

describe('handleCheckAnswer', () => {
  it('check: неверный ответ ослабляет только itemIds проверки', async () => {
    const db = await dbWith([BI, ODA])
    await putState(db, 'v:1', 10, NOW - DAY)
    await putState(db, 'v:2', 10, NOW - DAY)
    await addCheck(db, 'C1', 'post', ['v:1'])
    const d = makeDeps(db, { clock: { t: NOW } })
    expect(await handleCheckAnswer(d, { checkId: 'C1', choice: 1 })).toEqual({ correct: false, answerIndex: 0 })
    // check_wrong: max(0.5, 10 × 0.4) = 4 дня у проверяемого слова, у соседнего не меняется
    expect((await getState(db, 'v:1')).stabilityDays).toBeCloseTo(4)
    expect((await getState(db, 'v:2')).stabilityDays).toBeCloseTo(10)
    const events = await db.query<{ item_id: string; type: string; check_id: string }>(
      'select item_id, type, check_id from events',
    )
    expect(events).toEqual([{ item_id: 'v:1', type: 'check_wrong', check_id: 'C1' }])
    expect(await lastAnsweredAt(db, 'C1')).toBe(NOW)
    await rejectsWith(handleCheckAnswer(d, { checkId: 'нет-такой', choice: 0 }), 404)
  })

  it('check: ответ на проверку со словами 3급 и 5급 меняет память только у 3급', async () => {
    const db = await dbWith([vocab('v:30', '마', '명사', 3, 30), vocab('v:50', '사', '명사', 5, 50)])
    await putState(db, 'v:30', 4, NOW - DAY)
    await addCheck(db, 'C35', 'post', ['v:30', 'v:50'])
    const d = makeDeps(db, { clock: { t: NOW } })
    expect(await handleCheckAnswer(d, { checkId: 'C35', choice: 0 })).toEqual({ correct: true, answerIndex: 0 })
    // check_right: max(1, 4) × 2 = 8 дней у слова 3급
    const s30 = await getState(db, 'v:30')
    expect(s30.stabilityDays).toBeCloseTo(8)
    expect(s30.lastEventAt).toBe(NOW)
    // у слова 5급 строки item_state нет, событие в журнале есть
    expect(await count(db, "select count(*)::int as n from item_state where item_id = 'v:50'")).toBe(0)
    const events = await db.query<{ item_id: string; type: string }>('select item_id, type from events order by item_id')
    expect(events).toEqual([
      { item_id: 'v:30', type: 'check_right' },
      { item_id: 'v:50', type: 'check_right' },
    ])
    expect(await lastAnsweredAt(db, 'C35')).toBe(NOW)
  })

  it('check: повторный ответ на ту же проверку в окне 5 с не пишет второе событие', async () => {
    const db = await dbWith([BI])
    await putState(db, 'v:1', 10, NOW - DAY)
    await addCheck(db, 'C1', 'post', ['v:1'])
    const clock = { t: NOW }
    const d = makeDeps(db, { clock })
    expect(await handleCheckAnswer(d, { checkId: 'C1', choice: 0 })).toEqual({ correct: true, answerIndex: 0 })
    // повтор через 2 с: тот же результат, хотя выбран другой вариант; события нет
    clock.t = NOW + 2000
    expect(await handleCheckAnswer(d, { checkId: 'C1', choice: 1 })).toEqual({ correct: true, answerIndex: 0 })
    expect(await count(db, 'select count(*)::int as n from events')).toBe(1)
    expect((await getState(db, 'v:1')).stabilityDays).toBeCloseTo(20)
    // через 6 с после события ответ снова записывается
    clock.t = NOW + 6000
    expect(await handleCheckAnswer(d, { checkId: 'C1', choice: 1 })).toEqual({ correct: false, answerIndex: 0 })
    expect(await count(db, 'select count(*)::int as n from events')).toBe(2)
  })
})

describe('handleCheckPeek', () => {
  it('handleCheckPeek ничего не пишет, viewer на exam → 404', async () => {
    const db = await dbWith([BI])
    await putState(db, 'v:1', 10, NOW - DAY)
    await addCheck(db, 'P1', 'post', ['v:1'])
    await addCheck(db, 'E1', 'exam', ['v:1'])
    const clock = { t: NOW }
    const owner = makeDeps(db, { clock })
    const viewer = makeDeps(db, { clock, role: 'viewer' })
    const before = await stateSnapshot(db)

    expect(await handleCheckPeek(owner, { checkId: 'P1', choice: 1 })).toEqual({ correct: false, answerIndex: 0 })
    expect(await handleCheckPeek(viewer, { checkId: 'P1', choice: 0 })).toEqual({ correct: true, answerIndex: 0 })
    await rejectsWith(handleCheckPeek(viewer, { checkId: 'E1', choice: 0 }), 404)
    expect(await handleCheckPeek(owner, { checkId: 'E1', choice: 0 })).toEqual({ correct: true, answerIndex: 0 })

    expect(await count(db, 'select count(*)::int as n from events')).toBe(0)
    expect(await count(db, 'select count(*)::int as n from checks where last_answered_at is not null')).toBe(0)
    expect(await stateSnapshot(db)).toEqual(before)
  })
})

describe('handleChat', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('чат: пустое сообщение → 400, llm не вызван', async () => {
    const db = await dbWith([BI, GEODEUN_YO])
    const llm = fakeLlm([{ value: CHAT_REPLY }])
    const d = makeDeps(db, { clock: { t: NOW }, llm })
    expect(await handleChat(d, { message: '   ' })).toMatchObject({ status: 400 })
    expect(await handleChat(d, {})).toMatchObject({ status: 400 })
    expect(llm.calls).toHaveLength(0)
  })

  it('чат: 1001 символ → 400', async () => {
    const db = await dbWith([BI, GEODEUN_YO])
    analyzerStub('biga-ogeodeunyo')
    const llm = fakeLlm([{ value: CHAT_REPLY }])
    const d = makeDeps(db, { clock: { t: NOW }, llm })
    expect(await handleChat(d, { message: '가'.repeat(1001) })).toMatchObject({ status: 400 })
    expect(llm.calls).toHaveLength(0)
    // ровно 1000 знаков проходит проверку длины
    expect(await handleChat(d, { message: '가'.repeat(1000) })).toMatchObject({ status: 200 })
  })

  it('чат: ошибка ИИ → 502, в posts ничего не добавилось, handleFeed работает', async () => {
    const db = await dbWith([BI, GEODEUN_YO])
    await putState(db, 'v:1', 60, NOW)
    await addThread(db, 'B1', ['v:1'])
    analyzerStub('biga-ogeodeunyo')
    const llm = fakeLlm([new LlmError('OpenRouter 503: сервис недоступен', 503)])
    const d = makeDeps(db, { clock: { t: NOW }, llm })
    expect(await handleChat(d, { message: '거든요' })).toEqual({ status: 502, error: CHAT_FAILED })
    expect(await count(db, "select count(*)::int as n from threads where origin = 'chat'")).toBe(0)
    expect(await count(db, 'select count(*)::int as n from posts')).toBe(1)
    const { cards } = await handleFeed(d, 6)
    expect(cards.map(c => (c.type === 'thread' ? c.thread.id : c.check.id))).toEqual(['B1'])
  })

  it('чат: AnalyzerError → 502, ничего не сохранено', async () => {
    const db = await dbWith([BI, GEODEUN_YO])
    vi.stubGlobal('fetch', (async () => jsonRes({ detail: 'Internal Server Error' }, 500)) as unknown as typeof fetch)
    const llm = fakeLlm([{ value: CHAT_REPLY }])
    const d = makeDeps(db, { clock: { t: NOW }, llm })
    expect(await handleChat(d, { message: '거든요' })).toEqual({ status: 502, error: CHAT_FAILED })
    expect(await count(db, 'select count(*)::int as n from threads')).toBe(0)
    expect(await count(db, 'select count(*)::int as n from posts')).toBe(0)
  })

  it('чат: успех сохраняет тред origin=chat, sources, и возвращает его', async () => {
    const db = await dbWith([BI, GEODEUN_YO])
    await kbChunk(db, GRAMMAR, 12, '-거든요는 이유를 덧붙일 때 씁니다.')
    analyzerStub('biga-ogeodeunyo')
    const llm = fakeLlm([{ value: { posts: [chatPost('비가 오거든요', [1])] } }])
    const d = makeDeps(db, { clock: { t: NOW }, llm })
    const r = await handleChat(d, { message: '거든요' })
    if (r.status !== 200) throw new Error(`ответ чата не 200: ${r.error}`)
    expect(r.thread.origin).toBe('chat')
    expect(r.thread.posts[0].sources).toEqual([{ doc: 'GRAMMAR_MAIN.md', page: 12 }])
    expect(await loadThread(db, r.thread.id)).toEqual(r.thread)
  })

  it('чат: параллельный второй запрос → 409, ИИ вызван один раз (блокировка в БД)', async () => {
    const db = await dbWith([BI, GEODEUN_YO])
    analyzerStub('biga-ogeodeunyo')
    let open: () => void = () => undefined
    const gate = new Promise<void>(resolve => { open = resolve })
    // модель разрешает called при вызове: ждём событие, а не таймаут
    let entered: () => void = () => undefined
    const called = new Promise<void>(resolve => { entered = resolve })
    const llm = fakeLlm([{ value: CHAT_REPLY }], gate, () => entered())
    const d = makeDeps(db, { clock: { t: NOW }, llm })
    const first = handleChat(d, { message: '거든요' })
    await called
    expect(await count(db, 'select count(*)::int as n from chat_lock')).toBe(1)
    expect(await handleChat(d, { message: '거든요' })).toEqual({ status: 409, error: 'подожди ответа' })
    // отказ 409 чужую блокировку не снимает
    expect(await count(db, 'select count(*)::int as n from chat_lock')).toBe(1)
    open()
    expect((await first).status).toBe(200)
    expect(llm.calls).toHaveLength(1)
    expect(await count(db, 'select count(*)::int as n from chat_lock')).toBe(0)
  })

  it('чат: сбой базы в блокировке или лимитах → 502, не бросает, блокировка снята', async () => {
    const db = await dbWith([BI, GEODEUN_YO])
    const llm = fakeLlm([{ value: CHAT_REPLY }])
    const clock = { t: NOW }
    const lockFails = makeDeps(failingDb(db, 'chat_lock'), { clock, llm })
    expect(await handleChat(lockFails, { message: '거든요' })).toEqual({ status: 502, error: CHAT_FAILED })
    const limitFails = makeDeps(failingDb(db, 'rate_limits'), { clock, llm })
    expect(await handleChat(limitFails, { message: '거든요' })).toEqual({ status: 502, error: CHAT_FAILED })
    expect(await count(db, 'select count(*)::int as n from chat_lock')).toBe(0)
    expect(llm.calls).toHaveLength(0)
  })

  it('шестой запрос за минуту → 429 без вызова модели', async () => {
    const db = await dbWith([BI, GEODEUN_YO])
    analyzerStub('biga-ogeodeunyo')
    const llm = fakeLlm([{ value: CHAT_REPLY }])
    const d = makeDeps(db, { clock: { t: NOW }, llm })
    for (let i = 0; i < API.CHAT_PER_MIN; i++) {
      expect(await handleChat(d, { message: '거든요' })).toMatchObject({ status: 200 })
    }
    expect(await handleChat(d, { message: '거든요' })).toEqual({ status: 429, error: TOO_OFTEN })
    expect(llm.calls).toHaveLength(API.CHAT_PER_MIN)
  })

  it('после ошибки модели блокировка снята и следующий запрос проходит', async () => {
    const db = await dbWith([BI, GEODEUN_YO])
    analyzerStub('biga-ogeodeunyo')
    const llm = fakeLlm([new LlmError('OpenRouter 503: сервис недоступен', 503), { value: CHAT_REPLY }])
    const d = makeDeps(db, { clock: { t: NOW }, llm })
    expect(await handleChat(d, { message: '거든요' })).toEqual({ status: 502, error: CHAT_FAILED })
    expect(await handleChat(d, { message: '거든요' })).toMatchObject({ status: 200 })
    expect(llm.calls).toHaveLength(2)
  })

  it('viewer: handleEvent/handleChat/handleProgress/handleCheckAnswer → 403, ничего не записано', async () => {
    const NEW4 = vocab('v:4', '사과', '명사', 4, 4)
    const db = await dbWith([BI, NEW4])
    await putState(db, 'v:1', 10, NOW - DAY)
    // новое слово 4급 в ветке банка: выдача владельцу поставила бы ему introduced_day
    await putState(db, 'v:4', 0, null, true)
    await addThread(db, 'B1', ['v:1', 'v:4'])
    await addCheck(db, 'C1', 'post', ['v:1'])
    const llm = fakeLlm([{ value: CHAT_REPLY }])
    const viewer = makeDeps(db, { clock: { t: NOW }, role: 'viewer', llm })
    const snapshot = async (): Promise<unknown> => ({
      state: await db.query(
        'select item_id, stability_days, last_event_at, is_new, tap_count, introduced_day from item_state order by item_id',
      ),
      checks: await db.query('select id, last_answered_at from checks order by id'),
      rateLimits: await db.query('select key, window_start, count from rate_limits order by key, window_start'),
      chatLock: await db.query('select id, until from chat_lock order by id'),
    })
    const before = await snapshot()

    await rejectsWith(handleEvent(viewer, { itemId: 'v:1', type: 'tap' }), 403)
    await rejectsWith(handleCheckAnswer(viewer, { checkId: 'C1', choice: 0 }), 403)
    await rejectsWith(handleProgress(viewer), 403)
    expect(await handleChat(viewer, { message: '거든요' })).toMatchObject({ status: 403 })
    // чтение зрителем тоже ничего не пишет
    expect((await handleFeed(viewer, 6)).cards.length).toBeGreaterThan(0)
    expect(await handleCheckPeek(viewer, { checkId: 'C1', choice: 0 })).toEqual({ correct: true, answerIndex: 0 })

    expect(await count(db, 'select count(*)::int as n from events')).toBe(0)
    expect(await snapshot()).toEqual(before)
    expect(llm.calls).toHaveLength(0)
  })
})

describe('handleItem и handleLemma', () => {
  it('handleItem: source ai для слов без krdict; handleLemma кэширует', async () => {
    const db = await dbWith([BI, ODA, SCHOOL])
    await db.query("insert into item_notes (item_id, gloss_ru, source) values ('v:1', 'дождь', 'krdict')")
    await db.query("insert into item_notes (item_id, gloss_ru, source) values ('v:2', 'приходить', 'ai')")
    const clock = { t: NOW }

    expect(await handleItem(makeDeps(db, { clock }), 'v:1')).toMatchObject({
      glossRu: 'дождь', source: 'krdict', attribution: ATTRIBUTION,
    })
    expect(await handleItem(makeDeps(db, { clock }), 'v:2')).toMatchObject({
      glossRu: 'приходить', source: 'ai', attribution: null,
    })
    // слово без значения: показывается без перевода
    expect(await handleItem(makeDeps(db, { clock }), 'v:3')).toMatchObject({ glossRu: null, source: null, attribution: null })
    expect(await handleItem(makeDeps(db, { clock }), 'v:нет')).toBeNull()

    const llm = fakeLlm([{ value: { glossRu: 'школа' } }])
    const owner = makeDeps(db, { clock, llm })
    expect(await handleLemma(owner, '학교', '명사')).toEqual({ glossRu: 'школа', source: 'ai' })
    expect(await handleLemma(owner, '학교', '명사')).toEqual({ glossRu: 'школа', source: 'ai' })
    expect(llm.calls).toHaveLength(1)

    // зритель: промах не уходит в ИИ
    const viewer = makeDeps(db, { clock, llm, role: 'viewer' })
    expect(await handleLemma(viewer, '가다', '동사')).toEqual({ glossRu: null, source: null })
    expect(llm.calls).toHaveLength(1)
  })
})

describe('handleProgress', () => {
  it('progress: learned/confirmed по уровням 1–4 и daysToExam', async () => {
    const db = await dbWith([
      vocab('v:a1', '가', '명사', 1, 1),
      vocab('v:a2', '나', '명사', 1, 2),
      vocab('v:b1', '다', '명사', 2, 3),
      vocab('v:b2', '라', '명사', 2, 4),
      vocab('v:c1', '마', '명사', 3, 5),
      vocab('v:d1', '바', '명사', 4, 6),
      vocab('v:e5', '사', '명사', 5, 7),
    ])
    await putState(db, 'v:a1', 10, NOW - DAY) // R ≈ 0.90: выучено
    await putState(db, 'v:a2', 10, NOW - 5 * DAY) // R ≈ 0.61: не выучено
    await putState(db, 'v:b1', 7, NOW) // стабильность 7, R = 1: выучено
    await putState(db, 'v:b2', 0, null, true) // новое
    await putState(db, 'v:c1', 3, NOW) // стабильность меньше 7
    await putState(db, 'v:e5', 30, NOW) // 5급 в прогресс не входит
    const ins = (itemId: string, type: string, at: number): Promise<unknown> =>
      db.query('insert into events (at, item_id, type) values ($1::bigint, $2, $3)', [at, itemId, type])
    await ins('v:a1', 'check_right', NOW - 10 * DAY) // подтверждено
    await ins('v:a2', 'check_right', NOW - 40 * DAY) // старше 30 дней
    await ins('v:b1', 'check_wrong', NOW) // не подтверждение
    await ins('v:c1', 'check_right', NOW - DAY) // подтверждено
    await ins('v:e5', 'check_right', NOW - DAY) // 5급 не считается

    const clock = { t: NOW }
    const withExam = loadConfig({ ANALYZER_URL: ANALYZER, EXAM_DATE: '2027-02-01' })
    const p = await handleProgress(makeDeps(db, { clock, cfg: withExam }))
    expect(p.perLevel).toEqual([
      { level: 1, total: 2, learned: 1, confirmed: 1 },
      { level: 2, total: 2, learned: 1, confirmed: 0 },
      { level: 3, total: 1, learned: 0, confirmed: 1 },
      { level: 4, total: 1, learned: 0, confirmed: 0 },
    ])
    // 16.11.2026 → 01.02.2027 по Джайапуре: 77 дней
    expect(p.daysToExam).toBe(77)
    // без EXAM_DATE блок скрывается
    expect((await handleProgress(makeDeps(db, { clock }))).daysToExam).toBeNull()
  })
})

describe('handleFeed', () => {
  it('viewer в handleFeed получает только ветки bank и не получает проверок exam, last_delivered_at не меняется', async () => {
    const db = await dbWith([BI])
    await putState(db, 'v:1', 60, NOW)
    for (let i = 1; i <= 12; i++) await addThread(db, `b${i}`, ['v:1'])
    await addThread(db, 'chat1', ['v:1'], 'chat')
    await addCheck(db, 'E1', 'exam', ['v:1'])
    await addCheck(db, 'T1', 'topik-style', ['v:1'])
    const clock = { t: NOW }
    const delivered = (): Promise<number> => count(db, 'select count(*)::int as n from posts where last_delivered_at is not null')

    const { cards } = await handleFeed(makeDeps(db, { clock, role: 'viewer' }), 24)
    const threads = cards.flatMap(c => (c.type === 'thread' ? [c.thread.id] : [])).sort()
    const checks = cards.flatMap(c => (c.type === 'check' ? [c.check.id] : []))
    expect(threads).toEqual(Array.from({ length: 12 }, (_, i) => `b${i + 1}`).sort())
    expect(checks).toEqual(['T1'])
    expect(await delivered()).toBe(0)

    // у владельца та же выдача записывает показ
    await handleFeed(makeDeps(db, { clock }), 24)
    expect(await delivered()).toBeGreaterThan(0)
  })

  it('n = 0 и n = 51 → 400', async () => {
    const db = await dbWith([BI])
    const d = makeDeps(db, { clock: { t: NOW } })
    await rejectsWith(handleFeed(d, 0), 400)
    await rejectsWith(handleFeed(d, 51), 400)
  })
})

describe('hitRateLimit', () => {
  it('hitRateLimit считает по окнам', async () => {
    const db = await openTestDb()
    const MIN = 60000
    expect(await hitRateLimit(db, 'k', MIN, 2, 0)).toBe(false) // окно 0: 1
    expect(await hitRateLimit(db, 'k', MIN, 2, 1000)).toBe(false) // окно 0: 2
    expect(await hitRateLimit(db, 'k', MIN, 2, 2000)).toBe(true) // окно 0: 3 > 2
    expect(await hitRateLimit(db, 'k', MIN, 2, MIN)).toBe(false) // окно MIN: 1
    expect(await hitRateLimit(db, 'k', MIN, 2, MIN + 500)).toBe(false) // окно MIN: 2
    expect(await hitRateLimit(db, 'other', MIN, 2, 2000)).toBe(false) // другой ключ считается отдельно
    expect(await hitRateLimit(db, 'k', MIN, 2, 2 * MIN)).toBe(false) // окно 2·MIN: 1
    const rows = await db.query<{ key: string; window_start: number; count: number }>(
      'select key, window_start, count from rate_limits order by key, window_start',
    )
    expect(rows.map(r => [r.key, Number(r.window_start), r.count])).toEqual([
      ['k', 0, 3],
      ['k', MIN, 2],
      ['k', 2 * MIN, 1],
      ['other', 0, 1],
    ])
  })
})
