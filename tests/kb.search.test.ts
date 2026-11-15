import { it, expect } from 'vitest'
import type { Db } from '../src/lib/db'
import type { LlmClient } from '../src/lib/llm'
import { cosine, rrf, searchKb, embedMissing, type KbKind } from '../src/lib/kb/search'
import { openTestDb } from './helpers/testDb'

const DIM = 1024

// Вектор из 1024 чисел: единица в позиции pos, остальное нули.
function vecAt(pos: number, value = 1): number[] {
  const v = new Array<number>(DIM).fill(0)
  v[pos] = value
  return v
}

function vecText(v: number[]): string {
  return `[${v.join(',')}]`
}

interface FakeLlm extends LlmClient {
  embedCalls: string[][]
}

// Фейковый клиент: embed отдаёт векторы по функции; чат и картинки в поиске не нужны.
function fakeLlm(embedOf: (text: string) => number[] = () => vecAt(0)): FakeLlm {
  const embedCalls: string[][] = []
  return {
    embedCalls,
    async json() {
      throw new Error('json в тестах поиска не нужен')
    },
    async vision() {
      throw new Error('vision в тестах поиска не нужен')
    },
    async embed(texts) {
      embedCalls.push(texts)
      return texts.map(embedOf)
    },
  }
}

// База в памяти с двумя документами: грамматика (g) и экзамен (e).
async function openSeeded(): Promise<Db> {
  const db = await openTestDb()
  await db.query('insert into kb_docs (id, path, kind) values ($1, $2, $3)', ['g', 'GRAMMAR_MAIN.md', 'grammar'])
  await db.query('insert into kb_docs (id, path, kind) values ($1, $2, $3)', ['e', 'TOPIK/2023-1.pdf', 'exam'])
  return db
}

async function addChunk(
  db: Db,
  c: { doc?: 'g' | 'e'; kind?: KbKind; text: string; page?: number; ref?: string; vec?: number[] },
): Promise<number> {
  const rows = await db.query<{ id: number }>(
    'insert into kb_chunks (doc_id, kind, page, ref, text, vec) values ($1, $2, $3, $4, $5, $6::text::vector) returning id',
    [c.doc ?? 'g', c.kind ?? 'grammar', c.page ?? null, c.ref ?? null, c.text, c.vec ? vecText(c.vec) : null],
  )
  return rows[0].id
}

it('cosine', () => {
  expect(cosine(Float32Array.of(1, 0), Float32Array.of(1, 0))).toBeCloseTo(1)
  expect(cosine(Float32Array.of(1, 0), Float32Array.of(0, 1))).toBeCloseTo(0)
  expect(cosine(Float32Array.of(0, 0), Float32Array.of(1, 0))).toBe(0)
})

it('cosine: векторы разной длины → ошибка', () => {
  expect(() => cosine(Float32Array.of(1), Float32Array.of(1, 0))).toThrow()
})

it('rrf объединяет два списка и поднимает элемент, попавший в оба', () => {
  // 1: 1/61 + 1/62; 3: 1/61; 2: 1/62
  const fused = rrf([[1, 2], [3, 1]])
  expect(fused.get(1)).toBeCloseTo(1 / 61 + 1 / 62, 10)
  expect(fused.get(2)).toBeCloseTo(1 / 62, 10)
  expect(fused.get(3)).toBeCloseTo(1 / 61, 10)
  expect([...fused.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)).toEqual([1, 3, 2])
})

it('searchKb: короткий запрос "도" находит по LIKE', async () => {
  const db = await openSeeded()
  await addChunk(db, { text: '도서관에 갑니다' })
  await addChunk(db, { text: '가게에 갑니다' })
  const hits = await searchKb(db, fakeLlm(), '도', { k: 5 })
  expect(hits.map(h => h.text)).toEqual(['도서관에 갑니다'])
  expect(hits[0].docPath).toBe('GRAMMAR_MAIN.md')
})

it('searchKb: "-거든" находит чанк с этим текстом', async () => {
  const db = await openSeeded()
  await addChunk(db, { text: '-거든은 이유를 말할 때 씁니다' })
  await addChunk(db, { text: '아프거든요' })
  const hits = await searchKb(db, fakeLlm(), '-거든', { k: 5 })
  expect(hits.map(h => h.text)).toEqual(['-거든은 이유를 말할 때 씁니다'])
})

it('searchKb: слово внутри другого слова находится ("거든" в "아프거든요")', async () => {
  const db = await openSeeded()
  await addChunk(db, { text: '아프거든요' })
  const hits = await searchKb(db, fakeLlm(), '거든', { k: 5 })
  expect(hits.map(h => h.text)).toEqual(['아프거든요'])
})

it('searchKb: фильтр kinds работает и в тексте, и в векторах', async () => {
  const db = await openSeeded()
  await addChunk(db, { kind: 'grammar', doc: 'g', text: 'G 도', vec: vecAt(1) })
  await addChunk(db, { kind: 'exam', doc: 'e', text: 'E 도', vec: vecAt(2) })
  await addChunk(db, { kind: 'exam', doc: 'e', text: 'E 무관', vec: vecAt(0) })
  const llm = fakeLlm(() => vecAt(0))
  const all = await searchKb(db, llm, '도', { k: 10 })
  expect(all.map(h => h.text)).toContain('E 무관')
  const grammar = await searchKb(db, llm, '도', { k: 10, kinds: ['grammar'] })
  expect(grammar.map(h => h.text)).toEqual(['G 도'])
  expect(await searchKb(db, llm, '도', { k: 10, kinds: [] })).toEqual([])
})

