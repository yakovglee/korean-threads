import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Db } from '../src/lib/db'
import { nfc } from '../src/lib/ko'
import { buildCheck, buildPost, loadCheck, loadThread, saveCheck, saveThread, validatePost, type RawPost } from '../src/lib/posts'
import type { Check, Item, Level, Thread } from '../src/lib/types'
import { openTestDb } from './helpers/testDb'

const ANALYZER = 'http://analyzer.test'

type Verdict = { ok: true } | { ok: false; errors: string[] }
const errorsOf = (r: Verdict): string[] => (r.ok ? [] : r.errors)

const jsonRes = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

// ---- анализатор: фикстуры tests/fixtures/mecab/ ----
interface Fixture { text: string; tokens: unknown[] }
const fixture = (name: string): Fixture =>
  JSON.parse(readFileSync(new URL(`./fixtures/mecab/${name}.json`, import.meta.url), 'utf8')) as Fixture

// Фейковый fetch: ответ берётся из фикстуры по тексту запроса. Текст вне фикстур — ошибка сети (AnalyzerError), а не пустой результат
function analyzerFor(...names: string[]): { fetchImpl: typeof fetch; calls: string[] } {
  const byText = new Map(names.map(n => {
    const fx = fixture(n)
    return [nfc(fx.text), fx.tokens] as const
  }))
  const calls: string[] = []
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const { text } = JSON.parse(String(init?.body)) as { text: string }
    calls.push(text)
    const tokens = byText.get(text)
    if (tokens === undefined) throw new TypeError(`нет фикстуры для текста: ${text}`)
    return jsonRes(tokens)
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

// Синтетический анализатор там, где фикстур нет (варианты ответов): каждое слово через пробел — морфема NNG
function wordsAnalyzer(): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const { text } = JSON.parse(String(init?.body)) as { text: string }
    return jsonRes(text.split(/\s+/).filter(w => w !== '').map(surface => ({
      word: { surface, pos: 'NNG', entry_type: '*', expression: '*' },
      parsed_expression: null,
    })))
  }) as unknown as typeof fetch
}

// ---- записи списков: та же форма, что в tests/analyzer.test.ts ----
const vocab = (id: string, headword: string, pos: string, level: Level, seq: number): Item =>
  ({ id, kind: 'vocab', headword, homograph: 0, pos, hint: '', related: '', level, seq })

const grammar = (
  id: string,
  headword: string,
  o: { pos: string; level: Level; seq: number; related?: string; homograph?: number },
): Item => ({
  id, kind: 'grammar', headword, homograph: o.homograph ?? 0, pos: o.pos, hint: '', related: o.related ?? '',
  level: o.level, seq: o.seq,
})

const BI = vocab('v:1', '비', '명사', 1, 1)
const ODA = vocab('v:2', '오다', '동사', 1, 2)
const ODA5 = vocab('v:9', '오다', '동사', 5, 9)
const GEODEUN = grammar('g:6', '-거든', { pos: '종결어미', level: 2, seq: 6, related: '거든요', homograph: 2 })
const GEODEUN_YO = grammar('g:70', '-거든요', { pos: '종결어미', level: 1, seq: 70 })
const GI_TTAEMUNE = grammar('g:8', '-기 때문에', { pos: '관용 표현', level: 3, seq: 8 })
const EUL_SU_ISSDA = grammar('g:1', '-을 수 있다', { pos: '관용 표현', level: 2, seq: 1, related: '-ㄹ 수 있다, <반의> -ㄹ 수 없다, -을 수 없다' })
// слова для проверок варианта ответа
const SCHOOL = vocab('v:3', '학교', '명사', 1, 3)
const SHOP = vocab('v:4', '가게', '명사', 1, 4)
const CHAEYOUNG = vocab('v:5', '채영', '명사', 1, 5)

