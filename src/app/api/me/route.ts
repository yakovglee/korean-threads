// GET /api/me — роль текущего запроса; базу не открывает. Рантайм и кэш: см. src/lib/http.ts.
import { apiRoute } from '@/lib/http'

export const GET = apiRoute({ method: 'GET' }, async ({ role }) => ({ role }))
