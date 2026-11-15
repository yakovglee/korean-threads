// Клиент OpenRouter: чат с JSON-схемой, картинки, эмбеддинги, проверка списка моделей.
// Ключ уходит только в заголовке Authorization и вырезается из всех текстов ошибок.
import type { Config, ModelRole } from './config'

const BASE_URL = 'https://openrouter.ai/api/v1'
const EMBED_BATCH = 64
const MAX_RETRIES = 2
const DEFAULT_RETRY_DELAY_MS = 1000
const DEFAULT_TIMEOUT_MS = 120000
const DEFAULT_MAX_TOKENS = 4000
const REDACTED = '[ключ скрыт]'
const MODEL_ROLES: ModelRole[] = ['write', 'light', 'vision', 'verify', 'embed']

export interface Usage { inputTokens: number; outputTokens: number }

export class LlmError extends Error {
  constructor(message: string, public status?: number) {
    super(message)
    this.name = 'LlmError'
  }
}

export interface LlmClient {
  json<T>(args: { role: 'write' | 'light' | 'verify'; system: string; user: string; schema: object; schemaName: string; maxTokens?: number; temperature?: number }): Promise<{ value: T; usage: Usage }>
  vision(args: { imagePng: Buffer; prompt: string; maxTokens?: number }): Promise<{ text: string; usage: Usage }>
  embed(texts: string[]): Promise<number[][]>
}

export interface OpenRouterOptions { retryDelayMs?: number; timeoutMs?: number }

export interface ModelCheck { ok: boolean; missing: string[]; lines: string[] }

interface ChatResponse { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } }
interface EmbedResponse { data?: unknown }
interface ListedRow { id?: unknown; architecture?: { input_modalities?: unknown }; pricing?: { prompt?: unknown; completion?: unknown } }
interface Listed { inputModalities: string[]; prompt: number; completion: number }

export function openRouterClient(cfg: Config, fetchImpl?: typeof fetch, opts: OpenRouterOptions = {}): LlmClient {
  const doFetch = fetchImpl ?? fetch
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  // POST с повтором при 429 и 5xx: до MAX_RETRIES повторов, пауза растёт линейно
  async function send(path: string, body: unknown): Promise<unknown> {
    const key = requireKey(cfg)
    for (let attempt = 0; ; attempt++) {
      const res = await callOnce(doFetch, `${BASE_URL}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, key, timeoutMs)
      if (!res.ok) {
        if (attempt < MAX_RETRIES && (res.status === 429 || res.status >= 500)) {
          await sleep(retryDelayMs * (attempt + 1))
          continue
        }
        throw httpError(res.status, res.text, key)
      }
      const body200 = parseJson(res.text)
      bodyError(body200, key)
      return body200
    }
  }

  return {
    async json<T>(args: { role: 'write' | 'light' | 'verify'; system: string; user: string; schema: object; schemaName: string; maxTokens?: number; temperature?: number }): Promise<{ value: T; usage: Usage }> {
      const base = {
        model: cfg.models[args.role],
        max_tokens: args.maxTokens ?? DEFAULT_MAX_TOKENS,
        // temperature уходит в запрос только если её передали явно
        ...(args.temperature === undefined ? {} : { temperature: args.temperature }),
      }
      const messages = (system: string) => [
        { role: 'system', content: system },
        { role: 'user', content: args.user },
      ]
      let data: unknown
      try {
        data = await send('/chat/completions', {
          ...base,
          messages: messages(args.system),
          response_format: { type: 'json_schema', json_schema: { name: args.schemaName, strict: true, schema: args.schema } },
        })
      } catch (e) {
        if (!isSchemaUnsupported(e)) throw e
        // запасной путь: эндпоинт не знает json_schema, просим json_object и описываем схему в system
        data = await send('/chat/completions', {
          ...base,
          messages: messages(`${args.system}\n\nОтвет — только JSON по схеме:\n${JSON.stringify(args.schema)}`),
          response_format: { type: 'json_object' },
        })
      }
      const content = unfence(textContent(data))
      let parsed: unknown
      try {
        parsed = JSON.parse(content) as unknown
      } catch {
        throw new LlmError('модель вернула невалидный JSON')
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new LlmError('модель вернула не объект')
      return { value: parsed as T, usage: usageOf(data) }
    },

    async vision(args: { imagePng: Buffer; prompt: string; maxTokens?: number }): Promise<{ text: string; usage: Usage }> {
      const data = await send('/chat/completions', {
        model: cfg.models.vision,
        max_tokens: args.maxTokens ?? DEFAULT_MAX_TOKENS,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: args.prompt },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${args.imagePng.toString('base64')}` } },
          ],
        }],
      })
      return { text: textContent(data), usage: usageOf(data) }
    },

    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return []
      const out: number[][] = []
      for (let i = 0; i < texts.length; i += EMBED_BATCH) {
        const batch = texts.slice(i, i + EMBED_BATCH)
        const data = await send('/embeddings', { model: cfg.models.embed, input: batch })
        out.push(...vectorsOf(data, batch.length))
      }
      return out
    },
  }
}

