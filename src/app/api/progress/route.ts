// GET /api/progress — прогресс по уровням 1–4 (только владелец). Рантайм и кэш: см. src/lib/http.ts.
import { handleProgress } from '@/lib/api'
import { apiRoute } from '@/lib/http'

export const GET = apiRoute({ method: 'GET' }, async ({ deps }) => handleProgress(await deps()))