it('NFD-запрос находит NFC-текст', async () => {
  const db = await openSeeded()
  await addChunk(db, { text: '아프거든요'.normalize('NFC') })
  const query = '거든'.normalize('NFD')
  expect(query).not.toBe(query.normalize('NFC'))
  const hits = await searchKb(db, fakeLlm(), query, { k: 5 })
  expect(hits.map(h => h.text)).toEqual(['아프거든요'])
})

it('searchKb: знаки % и _ в запросе не работают как шаблон', async () => {
  const db = await openSeeded()
  await addChunk(db, { text: '할인 100% 오늘' })
  await addChunk(db, { text: '가격 1000 원' })
  await addChunk(db, { text: '코드 a_b' })
  const llm = fakeLlm()
  expect((await searchKb(db, llm, '%', { k: 5 })).map(h => h.text)).toEqual(['할인 100% 오늘'])
  expect((await searchKb(db, llm, '_', { k: 5 })).map(h => h.text)).toEqual(['코드 a_b'])
  expect(await searchKb(db, llm, '\\', { k: 5 })).toEqual([])
})

it('searchKb: чанк, найденный и по тексту, и по вектору, выше найденного одним способом', async () => {
  const db = await openSeeded()
  const both = await addChunk(db, { text: '아프거든요', vec: vecAt(1) })
  const vecOnly = await addChunk(db, { text: '오늘 날씨', vec: vecAt(0) })
  const hits = await searchKb(db, fakeLlm(() => vecAt(0)), '거든', { k: 5 })
  expect(hits.map(h => h.chunkId)).toEqual([both, vecOnly])
})

it('searchKb: ошибка embed не ломает поиск по тексту', async () => {
  const db = await openSeeded()
  await addChunk(db, { text: '아프거든요', vec: vecAt(0) })
  const broken = Object.assign(fakeLlm(), {
    embed: async (): Promise<number[][]> => {
      throw new Error('OpenRouter 503')
    },
  })
  const hits = await searchKb(db, broken, '거든', { k: 5 })
  expect(hits.map(h => h.text)).toEqual(['아프거든요'])
})

it('searchKb: порядок — сначала число разных слов, потом вхождения', async () => {
  const db = await openSeeded()
  await addChunk(db, { text: '가게 바다' })
  await addChunk(db, { text: '가게 가게 가게' })
  await addChunk(db, { text: '바다' })
  const hits = await searchKb(db, fakeLlm(), '가게 바다', { k: 5 })
  expect(hits.map(h => h.text)).toEqual(['가게 바다', '가게 가게 가게', '바다'])
})

it('searchKb: текстовых кандидатов не больше 20', async () => {
  const db = await openSeeded()
  for (let i = 0; i < 25; i++) await addChunk(db, { text: `도 ${i}` })
  const hits = await searchKb(db, fakeLlm(), '도', { k: 50 })
  expect(hits).toHaveLength(20)
})

it('searchKb: пустой запрос → [] без вызова embed', async () => {
  const db = await openSeeded()
  await addChunk(db, { text: '도' })
  const llm = fakeLlm()
  expect(await searchKb(db, llm, '   ', { k: 5 })).toEqual([])
  expect(llm.embedCalls).toHaveLength(0)
})

it('embedMissing: пачками по batch, повторный вызов возвращает 0', async () => {
  const db = await openSeeded()
  for (let i = 0; i < 5; i++) await addChunk(db, { text: `текст ${i}` })
  const llm = fakeLlm()
  expect(await embedMissing(db, llm, { batch: 2 })).toBe(5)
  expect(llm.embedCalls.map(c => c.length)).toEqual([2, 2, 1])
  expect(await embedMissing(db, llm, { batch: 2 })).toBe(0)
  expect(llm.embedCalls).toHaveLength(3)
  const left = await db.query<{ n: number }>('select count(*)::int as n from kb_chunks where vec is null')
  expect(left[0].n).toBe(0)
})

it('embedMissing: записанный вектор находится поиском', async () => {
  const db = await openSeeded()
  await addChunk(db, { text: 'альфа' })
  await addChunk(db, { text: 'бета', vec: vecAt(5) })
  const embedded = fakeLlm(text => (text === 'альфа' ? vecAt(0) : vecAt(9)))
  expect(await embedMissing(db, embedded)).toBe(1)
  const hits = await searchKb(db, fakeLlm(() => vecAt(0)), 'нет-такого-слова', { k: 1 })
  expect(hits.map(h => h.text)).toEqual(['альфа'])
})

it('embedMissing: неверная длина вектора → ошибка до записи', async () => {
  const db = await openSeeded()
  await addChunk(db, { text: 'а' })
  await addChunk(db, { text: 'б' })
  const llm = fakeLlm(() => new Array<number>(768).fill(0.5))
  await expect(embedMissing(db, llm)).rejects.toThrow(/1024/)
  const written = await db.query<{ n: number }>('select count(*)::int as n from kb_chunks where vec is not null')
  expect(written[0].n).toBe(0)
})
