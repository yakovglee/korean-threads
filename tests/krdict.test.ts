import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { candidateEntries, combinedGloss, fetchKrdictEntries, glossFromEntry, KrdictError, pickEntry, type DictEntry } from '../src/lib/krdict'

const KEY = 'KEY-TEST-123'

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/krdict/${name}`, import.meta.url), 'utf8')

// Фейковый fetch: отдаёт тело с заданным статусом и запоминает адреса запросов. Сеть не трогается.
function fakeFetch(body: string, status = 200) {
  const urls: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL) => {
    urls.push(String(input))
    return new Response(body, { status })
  }) as unknown as typeof fetch
  return { fetchImpl, urls }
}

// Ошибка из промиса; если промис разрешился, тест падает.
async function errorOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (e) {
    return e
  }
  throw new Error('ожидалась ошибка, но промис разрешился')
}

function must<T>(v: T | null): T {
  if (v === null) throw new Error('запись не найдена')
  return v
}

const loadBae = async (): Promise<DictEntry[]> => fetchKrdictEntries('배', KEY, fakeFetch(fixture('bae.xml')).fetchImpl)

describe('fetchKrdictEntries', () => {
  it('gage: точный поиск, перевод кириллицей, нужные параметры запроса', async () => {
    const { fetchImpl, urls } = fakeFetch(fixture('gage.xml'))
    const entries = await fetchKrdictEntries('가게', KEY, fetchImpl)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ targetCode: '17287', headword: '가게', supNo: 0, pos: '명사' })
    const sense = entries[0].senses[0]
    expect(sense).toEqual({
      order: 1,
      definitionKo: '작은 규모로 물건을 펼쳐 놓고 파는 집.',
      definitionRu: 'Здание или помещение для мелкой розничной торговли.',
      translationRu: 'магазин; лавка; ларек',
    })
    expect(sense.translationRu).toMatch(/[а-яё]/i)

    const url = new URL(urls[0])
    expect(`${url.origin}${url.pathname}`).toBe('https://krdict.korean.go.kr/api/search')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      key: KEY,
      q: '가게',
      translated: 'y',
      trans_lang: '10',
      advanced: 'y',
      method: 'exact',
      num: '100',
    })
  })

  it('q без дефисов по краям, но дефисы в headword ответа сохраняются', async () => {
    const { fetchImpl, urls } = fakeFetch(fixture('bae.xml'))
    const entries = await fetchKrdictEntries('-배', KEY, fetchImpl)
    expect(new URL(urls[0]).searchParams.get('q')).toBe('배')
    expect(entries.map(e => e.headword)).toContain('-배')
  })

  it('bae: 7 записей; у 배 с supNo 5 первое значение без перевода слов, но с определением', async () => {
    const entries = await loadBae()
    expect(entries).toHaveLength(7)
    const sup5 = entries.find(e => e.headword === '배' && e.supNo === 5)
    expect(sup5?.pos).toBe('의존 명사')
    expect(sup5?.senses[0].translationRu).toBeNull()
    expect(sup5?.senses[0].definitionRu).toBe('Единица исчисления полных бокалов спиртного или др. напитков.')
  })

  it('empty: ничего не найдено → пустой массив', async () => {
    expect(await fetchKrdictEntries('없는말', KEY, fakeFetch(fixture('empty.xml')).fetchImpl)).toEqual([])
  })

  it('error: ошибка в теле ответа с HTTP 200 → KrdictError с code 020', async () => {
    const err = await errorOf(fetchKrdictEntries('가게', KEY, fakeFetch(fixture('error.xml')).fetchImpl))
    expect(err).toBeInstanceOf(KrdictError)
    expect((err as KrdictError).code).toBe('020')
    expect((err as KrdictError).message).toContain('Unregistered key')
  })

  it('ключ, который словарь вернул внутри <message> ошибки, в текст KrdictError не попадает', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><error><error_code>020</error_code><message>Unregistered key ${KEY}</message></error>`
    const err = await errorOf(fetchKrdictEntries('가게', KEY, fakeFetch(xml).fetchImpl))
    expect(err).toBeInstanceOf(KrdictError)
    expect((err as KrdictError).code).toBe('020')
    expect((err as KrdictError).message).toContain('Unregistered key [ключ скрыт]')
    expect((err as KrdictError).message).not.toContain(KEY)
  })

  it('HTTP не 2xx → KrdictError; тело ответа и ключ в тексте ошибки не попадают', async () => {
    const err = await errorOf(fetchKrdictEntries('가게', KEY, fakeFetch(`bad key ${KEY}`, 503).fetchImpl))
    expect(err).toBeInstanceOf(KrdictError)
    expect((err as KrdictError).code).toBe('HTTP 503')
    expect((err as KrdictError).message).not.toContain(KEY)
  })

  it('ответ не XML → KrdictError', async () => {
    const err = await errorOf(fetchKrdictEntries('가게', KEY, fakeFetch('<html><body>Service down').fetchImpl))
    expect(err).toBeInstanceOf(KrdictError)
  })

  it('сбой сети: ключ и адрес запроса не попадают в текст ошибки', async () => {
    const failing = (async (input: RequestInfo | URL) => {
      throw new TypeError(`fetch failed: ${String(input)}`)
    }) as unknown as typeof fetch
    const err = await errorOf(fetchKrdictEntries('가게', KEY, failing))
    expect(err).toBeInstanceOf(KrdictError)
    expect((err as KrdictError).message).not.toContain(KEY)
    expect((err as KrdictError).message).not.toContain('krdict.korean.go.kr')
  })
})

