// POST /api/checks/answer — ответ на проверку. Владелец записывает ответ, остальные получают результат без записи.
// Рантайм и кэш: см. src/lib/http.ts.
import { handleCheckAnswer, handleCheckPeek } from '@/lib/api'
import { apiRoute } from '@/lib/http'

export const POST = apiRoute({ method: 'POST', limit: '/api/checks/answer' },async ({ role, body, deps }) => {
  const d = await deps()
  return role === 'owner' ? handleCheckAnswer(d, body) : handleCheckPeek(d, body)
})
