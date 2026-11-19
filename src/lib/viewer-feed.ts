// Лента зрителя (Task 14): случайные ветки origin 'bank' и случайные проверки только source 'topik-style' и 'post'.
// Ничего не пишет: ни last_delivered_at, ни introduced_day, ни ответы на проверки.
import type { Db } from './db'
import { FEED, type FeedCard } from './feed'
import { loadCheck, loadThread } from './posts'

// Проверка после каждых FEED.CHECK_EVERY веток; проверки берутся без повтора, пока есть.
export async function pickViewerFeed(db: Db, opts: { n: number; rng: () => number }): Promise<FeedCard[]> {
  const { n, rng } = opts
  if (n < 1) return []
  const threadRows = await db.query<{ id: string }>(`select id from threads where origin = 'bank' order by id`)
  const checkRows = await db.query<{ id: string }>(
    `select id from checks where source in ('topik-style', 'post') order by id`,
  )
  const threadIds = shuffle(threadRows.map(r => r.id), rng).slice(0, n)
  const checkIds = shuffle(checkRows.map(r => r.id), rng)

  const cards: FeedCard[] = []
  let delivered = 0
  let nextCheck = 0
  for (const id of threadIds) {
    const thread = await loadThread(db, id)
    if (thread === null) continue
    cards.push({ type: 'thread', thread })
    delivered++
    if (delivered % FEED.CHECK_EVERY === 0 && nextCheck < checkIds.length) {
      const check = await loadCheck(db, checkIds[nextCheck])
      nextCheck++
      if (check !== null) cards.push({ type: 'check', check })
    }
  }
  return cards
}

// Перемешивание Фишера–Йетса с внешним генератором (как в generate.ts, там не экспортируется)
function shuffle<T>(xs: readonly T[], rng: () => number): T[] {
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = a[i]
    a[i] = a[j]
    a[j] = tmp
  }
  return a
}
