import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/lib/config'
import { checkModels, LlmError, modelPrices, openRouterClient } from '../src/lib/llm'

const KEY = 'sk-or-v1-TESTKEY'
const cfg = (env: Record<string, string | undefined> = { OPENROUTER_API_KEY: KEY }) => loadConfig(env)
const FAST = { retryDelayMs: 0 }
const SCHEMA = { type: 'object', properties: { x: { type: 'number' } }, required: ['x'], additionalProperties: false }
const JSON_ARGS = { role: 'write' as const, system: 'система', user: 'вопрос', schema: SCHEMA, schemaName: 'thing' }

interface Sent {
  model: string
  messages: { role: string; content: unknown }[]
  temperature?: number
  response_format?: { type: string; json_schema?: { name: string; strict: boolean; schema: unknown } }
  input?: string[]
}
interface Call { url: string; init: RequestInit }

const sentOf = (c: Call): Sent => JSON.parse(String(c.init.body)) as Sent
const headerOf = (c: Call): Record<string, string> => c.init.headers as Record<string, string>

// фейковый fetch: запоминает вызовы, ответ выбирает по url, init и номеру вызова
function fake(respond: (url: string, init: RequestInit, n: number) => Response) {
  const calls: Call[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} }
    calls.push(call)
    return respond(call.url, call.init, calls.length - 1)
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

// «зависший» fetch: отклоняется только когда сигнал запроса прерван, с его reason (как в браузере и Node)
function hanging() {
  const calls: Call[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (signal) signal.addEventListener('abort', () => reject(signal.reason))
    })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const chatOk = (content: unknown): Response =>
  jsonRes({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } })
const chatWith = (content: unknown, finishReason: string): Response =>
  jsonRes({ choices: [{ message: { content }, finish_reason: finishReason }], usage: { prompt_tokens: 10, completion_tokens: 5 } })
const errRes = (status: number, message: string): Response => jsonRes({ error: { code: status, message } }, status)

async function errOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (e) {
    return e
  }
  throw new Error('ожидалась ошибка, а промис выполнился')
}

