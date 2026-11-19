// Зависимости обработчиков API для настоящих запросов: база, модель, конфиг, часы и случайность.
// База одна на процесс: соединение postgres.js держит пул, новый пул на каждый запрос исчерпал бы пулер.
// Кэш лежит на globalThis, чтобы горячая перезагрузка в dev не плодила пулы.
import type { Deps } from './api'
import { loadConfig } from './config'
import { openDb, type Db } from './db'
import { openRouterClient } from './llm'

const shared = globalThis as typeof globalThis & { __koreanThreadsDb?: Promise<Db> }

export async function getDeps(role: Deps['role']): Promise<Deps> {
  const cfg = loadConfig()
  return {
    db: await sharedDb(cfg.databaseUrl),
    llm: openRouterClient(cfg),
    cfg,
    now: Date.now,
    rng: Math.random,
    role,
  }
}

// Неудачное открытие из кэша убирается: следующий запрос попробует заново
function sharedDb(url: string): Promise<Db> {
  if (!shared.__koreanThreadsDb) {
    const opening = openDb(url)
    shared.__koreanThreadsDb = opening
    opening.catch(() => {
      if (shared.__koreanThreadsDb === opening) shared.__koreanThreadsDb = undefined
    })
  }
  return shared.__koreanThreadsDb
}
