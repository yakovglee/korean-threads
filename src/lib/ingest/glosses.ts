// Русские значения слов: словарь 한국어기초사전 по списку 1–4급 (возобновляемо), ИИ для слов без значения и для лемм вне списков.
import type { Db } from '../db'
import { candidateEntries, combinedGloss, fetchKrdictEntries, glossFromEntry, KrdictError, pickEntry, type DictEntry } from '../krdict'
import { nfc } from '../ko'
import type { LlmClient } from '../llm'
import type { Item } from '../types'

const ATTEMPTS = 3
const RETRY_PAUSE_MS = 1000
// Коды ошибок словаря, при которых прогон останавливается: ключ или доступ неверны, дальше запросы бессмысленны
const ABORT_CODES = new Set(['010', '020', '021'])
const AI_BATCH = 20
// Столько слов подряд без ответа словаря (сеть, HTTP): словарь недоступен, прогон прерываем
const DICT_SILENT_LIMIT = 5
// Столько запросов к модели подряд с ошибкой: модель недоступна, прогон прерываем
const MODEL_ERROR_LIMIT = 5
// Сколько первых значений кандидата уходит в запрос к модели при выборе по подсказке
const SENSES_IN_PROMPT = 3

export interface GlossProgress { index: number; total: number; item: Item; glossRu: string | null }

export interface IngestGlossesResult {
  done: number
  missing: number
  chosenByAi: number
  // слова без строки: сеть, ошибка модели, нет llm
  skipped: number
  // текст последней ошибки модели, если она была
  lastModelError?: string
}

export interface IngestGlossesOptions {
  apiKey: string
  fetchImpl?: typeof fetch
  // нужен, если у слова несколько значений в словаре: без него такие слова пропускаются
  llm?: LlmClient
  delayMs?: number
  limit?: number
  onProgress?: (p: GlossProgress) => void
}

// Тег морфоанализатора → часть речи словаря. VX — две части речи через «/»: кандидаты проверяются по каждой.
const DICT_POS: Record<string, string> = {
  NNG: '명사', NNP: '명사', NNB: '의존명사', NNBC: '의존명사', NP: '대명사', NR: '수사', VV: '동사', VA: '형용사',
  VX: '보조동사/보조형용사', MAG: '부사', MAJ: '부사', MM: '관형사', IC: '감탄사',
}

const GLOSS_BATCH_SYSTEM = 'Ты переводишь корейские слова учебника TOPIK на русский. Для каждого слова дай короткий русский перевод: одно слово или несколько через «; ». Учитывай часть речи. Если у слова есть подсказка (hint), переводи значение, на которое она указывает. Если слова не знаешь, верни пустую строку в glossRu. Ответ — JSON по схеме, без пояснений.'
const GLOSS_BATCH_SCHEMA = {
  type: 'object',
  properties: {
    glosses: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, glossRu: { type: 'string' } },
        required: ['id', 'glossRu'],
        additionalProperties: false,
      },
    },
  },
  required: ['glosses'],
  additionalProperties: false,
}

const LEMMA_SYSTEM = 'Ты переводишь корейское слово на русский. Дай короткий русский перевод: одно слово или несколько через «; ». Учитывай часть речи. Если слова не знаешь, верни glossRu: null. Ответ — JSON по схеме, без пояснений.'
const LEMMA_SCHEMA = {
  type: 'object',
  properties: { glossRu: { type: ['string', 'null'] } },
  required: ['glossRu'],
  additionalProperties: false,
}

