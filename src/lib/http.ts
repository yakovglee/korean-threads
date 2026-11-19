// Общая обёртка route.ts: проверки запроса, роль, лимиты и перевод ошибок в короткий ответ по-русски.
//
// Рантайм и кэш (Next 16, в next.config.ts включён cacheComponents): экспорты `runtime` и `dynamic` в этом режиме
// не поддерживаются, Node.js — рантайм по умолчанию. GET-обработчик, который читает запрос (url, заголовки),
// не пререндерится и выполняется на каждый запрос; обёртка читает req.url первым делом. Ответы идут с
// Cache-Control: no-store, чтобы их не кэшировали браузер и CDN.
//
// Порядок для POST: Origin (403) → размер тела (413: сначала заявленный Content-Length, затем фактически
// прочитанное) → JSON (400), всё до роли и обработчика. Затем (и у GET) роль, лимит маршрута для всех, кроме
// владельца (429), и обработчик. ApiError → его статус и текст; любая другая ошибка → 500 с общим
// текстом, в лог только имя ошибки и путь (без тела, заголовков, текста ошибки и стека).
import { createHash } from 'node:crypto'
import { unstable_rethrow } from 'next/navigation'
import { ApiError, hitRateLimit, type Deps } from './api'
import { resolveRole, type Role } from './auth'
import { getDeps } from './deps'

export const HTTP = {
  BODY_MAX_BYTES: 16 * 1024,
  RATE_WINDOW_MS: 60000,
  // лимиты для всех, кроме владельца (П-74): запросов в минуту на IP и маршрут. Владельца лимит не трогает;
  // чат держит свои лимиты в handleChat, а /api/events, /api/progress и /api/me без лимита (зрителю там 403 или роль)
  VIEWER_PER_MIN: { '/api/feed': 60, '/api/items': 120, '/api/lemma': 30, '/api/checks/answer': 60 },
} as const

export type LimitedRoute = keyof typeof HTTP.VIEWER_PER_MIN

export const HTTP_TEXT = {
  forbidden: 'нет доступа',
  tooLarge: 'слишком большой запрос',
  notJson: 'тело запроса не JSON',
  tooOften: 'слишком часто, подожди немного',
  failed: 'сервис временно недоступен',
} as const

export interface ApiCall<P> {
  req: Request
  url: URL
  role: Role
  params: P
  // разобранное тело POST; у GET — undefined
  body: unknown
  // зависимости открываются по требованию: /api/me обходится без базы
  deps: () => Promise<Deps>
}

export interface RouteOptions {
  method: 'GET' | 'POST'
  // маршрут с лимитом для всех, кроме владельца; без него лимита нет
  limit?: LimitedRoute
}

type RouteHandler<P> = (req: Request, ctx?: { params: Promise<P> }) => Promise<Response>

// Обработчик возвращает данные для JSON-ответа 200 или бросает ApiError
export function apiRoute<P extends object = object>(
  opts: RouteOptions,
  handler: (call: ApiCall<P>) => Promise<unknown>,
): RouteHandler<P> {
  return async (req, ctx) => {
    // чтение запроса вне try: на нём Next прерывает пререндер, это его исключение, а не ошибка API
    const url = new URL(req.url)
    try {
      let body: unknown
      if (opts.method === 'POST') {
        if (!sameOrigin(req, url)) return reply(403, { error: HTTP_TEXT.forbidden })
        const read = await readJson(req, HTTP.BODY_MAX_BYTES)
        if (read === 'tooLarge') return reply(413, { error: HTTP_TEXT.tooLarge })
        if (read === 'notJson') return reply(400, { error: HTTP_TEXT.notJson })
        body = read.value
      }

      const role = await resolveRole(req)
      let opened: Promise<Deps> | undefined
      const deps = (): Promise<Deps> => (opened ??= getDeps(role))

      if (opts.limit !== undefined && role !== 'owner') {
        const d = await deps()
        const max = HTTP.VIEWER_PER_MIN[opts.limit]
        if (await hitRateLimit(d.db, rateKey(req, opts.limit), HTTP.RATE_WINDOW_MS, max, d.now())) {
          return reply(429, { error: HTTP_TEXT.tooOften })
        }
      }

      const params = ctx ? await ctx.params : ({} as P)
      return reply(200, await handler({ req, url, role, params, body, deps }))
    } catch (e) {
      // внутренние исключения Next (прерывание пререндера и подобные) отдаём ему
      unstable_rethrow(e)
      if (e instanceof ApiError) return reply(e.status, { error: e.message })
      console.error(`api: ${errorName(e)} ${url.pathname}`)
      return reply(500, { error: HTTP_TEXT.failed })
    }
  }
}

function reply(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

// Origin, если есть, должен указывать на тот же хост, что и запрос; 'null' и мусор не проходят
function sameOrigin(req: Request, url: URL): boolean {
  const origin = req.headers.get('origin')
  if (origin === null) return true
  const host = (req.headers.get('host') ?? url.host).toLowerCase()
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

// Тело читается потоком с остановкой на лимите: заголовку Content-Length одному не верим
async function readJson(req: Request, max: number): Promise<{ value: unknown } | 'tooLarge' | 'notJson'> {
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) return 'tooLarge'
  if (req.body === null) return 'notJson'

  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => undefined)
      return 'tooLarge'
    }
    chunks.push(value)
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    return { value: JSON.parse(text) as unknown }
  } catch {
    return 'notJson'
  }
}

// Ключ лимита: маршрут и sha256 от IP клиента (первый адрес x-forwarded-for); в базу пишется sha256 адреса без соли
function rateKey(req: Request, route: LimitedRoute): string {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  return `${route}:${createHash('sha256').update(ip).digest('hex')}`
}

function errorName(e: unknown): string {
  return e instanceof Error ? e.name : typeof e
}
