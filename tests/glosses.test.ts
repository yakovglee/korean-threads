import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { Db } from '../src/lib/db'
import { chooseEntryWithAi, fillMissingGlossesWithAi, fixSharedEntries, ingestGlosses, lookupLemma } from '../src/lib/ingest/glosses'
import { candidateEntries, fetchKrdictEntries, type DictEntry, KrdictError } from '../src/lib/krdict'
import type { LlmClient } from '../src/lib/llm'
import { openTestDb } from './helpers/testDb'

const KEY = 'KEY-TEST-123'
const fixture = (name: string): string => readFileSync(new URL(`./fixtures/krdict/${name}`, import.meta.url), 'utf8')

// Запись без русского текста: есть корейское определение, перевода и русского определения нет
const NO_RUSSIAN_XML =
  '<?xml version="1.0" encoding="UTF-8"?><channel><total>1</total><item><target_code>555</target_code><word>없는말</word><sup_no>0</sup_no><pos>명사</pos><sense><sense_order>1</sense_order><definition>정의.</definition></sense></item></channel>'

const errorXml = (code: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><error><error_code>${code}</error_code><message>test</message></error>`

// Фейковый словарь: ответ зависит от слова в q. Сеть не трогается; запоминает слова, по которым спрашивали.
interface FakeDict { fetchImpl: typeof fetch; queries: string[] }
function fakeDict(respond: (q: string) => Response): FakeDict {
  const queries: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const q = new URL(String(input)).searchParams.get('q') ?? ''
    queries.push(q)
    return respond(q)
  }) as unknown as typeof fetch
  return { fetchImpl, queries }
}

// Словарь, который знает только слова из map (значение — тело ответа); остальные слова → пустой ответ
const knows = (xmlByWord: Record<string, string>): FakeDict =>
  fakeDict(q => new Response(xmlByWord[q] ?? fixture('empty.xml')))

type JsonArgs = Parameters<LlmClient['json']>[0]
interface FakeLlm extends LlmClient { calls: JsonArgs[] }

// Фейковый клиент: json отдаёт ответ по функции; картинки и эмбеддинги в глоссах не нужны
function fakeLlm(answer: (args: JsonArgs) => unknown = () => ({ glosses: [] })): FakeLlm {
  const calls: JsonArgs[] = []
  return {
    calls,
    async json<T>(args: JsonArgs) {
      calls.push(args)
      return { value: answer(args) as T, usage: { inputTokens: 0, outputTokens: 0 } }
    },
    async vision() {
      throw new Error('vision в тестах глоссов не нужен')
    },
    async embed() {
      throw new Error('embed в тестах глоссов не нужен')
    },
  }
}

interface ItemSeed { id: string; kind?: 'vocab' | 'grammar'; level?: number; headword: string; pos?: string; homograph?: number; hint?: string; seq?: number }
async function insertItem(db: Db, s: ItemSeed): Promise<void> {
  await db.query(
    'insert into items (id, kind, level, headword, homograph, pos, hint, seq) values ($1, $2, $3, $4, $5, $6, $7, $8)',
    [s.id, s.kind ?? 'vocab', s.level ?? 1, s.headword, s.homograph ?? 0, s.pos ?? '명사', s.hint ?? '', s.seq ?? 0],
  )
}

// Прогон с поддельными таймерами: паузы между повторами запроса к словарю идут без настоящего ожидания.
// Таймеры двигаем, пока прогон не кончился; setImmediate настоящий, чтобы дать ходу базе и промисам.
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown }
async function runWithFakeTimers<T>(run: () => Promise<T>): Promise<Outcome<T>> {
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  try {
    const box: { outcome?: Outcome<T> } = {}
    run().then(
      value => {
        box.outcome = { ok: true, value }
      },
      error => {
        box.outcome = { ok: false, error }
      },
    )
    for (let i = 0; i < 300 && box.outcome === undefined; i++) {
      await vi.advanceTimersByTimeAsync(1000)
      await new Promise(resolve => setImmediate(resolve))
    }
    if (box.outcome === undefined) throw new Error('прогон не завершился')
    return box.outcome
  } finally {
    vi.useRealTimers()
  }
}

// Записи 배 с частью речи 명사 из фикстуры: supNo 1–4 (supNo 5 — «의존 명사»)
async function baeCandidates(): Promise<DictEntry[]> {
  const entries = await fetchKrdictEntries('배', KEY, knows({ 배: fixture('bae.xml') }).fetchImpl)
  return candidateEntries(entries, { headword: '배', pos: '명사' })
}

// Значение «два раза» (supNo 4) — индекс 3 среди четырёх кандидатов-существительных
const BAE_SUP4_INDEX = 3
const BAE_SUP4_GLOSS = 'два раза; дважды; двойное количество; вдвойне · в несколько раз'
const BAE_SUP4_EXPLANATION = 'Вдвое больше какого-нибудь количества или объёма.'
// Четыре существительных «배» по supNo через «1) … 2) …»
const BAE_NOUNS_GLOSS = '1) живот; утроба; брюхо; желудок 2) лодка; судно; пароход 3) груша 4) два раза; дважды; двойное количество; вдвойне'

interface NoteRow { item_id: string; gloss_ru: string | null; explanation_ru: string | null; source: string | null; krdict_code: string | null }
const notes = (db: Db): Promise<NoteRow[]> =>
  db.query<NoteRow>('select item_id, gloss_ru, explanation_ru, source, krdict_code from item_notes order by item_id')

// Ошибка из промиса; если промис разрешился, тест падает.
async function errorOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (e) {
    return e
  }
  throw new Error('ожидалась ошибка, но промис разрешился')
}

const GAGE_GLOSS = 'магазин; лавка; ларек'
const GAGE_EXPLANATION = 'Здание или помещение для мелкой розничной торговли.'

describe('ingestGlosses', () => {
  it('русское значение найдено → item_notes с source krdict и кодом словаря; done', async () => {
    const db = await openTestDb()
    await insertItem(db, { id: 'v:1', headword: '가게' })
    const dict = knows({ 가게: fixture('gage.xml') })
    expect(await ingestGlosses(db, { apiKey: KEY, fetchImpl: dict.fetchImpl, delayMs: 0 })).toEqual({ done: 1, missing: 0, chosenByAi: 0, skipped: 0 })
    expect(await notes(db)).toEqual([
      { item_id: 'v:1', gloss_ru: GAGE_GLOSS, explanation_ru: GAGE_EXPLANATION, source: 'krdict', krdict_code: '17287' },
    ])
  })

  it('только слова 1–4급 без строки; по уровню и номеру; limit ограничивает число слов', async () => {
    const db = await openTestDb()
    await insertItem(db, { id: 'v:9', level: 2, headword: '없는말', seq: 9 })
    await insertItem(db, { id: 'v:5', level: 5, headword: '가게', seq: 1 })
    await insertItem(db, { id: 'g:1', kind: 'grammar', level: 1, headword: '가게', seq: 1 })
    await insertItem(db, { id: 'v:2', level: 1, headword: '없는말', seq: 2 })
    await insertItem(db, { id: 'v:3', level: 1, headword: '가게', seq: 3 })
    const dict = knows({ 가게: fixture('gage.xml') })

    expect(await ingestGlosses(db, { apiKey: KEY, fetchImpl: dict.fetchImpl, delayMs: 0, limit: 2 })).toEqual({ done: 1, missing: 1, chosenByAi: 0, skipped: 0 })
    // v:2 (1급, №2) раньше v:3 (1급, №3); 2급 v:9 ещё не спрашивали; 5급 и грамматика не берутся
    expect(dict.queries).toEqual(['없는말', '가게'])

    expect(await ingestGlosses(db, { apiKey: KEY, fetchImpl: dict.fetchImpl, delayMs: 0 })).toEqual({ done: 0, missing: 1, chosenByAi: 0, skipped: 0 })
    expect(dict.queries).toEqual(['없는말', '가게', '없는말'])
  })

  it('возобновляем: второй прогон не делает запросов и не дублирует строки', async () => {
    const db = await openTestDb()
    await insertItem(db, { id: 'v:1', headword: '가게' })
    await insertItem(db, { id: 'v:2', headword: '없는말', seq: 2 })
    const dict = knows({ 가게: fixture('gage.xml') })
    await ingestGlosses(db, { apiKey: KEY, fetchImpl: dict.fetchImpl, delayMs: 0 })
    expect(dict.queries).toHaveLength(2)

    expect(await ingestGlosses(db, { apiKey: KEY, fetchImpl: dict.fetchImpl, delayMs: 0 })).toEqual({ done: 0, missing: 0, chosenByAi: 0, skipped: 0 })
    expect(dict.queries).toHaveLength(2)
    expect(await notes(db)).toHaveLength(2)
  })

  it('словарь ответил без записи → строка с gloss_ru null и source null, missing; повторно не спрашивается', async () => {
    const db = await openTestDb()
    await insertItem(db, { id: 'v:1', headword: '없는말' })
    const dict = knows({})
    expect(await ingestGlosses(db, { apiKey: KEY, fetchImpl: dict.fetchImpl, delayMs: 0 })).toEqual({ done: 0, missing: 1, chosenByAi: 0, skipped: 0 })
    expect(await notes(db)).toEqual([{ item_id: 'v:1', gloss_ru: null, explanation_ru: null, source: null, krdict_code: null }])

    await ingestGlosses(db, { apiKey: KEY, fetchImpl: dict.fetchImpl, delayMs: 0 })
    expect(dict.queries).toHaveLength(1)
  })

  it('запись есть, но русского текста нет → строка с null, missing', async () => {
    const db = await openTestDb()
    await insertItem(db, { id: 'v:1', headword: '없는말' })
    const dict = knows({ 없는말: NO_RUSSIAN_XML })
    expect(await ingestGlosses(db, { apiKey: KEY, fetchImpl: dict.fetchImpl, delayMs: 0 })).toEqual({ done: 0, missing: 1, chosenByAi: 0, skipped: 0 })
    expect(await notes(db)).toEqual([{ item_id: 'v:1', gloss_ru: null, explanation_ru: null, source: null, krdict_code: null }])
  })

  it('сбой сети: до 3 попыток, затем skipped БЕЗ строки; следующий запуск спросит снова', async () => {
    const db = await openTestDb()
    await insertItem(db, { id: 'v:1', headword: '가게' })
    const dict = fakeDict(() => {
      throw new TypeError('fetch failed')
    })
    expect(await ingestGlosses(db, { apiKey: KEY, fetchImpl: dict.fetchImpl, delayMs: 0 })).toEqual({ done: 0, missing: 0, chosenByAi: 0, skipped: 1 })
    expect(dict.queries).toHaveLength(3)
    expect(await notes(db)).toEqual([])

    await ingestGlosses(db, { apiKey: KEY, fetchImpl: dict.fetchImpl, delayMs: 0 })
    expect(dict.queries).toHaveLength(6)
  })

  it('HTTP 503: тоже до 3 попыток и skipped без строки', async () => {
    const db = await openTestDb()
    await insertItem(db, { id: 'v:1', headword: '가게' })
    const dict = fakeDict(() => new Response('service down', { status: 503 }))
    expect(await ingestGlosses(db, { apiKey: KEY, fetchImpl: dict.fetchImpl, delayMs: 0 })).toEqual({ done: 0, missing: 0, chosenByAi: 0, skipped: 1 })
    expect(dict.queries).toHaveLength(3)
    expect(await notes(db)).toEqual([])
  })

  it.each(['010', '020', '021'])('код словаря %s прерывает прогон ошибкой без повтора; записанное раньше сохраняется', async code => {
    const db = await openTestDb()
    await insertItem(db, { id: 'v:1', headword: '가게', seq: 1 })
    await insertItem(db, { id: 'v:2', headword: '없는말', seq: 2 })
    const dict = fakeDict(q => new Response(q === '가게' ? fixture('gage.xml') : errorXml(code)))

    const err = await errorOf(ingestGlosses(db, { apiKey: KEY, fetchImpl: dict.fetchImpl, delayMs: 0 }))
    expect(err).toBeInstanceOf(KrdictError)
    expect((err as KrdictError).code).toBe(code)
    expect(dict.queries).toEqual(['가게', '없는말'])
    expect((await notes(db)).map(n => n.item_id)).toEqual(['v:1'])
  })

  it('несколько значений: ИИ выбирает по подсказке → source krdict и код записи, chosenByAi 1', async () => {
    const db = await openTestDb()
    await insertItem(db, { id: 'v:1', headword: '배', pos: '명사', hint: '두 배' })
    const dict = knows({ 배: fixture('bae.xml') })
    const llm = fakeLlm(() => ({ index: BAE_SUP4_INDEX }))

    expect(await ingestGlosses(db, { apiKey: KEY, fetchImpl: dict.fetchImpl, llm, delayMs: 0 })).toEqual({ done: 1, missing: 0, chosenByAi: 1, skipped: 0 })
    expect(await notes(db)).toEqual([
      { item_id: 'v:1', gloss_ru: BAE_SUP4_GLOSS, explanation_ru: BAE_SUP4_EXPLANATION, source: 'krdict', krdict_code: '15901' },
    ])
    // в запрос к модели попали подсказка и четыре существительных-кандидата
    expect(llm.calls).toHaveLength(1)
    const payload = JSON.parse(llm.calls[0].user) as { hint: string; candidates: { pos: string }[] }
    expect(payload.hint).toBe('두 배')
    expect(payload.candidates.map(c => c.pos)).toEqual(['명사', '명사', '명사', '명사'])
  })

  it('несколько значений и llm не передан → слово без строки (skipped); ИИ не вызывается', async () => {
    const db = await openTestDb()
    await insertItem(db, { id: 'v:1', headword: '배', pos: '명사', hint: '두 배' })
    const dict = knows({ 배: fixture('bae.xml') })

    expect(await ingestGlosses(db, { apiKey: KEY, fetchImpl: dict.fetchImpl, delayMs: 0 })).toEqual({ done: 0, missing: 0, chosenByAi: 0, skipped: 1 })
    expect(await notes(db)).toEqual([])
  })

  it('несколько значений, модель вернула null → строка с gloss_ru null, missing; chosenByAi 0', async () => {
    const db = await openTestDb()
    await insertItem(db, { id: 'v:1', headword: '배', pos: '명사', hint: '두 배' })
    const dict = knows({ 배: fixture('bae.xml') })
    const llm = fakeLlm(() => ({ index: null }))

    expect(await ingestGlosses(db, { apiKey: KEY, fetchImpl: dict.fetchImpl, llm, delayMs: 0 })).toEqual({ done: 0, missing: 1, chosenByAi: 0, skipped: 0 })
    expect(await notes(db)).toEqual([{ item_id: 'v:1', gloss_ru: null, explanation_ru: null, source: null, krdict_code: null }])
  })

  it('несколько значений, ошибка модели → слово пропущено без строки, lastModelError; следующий запуск спросит снова', async () => {
    const db = await openTestDb()
    await insertItem(db, { id: 'v:1', headword: '배', pos: '명사', hint: '두 배' })
    const dict = knows({ 배: fixture('bae.xml') })
    const failing = fakeLlm(() => {
      throw new Error('модель недоступна')
    })

    expect(await ingestGlosses(db, { apiKey: KEY, fetchImpl: dict.fetchImpl, llm: failing, delayMs: 0 })).toEqual({
      done: 0,
      missing: 0,
      chosenByAi: 0,
      skipped: 1,
      lastModelError: 'модель недоступна',
    })
    expect(await notes(db)).toEqual([])

    const llm = fakeLlm(() => ({ index: BAE_SUP4_INDEX }))
    expect(await ingestGlosses(db, { apiKey: KEY, fetchImpl: dict.fetchImpl, llm, delayMs: 0 })).toEqual({ done: 1, missing: 0, chosenByAi: 1, skipped: 0 })
    expect(llm.calls).toHaveLength(1)
  })

  it('пять слов подряд с ошибкой модели прерывают прогон ошибкой с её текстом; записанное раньше остаётся', async () => {
    const db = await openTestDb()
    await insertItem(db, { id: 'v:1', headword: '가게', seq: 1 })
    for (let i = 2; i <= 7; i++) await insertItem(db, { id: `v:${i}`, headword: '배', pos: '명사', hint: '두 배', seq: i })
    const dict = knows({ 가게: fixture('gage.xml'), 배: fixture('bae.xml') })
    const llm = fakeLlm(() => {
      throw new Error('модель недоступна')
    })

    const err = await errorOf(ingestGlosses(db, { apiKey: KEY, fetchImpl: dict.fetchImpl, llm, delayMs: 0 }))
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('ИИ недоступен: 5 слов подряд с ошибкой: модель недоступна')
    // 가게 берётся без ИИ; пять слов с 배 спросили модель, шестое и седьмое не спрашивали
    expect(llm.calls).toHaveLength(5)
    expect((await notes(db)).map(n => n.item_id)).toEqual(['v:1'])
  })

  it('успешный ответ модели сбрасывает счёт: четыре ошибки, ответ, четыре ошибки — прогон доходит до конца', async () => {
    const db = await openTestDb()
    for (let i = 1; i <= 9; i++) await insertItem(db, { id: `v:${i}`, headword: '배', pos: '명사', hint: '두 배', seq: i })
    const dict = knows({ 배: fixture('bae.xml') })
    let calls = 0
    const llm = fakeLlm(() => {
      calls++
      if (calls === 5) return { index: BAE_SUP4_INDEX }
      throw new Error('модель недоступна')
    })

    expect(await ingestGlosses(db, { apiKey: KEY, fetchImpl: dict.fetchImpl, llm, delayMs: 0 })).toEqual({
      done: 1,
      missing: 0,
      chosenByAi: 1,
      skipped: 8,
      lastModelError: 'модель недоступна',
    })
    expect((await notes(db)).map(n => n.item_id)).toEqual(['v:5'])
  })

  it('единственная запись с чужой частью речи: без llm → слово без строки; с llm → запрос к модели', async () => {
    const db = await openTestDb()
    await insertItem(db, { id: 'v:1', headword: '가게', pos: '동사' })
    const dict = knows({ 가게: fixture('gage.xml') })

    expect(await ingestGlosses(db, { apiKey: KEY, fetchImpl: dict.fetchImpl, delayMs: 0 })).toEqual({ done: 0, missing: 0, chosenByAi: 0, skipped: 1 })
    expect(await notes(db)).toEqual([])

    const llm = fakeLlm(() => ({ index: 0 }))
    expect(await ingestGlosses(db, { apiKey: KEY, fetchImpl: dict.fetchImpl, llm, delayMs: 0 })).toEqual({ done: 1, missing: 0, chosenByAi: 1, skipped: 0 })
    expect(llm.calls).toHaveLength(1)
    expect(await notes(db)).toEqual([
      { item_id: 'v:1', gloss_ru: GAGE_GLOSS, explanation_ru: GAGE_EXPLANATION, source: 'krdict', krdict_code: '17287' },
    ])
  })

  it('единственная запись с подходящей частью речи → модель не вызывается', async () => {
    const db = await openTestDb()
    await insertItem(db, { id: 'v:1', headword: '가게', pos: '명사' })
    const dict = knows({ 가게: fixture('gage.xml') })
    const llm = fakeLlm(() => ({ index: null }))

    expect(await ingestGlosses(db, { apiKey: KEY, fetchImpl: dict.fetchImpl, llm, delayMs: 0 })).toEqual({ done: 1, missing: 0, chosenByAi: 0, skipped: 0 })
    expect(llm.calls).toHaveLength(0)
  })

  it('сбой словаря: skipped без строки, модель не вызывается', async () => {
    const db = await openTestDb()
    await insertItem(db, { id: 'v:1', headword: '가게' })
    const dict = fakeDict(() => {
      throw new TypeError('fetch failed')
    })
    const llm = fakeLlm(() => ({ index: 0 }))
    const r = await runWithFakeTimers(() => ingestGlosses(db, { apiKey: KEY, fetchImpl: dict.fetchImpl, llm, delayMs: 0 }))
    expect(r).toEqual({ ok: true, value: { done: 0, missing: 0, chosenByAi: 0, skipped: 1 } })
    expect(llm.calls).toHaveLength(0)
  })

  it('пять слов подряд без ответа словаря прерывают прогон ошибкой; записанное раньше остаётся', async () => {
    const db = await openTestDb()
    await insertItem(db, { id: 'v:1', headword: '가게', seq: 1 })
    for (let i = 2; i <= 7; i++) await insertItem(db, { id: `v:${i}`, headword: `없는말${i}`, seq: i })
    const dict = fakeDict(q => {
      if (q === '가게') return new Response(fixture('gage.xml'))
      throw new TypeError('fetch failed')
    })

    const r = await runWithFakeTimers(() => ingestGlosses(db, { apiKey: KEY, fetchImpl: dict.fetchImpl, delayMs: 0 }))
    if (r.ok) throw new Error('ожидалась ошибка, но прогон завершился')
    expect(r.error).toBeInstanceOf(Error)
    expect((r.error as Error).message).toBe('словарь недоступен: 5 слов подряд без ответа')
    // 가게 — один запрос; пять слов по три попытки; шестое слово уже не спрашивали
    expect(dict.queries).toHaveLength(1 + 5 * 3)
    expect((await notes(db)).map(n => n.item_id)).toEqual(['v:1'])
  })

  it('успешный ответ сбрасывает счёт: четыре сбоя, ответ, четыре сбоя — прогон доходит до конца', async () => {
    const db = await openTestDb()
    for (let i = 1; i <= 9; i++) {
      await insertItem(db, { id: `v:${i}`, headword: i === 5 ? '가게' : `없는말${i}`, seq: i })
    }
    const dict = fakeDict(q => {
      if (q === '가게') return new Response(fixture('gage.xml'))
      throw new TypeError('fetch failed')
    })

    const r = await runWithFakeTimers(() => ingestGlosses(db, { apiKey: KEY, fetchImpl: dict.fetchImpl, delayMs: 0 }))
    expect(r).toEqual({ ok: true, value: { done: 1, missing: 0, chosenByAi: 0, skipped: 8 } })
    expect((await notes(db)).map(n => n.item_id)).toEqual(['v:5'])
  })
})

describe('chooseEntryWithAi', () => {
  const item = { headword: '배', pos: '명사', level: 1 as const, hint: '두 배' }
  type Payload = { hint: string; candidates: { index: number; pos: string; senses: { definitionKo: string; translationRu: string | null; definitionRu: string | null }[] }[] }

  it('индекс из списка → запись этого кандидата; в запросе подсказка и четыре существительных', async () => {
    const candidates = await baeCandidates()
    const llm = fakeLlm(() => ({ index: BAE_SUP4_INDEX }))

    expect((await chooseEntryWithAi(llm, item, candidates))?.supNo).toBe(4)
    expect(llm.calls).toHaveLength(1)
    expect(llm.calls[0].role).toBe('light')
    expect(llm.calls[0].schema).toMatchObject({ required: ['index'] })

    const payload = JSON.parse(llm.calls[0].user) as Payload
    expect(payload.hint).toBe('두 배')
    expect(payload.candidates).toHaveLength(4)
    expect(payload.candidates.map(c => c.pos)).toEqual(['명사', '명사', '명사', '명사'])
    expect(payload.candidates.map(c => c.index)).toEqual([0, 1, 2, 3])
  })

  it('кандидату передаются корейские толкования и русские переводы только первых трёх значений', async () => {
    const candidates = await baeCandidates()
    const llm = fakeLlm(() => ({ index: 0 }))
    expect((await chooseEntryWithAi(llm, item, candidates))?.supNo).toBe(1)

    const first = (JSON.parse(llm.calls[0].user) as Payload).candidates[0]
    expect(first.senses).toHaveLength(3)
    expect(first.senses[0]).toEqual({
      definitionKo: '사람이나 동물의 몸에서, 가슴 아래에서 다리 위까지의 부분.',
      translationRu: 'живот; утроба; брюхо; желудок',
      definitionRu: 'Часть тела человека или животного между нижней частью груди и верхней частью ног.',
    })
  })

  it('пустая подсказка уходит в запрос пустой строкой', async () => {
    const candidates = await baeCandidates()
    const llm = fakeLlm(() => ({ index: 1 }))
    expect((await chooseEntryWithAi(llm, { ...item, hint: '' }, candidates))?.supNo).toBe(2)
    expect((JSON.parse(llm.calls[0].user) as Payload).hint).toBe('')
  })

  it('системная подсказка: названия частей речи в списке и словаре различаются; выбор по значению подсказки', async () => {
    const candidates = await baeCandidates()
    const llm = fakeLlm(() => ({ index: null }))
    await chooseEntryWithAi(llm, item, candidates)
    expect(llm.calls[0].system).toContain('품사 없음')
    expect(llm.calls[0].system).toContain('의존 명사')
    expect(llm.calls[0].system).toContain('подсказка указывает')
  })

  it('null, номер вне списка, отрицательный или не целый → null', async () => {
    const candidates = await baeCandidates()
    for (const answer of [{ index: null }, { index: candidates.length }, { index: -1 }, { index: 1.5 }]) {
      expect(await chooseEntryWithAi(fakeLlm(() => answer), item, candidates)).toBeNull()
    }
  })
})

describe('fillMissingGlossesWithAi', () => {
  it('ставит source ai только строкам с gloss_ru null; чужие id из ответа игнорируются', async () => {
    const db = await openTestDb()
    await insertItem(db, { id: 'v:1', headword: '없는말', pos: '명사', seq: 1 })
    await insertItem(db, { id: 'v:2', headword: '모르는말', pos: '동사', seq: 2 })
    await insertItem(db, { id: 'v:3', headword: '가게', pos: '명사', seq: 3 })
    await db.query('insert into item_notes (item_id, gloss_ru, source) values ($1, $2, $3)', ['v:1', null, null])
    await db.query('insert into item_notes (item_id, gloss_ru, source) values ($1, $2, $3)', ['v:3', 'магазин', 'krdict'])

    const llm = fakeLlm(() => ({
      glosses: [
        { id: 'v:1', glossRu: 'неизвестное' },
        { id: 'v:3', glossRu: 'другое' }, // уже с русским значением: не трогаем
        { id: 'v:2', glossRu: 'чужой' }, // строки в item_notes нет: не трогаем
        { id: 'v:999', glossRu: 'чужой id' }, // такого слова нет
      ],
    }))
    expect(await fillMissingGlossesWithAi(db, llm)).toBe(1)

    expect(llm.calls).toHaveLength(1)
    expect(llm.calls[0].role).toBe('light')
    expect(llm.calls[0].user).toContain('없는말')
    expect(llm.calls[0].user).not.toContain('가게')
    expect(await notes(db)).toEqual([
      { item_id: 'v:1', gloss_ru: 'неизвестное', explanation_ru: null, source: 'ai', krdict_code: null },
      { item_id: 'v:3', gloss_ru: 'магазин', explanation_ru: null, source: 'krdict', krdict_code: null },
    ])
  })

  it('пустой glossRu оставляет null и source null', async () => {
    const db = await openTestDb()
    await insertItem(db, { id: 'v:1', headword: '없는말' })
    await db.query('insert into item_notes (item_id, gloss_ru, source) values ($1, $2, $3)', ['v:1', null, null])
    const llm = fakeLlm(() => ({ glosses: [{ id: 'v:1', glossRu: '' }] }))
    expect(await fillMissingGlossesWithAi(db, llm)).toBe(0)
    expect(await notes(db)).toEqual([{ item_id: 'v:1', gloss_ru: null, explanation_ru: null, source: null, krdict_code: null }])
  })

  it('пачками по 20 слов: 25 строк → два запроса (20 и 5)', async () => {
    const db = await openTestDb()
    for (let i = 1; i <= 25; i++) {
      await insertItem(db, { id: `v:${i}`, headword: `단어${i}`, seq: i })
      await db.query('insert into item_notes (item_id, gloss_ru, source) values ($1, $2, $3)', [`v:${i}`, null, null])
    }
    const llm = fakeLlm(args => {
      const ids = (JSON.parse(args.user) as { id: string }[]).map(x => x.id)
      return { glosses: ids.map(id => ({ id, glossRu: 'слово' })) }
    })
    expect(await fillMissingGlossesWithAi(db, llm)).toBe(25)
    expect(llm.calls.map(c => (JSON.parse(c.user) as unknown[]).length)).toEqual([20, 5])
  })

  it('limit: заполняет не больше limit слов, остальные остаются без значения', async () => {
    const db = await openTestDb()
    for (let i = 1; i <= 3; i++) {
      await insertItem(db, { id: `v:${i}`, headword: `단어${i}`, seq: i })
      await db.query('insert into item_notes (item_id, gloss_ru, source) values ($1, $2, $3)', [`v:${i}`, null, null])
    }
    const llm = fakeLlm(args => {
      const ids = (JSON.parse(args.user) as { id: string }[]).map(x => x.id)
      return { glosses: ids.map(id => ({ id, glossRu: 'слово' })) }
    })
    expect(await fillMissingGlossesWithAi(db, llm, { limit: 2 })).toBe(2)
    expect(llm.calls).toHaveLength(1)
    expect((await notes(db)).map(n => [n.item_id, n.gloss_ru])).toEqual([
      ['v:1', 'слово'],
      ['v:2', 'слово'],
      ['v:3', null],
    ])
  })

  it('только слова vocab; в запрос идёт подсказка, в системной подсказке сказано переводить значение, на которое она указывает', async () => {
    const db = await openTestDb()
    await insertItem(db, { id: 'v:1', headword: '배', pos: '명사', hint: '두 배', seq: 1 })
    await insertItem(db, { id: 'g:1', kind: 'grammar', headword: '-고', pos: '어미', seq: 2 })
    await db.query('insert into item_notes (item_id, gloss_ru, source) values ($1, $2, $3)', ['v:1', null, null])
    await db.query('insert into item_notes (item_id, gloss_ru, source) values ($1, $2, $3)', ['g:1', null, null])
    const llm = fakeLlm(() => ({ glosses: [{ id: 'v:1', glossRu: 'два раза' }, { id: 'g:1', glossRu: 'чужой' }] }))

    expect(await fillMissingGlossesWithAi(db, llm)).toBe(1)
    expect(llm.calls).toHaveLength(1)
    expect(JSON.parse(llm.calls[0].user)).toEqual([{ id: 'v:1', word: '배', pos: '명사', hint: '두 배' }])
    expect(llm.calls[0].system).toContain('указывает')
    expect(await notes(db)).toEqual([
      { item_id: 'g:1', gloss_ru: null, explanation_ru: null, source: null, krdict_code: null },
      { item_id: 'v:1', gloss_ru: 'два раза', explanation_ru: null, source: 'ai', krdict_code: null },
    ])
  })
})

describe('lookupLemma', () => {
  it('кэш: второй вызов берёт из lemma_cache без словаря и ИИ; лемма сравнивается в NFC', async () => {
    const db = await openTestDb()
    const dict = knows({ 가게: fixture('gage.xml') })
    const first = await lookupLemma(db, fakeLlm(), '가게'.normalize('NFD'), 'NNG', KEY, dict.fetchImpl)
    expect(first).toEqual({ glossRu: GAGE_GLOSS, source: 'krdict' })
    expect(dict.queries).toEqual(['가게'])

    const dict2 = fakeDict(() => {
      throw new Error('словарь не должен вызываться')
    })
    const llm2 = fakeLlm(() => {
      throw new Error('ИИ не должен вызываться')
    })
    expect(await lookupLemma(db, llm2, '가게', 'NNG', KEY, dict2.fetchImpl)).toEqual({ glossRu: GAGE_GLOSS, source: 'krdict' })
    expect(dict2.queries).toHaveLength(0)
    expect(llm2.calls).toHaveLength(0)
    expect(await db.query('select lemma, pos, gloss_ru, source from lemma_cache')).toEqual([
      { lemma: '가게', pos: 'NNG', gloss_ru: GAGE_GLOSS, source: 'krdict' },
    ])
  })

  it('без ключа словаря → ИИ, в кэш source ai; второй вызов из кэша', async () => {
    const db = await openTestDb()
    const llm = fakeLlm(() => ({ glossRu: 'вывеска' }))
    expect(await lookupLemma(db, llm, '간판', 'NNG')).toEqual({ glossRu: 'вывеска', source: 'ai' })
    expect(llm.calls[0].role).toBe('light')

    const llm2 = fakeLlm(() => {
      throw new Error('ИИ не должен вызываться')
    })
    expect(await lookupLemma(db, llm2, '간판', 'NNG')).toEqual({ glossRu: 'вывеска', source: 'ai' })
    expect(llm2.calls).toHaveLength(0)
    expect(await db.query('select source from lemma_cache')).toEqual([{ source: 'ai' }])
  })

  it.each(['NNB', 'NNBC'])('тег анализатора %s переводится в часть речи словаря 의존명사, а не 명사', async tag => {
    const db = await openTestDb()
    const dict = knows({ 배: fixture('bae.xml') })
    expect(await lookupLemma(db, fakeLlm(), '배', tag, KEY, dict.fetchImpl)).toEqual({
      glossRu: 'Единица исчисления полных бокалов спиртного или др. напитков',
      source: 'krdict',
    })
  })

  it('배 с NNG на фикстуре bae: нумерованный список из четырёх значений-существительных; в кэш source krdict', async () => {
    const db = await openTestDb()
    const dict = knows({ 배: fixture('bae.xml') })
    expect(await lookupLemma(db, fakeLlm(), '배', 'NNG', KEY, dict.fetchImpl)).toEqual({ glossRu: BAE_NOUNS_GLOSS, source: 'krdict' })
    expect(await db.query('select lemma, pos, source from lemma_cache')).toEqual([{ lemma: '배', pos: 'NNG', source: 'krdict' }])
  })

  it('нет в словаре и ИИ не дал значения → { glossRu: null, source: null }, кэш пуст', async () => {
    const db = await openTestDb()
    const dict = knows({})
    const llm = fakeLlm(() => ({ glossRu: null }))
    expect(await lookupLemma(db, llm, '없는말', 'NNG', KEY, dict.fetchImpl)).toEqual({ glossRu: null, source: null })
    expect(llm.calls).toHaveLength(1)
    expect(await db.query('select * from lemma_cache')).toEqual([])
  })

  it('llm = null при промахе словаря → { glossRu: null, source: null }; ИИ не вызывается, кэш пуст', async () => {
    const db = await openTestDb()
    const dict = knows({})
    expect(await lookupLemma(db, null, '없는말', 'NNG', KEY, dict.fetchImpl)).toEqual({ glossRu: null, source: null })
    expect(await db.query('select * from lemma_cache')).toEqual([])
  })

  it('llm = null и без ключа словаря → { glossRu: null, source: null }', async () => {
    const db = await openTestDb()
    expect(await lookupLemma(db, null, '가게', 'NNG')).toEqual({ glossRu: null, source: null })
  })

  it('llm = null, словарь нашёл значение → значение словаря', async () => {
    const db = await openTestDb()
    const dict = knows({ 가게: fixture('gage.xml') })
    expect(await lookupLemma(db, null, '가게', 'NNG', KEY, dict.fetchImpl)).toEqual({ glossRu: GAGE_GLOSS, source: 'krdict' })
  })

  it('ответ ИИ при ошибке словаря возвращается, но в кэш не пишется', async () => {
    const db = await openTestDb()
    const dict = fakeDict(() => {
      throw new TypeError('fetch failed')
    })
    const llm = fakeLlm(() => ({ glossRu: 'магазин' }))
    expect(await lookupLemma(db, llm, '가게', 'NNG', KEY, dict.fetchImpl)).toEqual({ glossRu: 'магазин', source: 'ai' })
    expect(await db.query('select * from lemma_cache')).toEqual([])
  })
})

describe('fixSharedEntries', () => {
  // В фикстуре bae.xml статьи с точным «배» по порядку supNo: индекс = supNo − 1.
  // supNo 4 — «два раза» (код 15901), supNo 2 — «лодка» (код 29729).
  const SUP4_INDEX = 3
  const SUP2_INDEX = 1
  // supNo 3 — «груша» (код 31454)
  const SUP3_INDEX = 2
  const SHIP_GLOSS = 'лодка; судно; пароход'
  const SHIP_EXPLANATION = 'Транспортное средство, перевозящее людей или грузы по воде.'
  const PEAR_GLOSS = 'груша'
  const PEAR_EXPLANATION = 'Плод круглой формы с жёлтой кожурой и белой мякотью, очень сочный и сладкий на вкус, созревающий осенью.'

  async function seedNote(db: Db, itemId: string, glossRu: string | null, explanationRu: string | null, code: string): Promise<void> {
    await db.query(
      'insert into item_notes (item_id, gloss_ru, explanation_ru, source, krdict_code) values ($1, $2, $3, $4, $5)',
      [itemId, glossRu, explanationRu, 'krdict', code],
    )
  }

  // Два омонима «배» с одной статьёй (код 15901, «два раза»): общая статья
  async function seedSharedPair(db: Db): Promise<void> {
    await insertItem(db, { id: 'v:1', headword: '배', pos: '명사', hint: '두 배', homograph: 3, seq: 1 })
    await insertItem(db, { id: 'v:2', headword: '배', pos: '명사', hint: '배를 타고', homograph: 2, seq: 2 })
    await seedNote(db, 'v:1', BAE_SUP4_GLOSS, BAE_SUP4_EXPLANATION, '15901')
    await seedNote(db, 'v:2', BAE_SUP4_GLOSS, BAE_SUP4_EXPLANATION, '15901')
  }

  // То же, и третий омоним «배» вне группы со своей статьёй «лодка» (29729)
  async function seedSharedPairAndOutsider(db: Db): Promise<void> {
    await seedSharedPair(db)
    await insertItem(db, { id: 'v:3', headword: '배', pos: '명사', hint: '배를 타고', homograph: 1, seq: 3 })
    await seedNote(db, 'v:3', SHIP_GLOSS, SHIP_EXPLANATION, '29729')
  }

  it('два омонима с одной статьёй: записывается выбор модели; модель вызвана один раз, переписана только вторая строка', async () => {
    const db = await openTestDb()
    await seedSharedPair(db)
    const dict = knows({ 배: fixture('bae.xml') })
    const llm = fakeLlm(() => ({ picks: [{ item: 0, entry: SUP4_INDEX }, { item: 1, entry: SUP2_INDEX }] }))

    expect(await fixSharedEntries(db, { apiKey: KEY, llm, fetchImpl: dict.fetchImpl, delayMs: 0 })).toEqual({ groups: 1, changed: 1 })
    expect(dict.queries).toEqual(['배'])
    expect(llm.calls).toHaveLength(1)
    expect(llm.calls[0].role).toBe('light')
    expect(await notes(db)).toEqual([
      { item_id: 'v:1', gloss_ru: BAE_SUP4_GLOSS, explanation_ru: BAE_SUP4_EXPLANATION, source: 'krdict', krdict_code: '15901' },
      { item_id: 'v:2', gloss_ru: SHIP_GLOSS, explanation_ru: SHIP_EXPLANATION, source: 'krdict', krdict_code: '29729' },
    ])
  })

  it('в запрос к модели идут омонимы (номер, часть речи, подсказка) и все статьи с точным заглавным словом', async () => {
    const db = await openTestDb()
    await seedSharedPair(db)
    const llm = fakeLlm(() => ({ picks: [] }))
    await fixSharedEntries(db, { apiKey: KEY, llm, fetchImpl: knows({ 배: fixture('bae.xml') }).fetchImpl, delayMs: 0 })

    const payload = JSON.parse(llm.calls[0].user) as {
      word: string
      homographs: { item: number; homograph: number; pos: string; hint: string }[]
      entries: { entry: number; pos: string; senses: unknown[] }[]
    }
    expect(payload.word).toBe('배')
    expect(payload.homographs).toEqual([
      { item: 0, homograph: 3, pos: '명사', hint: '두 배' },
      { item: 1, homograph: 2, pos: '명사', hint: '배를 타고' },
    ])
    // пять статей с точным «배», включая «의존 명사»; «-배» и «배-» не входят
    expect(payload.entries.map(e => [e.entry, e.pos])).toEqual([
      [0, '명사'],
      [1, '명사'],
      [2, '명사'],
      [3, '명사'],
      [4, '의존 명사'],
    ])
    expect(payload.entries[3].senses).toHaveLength(2)
  })

  it('роль модели задаётся опцией role', async () => {
    const db = await openTestDb()
    await seedSharedPair(db)
    const llm = fakeLlm(() => ({ picks: [] }))
    await fixSharedEntries(db, { apiKey: KEY, llm, fetchImpl: knows({ 배: fixture('bae.xml') }).fetchImpl, delayMs: 0, role: 'write' })
    expect(llm.calls[0].role).toBe('write')
  })

  it.each<[string, () => unknown]>([
    ['нет поля picks', () => ({})],
    ['picks не массив', () => ({ picks: 'два' })],
    ['номер статьи вне списка', () => ({ picks: [{ item: 0, entry: 9 }] })],
    ['номер омонима вне списка', () => ({ picks: [{ item: 5, entry: 1 }] })],
    ['номер статьи не целый', () => ({ picks: [{ item: 0, entry: 1.5 }] })],
    ['один омоним дважды', () => ({ picks: [{ item: 0, entry: 3 }, { item: 0, entry: 1 }] })],
    ['элемент picks не объект', () => ({ picks: ['0:3'] })],
    ['ошибка модели', () => {
      throw new Error('модель недоступна')
    }],
  ])('битый ответ модели (%s) ничего не меняет; группа остаётся как есть', async (_name, answer) => {
    const db = await openTestDb()
    await seedSharedPair(db)
    const before = await notes(db)
    const llm = fakeLlm(answer)

    expect(await fixSharedEntries(db, { apiKey: KEY, llm, fetchImpl: knows({ 배: fixture('bae.xml') }).fetchImpl, delayMs: 0 })).toEqual({ groups: 1, changed: 0 })
    expect(llm.calls).toHaveLength(1)
    expect(await notes(db)).toEqual(before)
  })

  it('слова с разными статьями группой не считаются: строки не трогаются, модель не вызывается', async () => {
    const db = await openTestDb()
    await insertItem(db, { id: 'v:1', headword: '배', pos: '명사', hint: '두 배', seq: 1 })
    await insertItem(db, { id: 'v:2', headword: '배', pos: '명사', hint: '배를 타고', seq: 2 })
    await seedNote(db, 'v:1', BAE_SUP4_GLOSS, BAE_SUP4_EXPLANATION, '15901')
    await seedNote(db, 'v:2', SHIP_GLOSS, SHIP_EXPLANATION, '29729')
    const before = await notes(db)
    const dict = knows({ 배: fixture('bae.xml') })
    const llm = fakeLlm(() => ({ picks: [] }))

    expect(await fixSharedEntries(db, { apiKey: KEY, llm, fetchImpl: dict.fetchImpl, delayMs: 0 })).toEqual({ groups: 0, changed: 0 })
    expect(dict.queries).toHaveLength(0)
    expect(llm.calls).toHaveLength(0)
    expect(await notes(db)).toEqual(before)
  })

  it('группа без статьи с точным заглавным словом в словаре: модель не вызывается, строки как есть', async () => {
    const db = await openTestDb()
    await insertItem(db, { id: 'v:1', headword: '없는말', seq: 1 })
    await insertItem(db, { id: 'v:2', headword: '없는말', seq: 2 })
    await seedNote(db, 'v:1', 'слово', null, '555')
    await seedNote(db, 'v:2', 'слово', null, '555')
    const before = await notes(db)
    const dict = knows({})
    const llm = fakeLlm(() => ({ picks: [{ item: 0, entry: 0 }] }))

    expect(await fixSharedEntries(db, { apiKey: KEY, llm, fetchImpl: dict.fetchImpl, delayMs: 0 })).toEqual({ groups: 1, changed: 0 })
    expect(dict.queries).toEqual(['없는말'])
    expect(llm.calls).toHaveLength(0)
    expect(await notes(db)).toEqual(before)
  })

  it('слова 5급 и грамматика в группы не входят', async () => {
    const db = await openTestDb()
    await insertItem(db, { id: 'v:1', level: 5, headword: '배', seq: 1 })
    await insertItem(db, { id: 'v:2', level: 5, headword: '배', seq: 2 })
    await insertItem(db, { id: 'g:1', kind: 'grammar', level: 1, headword: '배', seq: 3 })
    await seedNote(db, 'v:1', BAE_SUP4_GLOSS, BAE_SUP4_EXPLANATION, '15901')
    await seedNote(db, 'v:2', BAE_SUP4_GLOSS, BAE_SUP4_EXPLANATION, '15901')
    await seedNote(db, 'g:1', BAE_SUP4_GLOSS, BAE_SUP4_EXPLANATION, '15901')
    const dict = knows({ 배: fixture('bae.xml') })
    const llm = fakeLlm(() => ({ picks: [] }))

    expect(await fixSharedEntries(db, { apiKey: KEY, llm, fetchImpl: dict.fetchImpl, delayMs: 0 })).toEqual({ groups: 0, changed: 0 })
    expect(dict.queries).toHaveLength(0)
    expect(llm.calls).toHaveLength(0)
  })

  it('entry −1 оставляет строку как есть; другая строка той же группы переписывается', async () => {
    const db = await openTestDb()
    await seedSharedPair(db)
    const dict = knows({ 배: fixture('bae.xml') })
    const llm = fakeLlm(() => ({ picks: [{ item: 0, entry: -1 }, { item: 1, entry: SUP2_INDEX }] }))

    expect(await fixSharedEntries(db, { apiKey: KEY, llm, fetchImpl: dict.fetchImpl, delayMs: 0 })).toEqual({ groups: 1, changed: 1 })
    expect(await notes(db)).toEqual([
      { item_id: 'v:1', gloss_ru: BAE_SUP4_GLOSS, explanation_ru: BAE_SUP4_EXPLANATION, source: 'krdict', krdict_code: '15901' },
      { item_id: 'v:2', gloss_ru: SHIP_GLOSS, explanation_ru: SHIP_EXPLANATION, source: 'krdict', krdict_code: '29729' },
    ])
  })

  it('статья, занятая омонимом вне группы, не переписывается в строку группы; вторая строка группы применяется', async () => {
    const db = await openTestDb()
    await seedSharedPairAndOutsider(db)
    const dict = knows({ 배: fixture('bae.xml') })
    // первому омониму группы модель отдала «лодку» (занята v:3), второму — «грушу»
    const llm = fakeLlm(() => ({ picks: [{ item: 0, entry: SUP2_INDEX }, { item: 1, entry: SUP3_INDEX }] }))

    expect(await fixSharedEntries(db, { apiKey: KEY, llm, fetchImpl: dict.fetchImpl, delayMs: 0 })).toEqual({ groups: 1, changed: 1 })
    expect(await notes(db)).toEqual([
      { item_id: 'v:1', gloss_ru: BAE_SUP4_GLOSS, explanation_ru: BAE_SUP4_EXPLANATION, source: 'krdict', krdict_code: '15901' },
      { item_id: 'v:2', gloss_ru: PEAR_GLOSS, explanation_ru: PEAR_EXPLANATION, source: 'krdict', krdict_code: '31454' },
      { item_id: 'v:3', gloss_ru: SHIP_GLOSS, explanation_ru: SHIP_EXPLANATION, source: 'krdict', krdict_code: '29729' },
    ])
  })

  it('в запросе модели статья, занятая омонимом вне группы, помечена taken: true; остальные статьи без пометки', async () => {
    const db = await openTestDb()
    await seedSharedPairAndOutsider(db)
    const llm = fakeLlm(() => ({ picks: [] }))

    await fixSharedEntries(db, { apiKey: KEY, llm, fetchImpl: knows({ 배: fixture('bae.xml') }).fetchImpl, delayMs: 0 })
    const payload = JSON.parse(llm.calls[0].user) as { entries: { entry: number; taken?: boolean }[] }
    // лодка (entry 1) занята v:3: только у неё есть поле taken
    expect(payload.entries.map(e => [e.entry, 'taken' in e])).toEqual([
      [0, false],
      [1, true],
      [2, false],
      [3, false],
      [4, false],
    ])
    expect(payload.entries[1].taken).toBe(true)
  })

  it('если модель выбрала ту же статью, строка не переписывается', async () => {
    const db = await openTestDb()
    await insertItem(db, { id: 'v:1', headword: '배', pos: '명사', hint: '두 배', seq: 1 })
    await insertItem(db, { id: 'v:2', headword: '배', pos: '명사', hint: '두 배', seq: 2 })
    await seedNote(db, 'v:1', 'старое значение', null, '15901')
    await seedNote(db, 'v:2', BAE_SUP4_GLOSS, BAE_SUP4_EXPLANATION, '15901')
    const llm = fakeLlm(() => ({ picks: [{ item: 0, entry: SUP4_INDEX }, { item: 1, entry: SUP4_INDEX }] }))

    expect(await fixSharedEntries(db, { apiKey: KEY, llm, fetchImpl: knows({ 배: fixture('bae.xml') }).fetchImpl, delayMs: 0 })).toEqual({ groups: 1, changed: 0 })
    expect((await notes(db))[0]).toEqual({ item_id: 'v:1', gloss_ru: 'старое значение', explanation_ru: null, source: 'krdict', krdict_code: '15901' })
  })

  it('статья без русского текста не затирает строку', async () => {
    const db = await openTestDb()
    await insertItem(db, { id: 'v:1', headword: '없는말', seq: 1 })
    await insertItem(db, { id: 'v:2', headword: '없는말', seq: 2 })
    await seedNote(db, 'v:1', 'слово', null, '999')
    await seedNote(db, 'v:2', 'слово', null, '999')
    const before = await notes(db)
    const llm = fakeLlm(() => ({ picks: [{ item: 0, entry: 0 }, { item: 1, entry: -1 }] }))

    expect(await fixSharedEntries(db, { apiKey: KEY, llm, fetchImpl: knows({ 없는말: NO_RUSSIAN_XML }).fetchImpl, delayMs: 0 })).toEqual({ groups: 1, changed: 0 })
    expect(await notes(db)).toEqual(before)
  })

  it('сбой словаря после повторов: группа как есть, модель не вызывается', async () => {
    const db = await openTestDb()
    await seedSharedPair(db)
    const before = await notes(db)
    const dict = fakeDict(() => {
      throw new TypeError('fetch failed')
    })
    const llm = fakeLlm(() => ({ picks: [{ item: 0, entry: SUP4_INDEX }, { item: 1, entry: SUP2_INDEX }] }))

    const r = await runWithFakeTimers(() => fixSharedEntries(db, { apiKey: KEY, llm, fetchImpl: dict.fetchImpl, delayMs: 0 }))
    expect(r).toEqual({ ok: true, value: { groups: 1, changed: 0 } })
    expect(dict.queries).toHaveLength(3)
    expect(llm.calls).toHaveLength(0)
    expect(await notes(db)).toEqual(before)
  })

  it.each(['010', '020', '021'])('код словаря %s прерывает работу ошибкой без повтора', async code => {
    const db = await openTestDb()
    await seedSharedPair(db)
    const before = await notes(db)
    const dict = fakeDict(() => new Response(errorXml(code)))
    const llm = fakeLlm(() => ({ picks: [] }))

    const err = await errorOf(fixSharedEntries(db, { apiKey: KEY, llm, fetchImpl: dict.fetchImpl, delayMs: 0 }))
    expect(err).toBeInstanceOf(KrdictError)
    expect((err as KrdictError).code).toBe(code)
    expect(dict.queries).toHaveLength(1)
    expect(llm.calls).toHaveLength(0)
    expect(await notes(db)).toEqual(before)
  })
})