describe('pickEntry', () => {
  it('четыре существительных «배» без выбора по номеру: null; номер омонима ничего не решает', async () => {
    const entries = await loadBae()
    expect(pickEntry(entries, { headword: '배', pos: '명사' })).toBeNull()
    // объект не литерал, поэтому лишнее поле не ловится типами: проверяем, что homograph не влияет на результат
    const item = { headword: '배', pos: '명사', homograph: 3 }
    expect(pickEntry(entries, item)).toBeNull()
  })

  it('ровно одна запись с подходящей частью речи → она; «의존 명사» → supNo 5, а не существительное «명사»', async () => {
    const entries = await loadBae()
    expect(pickEntry(entries, { headword: '배', pos: '의존 명사' })?.supNo).toBe(5)
    expect(pickEntry(entries, { headword: '배', pos: '의존명사' })?.supNo).toBe(5)
  })

  it('составная «명사/부사»: существительных четыре → null; «의존 명사/부사» → supNo 5', async () => {
    const entries = await loadBae()
    expect(pickEntry(entries, { headword: '배', pos: '명사/부사' })).toBeNull()
    expect(pickEntry(entries, { headword: '배', pos: '의존 명사/부사' })?.supNo).toBe(5)
  })

  it('дефисы значимы: «-배» → 접사 74950; «배-» → 품사 없음 78550, но не 명사; «배» с 접사 → null', async () => {
    const entries = await loadBae()
    expect(pickEntry(entries, { headword: '-배', pos: '접사' })?.targetCode).toBe('74950')
    expect(pickEntry(entries, { headword: '배-', pos: '품사 없음' })?.targetCode).toBe('78550')
    expect(pickEntry(entries, { headword: '배-', pos: '명사' })).toBeNull()
    expect(pickEntry(entries, { headword: '배', pos: '접사' })).toBeNull()
  })

  it('единственная запись с чужой частью речи → null (решает ИИ в ingestGlosses); подходящая → она; нет записи → null', async () => {
    const gage = await fetchKrdictEntries('가게', KEY, fakeFetch(fixture('gage.xml')).fetchImpl)
    expect(pickEntry(gage, { headword: '가게', pos: '명사' })?.targetCode).toBe('17287')
    expect(pickEntry(gage, { headword: '가게', pos: '동사' })).toBeNull()
    expect(pickEntry(gage, { headword: '없음', pos: '명사' })).toBeNull()
  })
})

describe('candidateEntries', () => {
  it('배 с частью речи 명사: четыре существительных по возрастанию supNo, «의존 명사» и «배-»/«-배» не попадают', async () => {
    const entries = await loadBae()
    const candidates = candidateEntries(entries, { headword: '배', pos: '명사' })
    expect(candidates.map(e => e.supNo)).toEqual([1, 2, 3, 4])
    expect(candidates.every(e => e.pos === '명사')).toBe(true)
  })

  it('порядок по supNo не зависит от порядка в ответе словаря', async () => {
    const entries = [...(await loadBae())].reverse()
    expect(candidateEntries(entries, { headword: '배', pos: '명사' }).map(e => e.supNo)).toEqual([1, 2, 3, 4])
  })

  it('по части речи «의존명사» (без пробела) → только supNo 5', async () => {
    expect(candidateEntries(await loadBae(), { headword: '배', pos: '의존명사' }).map(e => e.supNo)).toEqual([5])
  })

  it('часть речи не совпала ни с одной записью → все записи с этим headword по supNo', async () => {
    expect(candidateEntries(await loadBae(), { headword: '배', pos: '접사' }).map(e => e.supNo)).toEqual([1, 2, 3, 4, 5])
  })

  it('дефисы значимы: «-배» → только запись «-배»', async () => {
    expect(candidateEntries(await loadBae(), { headword: '-배', pos: '접사' }).map(e => e.targetCode)).toEqual(['74950'])
  })

  it('нет записи с таким headword → пустой массив', async () => {
    expect(candidateEntries(await loadBae(), { headword: '없음', pos: '명사' })).toEqual([])
  })
})

