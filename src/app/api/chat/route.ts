// POST /api/chat — вопрос владельца, ответ веткой постов. Лимиты и блокировку держит handleChat.
// Рантайм и кэш: см. src/lib/http.ts.
import { ApiError, handleChat } from '@/lib/api'
import { apiRoute } from '@/lib/http'

// генерация с проверками и повторами идёт долго; секунды
export const maxDuration = 300

export const POST = apiRoute({ method: 'POST' }, async ({ body, deps }) => {
  const r = await handleChat(await deps(), body)
  if (r.status !== 200) throw new ApiError(r.status, r.error)
  return { thread: r.thread }
})