async function dbWith(items: Item[]): Promise<Db> {
  const db = await openTestDb()
  for (const it of items) {
    await db.query(
      'insert into items (id, kind, level, headword, homograph, pos, hint, related, seq) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [it.id, it.kind, it.level, it.headword, it.homograph, it.pos, it.hint, it.related, it.seq],
    )
  }
  return db
}

const raw = (paragraphs: RawPost['paragraphs'], extra: Partial<RawPost> = {}): RawPost =>
  ({ authorName: 'Автор', authorHandle: 'author', paragraphs, ...extra })

// число строк в таблицах постов и вопросов
async function counts(db: Db): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const table of ['threads', 'posts', 'post_items', 'checks', 'check_items']) {
    const rows = await db.query<{ n: number }>(`select count(*)::int as n from ${table}`)
    out[table] = rows[0].n
  }
  return out
}

describe('buildPost', () => {
  it('ru-абзац не анализируется, ko разбит на сегменты с itemIds', async () => {
    const db = await dbWith([BI, ODA, GEODEUN])
    const { fetchImpl, calls } = analyzerFor('biga-ogeodeunyo')
    const built = await buildPost(db, raw([
      { lang: 'ko', text: '비가 오거든요' },
      { lang: 'ru', text: 'Потому что идёт дождь.' },
    ]), ANALYZER, fetchImpl)
    expect(calls).toEqual(['비가 오거든요'])
    expect(built.post.paragraphs).toEqual([
      { lang: 'ko', segments: [
        { text: '비가', itemIds: ['v:1'], unlisted: [] },
        { text: '오거든요', itemIds: ['v:2', 'g:6'], unlisted: [] },
      ] },
      { lang: 'ru', text: 'Потому что идёт дождь.' },
    ])
    expect(built.itemIds).toEqual(['v:1', 'v:2', 'g:6'])
    expect(built.grammarIds).toEqual(['g:6'])
    expect(built.unlistedRatio).toBe(0)
  })

  it('unlistedRatio: часть конструкции («싶다» в «-고 싶다» из «쉬고 싶어요») не считается вне списков', async () => {
    const SWI = vocab('v:10', '쉬다', '동사', 1, 10)
    const GO_SIPEOYO = grammar('g:13', '-고 싶다', { pos: '관용 표현', level: 1, seq: 13 })
    const db = await dbWith([SWI, GO_SIPEOYO])
    const { fetchImpl } = analyzerFor('swigo-sipeoyo')
    const built = await buildPost(db, raw([{ lang: 'ko', text: '쉬고 싶어요' }]), ANALYZER, fetchImpl)
    expect(built.grammarIds).toEqual(['g:13'])
    expect(built.unlistedRatio).toBe(0)
  })

  it('цель-конструкция засчитывается через grammarIds: разметка отдала «거든요» другой записи', async () => {
    // -거든요 точнее совпадает с формой и выигрывает в itemIds; -거든 остаётся в grammarIds, потому что её морфемы есть в тексте
    const db = await dbWith([BI, ODA, GEODEUN, GEODEUN_YO])
    const { fetchImpl } = analyzerFor('biga-ogeodeunyo')
    const built = await buildPost(db, raw([{ lang: 'ko', text: '비가 오거든요' }]), ANALYZER, fetchImpl)
    expect(built.itemIds).toContain('g:70')
    expect(built.itemIds).not.toContain('g:6')
    expect(built.grammarIds).toContain('g:6')
    expect(await validatePost(db, built, { mode: 'bank', targets: [GEODEUN] })).toEqual({ ok: true })
  })
})

