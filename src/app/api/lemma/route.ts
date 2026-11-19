// GET /api/lemma?lemma=&pos= — значение слова вне списков. Рантайм и кэш: см. src/lib/http.ts.
import { handleLemma } from '@/lib/api'
import { apiRoute } from '@/lib/http'

export const GET = apiRoute({ method: 'GET', limit: '/api/lemma' }, async ({ url, deps }) =>
  handleLemma(await deps(), url.searchParams.get('lemma') ?? '', url.searchParams.get('pos') ?? ''),
)
