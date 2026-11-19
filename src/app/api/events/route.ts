// POST /api/events — событие памяти (tap, viewed). Рантайм и кэш: см. src/lib/http.ts.
import { handleEvent } from '@/lib/api'
import { apiRoute } from '@/lib/http'

export const POST = apiRoute({ method: 'POST' }, async ({ body, deps }) => handleEvent(await deps(), body))
