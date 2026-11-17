import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BAKE_OFF_MODELS, bakeOffReport, DEFAULT_THREADS, estimateBank, type GroupResult, maskText, parseBakeOffArgs,
  parseBankArgs, pickStretch, renderThread, runBank, secretValues, seededRng, STOP_AFTER_FAILURES,
} from '../src/lib/bank-run'
import { loadConfig } from '../src/lib/config'
import type { Db } from '../src/lib/db'
import { type BankDraft, GEN } from '../src/lib/generate'
import { nfc } from '../src/lib/ko'
import type { LlmClient, Usage } from '../src/lib/llm'
import type { Check, Item, Thread } from '../src/lib/types'
import { openTestDb } from './helpers/testDb'

const ANALYZER = 'http://analyzer.test'
const cfg = loadConfig({ ANALYZER_URL: ANALYZER })

// ---- записи списков: та же форма, что в tests/generate.test.ts ----
const vocab = (id: string, headword: string, pos: string, level: Item['level'], seq: number): Item =>
  ({ id, kind: 'vocab', headword, homograph: 0, pos, hint: '', related: '', level, seq })

const BI = vocab('v:1', '비', '명사', 1, 1)
const ODA = vocab('v:2', '오다', '동사', 1, 2)
const SHOP = vocab('v:4', '가게', '명사', 1, 4)
const RADIO = vocab('v:9', '라디오', '명사', 5, 9)
const BANANA = vocab('v:10', '바나나', '명사', 6, 10)
const GEODEUN_YO: Item = {
  id: 'g:70', kind: 'grammar', headword: '-거든요', homograph: 0, pos: '종결어미', hint: '', related: '', level: 1, seq: 70,
}

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

// ---- анализатор: фикстура из tests/fixtures/mecab/ подменяет глобальный fetch ----
interface Fixture { text: string; tokens: unknown[] }
const fixture = (name: string): Fixture =>
  JSON.parse(readFileSync(new URL(`./fixtures/mecab/${name}.json`, import.meta.url), 'utf8')) as Fixture

const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function analyzerStub(...names: string[]): void {
  const byText = new Map(names.map(n => {
    const fx = fixture(n)
    return [nfc(fx.text), fx.tokens] as const
  }))
  vi.stubGlobal('fetch', (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const { text } = JSON.parse(String(init?.body)) as { text: string }
    return jsonRes(byText.get(nfc(text)) ?? [])
  }) as unknown as typeof fetch)
}

// ---- фейковый LlmClient: json отдаёт ответы по очереди (после последнего — он же) ----
type JsonArgs = Parameters<LlmClient['json']>[0]
interface Reply { value: unknown; usage?: Usage }
interface FakeLlm extends LlmClient { calls: { role: string; user: string }[] }

function fakeLlm(replies: Reply[]): FakeLlm {
  const calls: { role: string; user: string }[] = []
  return {
    calls,
    async json<T>(args: JsonArgs): Promise<{ value: T; usage: Usage }> {
      calls.push({ role: args.role, user: args.user })
      const r = replies[Math.min(calls.length, replies.length) - 1]
      return { value: r.value as T, usage: r.usage ?? { inputTokens: 0, outputTokens: 0 } }
    },
    async vision() {
      throw new Error('vision в тестах банка не нужен')
    },
    async embed() {
      return []
    },
  }
}

// ---- ответы модели в форме RawThread ----
const post = (text: string): Record<string, unknown> => ({
  authorName: '민지', authorHandle: 'minji', title: null, paragraphs: [{ lang: 'ko', text }], stretchLemma: null,
})
const replyOf = (posts: unknown[]): { posts: unknown[]; checks: unknown[] } => ({ posts, checks: [] })
const BAD: Reply = { value: replyOf([]), usage: { inputTokens: 10, outputTokens: 1 } }
const GOOD_TEXT = '비가 오거든요'

// детерминированный rng (Park–Miller) для перемешивания и подтяжки
function seeded(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 16807) % 2147483647
    return s / 2147483647
  }
}