// Проверка моделей из Config.models: чат и vision — в /models, эмбеддинги — в /embeddings/models.
export async function checkModels(cfg: Config, fetchImpl?: typeof fetch, opts: OpenRouterOptions = {}): Promise<ModelCheck> {
  const key = requireKey(cfg)
  const doFetch = fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const chat = await listModels(doFetch, '/models', key, timeoutMs)
  const embed = await listModels(doFetch, '/embeddings/models', key, timeoutMs)

  const missing: string[] = []
  const lines: string[] = []
  for (const role of MODEL_ROLES) {
    const id = cfg.models[role]
    const found = (role === 'embed' ? embed : chat).get(id)
    if (!found) {
      missing.push(`${role}: ${id}`)
      lines.push(`${role.padEnd(7)} ${id}  НЕ НАЙДЕНА`)
      continue
    }
    const noImage = role === 'vision' && !found.inputModalities.includes('image')
    if (noImage) missing.push(`${role}: ${id} (нет входа image)`)
    lines.push(`${role.padEnd(7)} ${id}  вход $${perMillion(found.prompt)}, выход $${perMillion(found.completion)} за 1M токенов${noImage ? '  нет входа image' : ''}`)
  }
  return { ok: missing.length === 0, missing, lines }
}

async function listModels(doFetch: typeof fetch, path: string, key: string, timeoutMs: number): Promise<Map<string, Listed>> {
  const res = await callOnce(doFetch, `${BASE_URL}${path}`, { headers: { Authorization: `Bearer ${key}` } }, key, timeoutMs)
  if (!res.ok) throw httpError(res.status, res.text, key)
  const rows = (parseJson(res.text) as { data?: unknown } | null)?.data
  if (!Array.isArray(rows)) throw new LlmError(`${path}: неожиданный формат ответа`)

  const map = new Map<string, Listed>()
  for (const item of rows as unknown[]) {
    if (typeof item !== 'object' || item === null) continue
    const row = item as ListedRow
    if (typeof row.id !== 'string') continue
    const modalities = row.architecture?.input_modalities
    map.set(row.id, {
      inputModalities: Array.isArray(modalities) ? modalities.filter((m): m is string => typeof m === 'string') : [],
      prompt: Number(row.pricing?.prompt),
      completion: Number(row.pricing?.completion),
    })
  }
  return map
}

// Один HTTP-вызов с тайм-аутом на весь запрос, включая чтение тела; без повторов
async function callOnce(doFetch: typeof fetch, url: string, init: RequestInit, key: string, timeoutMs: number): Promise<{ status: number; ok: boolean; text: string }> {
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    const res = await doFetch(url, { ...init, signal })
    return { status: res.status, ok: res.ok, text: await res.text() }
  } catch (e) {
    if (signal.aborted) throw new LlmError(`OpenRouter не ответил за ${timeoutMs / 1000} с`)
    throw new LlmError(`сеть недоступна: ${redact(errorText(e), key)}`)
  }
}