// Слова 1–4급 из словаря: пишем строку на каждое слово, которое спросили. Нет значения → строка с null (спрошено, нет).
// Запись однозначна (pickEntry): берём её, модель не вызываем. Иначе кандидаты (candidateEntries): их нет → строка с null;
// есть (в том числе одна запись с чужой частью речи) → выбирает ИИ по подсказке, без llm слово пропускается.
// Пропущенные слова (skipped) строки не получают: сеть, ошибка модели или отсутствие llm, следующий запуск спросит снова.
// Коды из ABORT_CODES прерывают прогон, как и DICT_SILENT_LIMIT слов подряд без ответа словаря и MODEL_ERROR_LIMIT
// запросов к модели подряд с ошибкой.
export async function ingestGlosses(db: Db, opts: IngestGlossesOptions): Promise<IngestGlossesResult> {
  const { apiKey, fetchImpl, llm, delayMs = 150, limit, onProgress } = opts
  const items = await db.query<Item>(
    `select id, kind, level, headword, homograph, pos, hint, related, seq
       from items
      where kind = 'vocab' and level <= 4
        and not exists (select 1 from item_notes n where n.item_id = items.id)
      order by level, seq
      ${limit === undefined ? '' : 'limit $1'}`,
    limit === undefined ? [] : [limit],
  )

  let done = 0
  let missing = 0
  let skipped = 0
  let chosenByAi = 0
  let silentInRow = 0
  let modelErrorsInRow = 0
  let lastModelError: string | undefined
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (i > 0 && delayMs > 0) await sleep(delayMs)

    const entries = await askDictionary(item.headword, apiKey, fetchImpl)
    if (entries === null) {
      silentInRow++
      skipped++
      onProgress?.({ index: i + 1, total: items.length, item, glossRu: null })
      if (silentInRow >= DICT_SILENT_LIMIT) throw new Error(`словарь недоступен: ${DICT_SILENT_LIMIT} слов подряд без ответа`)
      continue
    }
    silentInRow = 0

    let entry: DictEntry | null = pickEntry(entries, item)
    if (entry === null) {
      const candidates = candidateEntries(entries, item)
      if (candidates.length > 0) {
        if (!llm) {
          // наугад запись не берём: слово останется без строки
          skipped++
          onProgress?.({ index: i + 1, total: items.length, item, glossRu: null })
          continue
        }
        try {
          entry = await chooseEntryWithAi(llm, item, candidates)
          modelErrorsInRow = 0
        } catch (e) {
          // ошибка модели: строки нет, следующий запуск спросит снова
          modelErrorsInRow++
          lastModelError = errorText(e)
          skipped++
          onProgress?.({ index: i + 1, total: items.length, item, glossRu: null })
          if (modelErrorsInRow >= MODEL_ERROR_LIMIT) {
            throw new Error(`ИИ недоступен: ${MODEL_ERROR_LIMIT} слов подряд с ошибкой: ${lastModelError}`)
          }
          continue
        }
        if (entry) chosenByAi++
      }
    }
    const gloss = entry ? glossFromEntry(entry) : null
    if (entry && gloss && gloss.glossRu !== null) {
      await db.query(
        `insert into item_notes (item_id, gloss_ru, explanation_ru, source, krdict_code)
         values ($1, $2, $3, 'krdict', $4)
         on conflict (item_id) do nothing`,
        [item.id, gloss.glossRu, gloss.explanationRu, entry.targetCode],
      )
      done++
      onProgress?.({ index: i + 1, total: items.length, item, glossRu: gloss.glossRu })
    } else {
      await db.query(
        `insert into item_notes (item_id, gloss_ru, explanation_ru, source, krdict_code)
         values ($1, null, null, null, null)
         on conflict (item_id) do nothing`,
        [item.id],
      )
      missing++
      onProgress?.({ index: i + 1, total: items.length, item, glossRu: null })
    }
  }
  return { done, missing, chosenByAi, skipped, ...(lastModelError === undefined ? {} : { lastModelError }) }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

const CHOOSE_SYSTEM = 'Ты выбираешь значение корейского слова из словаря. Слово учебника TOPIK дано с уровнем и, возможно, с подсказкой: подсказка указывает, какое значение нужно (например, «두 배» — значение «в два раза»). Кандидаты пронумерованы полем index с 0; у каждого указаны часть речи, корейские толкования и русские переводы первых значений. Названия частей речи в учебнике и в словаре различаются: например, 줄어든말 в словаре значится как «품사 없음», а 명사 бывает «의존 명사». Поэтому выбирай по значению, на которое указывает подсказка, а не по совпадению названия части речи. Верни index кандидата, чьё значение подходит слову и подсказке. Если ни одна запись не подходит, верни index: null. Ответ — JSON по схеме, без пояснений.'
const CHOOSE_SCHEMA = {
  type: 'object',
  properties: { index: { type: ['integer', 'null'] } },
  required: ['index'],
  additionalProperties: false,
}

