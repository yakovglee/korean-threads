// GET /api/items/:id — слово из списков и его значение. Рантайм и кэш: см. src/lib/http.ts.
import { ApiError, handleItem, TEXT } from '@/lib/api'
import { apiRoute } from '@/lib/http'

export const GET = apiRoute<{ id: string }>({ method: 'GET', limit: '/api/items' }, async ({ params, deps }) => {
  const view = await handleItem(await deps(), params.id)
  if (view === null) throw new ApiError(404, TEXT.noItem)
  return view
})
