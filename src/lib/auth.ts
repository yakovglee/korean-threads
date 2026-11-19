// Роль запроса.
// ВРЕМЕННАЯ ЗАГЛУШКА до Task 18 (вход владельца по подписанной cookie). Сейчас роль зависит только от окружения:
// 'owner' вне production (локальная разработка и тесты), в production всегда 'viewer'.
// Закрыто по умолчанию: пока нет настоящей проверки сессии, на боевом сервере никто не получает прав владельца.
// npm run dev слушает только 127.0.0.1: иначе права владельца получило бы любое устройство в локальной сети.
import type { Deps } from './api'

export type Role = Deps['role']

export async function resolveRole(req: Request): Promise<Role> {
  // запрос понадобится Task 18 (cookie сессии); заглушка его не читает
  void req
  return process.env.NODE_ENV !== 'production' ? 'owner' : 'viewer'
}
