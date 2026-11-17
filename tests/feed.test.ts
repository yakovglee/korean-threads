import { describe, expect, it } from 'vitest'
import type { Db } from '../src/lib/db'
import { FEED, localDayKey, pickCheck, pickFeed, recordDelivered, type FeedCard } from '../src/lib/feed'
import { saveState } from '../src/lib/memory'
import { loadThread, saveCheck, saveThread } from '../src/lib/posts'
import type { Check, Item, Level, Thread } from '../src/lib/types'
import { openTestDb } from './helpers/testDb'

const TZ = 'Asia/Jayapura'
const DAY = 86400000
const NOW = Date.UTC(2026, 10, 16, 3) // 12:00 16.11.2026 по Джайапуре
const TODAY = '2026-11-16'

// ---- данные ----
async function dbWith(words: Array<[string, Level]>): Promise<Db> {
  const db = await openTestDb()
  for (const [id, level] of words) {
    const item: Item = { id, kind: 'vocab', level, headword: id, homograph: 0, pos: '명사', hint: '', related: '', seq: 0 }
    await db.query(
      'insert into items (id, kind, level, headword, homograph, pos, hint, related, seq) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [item.id, item.kind, item.level, item.headword, item.homograph, item.pos, item.hint, item.related, item.seq],
    )
  }
  return db
}

async function setState(
  db: Db,
  itemId: string,
  o: { stab: number; last: number | null; isNew: boolean; introduced?: string | null },
): Promise<void> {
  await saveState(db, { itemId, stabilityDays: o.stab, lastEventAt: o.last, isNew: o.isNew, tapCount: 0 })
  if (o.introduced) await db.query('update item_state set introduced_day = $2::text where item_id = $1', [itemId, o.introduced])
}

// твёрдое слово: касалось сейчас, R ≈ 1, приоритет ≈ 0
const known = (db: Db, id: string): Promise<void> => setState(db, id, { stab: 60, last: NOW, isNew: false })
// новое слово, ещё не введённое (или введённое сегодня, если передан introduced)
const fresh = (db: Db, id: string, introduced: string | null = null): Promise<void> =>
  setState(db, id, { stab: 0, last: null, isNew: true, introduced })

// ветка с одним постом: каждое слово — отдельный сегмент
async function addThread(db: Db, id: string, itemIds: string[], stretchItemId?: string): Promise<void> {
  const thread: Thread = {
    id,
    origin: 'bank',
    posts: [{
      id: `${id}-1`,
      threadId: id,
      author: { name: 'Автор', handle: 'author' },
      paragraphs: [{ lang: 'ko', segments: itemIds.map(i => ({ text: '단어', itemIds: [i], unlisted: [] })) }],
      ...(stretchItemId === undefined ? {} : { stretchItemId }),
    }],
  }
  await saveThread(db, thread, { now: NOW })
}

// ветка из нескольких постов: в каждом посте свой список слов (по одному сегменту на слово)
async function addThreadPosts(db: Db, id: string, postsItemIds: string[][], origin: Thread['origin'] = 'bank'): Promise<void> {
  const thread: Thread = {
    id,
    origin,
    posts: postsItemIds.map((itemIds, i) => ({
      id: `${id}-${i + 1}`,
      threadId: id,
      author: { name: 'Автор', handle: 'author' },
      paragraphs: [{ lang: 'ko', segments: itemIds.map(itemId => ({ text: '단어', itemIds: [itemId], unlisted: [] })) }],
    })),
  }
  await saveThread(db, thread, { now: NOW })
}

async function markShown(db: Db, threadId: string, at: number): Promise<void> {
  await db.query('update posts set last_delivered_at = $2::bigint where thread_id = $1', [threadId, at])
}

async function markAnswered(db: Db, checkId: string, at: number): Promise<void> {
  await db.query('update checks set last_answered_at = $2::bigint where id = $1', [checkId, at])
}

// детерминированный rng в (0, 1) (Park–Miller): для проверок, где нужны разные значения, а не одно и то же
function seededRng(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 48271) % 2147483647
    return s / 2147483647
  }
}

async function addCheck(db: Db, id: string, source: Check['source'], itemIds: string[]): Promise<void> {
  await saveCheck(db, { id, source, stem: '___ 가', options: ['가', '나', '다', '라'], answerIndex: 0, itemIds }, NOW)
}