function requireKey(cfg: Config): string {
  if (!cfg.openrouterKey) throw new LlmError('OPENROUTER_API_KEY не задан')
  return cfg.openrouterKey
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new LlmError('ответ OpenRouter не JSON')
  }
}

function httpError(status: number, text: string, key: string): LlmError {
  let detail: unknown
  try {
    detail = (JSON.parse(text) as { error?: { message?: unknown } } | null)?.error?.message
  } catch {
    detail = undefined
  }
  const message = typeof detail === 'string' && detail !== '' ? detail : `HTTP ${status}`
  return new LlmError(`OpenRouter ${status}: ${redact(message, key)}`, status)
}

// Ошибка внутри ответа 200: в теле нет choices, а есть error (провайдер не ответил); status берём из code, если это число
function bodyError(body: unknown, key: string): void {
  if (typeof body !== 'object' || body === null || 'choices' in body) return
  const err = (body as { error?: { code?: unknown; message?: unknown } }).error
  if (!err || typeof err.message !== 'string' || err.message === '') return
  const status = typeof err.code === 'number' ? err.code : undefined
  const prefix = status === undefined ? 'OpenRouter' : `OpenRouter ${status}`
  throw new LlmError(`${prefix}: ${redact(err.message, key)}`, status)
}

// json_schema не поддерживается: 400, 404 или 422 с упоминанием формата ответа в тексте ошибки
function isSchemaUnsupported(e: unknown): boolean {
  return e instanceof LlmError && [400, 404, 422].includes(e.status ?? -1) && /response_format|json_schema|structured/i.test(e.message)
}

function textContent(data: unknown): string {
  const choice = (data as ChatResponse | null)?.choices?.[0]
  const content = choice?.message?.content
  // обрезанный по maxTokens ответ не принимаем, даже если часть текста пришла (например, «Крас» вместо «Красный»)
  if (choice?.finish_reason === 'length') throw new LlmError('ответ модели обрезан: не хватило maxTokens')
  // finish_reason в тексте ошибки: по нему видно, почему ответ пустой
  if (typeof content !== 'string' || content.trim() === '') throw new LlmError(`пустой ответ модели (finish_reason: ${String(choice?.finish_reason ?? 'нет')})`)
  return content
}

// Модели иногда оборачивают JSON в Markdown: первая строка ``` (или ```json), последняя ```
function unfence(content: string): string {
  const lines = content.trim().split('\n')
  if (lines.length >= 2 && /^```(json)?$/i.test(lines[0].trim()) && lines[lines.length - 1].trim() === '```') {
    return lines.slice(1, -1).join('\n')
  }
  return content
}

function usageOf(data: unknown): Usage {
  const u = (data as ChatResponse | null)?.usage
  return { inputTokens: u?.prompt_tokens ?? 0, outputTokens: u?.completion_tokens ?? 0 }
}

function vectorsOf(data: unknown, n: number): number[][] {
  const rows = (data as EmbedResponse | null)?.data
  if (!Array.isArray(rows)) throw new LlmError('ответ эмбеддингов без поля data')
  if (rows.length !== n) throw new LlmError(`векторов ${rows.length}, ожидалось ${n}`)
  const bad = new LlmError('ответ эмбеддингов с неверным index или вектором')
  const vecs = new Array<number[] | undefined>(n)
  for (const row of rows as unknown[]) {
    if (typeof row !== 'object' || row === null) throw bad
    const { index, embedding } = row as { index?: unknown; embedding?: unknown }
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= n) throw bad
    if (!Array.isArray(embedding) || embedding.length === 0 || !embedding.every(x => typeof x === 'number')) throw bad
    if (vecs[index] !== undefined) throw bad
    vecs[index] = embedding
  }
  return vecs as number[][]
}

function perMillion(perToken: number): string {
  return Number.isFinite(perToken) ? (perToken * 1e6).toFixed(3) : 'н/д'
}

// Текст ошибки не должен содержать ключ, даже если сервер его вернул
function redact(text: string, key: string): string {
  return text.split(key).join(REDACTED)
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