describe('openRouterClient', () => {
  it('json отправляет json_schema и разбирает ответ', async () => {
    const f = fake(() => chatOk('{"x":1}'))
    const llm = openRouterClient(cfg(), f.fetchImpl, FAST)
    const r = await llm.json<{ x: number }>(JSON_ARGS)
    expect(f.calls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(headerOf(f.calls[0]).Authorization).toBe(`Bearer ${KEY}`)
    expect(f.calls[0].init.signal).toBeInstanceOf(AbortSignal)
    const sent = sentOf(f.calls[0])
    expect(sent.model).toBe('anthropic/claude-sonnet-5.5')
    expect(sent.response_format?.type).toBe('json_schema')
    expect(sent.response_format?.json_schema).toMatchObject({ name: 'thing', strict: true, schema: SCHEMA })
    expect(r.value).toEqual({ x: 1 })
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
  })

  it('json: при отказе json_schema повторяет с json_object', async () => {
    const f = fake((_u, _i, n) => (n === 0 ? errRes(400, 'response_format json_schema is not supported by this provider') : chatOk('{"x":2}')))
    const llm = openRouterClient(cfg(), f.fetchImpl, FAST)
    const r = await llm.json<{ x: number }>({ ...JSON_ARGS, role: 'light' })
    expect(f.calls).toHaveLength(2)
    expect(sentOf(f.calls[1]).response_format).toEqual({ type: 'json_object' })
    expect(sentOf(f.calls[1]).messages[0].content).toContain(JSON.stringify(SCHEMA))
    expect(r.value).toEqual({ x: 2 })
  })

  it('json: невалидный JSON → LlmError', async () => {
    const f = fake(() => chatOk('это не JSON {'))
    const llm = openRouterClient(cfg(), f.fetchImpl, FAST)
    const e = await errOf(llm.json(JSON_ARGS))
    expect(e).toBeInstanceOf(LlmError)
  })

  it('vision кладёт PNG как data URL в image_url', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const f = fake(() => chatOk('распознано'))
    const llm = openRouterClient(cfg(), f.fetchImpl, FAST)
    const r = await llm.vision({ imagePng: png, prompt: 'перепиши страницу' })
    const parts = sentOf(f.calls[0]).messages[0].content as { type: string; text?: string; image_url?: { url: string } }[]
    const url = parts.find(p => p.type === 'image_url')?.image_url?.url ?? ''
    expect(url.startsWith('data:image/png;base64,')).toBe(true)
    expect(Buffer.from(url.slice('data:image/png;base64,'.length), 'base64').equals(png)).toBe(true)
    expect(parts.find(p => p.type === 'text')?.text).toBe('перепиши страницу')
    expect(sentOf(f.calls[0]).model).toBe('google/gemini-3.8-flash')
    expect(r.text).toBe('распознано')
  })

  it('embed режет на пакеты по 64 и склеивает результат в порядке', async () => {
    const texts = Array.from({ length: 130 }, (_, i) => String(i))
    const f = fake((_u, init) => {
      const input = (JSON.parse(String(init.body)) as Sent).input ?? []
      // ответ отдаём в обратном порядке: склеивать нужно по index, а не по позиции в data
      const data = input.map((t, i) => ({ index: i, embedding: [Number(t)] })).reverse()
      return jsonRes({ data })
    })
    const llm = openRouterClient(cfg(), f.fetchImpl, FAST)
    const vecs = await llm.embed(texts)
    expect(f.calls.map(c => sentOf(c).input?.length)).toEqual([64, 64, 2])
    expect(sentOf(f.calls[0]).model).toBe('baai/bge-m3')
    expect(f.calls[0].url).toBe('https://openrouter.ai/api/v1/embeddings')
    expect(vecs).toEqual(texts.map(t => [Number(t)]))
  })

  it('429 повторяется, затем LlmError со status', async () => {
    const f = fake(() => errRes(429, 'rate limited'))
    const llm = openRouterClient(cfg(), f.fetchImpl, FAST)
    const e = await errOf(llm.json(JSON_ARGS))
    expect(e).toBeInstanceOf(LlmError)
    expect((e as LlmError).status).toBe(429)
    expect(f.calls).toHaveLength(3)
  })

  it('без ключа LlmError до сетевого вызова', async () => {
    const f = fake(() => chatOk('{"x":1}'))
    const llm = openRouterClient(cfg({}), f.fetchImpl, FAST)
    const e = await errOf(llm.json(JSON_ARGS))
    expect(e).toBeInstanceOf(LlmError)
    expect((e as Error).message).toBe('OPENROUTER_API_KEY не задан')
    expect(f.calls).toHaveLength(0)
  })

  it('ключ уходит только в Authorization и не попадает в текст ошибки', async () => {
    const f = fake(() => errRes(500, `сбой при ключе ${KEY}`))
    const llm = openRouterClient(cfg(), f.fetchImpl, FAST)
    const e = await errOf(llm.json(JSON_ARGS))
    expect((e as Error).message).not.toContain(KEY)
    expect(headerOf(f.calls[0]).Authorization).toBe(`Bearer ${KEY}`)
    expect(String(f.calls[0].init.body)).not.toContain(KEY)
  })

  it('5xx повторяется и успех на третьей попытке', async () => {
    const f = fake((_u, _i, n) => (n < 2 ? errRes(503, 'unavailable') : chatOk('{"x":3}')))
    const llm = openRouterClient(cfg(), f.fetchImpl, FAST)
    const r = await llm.json<{ x: number }>(JSON_ARGS)
    expect(r.value).toEqual({ x: 3 })
    expect(f.calls).toHaveLength(3)
  })

  it('400 без признаков json_schema не повторяется', async () => {
    const f = fake(() => errRes(400, 'model not found'))
    const llm = openRouterClient(cfg(), f.fetchImpl, FAST)
    const e = await errOf(llm.json(JSON_ARGS))
    expect((e as LlmError).status).toBe(400)
    expect(f.calls).toHaveLength(1)
  })

  it('пустой content → LlmError', async () => {
    const f = fake(() => chatOk(''))
    const llm = openRouterClient(cfg(), f.fetchImpl, FAST)
    expect(await errOf(llm.json(JSON_ARGS))).toBeInstanceOf(LlmError)
    expect(await errOf(llm.vision({ imagePng: Buffer.from([1]), prompt: 'p' }))).toBeInstanceOf(LlmError)
  })

  it('embed([]) возвращает [] без запроса', async () => {
    const f = fake(() => jsonRes({ data: [] }))
    const llm = openRouterClient(cfg(), f.fetchImpl, FAST)
    expect(await llm.embed([])).toEqual([])
    expect(f.calls).toHaveLength(0)
  })

  it('embed: число векторов не совпало с числом текстов → LlmError', async () => {
    const f = fake(() => jsonRes({ data: [{ index: 0, embedding: [1] }] }))
    const llm = openRouterClient(cfg(), f.fetchImpl, FAST)
    expect(await errOf(llm.embed(['a', 'b']))).toBeInstanceOf(LlmError)
  })

  it('temperature не уходит в тело запроса, если не передана', async () => {
    const f = fake(() => chatOk('{"x":1}'))
    const llm = openRouterClient(cfg(), f.fetchImpl, FAST)
    await llm.json(JSON_ARGS)
    expect('temperature' in sentOf(f.calls[0])).toBe(false)
  })

  it('temperature 0.2 уходит в тело запроса', async () => {
    const f = fake(() => chatOk('{"x":1}'))
    const llm = openRouterClient(cfg(), f.fetchImpl, FAST)
    await llm.json({ ...JSON_ARGS, temperature: 0.2 })
    expect(sentOf(f.calls[0]).temperature).toBe(0.2)
  })

  it('json снимает обрамление ```json … ```', async () => {
    const f = fake((_u, _i, n) => (n === 0 ? chatOk('```json\n{"x":4}\n```') : chatOk('```\n{"x":5}\n```')))
    const llm = openRouterClient(cfg(), f.fetchImpl, FAST)
    expect((await llm.json<{ x: number }>(JSON_ARGS)).value).toEqual({ x: 4 })
    expect((await llm.json<{ x: number }>(JSON_ARGS)).value).toEqual({ x: 5 })
  })

  it('json разбирает обычный JSON без обрамления', async () => {
    const f = fake(() => chatOk('  {"x":6}  '))
    const llm = openRouterClient(cfg(), f.fetchImpl, FAST)
    expect((await llm.json<{ x: number }>(JSON_ARGS)).value).toEqual({ x: 6 })
  })

  it('тайм-аут: прерванный запрос → LlmError «OpenRouter не ответил за N с», без повтора', async () => {
    const h = hanging()
    const llm = openRouterClient(cfg(), h.fetchImpl, { retryDelayMs: 0, timeoutMs: 20 })
    const e = await errOf(llm.json(JSON_ARGS))
    expect(e).toBeInstanceOf(LlmError)
    expect((e as LlmError).message).toMatch(/OpenRouter не ответил за /)
    expect((e as LlmError).status).toBeUndefined()
    expect(h.calls).toHaveLength(1)
  })

  it('vision: непустой content с finish_reason length → LlmError про обрезанный ответ', async () => {
    const f = fake(() => chatWith('Крас', 'length'))
    const llm = openRouterClient(cfg(), f.fetchImpl, FAST)
    const e = await errOf(llm.vision({ imagePng: Buffer.from([1]), prompt: 'p' }))
    expect(e).toBeInstanceOf(LlmError)
    expect((e as LlmError).message).toBe('ответ модели обрезан: не хватило maxTokens')
    expect((e as LlmError).status).toBeUndefined()
  })

  it('json: валидный JSON с finish_reason length → такой же LlmError, без повтора', async () => {
    const f = fake(() => chatWith('{"x":1}', 'length'))
    const llm = openRouterClient(cfg(), f.fetchImpl, FAST)
    const e = await errOf(llm.json(JSON_ARGS))
    expect(e).toBeInstanceOf(LlmError)
    expect((e as LlmError).message).toBe('ответ модели обрезан: не хватило maxTokens')
    expect((e as LlmError).status).toBeUndefined()
    expect(f.calls).toHaveLength(1)
  })

  it('json: невалидный JSON → LlmError kind invalid с usage ответа', async () => {
    const f = fake(() => chatOk('это не JSON {'))
    const llm = openRouterClient(cfg(), f.fetchImpl, FAST)
    const e = await errOf(llm.json(JSON_ARGS))
    expect(e).toBeInstanceOf(LlmError)
    expect(e).toMatchObject({ message: 'модель вернула невалидный JSON', kind: 'invalid', usage: { inputTokens: 10, outputTokens: 5 } })
  })

  it('json: обрезанный ответ → LlmError kind truncated с usage ответа; HTTP-ошибка без kind и usage', async () => {
    const cut = await errOf(openRouterClient(cfg(), fake(() => chatWith('{"x":1}', 'length')).fetchImpl, FAST).json(JSON_ARGS))
    expect(cut).toMatchObject({ kind: 'truncated', usage: { inputTokens: 10, outputTokens: 5 } })
    const http = await errOf(openRouterClient(cfg(), fake(() => errRes(400, 'model not found')).fetchImpl, FAST).json(JSON_ARGS))
    expect(http).toBeInstanceOf(LlmError)
    expect((http as LlmError).kind).toBeUndefined()
    expect((http as LlmError).usage).toBeUndefined()
  })

  it('finish_reason stop проходит как раньше', async () => {
    const f = fake((_u, _i, n) => (n === 0 ? chatWith('распознано', 'stop') : chatWith('{"x":7}', 'stop')))
    const llm = openRouterClient(cfg(), f.fetchImpl, FAST)
    expect((await llm.vision({ imagePng: Buffer.from([1]), prompt: 'p' })).text).toBe('распознано')
    expect((await llm.json<{ x: number }>(JSON_ARGS)).value).toEqual({ x: 7 })
  })

  it('пустой content с finish_reason stop → в тексте ошибки finish_reason: stop', async () => {
    const f = fake(() => chatWith('', 'stop'))
    const llm = openRouterClient(cfg(), f.fetchImpl, FAST)
    const e1 = await errOf(llm.json(JSON_ARGS))
    const e2 = await errOf(llm.vision({ imagePng: Buffer.from([1]), prompt: 'p' }))
    expect((e1 as Error).message).toContain('finish_reason: stop')
    expect((e2 as Error).message).toContain('finish_reason: stop')
  })

  it('embed: null-элемент в data → LlmError', async () => {
    const f = fake(() => jsonRes({ data: [null] }))
    const llm = openRouterClient(cfg(), f.fetchImpl, FAST)
    expect(await errOf(llm.embed(['a']))).toBeInstanceOf(LlmError)
  })

  it('embed: пустой вектор → LlmError', async () => {
    const f = fake(() => jsonRes({ data: [{ index: 0, embedding: [] }] }))
    const llm = openRouterClient(cfg(), f.fetchImpl, FAST)
    expect(await errOf(llm.embed(['a']))).toBeInstanceOf(LlmError)
  })

  it('embed: дубль index → LlmError', async () => {
    const f = fake(() => jsonRes({ data: [{ index: 0, embedding: [1] }, { index: 0, embedding: [2] }] }))
    const llm = openRouterClient(cfg(), f.fetchImpl, FAST)
    expect(await errOf(llm.embed(['a', 'b']))).toBeInstanceOf(LlmError)
  })

  it('json: значение не объект → LlmError «модель вернула не объект»', async () => {
    for (const content of ['null', '[1]', '"x"']) {
      const f = fake(() => chatOk(content))
      const llm = openRouterClient(cfg(), f.fetchImpl, FAST)
      const e = await errOf(llm.json(JSON_ARGS))
      expect(e).toBeInstanceOf(LlmError)
      expect((e as LlmError).message).toBe('модель вернула не объект')
    }
  })

  it('ошибка в ответе 200 без choices → LlmError с текстом провайдера и status, без повтора', async () => {
    const f = fake(() => jsonRes({ error: { code: 502, message: 'Provider returned error' } }))
    const llm = openRouterClient(cfg(), f.fetchImpl, FAST)
    const e = await errOf(llm.json(JSON_ARGS))
    expect(e).toBeInstanceOf(LlmError)
    expect((e as LlmError).message).toContain('Provider returned error')
    expect((e as LlmError).status).toBe(502)
    expect(f.calls).toHaveLength(1)
  })

  it('сетевая ошибка fetch → LlmError без status, ровно один вызов', async () => {
    const f = fake(() => {
      throw new TypeError('fetch failed')
    })
    const llm = openRouterClient(cfg(), f.fetchImpl, FAST)
    const e = await errOf(llm.json(JSON_ARGS))
    expect(e).toBeInstanceOf(LlmError)
    expect((e as LlmError).status).toBeUndefined()
    expect(f.calls).toHaveLength(1)
  })

  it('ответ 200 с не-JSON телом → LlmError', async () => {
    const f = fake(() => new Response('<html>ошибка</html>', { status: 200 }))
    const llm = openRouterClient(cfg(), f.fetchImpl, FAST)
    const e = await errOf(llm.json(JSON_ARGS))
    expect(e).toBeInstanceOf(LlmError)
  })

  it('успех после одного 429: два вызова', async () => {
    const f = fake((_u, _i, n) => (n === 0 ? errRes(429, 'rate limited') : chatOk('{"x":8}')))
    const llm = openRouterClient(cfg(), f.fetchImpl, FAST)
    const r = await llm.json<{ x: number }>(JSON_ARGS)
    expect(r.value).toEqual({ x: 8 })
    expect(f.calls).toHaveLength(2)
  })
})