describe('parseBankArgs', () => {
  it('без флагов: всё выключено, лимит и зерно не заданы', () => {
    expect(parseBankArgs([])).toEqual({ limit: undefined, dryRun: false, yes: false, seed: undefined })
  })

  it('разбирает все флаги', () => {
    expect(parseBankArgs(['--limit', '20', '--dry-run', '--yes', '--seed', '7']))
      .toEqual({ limit: 20, dryRun: true, yes: true, seed: 7 })
  })

  it('--seed 0 допустим', () => {
    expect(parseBankArgs(['--seed', '0']).seed).toBe(0)
  })

  it.each([
    [['--limit'], '--limit: нужно целое число больше нуля'],
    [['--limit', '0'], '--limit: нужно целое число больше нуля'],
    [['--limit', '2.5'], '--limit: нужно целое число больше нуля'],
    [['--limit', '-3'], '--limit: нужно целое число больше нуля'],
    [['--limit', '--yes'], '--limit: нужно целое число больше нуля'],
    [['--seed'], '--seed: нужно целое число 0 или больше'],
    [['--seed', '-1'], '--seed: нужно целое число 0 или больше'],
    [['--seed', 'abc'], '--seed: нужно целое число 0 или больше'],
    [['--bogus'], 'неизвестный аргумент: --bogus'],
    [['20'], 'неизвестный аргумент: 20'],
  ])('ошибка для %j: %s', (argv, message) => {
    expect(() => parseBankArgs(argv)).toThrow(message)
  })
})

describe('parseBakeOffArgs', () => {
  it('по умолчанию: 10 веток, четыре модели, без зерна и без --yes', () => {
    expect(parseBakeOffArgs([])).toEqual({ threads: DEFAULT_THREADS, models: [...BAKE_OFF_MODELS], seed: undefined, yes: false })
    expect(DEFAULT_THREADS).toBe(10)
    expect(BAKE_OFF_MODELS).toEqual([
      'anthropic/claude-sonnet-5.5',
      'anthropic/claude-haiku-5.5',
      'google/gemini-3.8-flash',
      'openai/gpt-6.1-terra',
    ])
  })

  it('разбирает флаги; список моделей режется по запятым, пробелы и повторы убираются', () => {
    expect(parseBakeOffArgs(['--threads', '3', '--models', 'a/x, b/y ,a/x', '--seed', '5', '--yes']))
      .toEqual({ threads: 3, models: ['a/x', 'b/y'], seed: 5, yes: true })
  })

  it.each([
    [['--threads', '0'], '--threads: нужно целое число больше нуля'],
    [['--threads'], '--threads: нужно целое число больше нуля'],
    [['--models'], '--models: нужен хотя бы один id модели через запятую'],
    [['--models', ' , '], '--models: нужен хотя бы один id модели через запятую'],
    [['--seed', '-2'], '--seed: нужно целое число 0 или больше'],
    [['--dry-run'], 'неизвестный аргумент: --dry-run'],
  ])('ошибка для %j: %s', (argv, message) => {
    expect(() => parseBakeOffArgs(argv)).toThrow(message)
  })
})

describe('seededRng', () => {
  it('одно зерно — одна последовательность, значения в [0, 1); зерно 0 тоже даёт разные значения', () => {
    const a = seededRng(42)
    const b = seededRng(42)
    const xs = Array.from({ length: 5 }, () => a())
    expect(xs).toEqual(Array.from({ length: 5 }, () => b()))
    expect(xs.every(x => x >= 0 && x < 1)).toBe(true)
    const z = seededRng(0)
    expect(new Set(Array.from({ length: 5 }, () => z())).size).toBe(5)
  })
})

describe('pickStretch', () => {
  it('rng 0 → случайное слово 5–6급', async () => {
    const db = await dbWith([BI, GEODEUN_YO, RADIO, BANANA])
    const s = await pickStretch(db, () => 0)
    expect(s).toBeDefined()
    expect(s?.kind).toBe('vocab')
    expect([5, 6]).toContain(s?.level)
  })

  it('rng 0.5 → undefined (подтяжки в этой группе нет)', async () => {
    const db = await dbWith([BI, RADIO, BANANA])
    expect(await pickStretch(db, () => 0.5)).toBeUndefined()
  })

  it('слов 5–6급 нет → undefined даже при rng 0', async () => {
    const db = await dbWith([BI, GEODEUN_YO])
    expect(await pickStretch(db, () => 0)).toBeUndefined()
  })

  it('порог совпадает с GEN.STRETCH_RATE: чуть ниже — подтяжка, на пороге — нет', async () => {
    const db = await dbWith([RADIO])
    expect(await pickStretch(db, () => GEN.STRETCH_RATE - 0.001)).toBeDefined()
    expect(await pickStretch(db, () => GEN.STRETCH_RATE)).toBeUndefined()
  })
})

