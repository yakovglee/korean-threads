import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  handleChat,
  handleCheckAnswer,
  handleCheckPeek,
  handleEvent,
  handleItem,
  handleLemma,
  TEXT,
  type Deps,
} from '../src/lib/api'
import { resolveRole } from '../src/lib/auth'
import { loadConfig } from '../src/lib/config'
import type { Db } from '../src/lib/db'
import { getDeps } from '../src/lib/deps'
import { HTTP } from '../src/lib/http'
import type { LlmClient } from '../src/lib/llm'
import { saveCheck } from '../src/lib/posts'
import * as chatRoute from '../src/app/api/chat/route'
import * as answerRoute from '../src/app/api/checks/answer/route'
import * as eventsRoute from '../src/app/api/events/route'
import * as feedRoute from '../src/app/api/feed/route'
import * as itemRoute from '../src/app/api/items/[id]/route'
import * as lemmaRoute from '../src/app/api/lemma/route'
import * as meRoute from '../src/app/api/me/route'
import * as progressRoute from '../src/app/api/progress/route'
import { openTestDb } from './helpers/testDb'

// Зависимости маршрутов подменяются: база — PGlite, модель — фейк, часы стоят
vi.mock('../src/lib/deps', () => ({ getDeps: vi.fn() }))
// Обработчики настоящие, но со счётчиком вызовов: видно, дошёл ли запрос до них
vi.mock('../src/lib/api', async importOriginal => {
  const m = await importOriginal<typeof import('../src/lib/api')>()
  return {
    ...m,
    handleEvent: vi.fn(m.handleEvent),
    handleChat: vi.fn(m.handleChat),
    handleLemma: vi.fn(m.handleLemma),
    handleItem: vi.fn(m.handleItem),
    handleCheckAnswer: vi.fn(m.handleCheckAnswer),
    handleCheckPeek: vi.fn(m.handleCheckPeek),
  }
})

const NOW = Date.UTC(2026, 10, 16, 3)
const BASE = 'http://app.test'
const cfg = loadConfig({ ANALYZER_URL: 'http://analyzer.test' })
const FAILED = 'сервис временно недоступен'
const TOO_OFTEN = 'слишком часто, подожди немного'

const llm: LlmClient = {
  async json() {
    throw new Error('модель в тестах маршрутов не нужна')
  },
  async vision() {
    throw new Error('модель в тестах маршрутов не нужна')
  },
  async embed() {
    return []
  },
}

let db: Db

beforeEach(async () => {
  db = await openTestDb()
  await db.query(
    `insert into items (id, kind, level, headword, homograph, pos, hint, related, seq)
     values ('v:1', 'vocab', 1, '비', 0, '명사', '', '', 1)`,
  )
  vi.mocked(getDeps).mockImplementation(async (role: Deps['role']) => ({
    db, llm, cfg, now: () => NOW, rng: Math.random, role,
  }))
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

const get = (path: string, headers: Record<string, string> = {}): Request => new Request(`${BASE}${path}`, { headers })

const post = (path: string, body: string, headers: Record<string, string> = {}): Request =>
  new Request(`${BASE}${path}`, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } })

const noParams = { params: Promise.resolve({}) }
const itemParams = (id: string) => ({ params: Promise.resolve({ id }) })

async function count(sql: string): Promise<number> {
  const rows = await db.query<{ n: number }>(sql)
  return rows[0].n
}

const saveP1 = () =>
  saveCheck(db, { id: 'P1', source: 'post', stem: '___ 가', options: ['가', '나', '다', '라'], answerIndex: 0, itemIds: ['v:1'] }, NOW)

const answer = (choice: number, headers: Record<string, string> = {}) =>
  answerRoute.POST(post('/api/checks/answer', JSON.stringify({ checkId: 'P1', choice }), headers), noParams)