const threadIds = (cards: FeedCard[]): string[] => cards.flatMap(c => (c.type === 'thread' ? [c.thread.id] : []))
const checkIds = (cards: FeedCard[]): string[] => cards.flatMap(c => (c.type === 'check' ? [c.check.id] : []))
const wordIds = (cards: FeedCard[]): string[] => cards.flatMap(c => (c.type === 'thread'
  ? c.thread.posts.flatMap(p => p.paragraphs.flatMap(par => (par.lang === 'ko' ? par.segments.flatMap(s => s.itemIds) : [])))
  : []))
const range = (prefix: string, from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`)

describe('localDayKey', () => {
  it('localDayKey учитывает tz', () => expect(localDayKey(Date.UTC(2026, 10, 14, 23, 30), 'Asia/Seoul')).toBe('2026-11-15'))
})

describe('pickFeed', () => {
  it('приоритет: тред со слабым словом идёт раньше треда с твёрдым', async () => {
    const db = await dbWith([['v:1', 1], ['v:2', 3]])
    await known(db, 'v:1')
    await setState(db, 'v:2', { stab: 4, last: NOW - 10 * DAY, isNew: false })
    await addThread(db, 'strong', ['v:1'])
    await addThread(db, 'weak', ['v:2'])
    const cards = await pickFeed(db, { now: NOW, n: 1, rng: () => 0, tz: TZ })
    expect(threadIds(cards)).toEqual(['weak'])
  })

  it('тонкий банк: 1 тред, n=10 → вернётся 1 карточка, без зацикливания', async () => {
    const db = await dbWith([['v:1', 1]])
    await known(db, 'v:1')
    await addThread(db, 'only', ['v:1'])
    const cards = await pickFeed(db, { now: NOW, n: 10, rng: () => 0.5, tz: TZ })
    expect(threadIds(cards)).toEqual(['only'])
  })

  it('все посты недавно показаны → отдаются самые давно показанные (не пусто)', async () => {
    const db = await dbWith([['v:1', 1]])
    await known(db, 'v:1')
    for (const id of ['a', 'b', 'c']) await addThread(db, id, ['v:1'])
    await markShown(db, 'a', NOW - DAY)
    await markShown(db, 'b', NOW - 2 * DAY)
    await markShown(db, 'c', NOW - 3 * DAY)
    const cards = await pickFeed(db, { now: NOW, n: 2, rng: () => 0.5, tz: TZ })
    expect(threadIds(cards)).toEqual(['c', 'b'])
  })

  it('NEW_PER_DAY: не больше 6 новых слов за локальный день', async () => {
    const db = await dbWith([...range('v:', 1, 9).map(id => [id, 3] as [string, Level]), ['v:10', 1]])
    for (const id of range('v:', 1, 9)) await fresh(db, id)
    await known(db, 'v:10')
    await addThread(db, 'A', ['v:1', 'v:2', 'v:3'])
    await addThread(db, 'B', ['v:4', 'v:5', 'v:6'])
    await addThread(db, 'C', ['v:7', 'v:8', 'v:9'])
    await addThread(db, 'D', ['v:10'])
    for (const r of [0, 0.3, 0.6, 0.99]) {
      const cards = await pickFeed(db, { now: NOW, n: 3, rng: () => r, tz: TZ })
      expect(cards).toHaveLength(3)
      const newWords = new Set(wordIds(cards).filter(id => id !== 'v:10'))
      expect(newWords.size).toBeLessThanOrEqual(FEED.NEW_PER_DAY)
    }
  })

  it('CHECK_EVERY: на 24 карточки приходится 2 проверки, если проверки есть', async () => {
    const db = await dbWith([['v:1', 1]])
    await known(db, 'v:1')
    for (let i = 1; i <= 24; i++) await addThread(db, `t${i}`, ['v:1'])
    for (const id of ['c1', 'c2', 'c3']) await addCheck(db, id, 'post', ['v:1'])
    const cards = await pickFeed(db, { now: NOW, n: 24, rng: () => 0.5, tz: TZ })
    expect(threadIds(cards)).toHaveLength(24)
    const checks = checkIds(cards)
    expect(checks).toHaveLength(2)
    expect(new Set(checks).size).toBe(2)
  })

  it('нет проверок → карточек-проверок нет, без ошибки', async () => {
    const db = await dbWith([['v:1', 1]])
    await known(db, 'v:1')
    for (let i = 1; i <= 12; i++) await addThread(db, `t${i}`, ['v:1'])
    const cards = await pickFeed(db, { now: NOW, n: 12, rng: () => 0.5, tz: TZ })
    expect(threadIds(cards)).toHaveLength(12)
    expect(checkIds(cards)).toHaveLength(0)
  })

  it('банк, где у всех веток есть новые слова и лимит исчерпан, отдаёт ветки с наименьшим числом новых, а не пусто', async () => {
    // шесть слов уже введены сегодня: лимит исчерпан
    const db = await dbWith([...range('v:', 1, 6).map(id => [id, 3] as [string, Level]), ...range('v:', 21, 26).map(id => [id, 1] as [string, Level])])
    for (const id of range('v:', 1, 6)) await fresh(db, id)
    for (const id of range('v:', 21, 26)) await fresh(db, id, TODAY)
    await addThread(db, 'A', ['v:1'])
    await addThread(db, 'B', ['v:2', 'v:3'])
    await addThread(db, 'C', ['v:4', 'v:5', 'v:6'])
    const cards = await pickFeed(db, { now: NOW, n: 2, rng: () => 0.5, tz: TZ })
    expect(threadIds(cards)).toEqual(['A', 'B'])
  })

  it('слот stretch: при rng < STRETCH_RATE выбирается свежая ветка со stretch_item_id, даже если её оценка ниже', async () => {
    const db = await dbWith([['v:1', 3], ['v:2', 3]])
    await fresh(db, 'v:1') // оценка 1
    await known(db, 'v:2') // оценка ≈ 0, но ветка со stretch_item_id
    await addThread(db, 'strong', ['v:1'])
    await addThread(db, 'stretch', ['v:2'], 'v:2')
    const withSlot = await pickFeed(db, { now: NOW, n: 1, rng: () => 0, tz: TZ })
    expect(threadIds(withSlot)).toEqual(['stretch'])
    const withoutSlot = await pickFeed(db, { now: NOW, n: 1, rng: () => 0.5, tz: TZ })
    expect(threadIds(withoutSlot)).toEqual(['strong'])
  })

  it('слово, стоящее в двух постах одной ветки, входит в оценку один раз', async () => {
    const db = await dbWith([['v:1', 3]])
    await fresh(db, 'v:1') // приоритет слова 1
    // оценки равны, если v:1 считается один раз: тогда при равенстве порядок по id, и выбирается 'a-single'.
    // Если посчитать дважды, оценка 'z-double' станет 2 и она пойдёт первой.
    await addThreadPosts(db, 'a-single', [['v:1']])
    await addThreadPosts(db, 'z-double', [['v:1'], ['v:1']])
    const cards = await pickFeed(db, { now: NOW, n: 1, rng: () => 0, tz: TZ })
    expect(threadIds(cards)).toEqual(['a-single'])
  })

  it('в порции на 24 ветки все ветки разные', async () => {
    const words = range('v:', 1, 30)
    const db = await dbWith(words.map(id => [id, 3] as [string, Level]))
    // у каждого слова своя стабильность и давность: оценки веток разные
    for (let i = 1; i <= 30; i++) {
      await setState(db, `v:${i}`, { stab: i, last: NOW - i * DAY, isNew: false })
      await addThread(db, `t${i}`, [`v:${i}`])
    }
    for (const seed of [1, 2, 3, 4]) {
      const cards = await pickFeed(db, { now: NOW, n: 24, rng: seededRng(seed), tz: TZ })
      const ids = threadIds(cards)
      expect(ids).toHaveLength(24)
      expect(new Set(ids).size).toBe(24)
    }
  })

  it('ветка origin chat попадает в ленту владельца', async () => {
    const db = await dbWith([['v:1', 3], ['v:2', 3]])
    await known(db, 'v:1')
    await known(db, 'v:2')
    await addThread(db, 'bank-1', ['v:1'])
    await addThreadPosts(db, 'chat-1', [['v:2']], 'chat')
    const cards = await pickFeed(db, { now: NOW, n: 2, rng: () => 0.5, tz: TZ })
    expect(threadIds(cards).sort()).toEqual(['bank-1', 'chat-1'])
    const chat = cards.find(c => c.type === 'thread' && c.thread.id === 'chat-1')
    expect(chat?.type === 'thread' ? chat.thread.origin : null).toBe('chat')
  })
})

describe('pickCheck', () => {
  it('pickCheck предпочитает exam/topik-style при равном приоритете', async () => {
    const db = await dbWith([['v:1', 1]])
    await known(db, 'v:1')
    await addCheck(db, 'post-1', 'post', ['v:1'])
    await addCheck(db, 'exam-1', 'exam', ['v:1'])
    for (const r of [0, 0.99]) {
      const check = await pickCheck(db, { now: NOW, rng: () => r })
      expect(check?.id).toBe('exam-1')
    }
  })

  it('проверка, отвеченная 1 день назад, не выдаётся; отвеченная 4 дня назад выдаётся', async () => {
    const db = await dbWith([['v:1', 3], ['v:2', 3]])
    await known(db, 'v:1')
    await fresh(db, 'v:2') // приоритет 1: если бы отвеченная 1 день назад проходила, выбралась бы она
    await addCheck(db, 'recent', 'post', ['v:2'])
    await addCheck(db, 'old', 'post', ['v:1'])
    await markAnswered(db, 'recent', NOW - DAY)
    await markAnswered(db, 'old', NOW - 4 * DAY)
    const check = await pickCheck(db, { now: NOW, rng: () => 0 })
    expect(check?.id).toBe('old')
  })

  it('pickCheck возвращает null, когда подходящих нет', async () => {
    const db = await dbWith([['v:1', 3]])
    await known(db, 'v:1')
    expect(await pickCheck(db, { now: NOW, rng: () => 0 })).toBeNull() // проверок нет
    await addCheck(db, 'recent', 'exam', ['v:1'])
    await markAnswered(db, 'recent', NOW - DAY)
    expect(await pickCheck(db, { now: NOW, rng: () => 0 })).toBeNull() // единственная отвечена 1 день назад
    await addCheck(db, 'open', 'post', ['v:1'])
    expect(await pickCheck(db, { now: NOW, rng: () => 0, exclude: new Set(['open']) })).toBeNull() // единственная исключена
  })

  it('exam с приоритетом меньше post, но в пределах EXAM_BOOST, выбирается раньше post', async () => {
    // post: слово приоритета 1 (новое). exam: слово приоритета 0.8 — меньше, но 0.8 × 1.5 = 1.2 > 1
    const examRaw = 0.8
    const db = await dbWith([['v:1', 3], ['v:2', 3]])
    await fresh(db, 'v:1')
    // R = 1 - 0.8 = 0.2 при стабильности 1 день: приоритет = 1 - R = 0.8
    await setState(db, 'v:2', { stab: 1, last: NOW - Math.round(-Math.log(1 - examRaw) * DAY), isNew: false })
    await addCheck(db, 'post-1', 'post', ['v:1'])
    await addCheck(db, 'exam-1', 'exam', ['v:2'])
    expect(examRaw < 1 && examRaw * FEED.EXAM_BOOST > 1).toBe(true)
    for (const r of [0, 0.99]) {
      const check = await pickCheck(db, { now: NOW, rng: () => r })
      expect(check?.id).toBe('exam-1')
    }
  })
})

describe('карточки проверок в порции', () => {
  it('n = 6 при rng → 0 даёт одну проверку, при rng → 0.99 ни одной', async () => {
    const db = await dbWith([['v:1', 1]])
    await known(db, 'v:1')
    for (let i = 1; i <= 6; i++) await addThread(db, `t${i}`, ['v:1'])
    await addCheck(db, 'c1', 'post', ['v:1'])
    const low = await pickFeed(db, { now: NOW, n: 6, rng: () => 0, tz: TZ })
    expect(threadIds(low)).toHaveLength(6)
    expect(checkIds(low)).toHaveLength(1)
    const high = await pickFeed(db, { now: NOW, n: 6, rng: () => 0.99, tz: TZ })
    expect(threadIds(high)).toHaveLength(6)
    expect(checkIds(high)).toHaveLength(0)
  })
})

describe('recordDelivered', () => {
  it('recordDelivered ставит last_delivered_at и introduced_day и не трогает слова с is_new = false', async () => {
    const db = await dbWith([['v:1', 3], ['v:2', 1], ['v:3', 3]])
    await fresh(db, 'v:1')
    await known(db, 'v:2')
    await fresh(db, 'v:3')
    await addThread(db, 'T', ['v:1', 'v:2'])
    await addThread(db, 'U', ['v:3'])
    const thread = await loadThread(db, 'T')
    if (thread === null) throw new Error('ветка T не найдена')
    await recordDelivered(db, [{ type: 'thread', thread }], NOW, TZ)

    const posts = await db.query<{ thread_id: string; last_delivered_at: number | null }>(
      'select thread_id, last_delivered_at from posts order by thread_id',
    )
    expect(posts.map(p => ({ thread: p.thread_id, at: p.last_delivered_at === null ? null : Number(p.last_delivered_at) })))
      .toEqual([{ thread: 'T', at: NOW }, { thread: 'U', at: null }])

    const states = await db.query<{ item_id: string; introduced_day: string | null }>(
      'select item_id, introduced_day from item_state order by item_id',
    )
    expect(states).toEqual([
      { item_id: 'v:1', introduced_day: TODAY },
      { item_id: 'v:2', introduced_day: null },
      { item_id: 'v:3', introduced_day: null },
    ])
  })
})