// Выбор значения по подсказке, когда у слова несколько записей в словаре. Null: модель не выбрала или номер вне списка.
// Ошибка модели не перехватывается: её обрабатывает вызывающий.
export async function chooseEntryWithAi(
  llm: LlmClient,
  item: Pick<Item, 'headword' | 'pos' | 'level' | 'hint'>,
  candidates: DictEntry[],
): Promise<DictEntry | null> {
  const { value } = await llm.json<{ index: number | null }>({
    role: 'light',
    system: CHOOSE_SYSTEM,
    user: JSON.stringify({
      word: item.headword,
      pos: item.pos,
      level: item.level,
      hint: item.hint,
      candidates: candidates.map((c, index) => ({
        index,
        pos: c.pos,
        senses: c.senses.slice(0, SENSES_IN_PROMPT).map(s => ({
          definitionKo: s.definitionKo,
          translationRu: s.translationRu,
          definitionRu: s.definitionRu,
        })),
      })),
    }),
    schema: CHOOSE_SCHEMA,
    schemaName: 'word_sense',
  })
  const index = value.index
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= candidates.length) return null
  return candidates[index]
}

// Запрос к словарю с повтором при любой ошибке, кроме ABORT_CODES. Null: все попытки неудачны.
async function askDictionary(headword: string, apiKey: string, fetchImpl?: typeof fetch): Promise<DictEntry[] | null> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchKrdictEntries(headword, apiKey, fetchImpl)
    } catch (e) {
      if (e instanceof KrdictError && ABORT_CODES.has(e.code ?? '')) throw e
      if (attempt >= ATTEMPTS) return null
      await sleep(RETRY_PAUSE_MS * attempt)
    }
  }
}

export interface FixSharedOptions {
  apiKey: string
  llm: LlmClient
  fetchImpl?: typeof fetch
  delayMs?: number
  // роль модели для выбора статей: по умолчанию light
  role?: 'write' | 'light'
}

export interface FixSharedResult {
  // сколько групп найдено
  groups: number
  // сколько строк item_notes переписано
  changed: number
}

interface SharedRow { id: string; homograph: number; pos: string; hint: string; krdict_code: string }
interface SharedPick { item: number; entry: number }

const SHARED_SYSTEM = 'Ты сопоставляешь омонимы учебника TOPIK со статьями словаря 한국어기초사전. Все омонимы (поле homographs) записаны одним и тем же словом, но у каждого свой номер омонима (homograph), часть речи и подсказка (hint), которая указывает значение. Статьи словаря (поле entries) пронумерованы полем entry с 0; у каждой статьи часть речи, корейские толкования и русские переводы. Статья с полем taken: true уже занята другими омонимами этого слова: её не выбирай. Номер омонима (homograph) не совпадает с номером статьи (entry): сопоставляй только по значению, по подсказке (hint) и части речи. Названия частей речи в учебнике и словаре могут различаться (например, «명사» и «의존 명사»), поэтому сравнивай по значению. Для каждого омонима (поле item) выбери статью, чьё значение ему подходит. Разным омонимам давай разные статьи. Одну статью двум омонимам давай только если другой подходящей статьи нет. Если подходящей статьи нет, верни entry: -1. Ответ — JSON по схеме, без пояснений.'
const SHARED_SCHEMA = {
  type: 'object',
  properties: {
    picks: {
      type: 'array',
      items: {
        type: 'object',
        properties: { item: { type: 'integer' }, entry: { type: 'integer' } },
        required: ['item', 'entry'],
        additionalProperties: false,
      },
    },
  },
  required: ['picks'],
  additionalProperties: false,
}