describe('обёртка маршрутов', () => {
  it('ApiError → его статус и текст', async () => {
    const res = await feedRoute.GET(get('/api/feed?n=0'), noParams)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'неверные поля запроса' })
    expect(res.headers.get('cache-control')).toBe('no-store')

    // зритель на запись: 403 из обработчика
    vi.stubEnv('NODE_ENV', 'production')
    const denied = await eventsRoute.POST(post('/api/events', JSON.stringify({ itemId: 'v:1', type: 'tap' })), noParams)
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({ error: 'нет доступа' })
    expect(await count('select count(*)::int as n from events')).toBe(0)
  })

  it('посторонняя ошибка → 500 без стека и внутренних имён, в логе только имя ошибки и путь', async () => {
    class PostgresError extends Error {
      constructor(message: string) {
        super(message)
        this.name = 'PostgresError'
      }
    }
    vi.mocked(getDeps).mockRejectedValueOnce(new PostgresError('connect ECONNREFUSED db.internal:6543'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const res = await progressRoute.GET(get('/api/progress?secret=1'), noParams)
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ error: FAILED })
    for (const leak of ['ECONNREFUSED', 'db.internal', 'PostgresError', 'at ', 'Error']) {
      expect(text).not.toContain(leak)
    }

    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]).toEqual(['api: PostgresError /api/progress'])
  })

  it('чужой Origin → 403, обработчик и база не вызваны', async () => {
    const body = JSON.stringify({ itemId: 'v:1', type: 'tap' })
    for (const origin of ['https://evil.test', 'null', 'http://app.test.evil.test']) {
      const res = await eventsRoute.POST(post('/api/events', body, { origin }), noParams)
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'нет доступа' })
    }
    expect(handleEvent).not.toHaveBeenCalled()
    expect(getDeps).not.toHaveBeenCalled()
    expect(await count('select count(*)::int as n from events')).toBe(0)

    // свой Origin проходит
    const ok = await eventsRoute.POST(post('/api/events', body, { origin: BASE }), noParams)
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true, deduped: false })
    expect(handleEvent).toHaveBeenCalledTimes(1)
  })

  it('тело больше 16 КБ → 413, не JSON → 400; обработчик не вызван', async () => {
    const big = JSON.stringify({ message: '가'.repeat(HTTP.BODY_MAX_BYTES) })
    const tooLarge = await chatRoute.POST(post('/api/chat', big, { origin: BASE }), noParams)
    expect(tooLarge.status).toBe(413)
    expect(await tooLarge.json()).toEqual({ error: 'слишком большой запрос' })

    const notJson = await chatRoute.POST(post('/api/chat', '{"message": ', { origin: BASE }), noParams)
    expect(notJson.status).toBe(400)
    expect(await notJson.json()).toEqual({ error: 'тело запроса не JSON' })

    expect(handleChat).not.toHaveBeenCalled()
    expect(getDeps).not.toHaveBeenCalled()
  })

  it('заявленный Content-Length больше 16 КБ → 413 до чтения тела; обработчик и база не вызваны', async () => {
    const small = JSON.stringify({ itemId: 'v:1', type: 'tap' })
    const res = await eventsRoute.POST(
      post('/api/events', small, { origin: BASE, 'content-length': String(HTTP.BODY_MAX_BYTES + 1) }),
      noParams,
    )
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'слишком большой запрос' })
    expect(handleEvent).not.toHaveBeenCalled()
    expect(getDeps).not.toHaveBeenCalled()
    expect(await count('select count(*)::int as n from events')).toBe(0)
  })

  it('Origin с другим портом → 403', async () => {
    const body = JSON.stringify({ itemId: 'v:1', type: 'tap' })
    const otherPort = await eventsRoute.POST(post('/api/events', body, { origin: 'http://app.test:3000' }), noParams)
    expect(otherPort.status).toBe(403)
    expect(await otherPort.json()).toEqual({ error: 'нет доступа' })

    // и наоборот: запрос на порт 3100, Origin без порта
    const req = new Request('http://app.test:3100/api/events', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', origin: BASE },
    })
    const noPort = await eventsRoute.POST(req, noParams)
    expect(noPort.status).toBe(403)

    expect(handleEvent).not.toHaveBeenCalled()
    expect(getDeps).not.toHaveBeenCalled()
  })

  it('viewer: 61-й запрос ленты за минуту → 429, другой IP считается отдельно', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const ip = { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }
    for (let i = 0; i < HTTP.VIEWER_PER_MIN['/api/feed']; i++) {
      const res = await feedRoute.GET(get('/api/feed?n=1', ip), noParams)
      expect(res.status).toBe(200)
    }
    const limited = await feedRoute.GET(get('/api/feed?n=1', ip), noParams)
    expect(limited.status).toBe(429)
    expect(await limited.json()).toEqual({ error: TOO_OFTEN })

    const other = await feedRoute.GET(get('/api/feed?n=1', { 'x-forwarded-for': '198.51.100.2' }), noParams)
    expect(other.status).toBe(200)
    // в ключе лимита хэш, а не сам IP
    const keys = await db.query<{ key: string }>('select key from rate_limits')
    expect(keys).toHaveLength(2)
    for (const { key } of keys) {
      expect(key).toMatch(/^\/api\/feed:[0-9a-f]{64}$/)
      expect(key).not.toContain('203.0.113.7')
    }
  })

  it('viewer: лимит /api/items — 120 в минуту, 121-й → 429', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    expect(HTTP.VIEWER_PER_MIN['/api/items']).toBe(120)
    const ip = { 'x-forwarded-for': '203.0.113.7' }
    for (let i = 0; i < 120; i++) {
      const res = await itemRoute.GET(get('/api/items/v:1', ip), itemParams('v:1'))
      expect(res.status).toBe(200)
    }
    const limited = await itemRoute.GET(get('/api/items/v:1', ip), itemParams('v:1'))
    expect(limited.status).toBe(429)
    expect(await limited.json()).toEqual({ error: TOO_OFTEN })
  })

  it('viewer: лимит /api/checks/answer — 60 в минуту, 61-й → 429', async () => {
    await saveP1()
    vi.stubEnv('NODE_ENV', 'production')
    expect(HTTP.VIEWER_PER_MIN['/api/checks/answer']).toBe(60)
    const ip = { 'x-forwarded-for': '203.0.113.7' }
    for (let i = 0; i < 60; i++) {
      const res = await answer(1, ip)
      expect(res.status).toBe(200)
    }
    const limited = await answer(1, ip)
    expect(limited.status).toBe(429)
    expect(await limited.json()).toEqual({ error: TOO_OFTEN })
    expect(handleCheckPeek).toHaveBeenCalledTimes(60)
    expect(handleCheckAnswer).not.toHaveBeenCalled()
  })

  it('viewer: лимит /api/lemma — 30 в минуту, 31-й → 429', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    expect(HTTP.VIEWER_PER_MIN['/api/lemma']).toBe(30)
    const ip = { 'x-forwarded-for': '203.0.113.7' }
    for (let i = 0; i < 30; i++) {
      const res = await lemmaRoute.GET(get('/api/lemma?lemma=%EB%B9%84&pos=%EB%AA%85%EC%82%AC', ip), noParams)
      expect(res.status).toBe(200)
    }
    const limited = await lemmaRoute.GET(get('/api/lemma?lemma=%EB%B9%84&pos=%EB%AA%85%EC%82%AC', ip), noParams)
    expect(limited.status).toBe(429)
    expect(await limited.json()).toEqual({ error: TOO_OFTEN })
  })

  it('на 429 обработчик не вызван', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const ip = { 'x-forwarded-for': '203.0.113.7' }
    const max = HTTP.VIEWER_PER_MIN['/api/lemma']
    for (let i = 0; i < max; i++) await lemmaRoute.GET(get('/api/lemma?lemma=a&pos=b', ip), noParams)
    expect(handleLemma).toHaveBeenCalledTimes(max)

    const limited = await lemmaRoute.GET(get('/api/lemma?lemma=a&pos=b', ip), noParams)
    expect(limited.status).toBe(429)
    expect(handleLemma).toHaveBeenCalledTimes(max)
  })

  it('владельца лимит не трогает: запросы сверх лимита проходят, счётчик не пишется', async () => {
    const ip = { 'x-forwarded-for': '203.0.113.7' }
    const max = HTTP.VIEWER_PER_MIN['/api/items']
    for (let i = 0; i <= max; i++) {
      const res = await itemRoute.GET(get('/api/items/v:1', ip), itemParams('v:1'))
      expect(res.status).toBe(200)
    }
    expect(handleItem).toHaveBeenCalledTimes(max + 1)
    expect(await count('select count(*)::int as n from rate_limits')).toBe(0)
  })
})