describe('estimateBank', () => {
  it('число групп, целей и грубые токены по 7000 входных и 2000 выходных на группу', () => {
    expect(estimateBank([[BI, ODA, GEODEUN_YO], [SHOP]]))
      .toEqual({ groups: 2, targets: 4, inputTokens: 14000, outputTokens: 4000 })
    expect(estimateBank([])).toEqual({ groups: 0, targets: 0, inputTokens: 0, outputTokens: 0 })
  })
})

describe('runBank', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('usage суммируется по группам; onResult получает каждую группу по порядку', async () => {
    const db = await dbWith([BI, ODA, GEODEUN_YO])
    analyzerStub('biga-ogeodeunyo')
    const llm = fakeLlm([
      { value: replyOf([post(GOOD_TEXT)]), usage: { inputTokens: 1000, outputTokens: 200 } },
      { value: replyOf([post(GOOD_TEXT)]), usage: { inputTokens: 1100, outputTokens: 300 } },
    ])
    const seen: GroupResult[] = []
    const run = await runBank(db, { llm, cfg }, [[BI], [ODA]], { rng: seeded(1), onResult: r => seen.push(r) })
    expect(run).toEqual({
      processed: 2, ok: 2, failed: 0, usage: { inputTokens: 2100, outputTokens: 500 }, stopped: false, lastErrors: [],
    })
    expect(seen.map(r => r.index)).toEqual([0, 1])
    expect(seen[1].targets).toEqual([ODA])
    expect(seen.every(r => r.result.ok)).toBe(true)
  })

  it('три неудачи подряд останавливают прогон: последующие группы не вызываются', async () => {
    const db = await dbWith([BI, ODA, GEODEUN_YO])
    const llm = fakeLlm([BAD])
    const run = await runBank(db, { llm, cfg }, [[BI], [ODA], [BI], [ODA], [BI]], { rng: seeded(1) })
    // на каждую неудачную группу MAX_RETRIES+1 вызовов; 4-я и 5-я группы не запускаются
    expect(llm.calls).toHaveLength(STOP_AFTER_FAILURES * (GEN.MAX_RETRIES + 1))
    expect(run).toMatchObject({
      processed: STOP_AFTER_FAILURES,
      ok: 0,
      failed: STOP_AFTER_FAILURES,
      stopped: true,
      lastErrors: ['постов должно быть от 1 до 4, получено 0'],
    })
    expect(run.usage).toEqual({ inputTokens: 90, outputTokens: 9 })
  })

  it('успешная группа сбрасывает счётчик неудач: прогон идёт дальше', async () => {
    const db = await dbWith([BI, ODA, GEODEUN_YO])
    analyzerStub('biga-ogeodeunyo')
    const bad = { value: replyOf([]) }
    const good = { value: replyOf([post(GOOD_TEXT)]) }
    // группы 1–2 не прошли (по 3 вызова), группа 3 прошла (1 вызов), группы 4–5 не прошли
    const llm = fakeLlm([bad, bad, bad, bad, bad, bad, good, bad, bad, bad, bad, bad, bad])
    const run = await runBank(db, { llm, cfg }, [[BI], [ODA], [BI], [ODA], [BI]], { rng: seeded(1) })
    expect(run).toMatchObject({ processed: 5, ok: 1, failed: 4, stopped: false })
    expect(llm.calls).toHaveLength(13)
  })

  it('отказ анализатора (fatal) останавливает прогон на первой же группе: следующие группы не вызываются', async () => {
    const db = await dbWith([BI, ODA, GEODEUN_YO])
    vi.stubGlobal('fetch', (async () => jsonRes({ detail: 'Internal Server Error' }, 500)) as unknown as typeof fetch)
    const llm = fakeLlm([{ value: replyOf([post(GOOD_TEXT)]), usage: { inputTokens: 10, outputTokens: 1 } }])
    const seen: GroupResult[] = []
    const run = await runBank(db, { llm, cfg }, [[BI], [ODA], [BI], [ODA]], { rng: seeded(1), onResult: r => seen.push(r) })
    // ошибка анализатора не повторяется: одна попытка, и только у первой группы
    expect(llm.calls).toHaveLength(1)
    expect(run).toEqual({
      processed: 1,
      ok: 0,
      failed: 1,
      usage: { inputTokens: 10, outputTokens: 1 },
      stopped: true,
      lastErrors: ['анализатор ответил HTTP 500'],
    })
    expect(seen.map(r => r.result)).toEqual([
      { ok: false, errors: ['анализатор ответил HTTP 500'], usage: { inputTokens: 10, outputTokens: 1 }, fatal: true },
    ])
  })

  it('пустой список групп: ничего не вызывается', async () => {
    const db = await dbWith([BI])
    const llm = fakeLlm([BAD])
    const run = await runBank(db, { llm, cfg }, [], { rng: seeded(1) })
    expect(llm.calls).toHaveLength(0)
    expect(run).toEqual({ processed: 0, ok: 0, failed: 0, usage: { inputTokens: 0, outputTokens: 0 }, stopped: false, lastErrors: [] })
  })
})