type ListedRow = { id: string; input_modalities: string[]; prompt: string; completion?: string }
const CHAT_MODELS: ListedRow[] = [
  { id: 'anthropic/claude-sonnet-5.5', input_modalities: ['text'], prompt: '0.000003', completion: '0.000015' },
  { id: 'anthropic/claude-haiku-5.5', input_modalities: ['text'], prompt: '0.000001', completion: '0.000005' },
  { id: 'google/gemini-3.8-flash', input_modalities: ['text', 'image'], prompt: '0.0000003', completion: '0.0000025' },
]
const EMBED_MODELS: ListedRow[] = [{ id: 'baai/bge-m3', input_modalities: ['text'], prompt: '0.00000001' }]

const toItems = (rows: ListedRow[]) =>
  rows.map(r => ({
    id: r.id,
    architecture: { input_modalities: r.input_modalities },
    pricing: { prompt: r.prompt, completion: r.completion },
  }))
const listOf = (rows: ListedRow[]): Response => jsonRes({ data: toItems(rows) })

const modelsFake = (chat: ListedRow[], embed: ListedRow[]) =>
  fake(url => (url.endsWith('/embeddings/models') ? listOf(embed) : listOf(chat)))

describe('modelPrices', () => {
  it('цены за токен по /models: строки переводятся в числа; эмбеддинги не запрашиваются', async () => {
    const f = fake(() => listOf(CHAT_MODELS))
    const prices = await modelPrices(cfg(), f.fetchImpl)
    expect(f.calls.map(c => c.url)).toEqual(['https://openrouter.ai/api/v1/models'])
    expect(headerOf(f.calls[0]).Authorization).toBe(`Bearer ${KEY}`)
    expect(prices.size).toBe(3)
    expect(prices.get('anthropic/claude-sonnet-5.5')).toEqual({ prompt: 0.000003, completion: 0.000015 })
    expect(prices.get('google/gemini-3.8-flash')).toEqual({ prompt: 0.0000003, completion: 0.0000025 })
  })

  it('модель без числовой цены в Map не попадает', async () => {
    const rows: ListedRow[] = [...CHAT_MODELS, { id: 'x/no-price', input_modalities: ['text'], prompt: 'н/д', completion: '0.1' }]
    const prices = await modelPrices(cfg(), fake(() => listOf(rows)).fetchImpl)
    expect(prices.has('x/no-price')).toBe(false)
    expect(prices.has('anthropic/claude-haiku-5.5')).toBe(true)
  })

  it('без ключа LlmError до сетевого вызова', async () => {
    const f = fake(() => listOf(CHAT_MODELS))
    const e = await errOf(modelPrices(cfg({}), f.fetchImpl))
    expect(e).toBeInstanceOf(LlmError)
    expect((e as Error).message).toBe('OPENROUTER_API_KEY не задан')
    expect(f.calls).toHaveLength(0)
  })

  it('HTTP-ошибка → LlmError со status, ключ не попадает в текст', async () => {
    const f = fake(() => errRes(401, `invalid key ${KEY}`))
    const e = await errOf(modelPrices(cfg(), f.fetchImpl))
    expect(e).toBeInstanceOf(LlmError)
    expect((e as LlmError).status).toBe(401)
    expect((e as Error).message).not.toContain(KEY)
  })

  it('тайм-аут → LlmError «не ответил», без повтора', async () => {
    const h = hanging()
    const e = await errOf(modelPrices(cfg(), h.fetchImpl, { timeoutMs: 20 }))
    expect(e).toBeInstanceOf(LlmError)
    expect((e as LlmError).message).toMatch(/OpenRouter не ответил за /)
    expect(h.calls).toHaveLength(1)
  })
})