describe('validatePost', () => {
  it('validatePost bank: unlisted > 10% → ok:false; ровно 10% проходит', async () => {
    const db = await dbWith([BI])
    const { fetchImpl } = analyzerFor('hakgyoe-gayo')
    const built = await buildPost(db, raw([{ lang: 'ko', text: '학교에 가요' }]), ANALYZER, fetchImpl)
    expect(built.unlistedRatio).toBe(1)
    expect(errorsOf(await validatePost(db, built, { mode: 'bank' }))).toEqual([expect.stringMatching(/вне списков/)])

    // граница: 1 слово вне списка из 10 — 10% допустимо; 2 из 10 — нет
    const ok = await buildPost(db, raw([{ lang: 'ko', text: '비 비 비 비 비 비 비 비 비 없는말' }]), ANALYZER, wordsAnalyzer())
    expect(ok.unlistedRatio).toBeCloseTo(0.1)
    expect(await validatePost(db, ok, { mode: 'bank' })).toEqual({ ok: true })
    const over = await buildPost(db, raw([{ lang: 'ko', text: '비 비 비 비 비 비 비 비 없는말 없는말' }]), ANALYZER, wordsAnalyzer())
    expect(errorsOf(await validatePost(db, over, { mode: 'bank' }))).toEqual([expect.stringMatching(/вне списков/)])
  })

  it('validatePost bank: слово 5급 без stretchLemma → ok:false; со stretchLemma → ok:true', async () => {
    const db = await dbWith([BI, ODA5])
    const { fetchImpl } = analyzerFor('biga-ogeodeunyo')
    const built = await buildPost(db, raw([{ lang: 'ko', text: '비가 오거든요' }], { stretchLemma: '오다' }), ANALYZER, fetchImpl)
    expect(built.post.stretchItemId).toBe('v:9')
    expect(errorsOf(await validatePost(db, built, { mode: 'bank' }))).toEqual([expect.stringMatching(/выше 4/)])
    expect(await validatePost(db, built, { mode: 'bank', stretchLemma: '오다' })).toEqual({ ok: true })
    // подтяжка допускает только своё слово: другая лемма 5–6급 не проходит
    expect(errorsOf(await validatePost(db, built, { mode: 'bank', stretchLemma: '비' }))).toEqual([expect.stringMatching(/выше 4/)])
  })

  it('validatePost bank: два слова уровня 5–6 → ошибка, даже когда одно из них подтяжка', async () => {
    const db = await dbWith([vocab('v:10', '비', '명사', 6, 10), ODA5])
    const { fetchImpl } = analyzerFor('biga-ogeodeunyo')
    const built = await buildPost(db, raw([{ lang: 'ko', text: '비가 오거든요' }], { stretchLemma: '오다' }), ANALYZER, fetchImpl)
    expect(built.post.stretchItemId).toBe('v:9')
    expect(errorsOf(await validatePost(db, built, { mode: 'bank', stretchLemma: '오다' }))).toEqual([expect.stringMatching(/выше 4/)])
    expect(errorsOf(await validatePost(db, built, { mode: 'bank' }))).toEqual([expect.stringMatching(/выше 4/)])
  })

  it('validatePost bank: цель-конструкция не встретилась → ok:false', async () => {
    const db = await dbWith([BI, ODA, GEODEUN, GI_TTAEMUNE])
    const { fetchImpl } = analyzerFor('biga-ogeodeunyo')
    const built = await buildPost(db, raw([{ lang: 'ko', text: '비가 오거든요' }]), ANALYZER, fetchImpl)
    expect(await validatePost(db, built, { mode: 'bank', targets: [GEODEUN] })).toEqual({ ok: true })
    expect(errorsOf(await validatePost(db, built, { mode: 'bank', targets: [GI_TTAEMUNE] }))).toEqual([
      expect.stringMatching(/нет цели: -기 때문에/),
    ])
  })

  it('validatePost chat: правила уровня и доли не применяются', async () => {
    const db = await dbWith([BI, ODA5])
    const { fetchImpl } = analyzerFor('biga-ogeodeunyo', 'hakgyoe-gayo')
    const built = await buildPost(db, raw([
      { lang: 'ko', text: '비가 오거든요' },
      { lang: 'ko', text: '학교에 가요' },
    ]), ANALYZER, fetchImpl)
    expect(built.unlistedRatio).toBe(0.5)
    expect(errorsOf(await validatePost(db, built, { mode: 'bank' }))).toEqual([
      expect.stringMatching(/вне списков/),
      expect.stringMatching(/выше 4/),
    ])
    expect(await validatePost(db, built, { mode: 'chat' })).toEqual({ ok: true })
  })

  it('validatePost собирает все ошибки разом', async () => {
    const db = await dbWith([BI, ODA5, GI_TTAEMUNE])
    const { fetchImpl } = analyzerFor('biga-ogeodeunyo', 'hakgyoe-gayo')
    const built = await buildPost(db, raw([
      { lang: 'ko', text: '비가 오거든요' },
      { lang: 'ko', text: '학교에 가요' },
      { lang: 'ru', text: '   ' },
    ]), ANALYZER, fetchImpl)
    expect(errorsOf(await validatePost(db, built, { mode: 'bank', targets: [GI_TTAEMUNE] }))).toEqual([
      expect.stringMatching(/абзац 3 пустой/),
      expect.stringMatching(/вне списков/),
      expect.stringMatching(/выше 4/),
      expect.stringMatching(/нет цели/),
    ])
    // в чате доля и уровень не проверяются: остаются пустой абзац и цель
    expect(errorsOf(await validatePost(db, built, { mode: 'chat', targets: [GI_TTAEMUNE] }))).toEqual([
      expect.stringMatching(/абзац 3 пустой/),
      expect.stringMatching(/нет цели/),
    ])
  })

  it('ko-абзац из одних пробелов — ошибка «абзац 1 пустой»', async () => {
    const db = await dbWith([BI])
    const built = await buildPost(db, raw([{ lang: 'ko', text: '   ' }]), ANALYZER, wordsAnalyzer())
    expect(errorsOf(await validatePost(db, built, { mode: 'chat' }))).toEqual([expect.stringMatching(/абзац 1 пустой/)])
  })

  it('validatePost: пост без абзацев — ошибка', async () => {
    const db = await dbWith([BI])
    const built = await buildPost(db, raw([]), ANALYZER, wordsAnalyzer())
    expect(errorsOf(await validatePost(db, built, { mode: 'chat' }))).toEqual([expect.stringMatching(/нет ни одного абзаца/)])
  })
})