describe('renderThread', () => {
  const thread: Thread = {
    id: 't',
    origin: 'bank',
    posts: [
      {
        id: 'p1',
        threadId: 't',
        author: { name: '민지', handle: 'minji' },
        title: '오늘',
        paragraphs: [
          {
            lang: 'ko',
            segments: [
              { text: '비가', itemIds: ['v:1'], unlisted: [] },
              { text: '오거든요', itemIds: ['g:70'], unlisted: [] },
            ],
          },
          { lang: 'ru', text: 'Потому что идёт дождь.' },
        ],
      },
      {
        id: 'p2',
        threadId: 't',
        author: { name: '준호', handle: 'junho' },
        paragraphs: [{ lang: 'ko', segments: [{ text: '그래요', itemIds: [], unlisted: [] }] }],
      },
    ],
  }
  const checks: Check[] = [{
    id: 'c1', source: 'post', stem: '___ 가 오거든요', options: ['비', '학교', '가게', '채영'], answerIndex: 0, itemIds: ['v:1'],
  }]

  it('автор, заголовок, абзацы (ko — сегменты через пробел), вопросы с отметкой верного', () => {
    expect(renderThread(thread, checks)).toBe([
      '--- пост 1 ---',
      'Автор: 민지 (@minji)',
      'Заголовок: 오늘',
      '비가 오거든요',
      'Потому что идёт дождь.',
      '',
      '--- пост 2 ---',
      'Автор: 준호 (@junho)',
      '그래요',
      '',
      'Вопросы:',
      '1. ___ 가 오거든요',
      '   1) 비 (верный)',
      '   2) 학교',
      '   3) 가게',
      '   4) 채영',
    ].join('\n'))
  })

  it('без вопросов блока «Вопросы» нет и заголовка нет, если его не было', () => {
    const out = renderThread({ ...thread, posts: [thread.posts[1]] }, [])
    expect(out).toBe(['--- пост 1 ---', 'Автор: 준호 (@junho)', '그래요'].join('\n'))
  })
})