describe('checkModels', () => {
  it('checkModels: все найдены', async () => {
    const f = modelsFake(CHAT_MODELS, EMBED_MODELS)
    const r = await checkModels(cfg(), f.fetchImpl)
    expect(r.ok).toBe(true)
    expect(r.missing).toEqual([])
    expect(r.lines).toHaveLength(5)
    expect(r.lines.join('\n')).toContain('$3.000')
    expect(f.calls.map(c => c.url)).toContain('https://openrouter.ai/api/v1/models')
    expect(f.calls.map(c => c.url)).toContain('https://openrouter.ai/api/v1/embeddings/models')
    expect(headerOf(f.calls[0]).Authorization).toBe(`Bearer ${KEY}`)
  })

  it('checkModels: одной модели нет', async () => {
    const f = modelsFake(CHAT_MODELS.filter(m => m.id !== 'anthropic/claude-haiku-5.5'), EMBED_MODELS)
    const r = await checkModels(cfg(), f.fetchImpl)
    expect(r.ok).toBe(false)
    expect(r.missing).toEqual(['light: anthropic/claude-haiku-5.5'])
  })

  it('checkModels: у vision нет image', async () => {
    const chat = CHAT_MODELS.map(m => (m.id === 'google/gemini-3.8-flash' ? { ...m, input_modalities: ['text'] } : m))
    const r = await checkModels(cfg(), modelsFake(chat, EMBED_MODELS).fetchImpl)
    expect(r.ok).toBe(false)
    expect(r.missing).toEqual(['vision: google/gemini-3.8-flash (нет входа image)'])
  })

  it('checkModels: тайм-аут через третий параметр → LlmError', async () => {
    const h = hanging()
    const e = await errOf(checkModels(cfg(), h.fetchImpl, { timeoutMs: 20 }))
    expect(e).toBeInstanceOf(LlmError)
    expect((e as LlmError).message).toMatch(/OpenRouter не ответил за /)
    expect(h.calls).toHaveLength(1)
  })

  it('checkModels: null-элемент в списке пропускается, остальные найдены', async () => {
    const f = fake(url => jsonRes({ data: [null, ...toItems(url.endsWith('/embeddings/models') ? EMBED_MODELS : CHAT_MODELS)] }))
    const r = await checkModels(cfg(), f.fetchImpl)
    expect(r.ok).toBe(true)
    expect(r.missing).toEqual([])
  })

  it('checkModels: embed-модели нет в /embeddings/models → ok false и строка в missing', async () => {
    const r = await checkModels(cfg(), modelsFake(CHAT_MODELS, []).fetchImpl)
    expect(r.ok).toBe(false)
    expect(r.missing).toEqual(['embed: baai/bge-m3'])
    expect(r.lines.join('\n')).toContain('НЕ НАЙДЕНА')
  })
})