// Общая статья: омонимы с одним заглавным словом и одним krdict_code в item_notes (например, два «배» с кодом «два раза»).
// Для каждой такой группы заново берём статьи словаря с этим заглавным словом и одним вызовом модели сопоставляем
// омонимы со статьями. Строку переписываем только там, где статья изменилась. Статьи, уже записанные омонимам вне группы,
// в запрос идут с taken: true и строку группы не переписывают. Ошибки словаря и модели и битый ответ
// модели оставляют группу как есть; коды ABORT_CODES прерывают работу, как в ingestGlosses.
export async function fixSharedEntries(db: Db, opts: FixSharedOptions): Promise<FixSharedResult> {
  const { apiKey, llm, fetchImpl, delayMs = 150, role = 'light' } = opts
  const groups = await db.query<{ headword: string; krdict_code: string }>(
    `select i.headword, n.krdict_code
       from items i
       join item_notes n on n.item_id = i.id
      where i.kind = 'vocab' and i.level <= 4 and n.krdict_code is not null
      group by i.headword, n.krdict_code
     having count(*) > 1
      order by i.headword, n.krdict_code`,
  )

  let changed = 0
  for (let g = 0; g < groups.length; g++) {
    const { headword, krdict_code: code } = groups[g]
    const rows = await db.query<SharedRow>(
      `select i.id, i.homograph, i.pos, i.hint, n.krdict_code
         from items i
         join item_notes n on n.item_id = i.id
        where i.kind = 'vocab' and i.level <= 4 and i.headword = $1 and n.krdict_code = $2
        order by i.level, i.seq`,
      [headword, code],
    )
    // статьи, уже записанные омонимам того же слова вне группы: модели помечаем, строку группы на них не переписываем
    const takenRows = await db.query<{ krdict_code: string }>(
      `select distinct n.krdict_code
         from items i
         join item_notes n on n.item_id = i.id
        where i.kind = 'vocab' and i.level <= 4 and i.headword = $1
          and n.krdict_code is not null and n.krdict_code <> $2`,
      [headword, code],
    )
    const taken = new Set(takenRows.map(r => r.krdict_code))
    if (g > 0 && delayMs > 0) await sleep(delayMs)
    const entries = await askDictionary(headword, apiKey, fetchImpl)
    if (entries === null) continue
    const same = headwordEntries(entries, headword)
    if (same.length === 0) continue

    let picks: SharedPick[] | null
    try {
      const { value } = await llm.json<unknown>({
        role,
        system: SHARED_SYSTEM,
        user: JSON.stringify({
          word: headword,
          homographs: rows.map((r, item) => ({ item, homograph: r.homograph, pos: r.pos, hint: r.hint })),
          entries: same.map((e, entry) => ({
            entry,
            pos: e.pos,
            ...(taken.has(e.targetCode) ? { taken: true } : {}),
            senses: e.senses.map(s => ({ definitionKo: s.definitionKo, translationRu: s.translationRu, definitionRu: s.definitionRu })),
          })),
        }),
        schema: SHARED_SCHEMA,
        schemaName: 'shared_entry_picks',
      })
      picks = validPicks(value, rows.length, same.length)
    } catch {
      // ошибка модели: группа остаётся как есть
      continue
    }
    if (picks === null) continue

    for (const { item, entry } of picks) {
      if (entry === -1) continue
      const row = rows[item]
      const dictEntry = same[entry]
      if (dictEntry.targetCode === row.krdict_code) continue
      // статья занята омонимом вне группы: строку не переписываем
      if (taken.has(dictEntry.targetCode)) continue
      const gloss = glossFromEntry(dictEntry)
      // запись без русского текста не затирает строку, которая уже есть
      if (gloss.glossRu === null) continue
      await db.query(
        `update item_notes set gloss_ru = $1, explanation_ru = $2, source = 'krdict', krdict_code = $3
          where item_id = $4`,
        [gloss.glossRu, gloss.explanationRu, dictEntry.targetCode, row.id],
      )
      changed++
    }
  }
  return { groups: groups.length, changed }
}

// Статьи с точным заглавным словом (дефисы значимы), все части речи, по порядку supNo
function headwordEntries(entries: DictEntry[], headword: string): DictEntry[] {
  const head = nfc(headword.trim())
  return entries.filter(e => nfc(e.headword) === head).sort((a, b) => a.supNo - b.supNo)
}

// Ответ по схеме: номера омонимов и статей в пределах списков, entry −1 = подходящей статьи нет; номер омонима не повторяется.
// Иначе null: группа остаётся как есть.
function validPicks(value: unknown, itemCount: number, entryCount: number): SharedPick[] | null {
  const picks = (value as { picks?: unknown } | null)?.picks
  if (!Array.isArray(picks)) return null
  const out: SharedPick[] = []
  const seen = new Set<number>()
  for (const p of picks as unknown[]) {
    const { item, entry } = (p ?? {}) as { item?: unknown; entry?: unknown }
    if (!isInteger(item) || item < 0 || item >= itemCount) return null
    if (!isInteger(entry) || entry < -1 || entry >= entryCount) return null
    if (seen.has(item)) return null
    seen.add(item)
    out.push({ item, entry })
  }
  return out
}

function isInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v)
}