describe('buildCheck', () => {
  const words = (): Promise<Db> => dbWith([BI, SCHOOL, SHOP, CHAEYOUNG])

  it('buildCheck: два "___" → ok:false; дублирующиеся варианты → ok:false', async () => {
    const db = await words()
    const f = wordsAnalyzer()
    const twoBlanks = await buildCheck(db, { stem: '___ 비 ___', options: ['비', '학교', '가게', '채영'], answerIndex: 0 }, ANALYZER, 'post', f)
    expect(errorsOf(twoBlanks)).toEqual([expect.stringMatching(/ровно один пропуск/)])
    const dup = await buildCheck(db, { stem: '비가 ___', options: ['비', '비', '가게', '학교'], answerIndex: 0 }, ANALYZER, 'post', f)
    expect(errorsOf(dup)).toEqual([expect.stringMatching(/повторяются/)])
  })

  it('buildCheck: нет различающихся слов списка → ok:false; answerIndex вне 0–3 → ok:false', async () => {
    const db = await words()
    const f = wordsAnalyzer()
    const none = await buildCheck(db, { stem: '___ 가', options: ['없다', '저것', '그것', '이것'], answerIndex: 1 }, ANALYZER, 'post', f)
    expect(errorsOf(none)).toEqual([expect.stringMatching(/различающихся/)])
    const badIndex = await buildCheck(db, { stem: '___ 가', options: ['비', '학교', '가게', '채영'], answerIndex: 4 }, ANALYZER, 'post', f)
    expect(errorsOf(badIndex)).toEqual([expect.stringMatching(/от 0 до 3/)])
  })

  it('buildCheck: itemIds берутся из различающегося в вариантах, а не из stem', async () => {
    const db = await words()
    // «비» есть во всех вариантах (пересечение), «채영» — только в stem: ни то ни другое не попадает в itemIds
    const r = await buildCheck(db, {
      stem: '채영 ___',
      options: ['비 가게', '비 학교', '비 가게 학교', '비'],
      answerIndex: 0,
    }, ANALYZER, 'post', wordsAnalyzer())
    if (!r.ok) throw new Error(r.errors.join('; '))
    expect([...r.check.itemIds].sort()).toEqual(['v:3', 'v:4'])
    expect(r.check).toMatchObject({ source: 'post', stem: '채영 ___', answerIndex: 0 })
  })

  it('buildCheck: «____» принимается и сохраняется как «___»', async () => {
    const db = await words()
    const r = await buildCheck(db, { stem: '____ 가', options: ['비', '학교', '가게', '채영'], answerIndex: 0 }, ANALYZER, 'post', wordsAnalyzer())
    if (!r.ok) throw new Error(r.errors.join('; '))
    expect(r.check.stem).toBe('___ 가')
  })

  it('buildCheck: два пропуска любой длины → ok:false', async () => {
    const db = await words()
    const r = await buildCheck(db, { stem: '___ 비 ____', options: ['비', '학교', '가게', '채영'], answerIndex: 0 }, ANALYZER, 'post', wordsAnalyzer())
    expect(errorsOf(r)).toEqual([expect.stringMatching(/ровно один пропуск/)])
  })

  it('buildCheck: варианты « 비» и «비» считаются одинаковыми → ok:false', async () => {
    const db = await words()
    const r = await buildCheck(db, { stem: '___ 가', options: [' 비', '비', '학교', '가게'], answerIndex: 0 }, ANALYZER, 'post', wordsAnalyzer())
    expect(errorsOf(r)).toEqual([expect.stringMatching(/повторяются/)])
  })
})

