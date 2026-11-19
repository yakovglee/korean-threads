// GET /api/feed?n= — порция ленты. Рантайм и кэш: см. src/lib/http.ts.
import { handleFeed } from '@/lib/api'
import { apiRoute } from '@/lib/http'

export const GET = apiRoute({ method: 'GET', limit: '/api/feed' }, async ({ url, deps }) =>
  handleFeed(await deps(), countOf(url.searchParams.get('n'))),
)

// Только десятичные цифры; иначе NaN, и handleFeed отвечает 400
function countOf(raw: string | null): number {
  return raw !== null && /^\d{1,4}$/.test(raw) ? Number(raw) : NaN
}