// Слова vocab со строкой item_notes и gloss_ru null: ИИ пачками по 20. Пустой ответ оставляет null; id не из пачки игнорируются.
export async function fillMissingGlossesWithAi(db: Db, llm: LlmClient, opts: { limit?: number } = {}): Promise<number> {
  const rows = await db.query<{ item_id: string; headword: string; pos: string; hint: string }>(
    `select n.item_id, i.headword, i.pos, i.hint
       from item_notes n
       join items i on i.id = n.item_id
      where n.gloss_ru is null and i.kind = 'vocab'
      order by i.level, i.seq
      ${opts.limit === undefined ? '' : 'limit $1'}`,
    opts.limit === undefined ? [] : [opts.limit],
  )

  let filled = 0
  for (let start = 0; start < rows.length; start += AI_BATCH) {
    const batch = rows.slice(start, start + AI_BATCH)
    const batchIds = new Set(batch.map(r => r.item_id))
    const { value } = await llm.json<{ glosses: { id: string; glossRu: string }[] }>({
      role: 'light',
      system: GLOSS_BATCH_SYSTEM,
      user: JSON.stringify(batch.map(r => ({ id: r.item_id, word: r.headword, pos: r.pos, hint: r.hint }))),
      schema: GLOSS_BATCH_SCHEMA,
      schemaName: 'word_glosses',
    })
    if (!Array.isArray(value.glosses)) throw new Error('ИИ вернул ответ без поля glosses')

    for (const g of value.glosses) {
      const glossRu = typeof g.glossRu === 'string' ? g.glossRu.trim() : ''
      if (!batchIds.has(g.id) || glossRu === '') continue
      const updated = await db.query<{ item_id: string }>(
        `update item_notes set gloss_ru = $1, source = 'ai'
          where item_id = $2 and gloss_ru is null
         returning item_id`,
        [glossRu, g.id],
      )
      filled += updated.length
    }
  }
  return filled
}

// Значение леммы вне списков: кэш lemma_cache по (lemma в NFC, pos), затем словарь (если есть ключ), затем ИИ.
// Словарь: все записи слова с подходящей частью речи (candidateEntries), их русский текст через combinedGloss; номер омонима не нужен.
// llm null — ветка ИИ отключена: при промахе словаря результат { glossRu: null, source: null }.
// Ответ ИИ в кэш не пишем, если словарь упал с ошибкой: при следующем запросе словарь спросим снова.
export async function lookupLemma(
  db: Db,
  llm: LlmClient | null,
  lemma: string,
  pos: string,
  apiKey?: string,
  fetchImpl?: typeof fetch,
): Promise<{ glossRu: string | null; source: 'krdict' | 'ai' | null }> {
  const key = nfc(lemma)
  const cached = await db.query<{ gloss_ru: string | null; source: string | null }>(
    'select gloss_ru, source from lemma_cache where lemma = $1 and pos = $2',
    [key, pos],
  )
  const hit = cached[0]
  if (hit?.gloss_ru) return { glossRu: hit.gloss_ru, source: hit.source === 'ai' ? 'ai' : 'krdict' }

  let dictGloss: string | null = null
  let dictFailed = false
  if (apiKey) {
    try {
      const entries = await fetchKrdictEntries(key, apiKey, fetchImpl)
      dictGloss = combinedGloss(candidateEntries(entries, { headword: key, pos: DICT_POS[pos] ?? pos }))
    } catch {
      dictFailed = true
    }
  }
  if (dictGloss !== null) {
    await putLemmaCache(db, key, pos, dictGloss, 'krdict')
    return { glossRu: dictGloss, source: 'krdict' }
  }
  if (!llm) return { glossRu: null, source: null }

  const aiGloss = await askAiForLemma(llm, key, pos)
  if (aiGloss === null) return { glossRu: null, source: null }
  if (!dictFailed) await putLemmaCache(db, key, pos, aiGloss, 'ai')
  return { glossRu: aiGloss, source: 'ai' }
}

async function askAiForLemma(llm: LlmClient, word: string, pos: string): Promise<string | null> {
  const { value } = await llm.json<{ glossRu: string | null }>({
    role: 'light',
    system: LEMMA_SYSTEM,
    user: JSON.stringify({ word, pos: DICT_POS[pos] ?? pos }),
    schema: LEMMA_SCHEMA,
    schemaName: 'lemma_gloss',
  })
  const glossRu = typeof value.glossRu === 'string' ? value.glossRu.trim() : ''
  return glossRu === '' ? null : glossRu
}

async function putLemmaCache(db: Db, lemma: string, pos: string, glossRu: string, source: 'krdict' | 'ai'): Promise<void> {
  await db.query(
    `insert into lemma_cache (lemma, pos, gloss_ru, source) values ($1, $2, $3, $4)
     on conflict (lemma, pos) do update set gloss_ru = excluded.gloss_ru, source = excluded.source`,
    [lemma, pos, glossRu, source],
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
