import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  analyze, analyzeToSegments, AnalyzerError, grammarMatches, loadLexicon, posGroup, resolveMorphs, segmentText, toMorphs,
  type MecabToken, type Morph,
} from '../src/lib/analyzer'
import type { Db } from '../src/lib/db'
import type { Item, Level } from '../src/lib/types'
import { openTestDb } from './helpers/testDb'

// настоящие ответы сервиса: {text, tokens}, где tokens — сырой массив, как его отдаёт mecab-ko-fastapi
interface Fixture { text: string; tokens: unknown[] }
const fixture = (name: string): Fixture =>
  JSON.parse(readFileSync(new URL(`./fixtures/mecab/${name}.json`, import.meta.url), 'utf8')) as Fixture

const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

interface Call { url: string; init: RequestInit }

// фейковый fetch: запоминает вызовы и отвечает тем Response, что вернёт res()
function replying(res: () => Response) {
  const calls: Call[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return res()
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

// токены фикстуры через analyze: так заодно проверяется разбор ответа
async function tokensOf(name: string): Promise<{ text: string; tokens: MecabToken[] }> {
  const fx = fixture(name)
  const { fetchImpl } = replying(() => jsonRes(fx.tokens))
  return { text: fx.text, tokens: await analyze(fx.text, 'http://analyzer.test', fetchImpl) }
}

// морфемы всей фразы фикстуры (как их получает resolveMorphs по сегментам)
async function morphsOf(name: string): Promise<Morph[]> {
  const { text, tokens } = await tokensOf(name)
  return segmentText(text, tokens).flatMap(s => s.morphs)
}

async function errOf(p: Promise<unknown>): Promise<Error> {
  try {
    await p
  } catch (e) {
    return e as Error
  }
  throw new Error('ожидалась ошибка, но промис выполнился')
}

const headersOf = (c: Call): Record<string, string> => c.init.headers as Record<string, string>

// слова и конструкции в той же записи, что в настоящем списке (headword / related)
const vocab = (id: string, headword: string, pos: string, level: Level, seq = 0, homograph = 0): Item =>
  ({ id, kind: 'vocab', headword, homograph, pos, hint: '', related: '', level, seq })

const grammar = (
  id: string,
  headword: string,
  o: { pos?: string; related?: string; level?: Level; seq?: number; homograph?: number } = {},
): Item => ({
  id, kind: 'grammar', headword, homograph: o.homograph ?? 0, pos: o.pos ?? '', hint: '',
  related: o.related ?? '', level: o.level ?? 1, seq: o.seq ?? 0,
})

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

// конструкции из списка 1–4급 (подмножество, нужное тестам)
const GEODEUN_HOM1 = grammar('g:5', '-거든', { homograph: 1, pos: '연결어미', related: '거들랑', level: 3, seq: 5 })
const GEODEUN_HOM2 = grammar('g:6', '-거든', { homograph: 2, pos: '종결어미', related: '거든요', level: 2, seq: 6 })
const EUL_SU_ISSDA = grammar('g:1', '-을 수 있다', { pos: '관용 표현', related: '-ㄹ 수 있다, <반의> -ㄹ 수 없다, -을 수 없다', level: 2, seq: 1 })
const EO_BOGDA = grammar('g:2', '-어 보다', { pos: '관용 표현', related: '-아 보다, -여 보다', level: 2, seq: 2 })
const SEUMNIDA = grammar('g:3', '-습니다', { pos: '종결어미', related: '-ㅂ니다', level: 1, seq: 3 })
const NIKKA = grammar('g:4', '-으니까', { pos: '연결어미', related: '-니까', level: 3, seq: 4 })
const GO_ISSDA = grammar('g:7', '-고 있다', { pos: '관용 표현', level: 1, seq: 7 })
const GI_TTAEMUNE = grammar('g:8', '-기 때문에', { pos: '관용 표현', related: '-기 때문이다', level: 3, seq: 8 })
const EOYA_DOEDA = grammar('g:9', '-어야 되다', { pos: '관용 표현', related: '-아야 되다, -여야 되다, <유의> -어야 하다', level: 3, seq: 9 })
const EUSEYO = grammar('g:10', '-으세요', { pos: '종결어미', related: '-세요. -으셔요, -셔요, -으시어요, -시어요', level: 1, seq: 10 })
const EO_HOM2 = grammar('g:11', '-어', { homograph: 2, pos: '종결어미', related: '-아2, -여2, -야3, -어요, -아요, -여요, -에요', level: 1, seq: 11 })
const I_JOSA = grammar('g:12', '이', { pos: '조사', related: '가', level: 1, seq: 12 })
const GRAMMAR: Item[] = [
  EUL_SU_ISSDA, EO_BOGDA, SEUMNIDA, NIKKA, GEODEUN_HOM1, GEODEUN_HOM2,
  GO_ISSDA, GI_TTAEMUNE, EOYA_DOEDA, EUSEYO, EO_HOM2, I_JOSA,
]
// записи, которые сопоставлялись с морфемами неверного класса (проверка совместимости класса)
const EUL_ETM = grammar('g:50', '-을', { pos: '전성어미', related: '-ㄹ2', level: 3, seq: 50 })
const EUL_JOSA = grammar('g:51', '을', { pos: '조사', related: '를, ㄹ1', level: 1, seq: 51 })
const A_JOSA = grammar('g:52', '아', { pos: '조사', level: 2, seq: 52 })
const IGO_JOSA = grammar('g:53', '이고', { pos: '조사', related: '고1', level: 2, seq: 53 })
const SI_PRE = grammar('g:120', '시', { pos: '선어말어미', level: 2, seq: 120 })

describe('toMorphs', () => {
  it('toMorphs: глаголы получают 다, сочетаемое джамо в лемме нормализуется', async () => {
    const { tokens } = await tokensOf('imnida')
    // 입니다 в ответе сервиса: 이/VCP и EC-часть с сочетаемым джамо из фикстуры
    expect(toMorphs(tokens[1])).toEqual([{ lemma: '이다', pos: 'VCP' }, { lemma: 'ㅂ니다', pos: 'EC' }])
  })

  it('toMorphs: слитные морфемы берутся из parts, когда в pos есть +', async () => {
    const gaBoseyo = (await tokensOf('ga-boseyo')).tokens
    expect(toMorphs(gaBoseyo[0])).toEqual([{ lemma: '가다', pos: 'VV' }, { lemma: '아', pos: 'EC' }])
    expect(toMorphs(gaBoseyo[1])).toEqual([{ lemma: '보다', pos: 'VX' }])
    expect(toMorphs(gaBoseyo[2])).toEqual([{ lemma: '시', pos: 'EP' }, { lemma: '어요', pos: 'EF' }])
    const gongbu = (await tokensOf('gongbuhamnida')).tokens
    expect(toMorphs(gongbu[1])).toEqual([{ lemma: '하다', pos: 'XSV' }, { lemma: 'ㅂ니다', pos: 'EC' }])
  })

  it('toMorphs: без + в pos и при одной части того же pos лемма строится из surface, alt из части (가 в ganikka)', async () => {
    const { tokens } = await tokensOf('ganikka')
    expect(toMorphs(tokens[0])).toEqual([{ lemma: '가다', pos: 'VV', alt: '갈다' }])
  })

  it('toMorphs: alt для 물 (묻) и 재미있 (재밌); без alt, если частей несколько или лемма та же', async () => {
    const kkeut = (await tokensOf('kkeutnagi-jeone')).tokens
    expect(toMorphs(kkeut[6])).toEqual([{ lemma: '물다', pos: 'VV', alt: '묻다' }])
    const jm = (await tokensOf('jaemiisseumnida')).tokens
    expect(toMorphs(jm[0])).toEqual([{ lemma: '재미있다', pos: 'VA', alt: '재밌다' }])
    const baeugi = (await tokensOf('baeugi-ttaemune')).tokens
    expect(toMorphs(baeugi[0])).toEqual([{ lemma: '한국어', pos: 'NNG' }])
  })
})

describe('segmentText', () => {
  it('segmentText: сегменты по пробелам, морфемы разложены по сегментам', async () => {
    const biga = await tokensOf('biga-ogeodeunyo')
    expect(segmentText(biga.text, biga.tokens)).toEqual([
      { text: '비가', morphs: [{ lemma: '비', pos: 'NNG' }, { lemma: '가', pos: 'JKS' }] },
      { text: '오거든요', morphs: [{ lemma: '오다', pos: 'VV' }, { lemma: '거든요', pos: 'EF' }] },
    ])
    const school = await tokensOf('hakgyoe-gayo')
    expect(segmentText(school.text, school.tokens)).toEqual([
      { text: '학교에', morphs: [{ lemma: '학교', pos: 'NNG' }, { lemma: '에', pos: 'JKB' }] },
      { text: '가요', morphs: [{ lemma: '가요', pos: 'NNG' }] },
    ])
  })

  it('segmentText: эмодзи и ㅠㅠ не ломают выравнивание', async () => {
    const emo = await tokensOf('emoji')
    expect(segmentText(emo.text, emo.tokens)).toEqual([
      { text: '채영이', morphs: [{ lemma: '이', pos: 'JKS' }] },
      { text: '😂', morphs: [] },
      { text: 'ㅠㅠ', morphs: [] },
      { text: '웃었어', morphs: [{ lemma: '웃다', pos: 'VV' }, { lemma: '었', pos: 'EP' }, { lemma: '어', pos: 'EC' }] },
    ])
  })

  it('segmentText принимает NFD-ввод', async () => {
    const { text, tokens } = await tokensOf('biga-ogeodeunyo')
    const nfd = text.normalize('NFD')
    expect(nfd).not.toBe(text)
    expect(segmentText(nfd, tokens)).toEqual(segmentText(text, tokens))
    expect(segmentText(nfd, tokens).map(s => s.text)).toEqual(['비가', '오거든요'])
  })

  it('segmentText: расстыковка в середине портит только один сегмент', async () => {
    const emo = await tokensOf('emoji')
    const good = segmentText(emo.text, emo.tokens)
    // токен 😂 (индекс 2) подменён: его сегмент без morphs, соседние на месте
    const brokenMiddle = emo.tokens.map((t, i) => (i === 2 ? { ...t, surface: 'X' } : t))
    expect(segmentText(emo.text, brokenMiddle)).toEqual([good[0], { text: '😂', morphs: [] }, good[2], good[3]])
    // токен 이 (индекс 1) подменён: сломан первый сегмент, остальные выравниваются заново
    const brokenFirst = emo.tokens.map((t, i) => (i === 1 ? { ...t, surface: 'X' } : t))
    expect(segmentText(emo.text, brokenFirst)).toEqual([{ text: '채영이', morphs: [] }, good[1], good[2], good[3]])
  })

  it('segmentText: токенов меньше, чем нужно, не бросает и отдаёт сегменты без morphs', async () => {
    const biga = await tokensOf('biga-ogeodeunyo')
    expect(segmentText(biga.text, biga.tokens.slice(0, 1))).toEqual([
      { text: '비가', morphs: [] },
      { text: '오거든요', morphs: [] },
    ])
    expect(segmentText(biga.text, biga.tokens.slice(0, 2))).toEqual([
      { text: '비가', morphs: [{ lemma: '비', pos: 'NNG' }, { lemma: '가', pos: 'JKS' }] },
      { text: '오거든요', morphs: [] },
    ])
  })

  it('segmentText: пустой список токенов даёт сегменты без morphs; пустой текст даёт []', () => {
    expect(segmentText('비가 오거든요', [])).toEqual([
      { text: '비가', morphs: [] },
      { text: '오거든요', morphs: [] },
    ])
    expect(segmentText('  ', [])).toEqual([])
  })
})

describe('posGroup', () => {
  it('posGroup', () => {
    expect(posGroup('NNG')).toBe('noun')
    expect(posGroup('NNB')).toBe('noun')
    expect(posGroup('NNBC')).toBe('noun')
    expect(posGroup('EC')).toBe('func')
    expect(posGroup('NNP')).toBe('skip')
    expect(posGroup('NR')).toBe('num')
    expect(posGroup('NP')).toBe('pron')
    expect(posGroup('VV')).toBe('verb')
    expect(posGroup('VX')).toBe('verb')
    expect(posGroup('VA')).toBe('adj')
    expect(posGroup('MAG')).toBe('adv')
    expect(posGroup('MAJ')).toBe('adv')
    expect(posGroup('MM')).toBe('det')
    expect(posGroup('IC')).toBe('interj')
  })

  it('posGroup: служебные теги и JK* → func, знаки и имена → skip', () => {
    for (const pos of ['JKS', 'JKB', 'JKO', 'JX', 'JC', 'EP', 'EF', 'EC', 'ETN', 'ETM', 'VCP', 'VCN', 'XSV', 'XSA', 'XSN', 'XPN']) {
      expect(posGroup(pos)).toBe('func')
    }
    for (const pos of ['NNP', 'SL', 'SH', 'SN', 'SY', 'SF', 'SE', 'SSO', 'SSC', 'SC', 'XR', 'UNKNOWN']) {
      expect(posGroup(pos)).toBe('skip')
    }
  })

  it('posGroup: тег с + оценивается по первой части; неизвестный тег → skip', () => {
    expect(posGroup('VV+EC')).toBe('verb')
    expect(posGroup('EP+EF')).toBe('func')
    expect(posGroup('ZZZ')).toBe('skip')
    expect(posGroup('constructor')).toBe('skip')
    expect(posGroup('')).toBe('skip')
  })
})

describe('resolveMorphs', () => {
  it('loadLexicon читает items один раз: второй resolveMorphs не делает запроса', async () => {
    const db = await dbWith([vocab('v:1', '가다', '동사', 1)])
    const spy = vi.spyOn(db, 'query')
    await resolveMorphs(db, [{ lemma: '가다', pos: 'VV' }])
    await resolveMorphs(db, [{ lemma: '가다', pos: 'VV' }])
    expect(spy).toHaveBeenCalledTimes(1)
    expect(await loadLexicon(db)).toBeDefined()
  })

  it('resolveMorphs: часть речи списка важнее уровня', async () => {
    const db = await dbWith([vocab('v:1', '가다', '형용사', 1), vocab('v:2', '가다', '동사', 3)])
    expect(await resolveMorphs(db, [{ lemma: '가다', pos: 'VV' }])).toEqual({ itemIds: ['v:2'], unlisted: [] })
  })

  it('resolveMorphs: омонимы 가다 — меньший level, затем меньший seq', async () => {
    const byLevel = await dbWith([vocab('v:1', '가다', '동사', 2, 3, 1), vocab('v:2', '가다', '동사', 1, 9, 2)])
    expect(await resolveMorphs(byLevel, [{ lemma: '가다', pos: 'VV' }])).toEqual({ itemIds: ['v:2'], unlisted: [] })
    const bySeq = await dbWith([vocab('v:3', '가다', '동사', 1, 4, 1), vocab('v:4', '가다', '동사', 1, 2, 2)])
    expect(await resolveMorphs(bySeq, [{ lemma: '가다', pos: 'VV' }])).toEqual({ itemIds: ['v:4'], unlisted: [] })
  })

  it('resolveMorphs: подходящей части речи нет → совпадение по headword (바쁘다 с тегом VV при 형용사)', async () => {
    const db = await dbWith([vocab('v:1', '바쁘다', '형용사', 1)])
    expect(await resolveMorphs(db, [{ lemma: '바쁘다', pos: 'VV' }])).toEqual({ itemIds: ['v:1'], unlisted: [] })
  })

  it('resolveMorphs: alt — 가다 с alt 갈다 → 가다 (уровень ниже); 물다 с alt 묻다 → 묻다 (L1 раньше L3)', async () => {
    const db = await dbWith([
      vocab('v:1', '가다', '동사', 2), vocab('v:2', '갈다', '동사', 4),
      vocab('v:3', '묻다', '동사', 1), vocab('v:4', '물다', '동사', 3),
    ])
    expect(await resolveMorphs(db, [{ lemma: '가다', pos: 'VV', alt: '갈다' }])).toEqual({ itemIds: ['v:1'], unlisted: [] })
    expect(await resolveMorphs(db, [{ lemma: '물다', pos: 'VV', alt: '묻다' }])).toEqual({ itemIds: ['v:3'], unlisted: [] })
  })

  it('resolveMorphs: 재미있다 с alt 재밌다 → 재미있다 (재밌다 в списке нет)', async () => {
    const db = await dbWith([vocab('v:1', '재미있다', '형용사', 2)])
    const [first] = await morphsOf('jaemiisseumnida')
    expect(await resolveMorphs(db, [first])).toEqual({ itemIds: ['v:1'], unlisted: [] })
  })

  it('resolveMorphs: существительное + XSV → слитное слово (공부하다), существительное отдельно не добавляется', async () => {
    const db = await dbWith([vocab('v:1', '공부', '명사', 1), vocab('v:2', '공부하다', '동사', 2)])
    expect(await resolveMorphs(db, await morphsOf('gongbuhamnida'))).toEqual({ itemIds: ['v:2'], unlisted: [] })
  })

  it('resolveMorphs: существительное + XSV без слитного слова (친구 + 하다) → существительное как обычно', async () => {
    const db = await dbWith([vocab('v:1', '친구', '명사', 1)])
    expect(await resolveMorphs(db, await morphsOf('chinguhago'))).toEqual({
      itemIds: ['v:1'],
      unlisted: [{ lemma: '같이', pos: 'MAG' }, { lemma: '먹다', pos: 'VV' }],
    })
  })

  it('resolveMorphs: неизвестная лемма → unlisted; alt без записи в списке → unlisted по alt; skip и служебная без записи игнорируются', async () => {
    const db = await dbWith([])
    expect(await resolveMorphs(db, [
      { lemma: '없는말', pos: 'NNG' },
      { lemma: '가다', pos: 'VV', alt: '갈다' },
      { lemma: '채영', pos: 'NNP' },
      { lemma: '고', pos: 'EC' },
    ])).toEqual({ itemIds: [], unlisted: [{ lemma: '없는말', pos: 'NNG' }, { lemma: '갈다', pos: 'VV' }] })
  })

  it('resolveMorphs: itemIds без повторов, в порядке появления', async () => {
    const db = await dbWith([vocab('v:1', '가다', '동사', 1)])
    expect(await resolveMorphs(db, [{ lemma: '가다', pos: 'VV' }, { lemma: '가다', pos: 'VV' }])).toEqual({ itemIds: ['v:1'], unlisted: [] })
  })

  it('resolveMorphs: 거든요/EF → -거든 с homograph 2 (точное совпадение раньше совпадения без 요)', async () => {
    const db = await dbWith(GRAMMAR)
    expect(await resolveMorphs(db, [{ lemma: '거든요', pos: 'EF' }])).toEqual({ itemIds: ['g:6'], unlisted: [] })
  })

  it('resolveMorphs: ㅏ요 из фикстуры (바빠요) → -어 через вариант «-아요»', async () => {
    const db = await dbWith(GRAMMAR)
    const endings = (await morphsOf('baeugi-ttaemune')).filter(m => m.pos === 'EF')
    expect(endings).toHaveLength(1)
    expect(await resolveMorphs(db, endings)).toEqual({ itemIds: ['g:11'], unlisted: [] })
  })

  it('resolveMorphs: «<» отбрасывает хвост related; «.» тоже разделитель (-세요. → 세요)', async () => {
    const db = await dbWith(GRAMMAR)
    expect(await resolveMorphs(db, [{ lemma: '세요', pos: 'EF' }])).toEqual({ itemIds: ['g:10'], unlisted: [] })
  })

  it('resolveMorphs: из нескольких конструкций класс раньше уровня; headword раньше related', async () => {
    const db = await dbWith([
      grammar('g:20', '-고', { pos: '종결어미', level: 1, seq: 1 }),
      grammar('g:21', '-고', { pos: '연결어미', level: 3, seq: 9 }),
      grammar('g:22', '가', { pos: '조사', level: 3, seq: 9 }),
      grammar('g:23', '이', { pos: '조사', related: '가', level: 1, seq: 1 }),
    ])
    expect(await resolveMorphs(db, [{ lemma: '고', pos: 'EC' }])).toEqual({ itemIds: ['g:21'], unlisted: [] })
    expect(await resolveMorphs(db, [{ lemma: '가', pos: 'JKS' }])).toEqual({ itemIds: ['g:22'], unlisted: [] })
  })

  it('resolveMorphs: при равных классе и формах — меньший level, затем меньший seq', async () => {
    const byLevel = await dbWith([
      grammar('g:30', '-고', { pos: '연결어미', level: 3, seq: 1 }),
      grammar('g:31', '-고', { pos: '연결어미', level: 2, seq: 9, homograph: 2 }),
    ])
    expect(await resolveMorphs(byLevel, [{ lemma: '고', pos: 'EC' }])).toEqual({ itemIds: ['g:31'], unlisted: [] })
    const bySeq = await dbWith([
      grammar('g:32', '-고', { pos: '연결어미', level: 2, seq: 5 }),
      grammar('g:33', '-고', { pos: '연결어미', level: 2, seq: 2, homograph: 2 }),
    ])
    expect(await resolveMorphs(bySeq, [{ lemma: '고', pos: 'EC' }])).toEqual({ itemIds: ['g:33'], unlisted: [] })
  })

  it('resolveMorphs: многословная конструкция в itemIds не попадает (её даёт grammarMatches); 어요 — однословная форма -어', async () => {
    const db = await dbWith(GRAMMAR)
    expect(await resolveMorphs(db, await morphsOf('meogeul-su-isseoyo'))).toEqual({
      itemIds: ['g:11'],
      unlisted: [{ lemma: '먹다', pos: 'VV' }, { lemma: '수', pos: 'NNB' }, { lemma: '있다', pos: 'VV' }],
    })
  })

  it('resolveMorphs: скобки в конце записи дают две формы: 에서부터(서부터), -지요(-죠), 에다가(에다)', async () => {
    const db = await dbWith([
      grammar('g:100', '에서부터(서부터)', { pos: '조사', level: 3, seq: 100 }),
      grammar('g:101', '-지요(-죠)', { pos: '종결어미', level: 2, seq: 101 }),
      grammar('g:102', '에', { pos: '조사', related: '에다가(에다)', level: 3, seq: 102 }),
    ])
    expect(await resolveMorphs(db, [{ lemma: '에서부터', pos: 'JX' }])).toEqual({ itemIds: ['g:100'], unlisted: [] })
    expect(await resolveMorphs(db, [{ lemma: '서부터', pos: 'JX' }])).toEqual({ itemIds: ['g:100'], unlisted: [] })
    expect(await resolveMorphs(db, [{ lemma: '지요', pos: 'EF' }])).toEqual({ itemIds: ['g:101'], unlisted: [] })
    expect(await resolveMorphs(db, [{ lemma: '죠', pos: 'EF' }])).toEqual({ itemIds: ['g:101'], unlisted: [] })
    expect(await resolveMorphs(db, [{ lemma: '에다가', pos: 'JKB' }])).toEqual({ itemIds: ['g:102'], unlisted: [] })
    expect(await resolveMorphs(db, [{ lemma: '에다', pos: 'JKB' }])).toEqual({ itemIds: ['g:102'], unlisted: [] })
    // склейки A+B («에서부터서부터») быть не должно
    expect(await resolveMorphs(db, [{ lemma: '에서부터서부터', pos: 'JX' }])).toEqual({ itemIds: [], unlisted: [] })
  })

  it('resolveMorphs: гласная джамо в начале леммы → слог с ㅇ (ㅣ요 → 이요, ㅐ요 → 애요, ㅔ요 → 에요)', async () => {
    const db = await dbWith([
      grammar('g:110', '-이', { pos: '종결어미', related: '-이요', level: 1, seq: 110 }),
      grammar('g:111', '-애', { pos: '종결어미', related: '-애요', level: 1, seq: 111 }),
      EO_HOM2,
    ])
    expect(await resolveMorphs(db, [{ lemma: 'ㅣ요', pos: 'EF' }])).toEqual({ itemIds: ['g:110'], unlisted: [] })
    expect(await resolveMorphs(db, [{ lemma: 'ㅐ요', pos: 'EF' }])).toEqual({ itemIds: ['g:111'], unlisted: [] })
    expect(await resolveMorphs(db, [{ lemma: 'ㅔ요', pos: 'EF' }])).toEqual({ itemIds: ['g:11'], unlisted: [] })
  })

  it('resolveMorphs: 예요/VCP+EF — ㅔ요 из леммы совпадает с «-에요» конструкции «-어» (homograph 2)', async () => {
    // в фикстурах такого токена нет: лемма окончания собирается по коду U+1166 (гласная e), литерала джамо в исходнике нет
    const ending = String.fromCharCode(0x1166) + '요'
    const yeyo: MecabToken = {
      surface: '예요', pos: 'VCP+EF', entryType: 'Inflect', expression: '',
      parts: [{ lemma: '이', pos: 'VCP' }, { lemma: ending, pos: 'EF' }],
    }
    const db = await dbWith(GRAMMAR)
    expect(await resolveMorphs(db, toMorphs(yeyo))).toEqual({ itemIds: ['g:11'], unlisted: [] })
  })

  it('resolveMorphs: класс несовместим → конструкция не выбирается: 을/JKO не даёт -을 [전성어미], ㄹ/ETM не даёт 을 [조사], 아/EC не даёт 아 [조사], 고/EC не даёт 이고 [조사]', async () => {
    expect(await resolveMorphs(await dbWith([EUL_ETM]), [{ lemma: '을', pos: 'JKO' }])).toEqual({ itemIds: [], unlisted: [] })
    expect(await resolveMorphs(await dbWith([EUL_JOSA]), [{ lemma: 'ㄹ', pos: 'ETM' }])).toEqual({ itemIds: [], unlisted: [] })
    expect(await resolveMorphs(await dbWith([A_JOSA]), [{ lemma: '아', pos: 'EC' }])).toEqual({ itemIds: [], unlisted: [] })
    expect(await resolveMorphs(await dbWith([IGO_JOSA]), [{ lemma: '고', pos: 'EC' }])).toEqual({ itemIds: [], unlisted: [] })
  })

  it('resolveMorphs: совместимый класс остаётся: ㅂ니다/EC → -습니다 [종결어미]; 을/JKO → 을 [조사] при наличии', async () => {
    const db = await dbWith([...GRAMMAR, EUL_JOSA])
    expect(await resolveMorphs(db, [{ lemma: 'ㅂ니다', pos: 'EC' }])).toEqual({ itemIds: ['g:3'], unlisted: [] })
    expect(await resolveMorphs(db, [{ lemma: '을', pos: 'JKO' }])).toEqual({ itemIds: ['g:51'], unlisted: [] })
  })

  it('resolveMorphs: настоящая фраза 밥을 먹고 학교에 갈 수 있다 — 을/JKO → 을 [조사], ㄹ/ETM → -을 [전성어미], без ложных 고 и 아', async () => {
    const db = await dbWith([...GRAMMAR, EUL_ETM, EUL_JOSA, A_JOSA, IGO_JOSA])
    const r = await resolveMorphs(db, await morphsOf('meokgo-gal-su-itda'))
    expect(r.itemIds).toEqual(['g:51', 'g:50'])
  })
})

describe('grammarMatches', () => {
  it('grammarMatches: -거든 в 비가 오거든요 true, в 학교에 가요 false', async () => {
    expect(grammarMatches(GEODEUN_HOM2, await morphsOf('biga-ogeodeunyo'))).toBe(true)
    expect(grammarMatches(GEODEUN_HOM2, await morphsOf('hakgyoe-gayo'))).toBe(false)
  })

  it('grammarMatches: -을 수 있다 в 먹을 수 있어요 и 갈 수 있어요 true', async () => {
    expect(grammarMatches(EUL_SU_ISSDA, await morphsOf('meogeul-su-isseoyo'))).toBe(true)
    expect(grammarMatches(EUL_SU_ISSDA, await morphsOf('gal-su-isseoyo'))).toBe(true)
  })

  it('grammarMatches: -어 보다 в 가 보세요 и 읽어 보세요 true', async () => {
    expect(grammarMatches(EO_BOGDA, await morphsOf('ga-boseyo'))).toBe(true)
    expect(grammarMatches(EO_BOGDA, await morphsOf('ilgeo-boseyo'))).toBe(true)
  })

  it('grammarMatches: -습니다 в 공부합니다 true', async () => {
    expect(grammarMatches(SEUMNIDA, await morphsOf('gongbuhamnida'))).toBe(true)
  })

  it('grammarMatches: -으니까 в 가니까 true', async () => {
    expect(grammarMatches(NIKKA, await morphsOf('ganikka'))).toBe(true)
  })

  it('grammarMatches: -고 있다 в 밥을 먹고 학교에 갈 수 있다 и в 쉬고 싶어요 false', async () => {
    expect(grammarMatches(GO_ISSDA, await morphsOf('meokgo-gal-su-itda'))).toBe(false)
    expect(grammarMatches(GO_ISSDA, await morphsOf('swigo-sipeoyo'))).toBe(false)
  })

  it('grammarMatches: -기 때문에 в 한국어를 배우기 때문에 바빠요 true', async () => {
    expect(grammarMatches(GI_TTAEMUNE, await morphsOf('baeugi-ttaemune'))).toBe(true)
  })

  it('grammarMatches: -어야 되다 в 공부해야 돼요 true; форма после «<유의>» (-어야 하다) не используется', async () => {
    expect(grammarMatches(EOYA_DOEDA, await morphsOf('gongbuhaeya-dwaeyo'))).toBe(true)
    const hae = [
      { lemma: '공부', pos: 'NNG' }, { lemma: '하다', pos: 'XSV' }, { lemma: '어야', pos: 'EC' },
      { lemma: '하다', pos: 'VV' }, { lemma: '어요', pos: 'EF' },
    ]
    expect(grammarMatches(EOYA_DOEDA, hae)).toBe(false)
  })

  it('grammarMatches: -으세요 в 읽어 보세요 true (через 시어요)', async () => {
    expect(grammarMatches(EUSEYO, await morphsOf('ilgeo-boseyo'))).toBe(true)
  })

  it('grammarMatches: -어 (homograph 2) в 바빠요 true (через «아요» из фикстуры)', async () => {
    expect(grammarMatches(EO_HOM2, await morphsOf('baeugi-ttaemune'))).toBe(true)
  })

  it('grammarMatches: 이 (조사) в 이 책이 좋아요 true; на морфемах 이/MM 책/NNG false', async () => {
    expect(grammarMatches(I_JOSA, await morphsOf('i-chaek'))).toBe(true)
    expect(grammarMatches(I_JOSA, [{ lemma: '이', pos: 'MM' }, { lemma: '책', pos: 'NNG' }])).toBe(false)
  })

  it('grammarMatches: форма «A(B)»: -(으)니까 даёт и -니까, и -으니까', () => {
    const item = grammar('g:40', '-(으)니까', { pos: '연결어미' })
    expect(grammarMatches(item, [{ lemma: '니까', pos: 'EC' }])).toBe(true)
    expect(grammarMatches(item, [{ lemma: '으니까', pos: 'EC' }])).toBe(true)
    expect(grammarMatches(item, [{ lemma: '가다', pos: 'VV' }])).toBe(false)
  })

  it('grammarMatches: 에서부터(서부터): цепочка 에서 JKB + 부터 JX даёт 에서부터 (조사), 서부터 — отдельная форма', () => {
    const item = grammar('g:100', '에서부터(서부터)', { pos: '조사' })
    expect(grammarMatches(item, [{ lemma: '에서', pos: 'JKB' }, { lemma: '부터', pos: 'JX' }])).toBe(true)
    expect(grammarMatches(item, [{ lemma: '서부터', pos: 'JX' }])).toBe(true)
  })

  it('grammarMatches: класс по тегу последней морфемы — 을/JKO, ㄹ/ETM, 아/EC, 고/EC не совпадают с несовместимыми классами', () => {
    expect(grammarMatches(EUL_ETM, [{ lemma: '을', pos: 'JKO' }])).toBe(false)
    expect(grammarMatches(EUL_JOSA, [{ lemma: 'ㄹ', pos: 'ETM' }])).toBe(false)
    expect(grammarMatches(A_JOSA, [{ lemma: '아', pos: 'EC' }])).toBe(false)
    expect(grammarMatches(IGO_JOSA, [{ lemma: '고', pos: 'EC' }])).toBe(false)
    expect(grammarMatches(SI_PRE, [{ lemma: '시', pos: 'EF' }])).toBe(false)
  })

  it('grammarMatches: совместимые пары остаются: ㄹ/ETM ↔ -을 [전성어미]; ㅂ니다/EC ↔ -습니다 [종결어미]; 시+어요 ↔ -으세요; 시/EP ↔ 시 [선어말어미]; 에서+부터 (JKB+JX) ↔ 에서부터 [조사]', () => {
    expect(grammarMatches(EUL_ETM, [{ lemma: 'ㄹ', pos: 'ETM' }])).toBe(true)
    expect(grammarMatches(SEUMNIDA, [{ lemma: 'ㅂ니다', pos: 'EC' }])).toBe(true)
    expect(grammarMatches(EUSEYO, [{ lemma: '시', pos: 'EP' }, { lemma: '어요', pos: 'EF' }])).toBe(true)
    expect(grammarMatches(SI_PRE, [{ lemma: '시', pos: 'EP' }])).toBe(true)
    const eseo = grammar('g:101', '에서부터', { pos: '조사' })
    expect(grammarMatches(eseo, [{ lemma: '에서', pos: 'JKB' }, { lemma: '부터', pos: 'JX' }])).toBe(true)
  })
})

describe('grammarMatches: пропуск частицы между словами формы', () => {
  it('grammarMatches: между 수 и 있다 пропускается одна частица (-을 수 있다 в 먹을 수 가 있다 true); две подряд — false', () => {
    const one = [
      { lemma: '먹다', pos: 'VV' }, { lemma: '을', pos: 'ETM' }, { lemma: '수', pos: 'NNB' },
      { lemma: '가', pos: 'JKS' }, { lemma: '있다', pos: 'VV' },
    ]
    expect(grammarMatches(EUL_SU_ISSDA, one)).toBe(true)
    const two = [
      { lemma: '먹다', pos: 'VV' }, { lemma: '을', pos: 'ETM' }, { lemma: '수', pos: 'NNB' },
      { lemma: '가', pos: 'JKS' }, { lemma: '도', pos: 'JX' }, { lemma: '있다', pos: 'VV' },
    ]
    expect(grammarMatches(EUL_SU_ISSDA, two)).toBe(false)
  })
})

describe('analyzeToSegments', () => {
  it('analyzeToSegments: фикстура через фейковый fetch → сегменты с itemIds', async () => {
    const db = await dbWith([vocab('v:1', '비', '명사', 1), vocab('v:2', '오다', '동사', 1), ...GRAMMAR])
    const fx = fixture('biga-ogeodeunyo')
    const { fetchImpl, calls } = replying(() => jsonRes(fx.tokens))
    expect(await analyzeToSegments(db, fx.text, 'http://analyzer.test', fetchImpl)).toEqual([
      { text: '비가', itemIds: ['v:1', 'g:12'], unlisted: [] },
      { text: '오거든요', itemIds: ['v:2', 'g:6'], unlisted: [] },
    ])
    expect(calls).toHaveLength(1)
  })

  it('analyzeToSegments: без записи в словаре — unlisted; эмодзи и ㅠㅠ — пустые сегменты', async () => {
    const db = await dbWith(GRAMMAR)
    const school = fixture('hakgyoe-gayo')
    const schoolFetch = replying(() => jsonRes(school.tokens))
    expect(await analyzeToSegments(db, school.text, 'http://analyzer.test', schoolFetch.fetchImpl)).toEqual([
      { text: '학교에', itemIds: [], unlisted: [{ lemma: '학교', pos: 'NNG' }] },
      { text: '가요', itemIds: [], unlisted: [{ lemma: '가요', pos: 'NNG' }] },
    ])
    const emo = fixture('emoji')
    const emoFetch = replying(() => jsonRes(emo.tokens))
    expect(await analyzeToSegments(db, emo.text, 'http://analyzer.test', emoFetch.fetchImpl)).toEqual([
      { text: '채영이', itemIds: ['g:12'], unlisted: [] },
      { text: '😂', itemIds: [], unlisted: [] },
      { text: 'ㅠㅠ', itemIds: [], unlisted: [] },
      { text: '웃었어', itemIds: ['g:11'], unlisted: [{ lemma: '웃다', pos: 'VV' }] },
    ])
  })

  it('analyzeToSegments: пустой текст возвращает [] без запроса', async () => {
    const db = await dbWith(GRAMMAR)
    const { fetchImpl, calls } = replying(() => jsonRes([]))
    expect(await analyzeToSegments(db, '  ', 'http://analyzer.test', fetchImpl)).toEqual([])
    expect(calls).toHaveLength(0)
  })
})

describe('analyze', () => {
  it('analyze: 404 с другим detail → []; 404 с detail «Not Found» и 404 с телом не JSON → AnalyzerError (адрес не найден)', async () => {
    // сервис на неразборчивый текст отвечает 404 с своим detail: это пустой результат
    const other = replying(() => jsonRes({ detail: 'текст не разобран' }, 404))
    expect(await analyze('가', 'http://analyzer.test', other.fetchImpl)).toEqual([])
    // маршрута нет: FastAPI отвечает {"detail": "Not Found"}; ошибка в ANALYZER_URL не должна выглядеть как пустой результат
    const noRoute = replying(() => jsonRes({ detail: 'Not Found' }, 404))
    const e1 = await errOf(analyze('가', 'http://analyzer.test', noRoute.fetchImpl))
    expect(e1).toBeInstanceOf(AnalyzerError)
    expect(e1.message).toBe('анализатор: адрес не найден (404)')
    const html = replying(() => new Response('<html>404</html>', { status: 404 }))
    const e2 = await errOf(analyze('가', 'http://analyzer.test', html.fetchImpl))
    expect(e2).toBeInstanceOf(AnalyzerError)
    expect(e2.message).toBe('анализатор: адрес не найден (404)')
  })

  it('analyze: 500 и сетевая ошибка → AnalyzerError', async () => {
    const serverError = replying(() => new Response('boom', { status: 500 }))
    expect(await errOf(analyze('가', 'http://analyzer.test', serverError.fetchImpl))).toBeInstanceOf(AnalyzerError)
    const offline = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    expect(await errOf(analyze('가', 'http://analyzer.test', offline))).toBeInstanceOf(AnalyzerError)
  })

  it('analyze: fetch вызывается с redirect: error; редирект → AnalyzerError', async () => {
    const { fetchImpl, calls } = replying(() => new Response(null, { status: 302, headers: { location: 'http://elsewhere.test/' } }))
    expect(await errOf(analyze('가', 'https://analyzer.test', fetchImpl, { secret: 'S' }))).toBeInstanceOf(AnalyzerError)
    expect(calls[0].init.redirect).toBe('error')
  })

  it('analyze: секрет по http на чужой хост — AnalyzerError до запроса; 127.0.0.1, localhost и https проходят', async () => {
    const ok = replying(() => jsonRes([]))
    const plain = await errOf(analyze('가', 'http://analyzer.test', ok.fetchImpl, { secret: 'S' }))
    expect(plain).toBeInstanceOf(AnalyzerError)
    expect(plain.message).toBe('секрет анализатора передаётся только по https')
    expect(ok.calls).toHaveLength(0)
    expect(await analyze('가', 'http://127.0.0.1:8000', ok.fetchImpl, { secret: 'S' })).toEqual([])
    expect(await analyze('가', 'http://localhost:8000', ok.fetchImpl, { secret: 'S' })).toEqual([])
    expect(await analyze('가', 'https://analyzer.test', ok.fetchImpl, { secret: 'S' })).toEqual([])
    expect(ok.calls).toHaveLength(3)
  })

  it('analyze: без секрета заголовка X-Analyzer-Secret нет; http без секрета допустим', async () => {
    const { fetchImpl, calls } = replying(() => jsonRes([]))
    await analyze('가', 'http://analyzer.test', fetchImpl)
    expect(calls).toHaveLength(1)
    expect(headersOf(calls[0])).not.toHaveProperty('X-Analyzer-Secret')
  })

  it('analyze: текст уходит в теле в NFC (NFD-ввод)', async () => {
    const { fetchImpl, calls } = replying(() => jsonRes([]))
    const nfd = '가'.normalize('NFD')
    expect(nfd).not.toBe('가')
    await analyze(nfd, 'http://analyzer.test', fetchImpl)
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ text: '가' })
  })

  it('analyze: parsed_expression не null и не массив → AnalyzerError; отсутствующее поле равнозначно null', async () => {
    for (const parsed of ['x', {}, 1]) {
      const { fetchImpl } = replying(() => jsonRes([{ word: { surface: '가', pos: 'VV' }, parsed_expression: parsed }]))
      expect(await errOf(analyze('가', 'http://analyzer.test', fetchImpl))).toBeInstanceOf(AnalyzerError)
    }
    const missing = replying(() => jsonRes([{ word: { surface: '가', pos: 'VV' } }]))
    expect((await analyze('가', 'http://analyzer.test', missing.fetchImpl))[0]).toMatchObject({ surface: '가', pos: 'VV', parts: [] })
  })

  it('analyze: токен с пустым surface пропускается', async () => {
    const { fetchImpl } = replying(() => jsonRes([
      { word: { surface: '', pos: 'SF' }, parsed_expression: null },
      { word: { surface: '가', pos: 'VV' }, parsed_expression: null },
    ]))
    const tokens = await analyze('가.', 'http://analyzer.test', fetchImpl)
    expect(tokens.map(t => t.surface)).toEqual(['가'])
  })

  it('analyze: разбирает ответ в MecabToken', async () => {
    const { tokens } = await tokensOf('ga-boseyo')
    expect(tokens[0]).toEqual({
      surface: '가',
      pos: 'VV+EC',
      entryType: 'Inflect',
      expression: '가/VV/*+아/EC/*',
      parts: [{ lemma: '가', pos: 'VV' }, { lemma: '아', pos: 'EC' }],
    })
    expect(tokens[1]).toEqual({ surface: '보', pos: 'VX', entryType: '*', expression: '*', parts: [] })
  })

  it('analyze: POST {text} на baseUrl + «/», лишние «/» в конце baseUrl убираются', async () => {
    const { fetchImpl, calls } = replying(() => jsonRes([]))
    await analyze('가', 'http://analyzer.test///', fetchImpl)
    expect(calls[0].url).toBe('http://analyzer.test/')
    expect(calls[0].init.method).toBe('POST')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ text: '가' })
  })

  it('analyze: пробельный текст возвращает [] без запроса', async () => {
    const { fetchImpl, calls } = replying(() => jsonRes([]))
    expect(await analyze(' \n\t ', 'http://analyzer.test', fetchImpl)).toEqual([])
    expect(await analyze('', 'http://analyzer.test', fetchImpl)).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('analyze: тайм-аут → AnalyzerError', async () => {
    // «зависший» fetch: отклоняется только когда сигнал запроса прерван
    const hanging = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (signal) signal.addEventListener('abort', () => reject(signal.reason))
      })) as unknown as typeof fetch
    const err = await errOf(analyze('가', 'http://analyzer.test', hanging, { timeoutMs: 20 }))
    expect(err).toBeInstanceOf(AnalyzerError)
    expect(err.message).toMatch(/не ответил/)
  })

  it('analyze: секрет уходит в заголовке и не попадает в текст ошибки', async () => {
    const SECRET = 'секрет-тестовый-9d2f'
    const ADDR = 'analyzer.test'
    const { fetchImpl, calls } = replying(() => new Response('boom', { status: 500 }))
    const err = await errOf(analyze('가', `https://${ADDR}`, fetchImpl, { secret: SECRET }))
    expect(headersOf(calls[0])['X-Analyzer-Secret']).toBe(SECRET)
    expect(err).toBeInstanceOf(AnalyzerError)
    expect(err.message).not.toContain(SECRET)
    expect(err.message).not.toContain(ADDR)
    // сетевая ошибка: исходный текст с адресом и секретом в AnalyzerError не переносится
    const offline = (async () => { throw new TypeError(`connect ECONNREFUSED ${ADDR} ${SECRET}`) }) as unknown as typeof fetch
    const netErr = await errOf(analyze('가', `https://${ADDR}`, offline, { secret: SECRET }))
    expect(netErr).toBeInstanceOf(AnalyzerError)
    expect(netErr.message).not.toContain(SECRET)
    expect(netErr.message).not.toContain(ADDR)
  })

  it('analyze: не-JSON, не массив и токен без word в ответе → AnalyzerError', async () => {
    const notJson = replying(() => new Response('<html>', { status: 200 }))
    expect(await errOf(analyze('가', 'http://analyzer.test', notJson.fetchImpl))).toBeInstanceOf(AnalyzerError)
    const notArray = replying(() => jsonRes({ error: 'x' }))
    expect(await errOf(analyze('가', 'http://analyzer.test', notArray.fetchImpl))).toBeInstanceOf(AnalyzerError)
    const noWord = replying(() => jsonRes([{ parsed_expression: null }]))
    expect(await errOf(analyze('가', 'http://analyzer.test', noWord.fetchImpl))).toBeInstanceOf(AnalyzerError)
  })
})