describe('маршруты', () => {
  it('/api/items: неизвестный id → 404, известный → значение', async () => {
    const missing = await itemRoute.GET(get('/api/items/v:999'), { params: Promise.resolve({ id: 'v:999' }) })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'слово не найдено' })

    const found = await itemRoute.GET(get('/api/items/v:1'), { params: Promise.resolve({ id: 'v:1' }) })
    expect(found.status).toBe(200)
    expect(await found.json()).toMatchObject({ item: { id: 'v:1', headword: '비' }, glossRu: null })
  })

  it('/api/chat экспортирует maxDuration = 300', () => {
    expect(chatRoute.maxDuration).toBe(300)
  })

  it('/api/checks/answer: зритель получает ответ без записи', async () => {
    await saveCheck(db, { id: 'P1', source: 'post', stem: '___ 가', options: ['가', '나', '다', '라'], answerIndex: 0, itemIds: ['v:1'] }, NOW)
    vi.stubEnv('NODE_ENV', 'production')
    const res = await answerRoute.POST(post('/api/checks/answer', JSON.stringify({ checkId: 'P1', choice: 2 })), noParams)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ correct: false, answerIndex: 0 })
    expect(await count('select count(*)::int as n from events')).toBe(0)
    expect(await count('select count(*)::int as n from checks where last_answered_at is not null')).toBe(0)
  })

  it('/api/checks/answer: владелец записывает ответ', async () => {
    await saveP1()
    const res = await answer(0)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ correct: true, answerIndex: 0 })
    expect(handleCheckAnswer).toHaveBeenCalledTimes(1)
    expect(handleCheckPeek).not.toHaveBeenCalled()
    const events = await db.query<{ item_id: string; type: string; check_id: string }>(
      'select item_id, type, check_id from events',
    )
    expect(events).toEqual([{ item_id: 'v:1', type: 'check_right', check_id: 'P1' }])
    expect(await count('select count(*)::int as n from checks where last_answered_at is not null')).toBe(1)
  })

  it('/api/lemma: разбор параметров запроса', async () => {
    // нет lemma или одни пробелы → 400 из обработчика
    for (const path of ['/api/lemma?pos=%EB%AA%85%EC%82%AC', '/api/lemma?lemma=%20%20&pos=%EB%AA%85%EC%82%AC']) {
      const res = await lemmaRoute.GET(get(path), noParams)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'неверные поля запроса' })
    }

    // lemma с пробелами по краям и pos из строки запроса доходят до кэша
    await db.query(`insert into lemma_cache (lemma, pos, gloss_ru, source) values ($1, $2, 'дождь', 'krdict')`, ['비', '명사'])
    const url = `/api/lemma?lemma=${encodeURIComponent(' 비 ')}&pos=${encodeURIComponent('명사')}`
    const res = await lemmaRoute.GET(get(url), noParams)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ glossRu: 'дождь', source: 'krdict' })
    expect(vi.mocked(handleLemma).mock.calls.at(-1)?.slice(1)).toEqual([' 비 ', '명사'])
  })

  it('/api/chat: зритель → 403', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const res = await chatRoute.POST(post('/api/chat', JSON.stringify({ message: '안녕' }), { origin: BASE }), noParams)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'нет доступа' })
    expect(await count('select count(*)::int as n from chat_lock')).toBe(0)
  })

  it.each([
    [409, TEXT.busy],
    [429, TEXT.tooOften],
    [502, TEXT.chatFailed],
  ] as const)('/api/chat: статус %i из handleChat переходит в ответ', async (status, error) => {
    vi.mocked(handleChat).mockResolvedValueOnce({ status, error })
    const res = await chatRoute.POST(post('/api/chat', JSON.stringify({ message: '안녕' }), { origin: BASE }), noParams)
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({ error })
    expect(handleChat).toHaveBeenCalledTimes(1)
  })

  it('/api/progress: владелец → 200 с уровнями, зритель → 403', async () => {
    const owner = await progressRoute.GET(get('/api/progress'), noParams)
    expect(owner.status).toBe(200)
    const body = (await owner.json()) as { perLevel: { level: number; total: number }[] }
    expect(body.perLevel.map(l => l.level)).toEqual([1, 2, 3, 4])
    expect(body.perLevel[0]).toMatchObject({ level: 1, total: 1 })

    vi.stubEnv('NODE_ENV', 'production')
    const viewer = await progressRoute.GET(get('/api/progress'), noParams)
    expect(viewer.status).toBe(403)
    expect(await viewer.json()).toEqual({ error: 'нет доступа' })
  })

  it('/api/me отдаёт роль и не открывает базу', async () => {
    const owner = await meRoute.GET(get('/api/me'), noParams)
    expect(await owner.json()).toEqual({ role: 'owner' })
    vi.stubEnv('NODE_ENV', 'production')
    const viewer = await meRoute.GET(get('/api/me'), noParams)
    expect(await viewer.json()).toEqual({ role: 'viewer' })
    expect(getDeps).not.toHaveBeenCalled()
  })
})

describe('resolveRole (заглушка до Task 18)', () => {
  it('NODE_ENV production → viewer, иначе owner', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    expect(await resolveRole(get('/'))).toBe('viewer')
    vi.stubEnv('NODE_ENV', 'development')
    expect(await resolveRole(get('/'))).toBe('owner')
    vi.stubEnv('NODE_ENV', 'test')
    expect(await resolveRole(get('/'))).toBe('owner')
  })
})
