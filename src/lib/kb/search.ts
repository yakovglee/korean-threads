// Поиск по базе знаний: текстовая часть (ILIKE по словам запроса) и векторная (pgvector, косинус), слияние rrf.
// Файл не зависит от разбора PDF: типы и поиск можно импортировать из приложения.
import type { Db } from '../db'
import type { LlmClient } from '../llm'
import { nfc } from '../ko'

export type KbKind = 'grammar' | 'textbook' | 'exam' | 'dict' | 'generated'

export interface KbHit {
  chunkId: number
  docPath: string
  page: number | null
  ref: string
  kind: KbKind
  text: string
  score: number
}

const VEC_DIM = 1024
const EMBED_BATCH = 64
const RRF_K = 60
const CANDIDATES = 20
const MAX_WORDS = 8

interface ChunkRow {
  id: number
  kind: string | null
  page: number | null
  ref: string | null
  text: string
  doc_path: string
}

// Косинусное сходство двух векторов; нулевой вектор даёт 0.
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error(`cosine: длины векторов ${a.length} и ${b.length} не совпадают`)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

// Reciprocal rank fusion: сумма 1 / (k + ранг), ранг с единицы.
export function rrf(lists: number[][], k = RRF_K): Map<number, number> {
  const scores = new Map<number, number>()
  for (const list of lists) {
    list.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1)))
  }
  return scores
}

// Эмбеддинги для чанков без вектора, пачками по id. Возвращает число обновлённых чанков.
// Пачка сначала проверяется целиком, и только потом пишется в одной транзакции.
export async function embedMissing(db: Db, llm: LlmClient, opts: { batch?: number } = {}): Promise<number> {
  const batch = opts.batch ?? EMBED_BATCH
  let updated = 0
  let lastId = 0
  for (;;) {
    const rows = await db.query<{ id: number; text: string }>(
      'select id, text from kb_chunks where vec is null and id > $1 order by id limit $2',
      [lastId, batch],
    )
    if (rows.length === 0) return updated
    const vectors = await llm.embed(rows.map(r => r.text))
    if (vectors.length !== rows.length) {
      throw new Error(`embedMissing: получено векторов ${vectors.length}, ожидалось ${rows.length}`)
    }
    for (const v of vectors) checkVector(v)
    await db.tx(async tx => {
      for (let i = 0; i < rows.length; i++) {
        await tx.query('update kb_chunks set vec = $2::text::vector where id = $1', [rows[i].id, vectorText(vectors[i])])
      }
    })
    updated += rows.length
    lastId = rows[rows.length - 1].id
  }
}

// Гибридный поиск: до 20 чанков по тексту, до 20 по косинусу, слияние rrf, наверх k.
export async function searchKb(db: Db, llm: LlmClient, query: string, opts: { k: number; kinds?: KbKind[] }): Promise<KbHit[]> {
  const q = nfc(query).trim()
  if (q === '' || opts.k <= 0) return []
  if (opts.kinds && opts.kinds.length === 0) return []
  const words = [...new Set(q.split(/\s+/))].slice(0, MAX_WORDS)

  const textRows = await textCandidates(db, words, opts.kinds)

  // Если эмбеддинг запроса не получился, поиск идёт только по тексту
  let qvec: number[] | undefined
  try {
    qvec = (await llm.embed([q]))[0]
  } catch {
    qvec = undefined
  }
  const vecRows = qvec ? await vectorCandidates(db, qvec, opts.kinds) : []

  const rows = new Map<number, ChunkRow>()
  for (const r of [...textRows, ...vecRows]) rows.set(r.id, r)
  const fused = rrf([textRows.map(r => r.id), vecRows.map(r => r.id)])
  // при равном счёте порядок по id, чтобы выдача не плавала
  const ranked = [...fused.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, opts.k)

  const hits: KbHit[] = []
  for (const [id, score] of ranked) {
    const r = rows.get(id)
    if (!r) continue
    hits.push({
      chunkId: id,
      docPath: r.doc_path,
      page: r.page,
      ref: r.ref ?? '',
      kind: r.kind as KbKind,
      text: r.text,
      score,
    })
  }
  return hits
}

// Текстовая часть: чанк подходит, если содержит хотя бы одно слово запроса как подстроку.
// Порядок: сколько разных слов найдено, затем сколько всего вхождений, затем id.
async function textCandidates(db: Db, words: string[], kinds: KbKind[] | undefined): Promise<ChunkRow[]> {
  const p = paramList()
  const any: string[] = []
  const found: string[] = []
  const occ: string[] = []
  for (const w of words) {
    const pattern = p.add(`%${escapeLike(w)}%`)
    const raw = p.add(w)
    any.push(`c.text ilike ${pattern}`)
    found.push(`(c.text ilike ${pattern})::int`)
    occ.push(`((length(lower(c.text)) - length(replace(lower(c.text), lower(${raw}), ''))) / length(${raw}))`)
  }
  const kindPart = kindFilter(p, kinds)
  return db.query<ChunkRow>(
    `select h.id, h.kind, h.page, h.ref, h.text, coalesce(d.path, '') as doc_path
     from (
       select c.id, c.doc_id, c.kind, c.page, c.ref, c.text,
              ${found.join(' + ')} as found,
              ${occ.join(' + ')} as occ
       from kb_chunks c
       where (${any.join(' or ')})${kindPart}
     ) h
     left join kb_docs d on d.id = h.doc_id
     order by h.found desc, h.occ desc, h.id
     limit ${CANDIDATES}`,
    p.values,
  )
}

// Векторная часть: 20 ближайших по косинусному расстоянию среди чанков с вектором.
async function vectorCandidates(db: Db, qvec: number[], kinds: KbKind[] | undefined): Promise<ChunkRow[]> {
  const p = paramList()
  const vec = p.add(vectorText(qvec))
  const kindPart = kindFilter(p, kinds)
  return db.query<ChunkRow>(
    `select c.id, c.kind, c.page, c.ref, c.text, coalesce(d.path, '') as doc_path
     from kb_chunks c
     left join kb_docs d on d.id = c.doc_id
     where c.vec is not null${kindPart}
     order by c.vec <=> ${vec}::vector
     limit ${CANDIDATES}`,
    p.values,
  )
}

// Параметры запроса: только строки (примитивы по соглашению db.ts), каждая с приведением ::text.
function paramList(): { values: unknown[]; add(v: string): string } {
  const values: unknown[] = []
  return {
    values,
    add(v: string): string {
      values.push(v)
      return `$${values.length}::text`
    },
  }
}

function kindFilter(p: ReturnType<typeof paramList>, kinds: KbKind[] | undefined): string {
  if (!kinds) return ''
  return ` and c.kind in (${kinds.map(k => p.add(k)).join(', ')})`
}

// Экранирование для ILIKE: %, _ и сама обратная косая черта (она же escape-символ по умолчанию).
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&')
}

function checkVector(v: number[]): void {
  if (v.length !== VEC_DIM) {
    throw new Error(`embedMissing: вектор длиной ${v.length}, колонка vec ждёт ${VEC_DIM}; проверь модель эмбеддингов`)
  }
  if (!v.every(Number.isFinite)) throw new Error('embedMissing: вектор содержит не число')
}

// Текст для приведения в vector: '[0.1,0.2,…]'
function vectorText(v: number[]): string {
  return `[${v.join(',')}]`
}