describe('glossFromEntry', () => {
  it('gage: переводы слов и определение первого значения', async () => {
    const [entry] = await fetchKrdictEntries('가게', KEY, fakeFetch(fixture('gage.xml')).fetchImpl)
    expect(glossFromEntry(entry)).toEqual({
      glossRu: 'магазин; лавка; ларек',
      explanationRu: 'Здание или помещение для мелкой розничной торговли.',
    })
  })

  it('배 с supNo 5: слов-переводов нет → glossRu из определения без точки', async () => {
    const entry = must(pickEntry(await loadBae(), { headword: '배', pos: '의존 명사' }))
    expect(glossFromEntry(entry)).toEqual({
      glossRu: 'Единица исчисления полных бокалов спиртного или др. напитков',
      explanationRu: 'Единица исчисления полных бокалов спиртного или др. напитков.',
    })
  })

  it('glossRu: слова первых трёх значений, у которых они есть, через « · »; пустые записи → null', () => {
    const sense = (order: number, translationRu: string | null) => ({
      order,
      definitionKo: '정의',
      definitionRu: `Определение ${order}.`,
      translationRu,
    })
    const entry: DictEntry = {
      targetCode: '1',
      headword: '테스트',
      supNo: 0,
      pos: '명사',
      senses: [sense(1, null), sense(2, 'а'), sense(3, null), sense(4, 'б'), sense(5, 'в'), sense(6, 'г')],
    }
    expect(glossFromEntry(entry)).toEqual({ glossRu: 'а · б · в', explanationRu: 'Определение 1.' })
    expect(glossFromEntry({ ...entry, senses: [] })).toEqual({ glossRu: null, explanationRu: null })
  })

  it('одинаковые переводы значений не повторяются; в глоссе идут первые три различных', () => {
    const sense = (order: number, translationRu: string | null) => ({
      order,
      definitionKo: '정의',
      definitionRu: `Определение ${order}.`,
      translationRu,
    })
    const entry: DictEntry = {
      targetCode: '1',
      headword: '테스트',
      supNo: 0,
      pos: '명사',
      senses: [sense(1, 'а'), sense(2, 'а'), sense(3, 'б'), sense(4, 'а'), sense(5, 'в'), sense(6, 'г')],
    }
    expect(glossFromEntry(entry)).toEqual({ glossRu: 'а · б · в', explanationRu: 'Определение 1.' })
  })
})

describe('combinedGloss', () => {
  const sense = (translationRu: string | null, definitionRu: string | null = null) => ({
    order: 1,
    definitionKo: '정의',
    definitionRu,
    translationRu,
  })
  const entryOf = (supNo: number, senses: DictEntry['senses']): DictEntry => ({
    targetCode: String(100 + supNo),
    headword: '테스트',
    supNo,
    pos: '명사',
    senses,
  })

  it('четыре существительных «배» по supNo → нумерованный список первых значений', async () => {
    const candidates = candidateEntries(await loadBae(), { headword: '배', pos: '명사' })
    expect(combinedGloss(candidates)).toBe(
      '1) живот; утроба; брюхо; желудок 2) лодка; судно; пароход 3) груша 4) два раза; дважды; двойное количество; вдвойне',
    )
  })

  it('одна запись → её текст без номера; ни одной записи → null', async () => {
    const sup5 = must(pickEntry(await loadBae(), { headword: '배', pos: '의존 명사' }))
    expect(combinedGloss([sup5])).toBe('Единица исчисления полных бокалов спиртного или др. напитков')
    expect(combinedGloss([entryOf(1, [sense('магазин; лавка')])])).toBe('магазин; лавка')
    expect(combinedGloss([])).toBeNull()
  })

  it('нет слова-перевода → русское толкование без точки; запись без русского текста пропускается', () => {
    const entries = [
      entryOf(2, [sense(null, 'Второе толкование.')]),
      entryOf(1, [sense(null, 'Первое толкование.')]),
      entryOf(3, []),
      entryOf(4, [sense(null, null)]),
    ]
    expect(combinedGloss(entries)).toBe('1) Первое толкование 2) Второе толкование')
  })

  it('записи идут по supNo, в списке не больше четырёх пунктов', () => {
    const entries = [5, 4, 3, 2, 1].map(n => entryOf(n, [sense(`слово${n}`)]))
    expect(combinedGloss(entries)).toBe('1) слово1 2) слово2 3) слово3 4) слово4')
  })

  it('запись без русского текста не занимает место в списке', () => {
    const entries = [entryOf(1, [sense(null, null)]), ...[2, 3, 4, 5, 6].map(n => entryOf(n, [sense(`слово${n}`)]))]
    expect(combinedGloss(entries)).toBe('1) слово2 2) слово3 3) слово4 4) слово5')
  })
})