describe('хранение веток и вопросов', () => {
  it('saveThread/loadThread и saveCheck/loadCheck: круговой обмен, порядок itemIds сохраняется', async () => {
    const db = await dbWith([BI, ODA5, GEODEUN])
    const { fetchImpl } = analyzerFor('biga-ogeodeunyo')
    const first = await buildPost(db, raw([
      { lang: 'ko', text: '비가 오거든요' },
      { lang: 'ru', text: 'Идёт дождь.' },
    ], { title: 'Дождь', stretchLemma: '오다' }), ANALYZER, fetchImpl)
    const second = await buildPost(db, raw([{ lang: 'ko', text: '비가 오거든요' }], { authorName: 'Второй', authorHandle: 'second' }), ANALYZER, fetchImpl)
    const thread: Thread = {
      id: 't1',
      origin: 'bank',
      posts: [
        { id: 'p1', threadId: 't1', ...first.post, sources: [{ doc: 'GRAMMAR_MAIN.md', page: 12 }] },
        { id: 'p2', threadId: 't1', ...second.post },
      ],
    }
    const check: Check = {
      id: 'c1', source: 'post', stem: '비가 ___', options: ['가게', '비', '학교', '채영'], answerIndex: 2,
      itemIds: ['v:4', 'v:1', 'v:3'], label: 'тест',
    }
    await saveThread(db, thread, { checks: [check], now: 1000 })
    expect(await loadThread(db, 't1')).toEqual(thread)
    expect(await loadCheck(db, 'c1')).toEqual(check)
    expect((await loadCheck(db, 'c1'))?.itemIds).toEqual(['v:4', 'v:1', 'v:3'])
    expect(await loadThread(db, 'нет')).toBeNull()
    expect(await loadCheck(db, 'нет')).toBeNull()
  })

  it('post_items совпадают с id сегментов поста, без повторов', async () => {
    const db = await dbWith([EUL_SU_ISSDA])
    const { fetchImpl } = analyzerFor('meogeul-su-isseoyo')
    const built = await buildPost(db, raw([{ lang: 'ko', text: '먹을 수 있어요' }]), ANALYZER, fetchImpl)
    // конструкция попала во все три сегмента, в post_items она одна
    const segIds = built.post.paragraphs.flatMap(p => (p.lang === 'ko' ? p.segments.flatMap(s => s.itemIds) : []))
    expect(segIds).toEqual(['g:1', 'g:1', 'g:1'])
    await saveThread(db, { id: 't2', origin: 'bank', posts: [{ id: 'p9', threadId: 't2', ...built.post }] })
    const rows = await db.query<{ item_id: string }>('select item_id from post_items where post_id = $1 order by item_id', ['p9'])
    expect(rows.map(r => r.item_id)).toEqual([...new Set(segIds)].sort())
  })

  it('saveThread откатывается целиком при повторном id поста, треда и вопроса', async () => {
    const db = await dbWith([BI, ODA, GEODEUN])
    const { fetchImpl } = analyzerFor('biga-ogeodeunyo')
    const built = await buildPost(db, raw([{ lang: 'ko', text: '비가 오거든요' }]), ANALYZER, fetchImpl)
    const post = (id: string, threadId: string) => ({ id, threadId, ...built.post })
    await saveThread(db, { id: 't1', origin: 'bank', posts: [post('p1', 't1'), post('p2', 't1')] }, { now: 1 })
    const existing: Check = { id: 'c1', source: 'post', stem: '___', options: ['비', '학교', '가게', '채영'], answerIndex: 0, itemIds: ['v:1'] }
    await saveCheck(db, existing, 1)
    const before = await counts(db)

    // повтор id поста: тред и первый пост уже вставлены, второй падает — всё откатывается
    await expect(saveThread(db, { id: 't2', origin: 'chat', posts: [post('p3', 't2'), post('p1', 't2')] }, { now: 2 })).rejects.toThrow()
    expect(await counts(db)).toEqual(before)
    expect(await loadThread(db, 't2')).toBeNull()

    // повтор id треда
    await expect(saveThread(db, { id: 't1', origin: 'bank', posts: [post('p4', 't1')] }, { now: 3 })).rejects.toThrow()
    expect(await counts(db)).toEqual(before)

    // повтор id вопроса в той же транзакции: новый тред и новый пост не остаются
    await expect(saveThread(db, { id: 't3', origin: 'bank', posts: [post('p5', 't3')] }, { now: 4, checks: [existing] })).rejects.toThrow()
    expect(await counts(db)).toEqual(before)
    expect(await loadThread(db, 't3')).toBeNull()
  })

  it('loadThread возвращает посты по position, когда id постов не в порядке вставки', async () => {
    const db = await dbWith([BI])
    const { fetchImpl } = analyzerFor('biga-ogeodeunyo')
    const built = await buildPost(db, raw([{ lang: 'ko', text: '비가 오거든요' }]), ANALYZER, fetchImpl)
    const thread: Thread = {
      id: 't5', origin: 'bank',
      posts: [{ id: 'p9', threadId: 't5', ...built.post }, { id: 'p1', threadId: 't5', ...built.post }],
    }
    await saveThread(db, thread, { now: 5 })
    const loaded = await loadThread(db, 't5')
    expect(loaded?.posts.map(p => p.id)).toEqual(['p9', 'p1'])
    expect(loaded).toEqual(thread)
  })

  it('saveThread: пост с чужим threadId — ошибка до записи, таблицы пусты', async () => {
    const db = await dbWith([BI])
    const { fetchImpl } = analyzerFor('biga-ogeodeunyo')
    const built = await buildPost(db, raw([{ lang: 'ko', text: '비가 오거든요' }]), ANALYZER, fetchImpl)
    const thread: Thread = {
      id: 't6', origin: 'bank',
      posts: [{ id: 'p1', threadId: 't6', ...built.post }, { id: 'p2', threadId: 'чужая', ...built.post }],
    }
    await expect(saveThread(db, thread)).rejects.toThrow(/threadId/)
    expect(await counts(db)).toEqual({ threads: 0, posts: 0, post_items: 0, checks: 0, check_items: 0 })
  })
})