describe('bakeOffReport', () => {
  const PRICE = { prompt: 0.000001, completion: 0.000005 }
  const threadOf = (text: string): Thread => ({
    id: 't',
    origin: 'bank',
    posts: [{
      id: 'p',
      threadId: 't',
      author: { name: '민지', handle: 'minji' },
      paragraphs: [{ lang: 'ko', segments: [{ text, itemIds: [], unlisted: [] }] }],
    }],
  })
  const okDraft = (usage: Usage): BankDraft => ({ ok: true, thread: threadOf(GOOD_TEXT), checks: [], extraItems: {}, usage })
  const badDraft = (usage: Usage, errors: string[]): BankDraft => ({ ok: false, errors, usage })

  const rows = [
    {
      model: 'a/one',
      price: PRICE,
      cells: [
        { targets: [BI], draft: okDraft({ inputTokens: 1000, outputTokens: 200 }) },
        { targets: [ODA], draft: badDraft({ inputTokens: 2000, outputTokens: 300 }, ['нет цели: 오다']) },
        { targets: [SHOP], draft: okDraft({ inputTokens: 3000, outputTokens: 500 }) },
        { targets: [SHOP], draft: badDraft({ inputTokens: 4000, outputTokens: 0 }, ['нет цели: 가게']) },
      ],
    },
    {
      model: 'b/two',
      price: PRICE,
      cells: [{ targets: [BI], draft: badDraft({ inputTokens: 1000, outputTokens: 100 }, ['нет цели: 비']) }],
    },
  ]

  const asIs = (text: string): string => text

  it('таблица: годные из N, токены, расход и цена за годную ветку по usage и ценам', () => {
    const report = bakeOffReport(rows, asIs)
    // a/one: вход 10000 × 0.000001 + выход 1000 × 0.000005 = $0.0150; годных 2 → $0.0075 на ветку
    expect(report).toContain('| a/one | 2 из 4 | 10000 | 1000 | $0.0150 | $0.0075 |')
    // b/two: годных нет → цена за ветку н/д
    expect(report).toContain('| b/two | 0 из 1 | 1000 | 100 | $0.0015 | н/д |')
    expect(report.indexOf('| Модель')).toBeLessThan(report.indexOf('## a/one'))
  })

  it('ниже таблицы разделы по моделям и группам целей; годная ветка в тексте, негодная — с ошибкой', () => {
    const report = bakeOffReport(rows, asIs)
    expect(report.indexOf('## a/one')).toBeLessThan(report.indexOf('## b/two'))
    expect(report).toContain('### Группа 1: 비')
    expect(report).toContain('### Группа 2: 오다')
    expect(report).toContain('```text')
    expect(report).toContain('비가 오거든요')
    expect(report).toContain('Не годна: нет цели: 오다')
    expect(report).toContain('Не годна: нет цели: 비')
  })

  it('тексты ошибок идут в отчёт через функцию маскировки', () => {
    const leaky = [{
      model: 'a/one',
      price: PRICE,
      cells: [{ targets: [BI], draft: badDraft({ inputTokens: 1, outputTokens: 1 }, ['сбой: db.example-host.test, 203.0.113.9:5432']) }],
    }]
    const report = bakeOffReport(leaky, text => maskText(text, ['db.example-host.test']))
    expect(report).toContain('Не годна: сбой: [скрыто], [адрес]')
    expect(report).not.toContain('db.example-host.test')
    expect(report).not.toContain('203.0.113.9')
  })
})

describe('секреты в выводе', () => {
  const env = {
    OPENROUTER_API_KEY: 'sk-or-SECRETKEY',
    DATABASE_URL: 'postgresql://app:dbpass@db.example-host.test:6543/postgres',
    ANALYZER_URL: 'https://mecab.example-host.test',
    ANALYZER_SECRET: 'analyzer-secret',
  }

  it('secretValues: ключи, строка подключения и адреса базы и анализатора с хостами', () => {
    expect(secretValues(loadConfig(env))).toEqual(expect.arrayContaining([
      'sk-or-SECRETKEY',
      'analyzer-secret',
      env.DATABASE_URL,
      'db.example-host.test',
      'https://mecab.example-host.test',
      'mecab.example-host.test',
    ]))
  })

  it('maskText убирает ключи, хосты, строку подключения и IP-адреса', () => {
    const text = `ошибка: ${env.DATABASE_URL}, ключ sk-or-SECRETKEY, хост db.example-host.test, ` +
      'сервис 203.0.113.9:8000, mecab.example-host.test, analyzer-secret'
    const out = maskText(text, secretValues(loadConfig(env)))
    for (const s of ['sk-or-SECRETKEY', 'db.example-host.test', 'mecab.example-host.test', 'analyzer-secret', '203.0.113.9', 'dbpass']) {
      expect(out).not.toContain(s)
    }
    expect(out).toContain('[адрес]')
    expect(out).toContain('[скрыто]')
  })

  it('secretValues: имя пользователя из строки подключения к базе (как в адресе и раскодированное) скрывается', () => {
    const secrets = secretValues(loadConfig({ DATABASE_URL: 'postgresql://postgres.ab%2Bcd:dbpass@db.example-host.test:6543/postgres' }))
    expect(secrets).toEqual(expect.arrayContaining(['postgres.ab%2Bcd', 'postgres.ab+cd']))
    expect(maskText('password authentication failed for user "postgres.ab+cd"', secrets)).toBe(
      'password authentication failed for user "[скрыто]"',
    )
  })
})
