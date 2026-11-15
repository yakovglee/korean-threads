# Korean Threads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (the owner chose native execution). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Личная веб-лента для телефона, которая учит корейский к TOPIK II 4급 (февраль 2027): банк ИИ-постов в стиле Threads/Substack, чат с опорой на книги, касания по словам, мини-проверки (настоящие и «в стиле TOPIK») и модель забывания.

**Architecture:** Next.js на Vercel (Fluid, регион `icn1`) с базой Supabase Postgres (Seoul) и отдельным анализатором-контейнером (`mecab-ko-fastapi`, Fly.io). Две роли: владелец (вход по паролю) и зритель (аноним, только чтение). ИИ (OpenRouter) пишет обычный корейский текст, анализатор размечает его по морфемам, система сверяет слова и конструкции со списками 1–6급. Книги, экзамены и словарь обрабатываются на Mac скриптами; в облачную базу знаний идут только текстовые чанки с векторами (поиск по ключевым словам и по смыслу), страницы без текстового слоя распознаются визуальной моделью с OCR-кэшем на диске Mac.

**Tech Stack:** TypeScript, Next.js (App Router), Postgres (Supabase: `pgvector`, `pg_trgm`) через `postgres` (postgres.js) или `pg` с пулером Supavisor, Zod, Vitest + Testing Library + PGlite, OpenRouter (HTTP через `fetch`), `csv-parse`, `fast-xml-parser`, `pdfjs-dist` + рендер страниц в PNG (`mupdf` или `@napi-rs/canvas`), Python 3.10–3.13 для анализатора (Docker-образ), Fly.io (контейнер), Vercel, GitHub (приватный репозиторий).

**Репозиторий:** код приложения живёт в отдельной папке `~/Documents/korean-threads-app/` (свой `git init`, приватный репозиторий GitHub, Vercel с автодеплоем `main`). Папки `books/`, `specs/`, `docs/`, OCR-кэш лежат вне репозитория; пути к ним задаются `KB_SOURCE_DIR`. Решения по деплою: `specs/korean-threads/TECH.md` (разделы «Контекст», «Архитектура», «Доступ и безопасность»).

**Spec:** `/Users/yakov/Documents/korean-threads/docs/superpowers/specs/2026-11-14-korean-threads-design.md`

## Global Constraints

- Цель: **TOPIK II, 4급, экзамен в феврале 2027**; дата — переменная `EXAM_DATE` (`YYYY-MM-DD`), необязательна.
- Приложение личное, но опубликовано для чтения: владелец (пароль) и зрители (без входа, без записи). Файлы книг и экзаменов, OCR-кэш, `.env*`, `data/`, `backups/` не попадают в git и не публикуются; в облако идут только текстовые чанки базы знаний.
- Всё, что изменяет состояние или тратит деньги (запись событий, ответы на проверки, чат, прогресс), доступно только владельцу; проверка роли — на сервере (Task 18).
- Зритель не вызывает ИИ, не видит `source='exam'`, `origin='chat'`, прогресс и дату экзамена.
- Объём: лексика 1–4급 = 5690 слов, грамматика 1–4급 = 224 конструкции (в списках всего 10 635 и 336). 5–6급: только изредка («подтяжка вверх»), не входят в прогресс и план.
- Объяснения и значения на русском. Значения слов — из 한국어기초사전; если там нет, значение даёт ИИ и хранится с `source='ai'`, UI показывает пометку «ИИ».
- Один текст для любого уровня: любое слово или конструкцию можно раскрыть касанием; уровня на входе нет.
- ИИ пишет текст без разметки; разметку делает анализатор (`ANALYZER_URL`; локально `http://127.0.0.1:8000`, на проде адрес контейнера Fly.io; запросы подписаны `ANALYZER_SECRET`).
- Слова вне всех списков допускаются, помечаются и получают значение при касании.
- Мини-проверки редкие (`CHECK_EVERY = 12` карточек). Вкладка «Тренировка», письмо и аудио в первую версию **не** входят.
- Провайдер ИИ — **OpenRouter** (`OPENROUTER_API_KEY`). Роли и модели по умолчанию, все переопределяются в `.env.local`: `MODEL_WRITE=anthropic/claude-sonnet-5.5`, `MODEL_LIGHT=anthropic/claude-haiku-5.5`, `MODEL_VISION=google/gemini-3.8-flash`, `MODEL_VERIFY=google/gemini-3.8-flash`, `MODEL_EMBED=baai/bge-m3`. Итоговый выбор моделей за владельцем (Task 4, Task 10).
- Формат запросов OpenRouter: `POST https://openrouter.ai/api/v1/chat/completions`; структурный вывод `response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } }` (поддержка зависит от провайдера эндпоинта, нужен запасной путь); картинка как `{ type: 'image_url', image_url: { url: 'data:image/png;base64,…' } }`; эмбеддинги `POST /api/v1/embeddings` в формате OpenAI (проверить по документации).
- Секреты (`OPENROUTER_API_KEY`, `KRDICT_API_KEY`, `DATABASE_URL`, `OWNER_PASSWORD_HASH`, `SESSION_SECRET`, `ANALYZER_SECRET`) — только в `.env.local` (Mac) и в переменных окружения Vercel (Production); у Preview прод-секретов нет. Токенов в URL нет.
- Часовой пояс для «дня» — переменная `APP_TZ`, на проде `Asia/Jayapura` (Vercel работает в UTC, поэтому задаётся всегда явно).
- Состояние на serverless не хранится в памяти процесса: дедупликация, блокировки и лимиты — в БД.
- Перед использованием API библиотек и сервисов (Next.js, `postgres`/`pg`, Supabase, Vercel, Fly.io, OpenRouter, `pdfjs-dist`, `mupdf`) получить актуальную документацию через `npx ctx7@latest library <name> "<вопрос>"` и `npx ctx7@latest docs <id> "<вопрос>"` (для OpenRouter id `/websites/openrouter_ai`).
- Весь корейский текст нормализуется в NFC до сравнения и записи; лемма анализатора приводится к совместимым джамо (`ᄇ` → `ㅂ`).

## Review Focus

1. Сбой ИИ в чате (нет сети, ошибка OpenRouter, невалидный JSON): чат отвечает понятной ошибкой, ничего не сохраняет, лента продолжает работать из банка. Тест в Task 14.
2. Анализатор не запущен или вернул 404/500: генерация банка останавливается с понятным сообщением, чат отвечает 502, лента работает (ленте анализатор не нужен). Тесты в Task 5 и Task 14.
3. Тонкий банк (свежий старт, все посты недавно показаны): лента отдаёт посты, показанные раньше всех, а не пустую страницу и не зависает. Тест в Task 13.
4. Двойной тап по одному слову за несколько секунд считается один раз. Тест в Task 14.
5. Необычный текст: NFD, эмодзи и `ㅠㅠ`/`ㅋㅋ` (которые анализатор может не вернуть), джамо `ᄇ` в леммах, пустое или слишком длинное (> 1000 символов) сообщение в чат. Тесты в Task 5 и Task 14.
6. Роли: зритель не пишет в состояние, не получает чат, прогресс, `exam`-вопросы, чат-ветки и ИИ-значения; владелец защищён паролем с лимитом попыток. Тесты в Task 18 и Task 19.
7. Таблицы Supabase закрыты RLS без политик; у `anon`/`authenticated` нет доступа; приложение ходит только с сервера. Тест в Task 17.
8. Serverless: нет флагов в памяти (блокировка чата и дедупликация в БД), `maxDuration` у `/api/chat`, пулер без prepared statements. Тесты в Task 14 и Task 17.

---

## File Structure

```
(корень = korean-threads-app/, отдельный git-репозиторий)
package.json, tsconfig.json, vitest.config.ts, next.config.ts, vercel.json, .gitignore, .env.example, README.md
services/mecab-ko-fastapi/   клон репозитория владельца; Dockerfile и fly.toml для контейнера (Task 18)
scripts/analyzer.sh          venv, установка, запуск анализатора локально
scripts/backup.sh, restore.sh, launchd/*.plist   ежедневный pg_dump на Mac (Task 21)
src/lib/config.ts            env, роли и модели
src/lib/db.ts, schema.ts, types.ts   Postgres-слой, миграции (supabase/migrations/*.sql), RLS
src/lib/auth.ts              resolveRole, сессия, пароль, лимиты входа
src/lib/ratelimit.ts         счётчики в rate_limits
src/lib/security.ts          заголовки, проверка Origin, Zod-обёртка route.ts
src/lib/ko.ts                nfc, compatJamo, splitHomograph, normGrammarForm
src/lib/ingest/lists.ts      parseGradeList, ingestLists
src/lib/memory.ts            модель забывания, seedItemState, getState/saveState
src/lib/llm.ts               LlmClient (OpenRouter): json, vision, embed
src/lib/analyzer.ts          analyze, toMorphs, segmentText, resolveMorphs, grammarMatches
src/lib/kb/extract.ts        extractDocument, renderPdfPage, chunkPages
src/lib/kb/index.ts          indexDocument, embedMissing, searchKb
src/lib/krdict.ts, ingest/glosses.ts, ingest/grammarNotes.ts
src/lib/posts.ts             buildPost, validatePost, saveThread, loadThread, saveCheck, loadCheck
src/lib/prompts.ts, generate.ts
src/lib/ingest/exams.ts      parseAnswerKey, ingestExamChecks
src/lib/topikStyle.ts        generateTopikStyleCheck
src/lib/feed.ts, api.ts, deps.ts
src/app/api/**/route.ts, src/app/page.tsx, src/app/progress/page.tsx, src/components/*, src/middleware.ts
scripts/*.ts                 ingest-lists, ingest-kb, ingest-glosses, ingest-grammar-notes, ingest-exams, generate-bank, generate-topik-style, check-models, bake-off
tests/**                     по одному файлу на модуль
```

---

### Task 1: Каркас, конфиг и база данных

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `next.config.ts`, `.gitignore`, `.env.example`, `README.md`, `src/lib/config.ts`, `src/lib/db.ts`, `src/lib/schema.ts`, `src/lib/types.ts`, `supabase/migrations/0001_init.sql`, `tests/helpers/testDb.ts`, `src/app/layout.tsx`, `src/app/page.tsx` (заглушка)
- Test: `tests/db.test.ts`, `tests/config.test.ts`

**Interfaces:**
- Produces: `openDb(url: string): Promise<Db>` (Postgres: `postgres`/`pg` через пулер Supavisor на порту 6543 без prepared statements; в тестах — PGlite, адаптер с тем же интерфейсом `Db`), `migrate(db: Db): Promise<void>` (идемпотентна; SQL лежит в `supabase/migrations/*.sql`), `openTestDb(): Promise<Db>` (в `tests/helpers/testDb.ts`: PGlite в памяти с расширениями `vector` и `pg_trgm`, схема из тех же миграций; им пользуются тесты всех задач, Task 17 его только дорабатывает), `loadConfig(env?: NodeJS.ProcessEnv): Config`:

```ts
export type ModelRole = 'write' | 'light' | 'vision' | 'verify' | 'embed'
export interface Config {
  openrouterKey: string | undefined; analyzerUrl: string; analyzerSecret: string | undefined
  models: Record<ModelRole, string>; databaseUrl: string; tz: string; examDate: string | null
  ownerPasswordHash: string | undefined; sessionSecret: string | undefined; publicFeed: boolean
  kbSourceDir: string | undefined
}
```

`Db` — тонкая обёртка: `query<T>(sql, params): Promise<T[]>`, `tx(fn)`, `close()`. Все функции `src/lib/*`, работавшие синхронно с `better-sqlite3`, становятся `async`; в сигнатурах ниже тип `Database` читается как `Db`, а `getState(db, …)` и т.п. — как `await`. Возвращаемые типы `void`/значения читаются как `Promise<…>`.

Типы в `types.ts`:

```ts
export type ItemKind = 'vocab' | 'grammar'
export type Level = 1 | 2 | 3 | 4 | 5 | 6
export interface Item { id: string; kind: ItemKind; level: Level; headword: string; homograph: number; pos: string; hint: string; related: string; seq: number }
export interface Segment { text: string; itemIds: string[]; unlisted: { lemma: string; pos: string }[] } // один сегмент = одна «слово-форма» (по пробелам), без пробелов
export type Paragraph = { lang: 'ko'; segments: Segment[] } | { lang: 'ru'; text: string }
export interface Source { doc: string; page: number | null }
export interface Post { id: string; threadId: string; author: { name: string; handle: string }; title?: string; paragraphs: Paragraph[]; stretchItemId?: string; sources?: Source[] }
export interface Thread { id: string; origin: 'bank' | 'chat'; posts: Post[] }
export interface Check { id: string; source: 'exam' | 'post' | 'topik-style'; stem: string; passage?: string; options: string[]; answerIndex: number; itemIds: string[]; label?: string }
```

Таблицы: `items(id PK, kind, level, headword, homograph, pos, hint, related, seq)`, `item_notes(item_id PK, gloss_ru, explanation_ru, examples_json, source, krdict_code, sources_json)` (`sources_json` — `Source[]`, откуда взято пояснение грамматики), `lemma_cache(lemma, pos, gloss_ru, source, PRIMARY KEY(lemma,pos))`, `item_state(item_id PK, stability_days, last_event_at, is_new, tap_count, introduced_day)`, `events(id PK AUTOINCREMENT, at, item_id, type, post_id, check_id)`, `threads(id PK, origin, created_at)`, `posts(id PK, thread_id, position, body_json, stretch_item_id, sources_json, last_delivered_at)`, `post_items(post_id, item_id)`, `checks(id PK, source, body_json, created_at, last_answered_at)`, `check_items(check_id, item_id)`, `kb_docs(id PK, path, kind, sha1, pages, ocr_pages)`, `kb_chunks(id bigserial PK, doc_id, kind, page, ref, text, vec vector(N))` с GIN-индексом `pg_trgm` по `text`. В Postgres `events.id` — `bigserial`, `at` — `bigint` (мс). Служебные: `rate_limits(key, window_start, count)`, `chat_lock(id, until)`, `login_attempts(ip_hash, window_start, count)`. Все таблицы — `ENABLE ROW LEVEL SECURITY`, политик нет (Task 17).

`loadConfig`: `MODEL_*` из env, иначе значения из Global Constraints; `ANALYZER_URL` локально `http://127.0.0.1:8000`; `DATABASE_URL` обязателен (в тестах не нужен); `PUBLIC_FEED` по умолчанию `on`; `APP_TZ` по умолчанию `Asia/Jayapura`.

- [x] **Step 1: Тесты**

```ts
it('migrate создаёт все таблицы и идемпотентна', async () => {
  const db = await openTestDb(); await migrate(db); await migrate(db)
  const rows = await db.query<{ tablename: string }>("select tablename from pg_tables where schemaname = 'public'")
  const names = rows.map(r => r.tablename)
  for (const t of ['items','item_notes','lemma_cache','item_state','events','threads','posts','post_items','checks','check_items','kb_docs','kb_chunks','rate_limits','chat_lock','login_attempts']) expect(names).toContain(t)
})
it('loadConfig: модели по умолчанию и переопределение', () => {
  expect(loadConfig({}).models.write).toBe('anthropic/claude-sonnet-5.5')
  expect(loadConfig({ MODEL_WRITE: 'x/y' }).models.write).toBe('x/y')
  expect(loadConfig({}).analyzerUrl).toBe('http://127.0.0.1:8000')
})
```

- [x] **Step 2: Запустить `npx vitest run tests/db.test.ts tests/config.test.ts`. Ожидается FAIL.**
- [x] **Step 3: Создать каркас в `~/Documents/korean-threads-app/` (Next.js + TS + Vitest + Postgres-драйвер + PGlite для тестов), реализовать `openDb`, `migrate`, `loadConfig`, типы.** `.gitignore`: `node_modules`, `.next`, `data/`, `backups/`, `*.db`, `.env*` (кроме `.env.example`), `.vercel`. Скрипты `package.json`: `test`, `dev`, `build`, `start`.
- [x] **Step 4: Тесты проходят.**
- [x] **Step 5: `git init` в `korean-threads-app/`, коммит `chore: scaffold app, config and postgres schema` (до первого коммита — `gitleaks`).**

---

### Task 2: Корейские утилиты и загрузка списков 1–6급

**Files:**
- Create: `src/lib/ko.ts`, `src/lib/ingest/lists.ts`, `scripts/ingest-lists.ts`
- Test: `tests/ko.test.ts`, `tests/lists.test.ts`

**Interfaces:**
- Consumes: `Item`, `openDb`, `migrate` (Task 1).
- Produces:
  - `nfc(s: string): string`
  - `compatJamo(s: string): string` (заменяет сочетаемые джамо U+1100–U+11FF на совместимые, например `ᄇ` → `ㅂ`; остальное не трогает)
  - `splitHomograph(s: string): { base: string; homograph: number }`
  - `normGrammarForm(s: string): string` (NFC, совместимые джамо, без ведущих `-` и `~`, без номера омонима)
  - `parseGradeList(csvText: string, kind: ItemKind): { items: Item[]; warnings: string[] }`
  - `ingestLists(db: Database, vocabCsv: string, grammarCsv: string): { vocab: number; grammar: number; warnings: string[] }`
- Id-схема: `v:<전체 번호>`, `g:<전체 번호>`.

- [x] **Step 1: Тесты**

```ts
it('splitHomograph', () => {
  expect(splitHomograph('가격02')).toEqual({ base: '가격', homograph: 2 })
  expect(splitHomograph('은1')).toEqual({ base: '은', homograph: 1 })
  expect(splitHomograph('-거든2')).toEqual({ base: '-거든', homograph: 2 })
  expect(splitHomograph('가게')).toEqual({ base: '가게', homograph: 0 })
})
it('nfc сводит NFD к NFC', () => expect(nfc('가'.normalize('NFD'))).toBe('가'))
it('compatJamo', () => expect(compatJamo('ᄇ니다')).toBe('ㅂ니다'))
it('normGrammarForm', () => expect(normGrammarForm('-거든2')).toBe('거든'))
it('parseGradeList vocab', () => {
  const csv = '전체 번호,등급별 번호,등급,어휘,품사,길잡이말,어휘교육내용개발(1-4단계),등급\n1,1,1급,가게,명사,가게에 가다 ,초급,1급\n2,2,1급,가격02,명사,가격이 비싸다 ,초급,1급'
  const { items } = parseGradeList(csv, 'vocab')
  expect(items[0]).toMatchObject({ id: 'v:1', level: 1, headword: '가게', pos: '명사', hint: '가게에 가다', homograph: 0 })
  expect(items[1]).toMatchObject({ id: 'v:2', headword: '가격', homograph: 2 })
})
it('parseGradeList grammar', () => {
  const csv = '전체 번호,등급별 번호,등급,분류,대표형,관련형,의미,국제통용 (2단계),문법.표현 교육내용개발(1-4단계),메모(20201030 수정)\n1,1,1급,조사,이,가,,초급,초급,'
  expect(parseGradeList(csv, 'grammar').items[0]).toMatchObject({ id: 'g:1', level: 1, headword: '이', pos: '조사', related: '가' })
})
it('ingestLists на реальных файлах: 5690 слов и 224 конструкции на уровнях 1–4', () => { /* books/…csv, select count(*) where level<=4 */ })
```

- [x] **Step 2: Запустить `npx vitest run tests/ko.test.ts tests/lists.test.ts`. FAIL.**
- [x] **Step 3: Реализовать.** Файлы в `books/` содержат неверные байты UTF-8: декодировать с заменой, строки с `�` записывать в `warnings` и в `data/ingest-warnings.json`. Колонки находить по имени заголовка (в словаре колонка `등급` встречается дважды: брать первую). `scripts/ingest-lists.ts` читает оба CSV из `books/`.
- [x] **Step 4: Тесты проходят; запустить `npx tsx scripts/ingest-lists.ts`, увидеть «vocab 5690 / grammar 224 (1–4급), всего 10 635 / 336».**
- [x] **Step 5: Commit `feat: ingest vocab and grammar grade lists`.**

---

### Task 3: Модель забывания и стартовое состояние

**Files:**
- Create: `src/lib/memory.ts`
- Test: `tests/memory.test.ts`

**Interfaces:**
- Consumes: `Item`, `Level` (Task 1), `items` (Task 2).
- Produces:

```ts
export const MEMORY = { TAP_FACTOR: 0.5, MIN_DAYS: 0.5, CHECK_RIGHT_FACTOR: 2, CHECK_RIGHT_FLOOR_DAYS: 1, CHECK_WRONG_FACTOR: 0.4, UNTAPPED_BOOST: 1.15, MAX_DAYS: 180 } as const
export const LEVEL_WEIGHT: Record<Level, number> = { 1: 0.2, 2: 0.3, 3: 1, 4: 1, 5: 0, 6: 0 }
export interface ItemState { itemId: string; stabilityDays: number; lastEventAt: number | null; isNew: boolean; tapCount: number }
export type MemEvent = 'tap' | 'viewed' | 'check_right' | 'check_wrong'
export function retrievability(s: ItemState, now: number): number // now в мс; isNew → 0
export function applyEvent(s: ItemState, ev: MemEvent, now: number): ItemState
export function priority(item: Item, s: ItemState, now: number): number // (1 - R) * LEVEL_WEIGHT[level]
export function seedItemState(db: Database, now: number): number
export function getState(db: Database, itemId: string): ItemState // без now (решение 15.11.2026); для отсутствующего (5–6급) возвращает {stability 0, isNew true}, в базу не пишет
export function saveState(db: Database, s: ItemState): void
```

Правила (из спеки: касания ослабляют, верные проверки укрепляют, время ослабляет; `viewed` без касания — выбор плана): `tap`: `stability = max(MIN_DAYS, stability × TAP_FACTOR)`, `isNew=false`, `tapCount+1`; `check_right`: `min(MAX_DAYS, max(CHECK_RIGHT_FLOOR_DAYS, stability) × 2)`, `isNew=false`; `check_wrong`: `max(MIN_DAYS, stability × 0.4)`, `isNew=false`; `viewed`: только для `!isNew`, `min(MAX_DAYS, stability × 1.15)`, для новых слов ничего. Старт: 1–2급 — `stability 60, isNew false`; 3급 — `stability 4, isNew false`; 4급 — `stability 0, isNew true`; 5–6급 строк нет.

- [x] **Step 1: Тесты**

```ts
const s = (o = {}) => ({ itemId: 'v:1', stabilityDays: 4, lastEventAt: 0, isNew: false, tapCount: 0, ...o })
it('retrievability', () => expect(retrievability(s(), 4 * 86400000)).toBeCloseTo(Math.exp(-1), 4))
it('retrievability нового слова = 0', () => expect(retrievability(s({ isNew: true, stabilityDays: 0 }), 0)).toBe(0))
it('tap: 4 → 2 → 1 → 0.5 → 0.5', () => { let x = s(); const seq = [] as number[]; for (let i = 0; i < 4; i++) { x = applyEvent(x, 'tap', 1); seq.push(x.stabilityDays) } expect(seq).toEqual([2, 1, 0.5, 0.5]) })
it('check_right 4 → 8, cap 180', () => { expect(applyEvent(s(), 'check_right', 1).stabilityDays).toBe(8); expect(applyEvent(s({ stabilityDays: 150 }), 'check_right', 1).stabilityDays).toBe(180) })
it('check_wrong 4 → 1.6', () => expect(applyEvent(s(), 'check_wrong', 1).stabilityDays).toBeCloseTo(1.6))
it('viewed 4 → 4.6; на новом ничего', () => { expect(applyEvent(s(), 'viewed', 1).stabilityDays).toBeCloseTo(4.6); expect(applyEvent(s({ isNew: true, stabilityDays: 0 }), 'viewed', 1).isNew).toBe(true) })
it('tap по новому слову: isNew=false, stability 0.5', () => expect(applyEvent(s({ isNew: true, stabilityDays: 0 }), 'tap', 1)).toMatchObject({ isNew: false, stabilityDays: 0.5 }))
it('seedItemState: 1–2급 60, 3급 4, 4급 новое, 5–6급без строки', () => { /* по одному item каждого уровня */ })
```

- [x] **Step 2: Запустить `npx vitest run tests/memory.test.ts`. FAIL.**
- [x] **Step 3: Реализовать функции выше.**
- [x] **Step 4: Тесты проходят.**
- [x] **Step 5: Commit `feat: forgetting model and seed state`.**

---

### Task 4: Клиент OpenRouter и выбор моделей

**Files:**
- Create: `src/lib/llm.ts`, `scripts/check-models.ts`
- Test: `tests/llm.test.ts`

**Interfaces:**
- Consumes: `Config`, `ModelRole` (Task 1).
- Produces:

```ts
export interface Usage { inputTokens: number; outputTokens: number }
export class LlmError extends Error { constructor(message: string, public status?: number) }
export interface LlmClient {
  json<T>(args: { role: 'write' | 'light' | 'verify'; system: string; user: string; schema: object; schemaName: string; maxTokens?: number; temperature?: number }): Promise<{ value: T; usage: Usage }>
  vision(args: { imagePng: Buffer; prompt: string; maxTokens?: number }): Promise<{ text: string; usage: Usage }>  // роль vision
  embed(texts: string[]): Promise<number[][]>                                                                      // роль embed, пакеты до 64
}
export function openRouterClient(cfg: Config, fetchImpl?: typeof fetch, opts?: { retryDelayMs?: number; timeoutMs?: number }): LlmClient
```

`json`: сначала `response_format: json_schema` со `strict: true`; если эндпоинт отвечает ошибкой «не поддерживается», повтор с `json_object` и схемой в промпте; ответ парсится, невалидный JSON → `LlmError`. Заголовок `Authorization: Bearer <OPENROUTER_API_KEY>`; без ключа `LlmError('OPENROUTER_API_KEY не задан')`. Повтор 2 раза при 429 и 5xx с паузой.

- [x] **Step 1: Тесты (фейковый `fetchImpl`)**

```ts
it('json отправляет json_schema и разбирает ответ', async () => { /* тело запроса: response_format.type==='json_schema', model==='anthropic/claude-sonnet-5.5' */ })
it('json: при отказе json_schema повторяет с json_object', async () => {})
it('json: невалидный JSON → LlmError', async () => {})
it('vision кладёт PNG как data URL в image_url', async () => { /* messages[0].content содержит image_url.url, начинающийся с data:image/png;base64, */ })
it('embed режет на пакеты по 64 и склеивает результат в порядке', async () => {})
it('429 повторяется, затем LlmError со status', async () => {})
```

- [x] **Step 2: Запустить `npx vitest run tests/llm.test.ts`. FAIL.**
- [x] **Step 3: Реализовать на `fetch`. Формат эмбеддингов сверить с документацией OpenRouter (`ctx7`).** `scripts/check-models.ts` читает `GET https://openrouter.ai/api/v1/models`, проверяет, что все id из `Config.models` существуют, у `vision` есть вход `image`, и печатает цены за миллион токенов.
- [x] **Step 4: Тесты проходят; `npx tsx scripts/check-models.ts` с реальным ключом печатает «все модели найдены».**
- [x] **Step 5: Commit `feat: openrouter client`.**

---

### Task 5: Анализатор: сервис, клиент, разметка текста

**Files:**
- Create: `scripts/analyzer.sh`, `src/lib/analyzer.ts`, `tests/fixtures/mecab/*.json`; клон `services/mecab-ko-fastapi/` (в git не входит)
- Test: `tests/analyzer.test.ts`

**Interfaces:**
- Consumes: `Item`, `Segment`, `Paragraph` (Task 1), `nfc`, `compatJamo`, `splitHomograph`, `normGrammarForm` (Task 2).
- Produces:

```ts
export interface MecabToken { surface: string; pos: string; entryType: string; expression: string; parts: { lemma: string; pos: string }[] }
export interface Morph { lemma: string; pos: string }               // lemma: глаголы и прилагательные в форме на «다», джамо совместимые
export class AnalyzerError extends Error {}
export function analyze(text: string, baseUrl: string, fetchImpl?: typeof fetch): Promise<MecabToken[]> // POST {text} на baseUrl/, 404 → [], прочие ошибки → AnalyzerError
export function toMorphs(token: MecabToken): Morph[]
export function segmentText(text: string, tokens: MecabToken[]): { text: string; morphs: Morph[] }[]   // сегмент на «слово-форму» (по пробелам); нестыковка → сегмент без morphs, не исключение
export function posGroup(pos: string): 'noun' | 'verb' | 'adj' | 'adv' | 'det' | 'interj' | 'num' | 'pron' | 'func' | 'skip'
export function resolveMorphs(db: Database, morphs: Morph[]): { itemIds: string[]; unlisted: { lemma: string; pos: string }[] }
export function grammarMatches(item: Item, morphs: Morph[]): boolean
export function analyzeToSegments(db: Database, text: string, baseUrl: string): Promise<Segment[]>
```

Правила:
- `toMorphs`: берётся `parts` (если есть) иначе сам токен; для `VV VA VX VCP VCN XSV XSA` лемма = основа + `다`. Токен `입니다` (`이/VCP` + `ᄇ니다/EF`) даёт леммы `이다` и `ㅂ니다`.
- `posGroup`: `NNG NNB NNBC` → noun; `NR` → num; `NP` → pron; `VV VX` → verb; `VA` → adj; `MAG MAJ` → adv; `MM` → det; `IC` → interj; `JK* JX JC EP EF EC ETN ETM VCP VCN XSV XSA XSN XPN` → func; `NNP SL SH SN SY SF SE SSO SSC SC XR UNKNOWN` → skip (имена, иностранные слова, знаки не считаются ни списочными, ни «вне списка»).
- `resolveMorphs`: содержательные морфемы (noun/verb/adj/adv/det/interj/num/pron) → `resolveVocab(lemma, posGroup)`: совпадение `headword` (после NFC и `splitHomograph`) и подходящей части речи списка (명사, 동사, 형용사, 부사, 관형사, 감탄사, 수사, 대명사); при нескольких омонимах сначала по части речи, затем меньший `level`, затем меньший `seq`; не найдено → `unlisted`. Служебные морфемы (`func`) → грамматические items по совпадению `normGrammarForm(headword)` с `compatJamo(lemma)`; несовпавшие игнорируются.
- `grammarMatches`: многоморфемные конструкции строятся из `normGrammarForm(item.headword)` и 대표형: разбить по пробелам, раскрыть `(으)`, `아/어` и `ㅂ/습` как альтернативы, искать как подпоследовательность лемм; для однослоговых служебных форм достаточно совпадения морфемы.

**Подготовка сервиса.** Системный `python3` здесь 3.14, а закреплённые в `requirements.txt` пакеты (`pydantic-core 2.33.2`, `uvloop 0.21`, `mecab-ko 1.0.2`) могут на нём не собраться. `scripts/analyzer.sh` ищет `python3.12` или `python3.13`; иначе печатает подсказку `brew install python@3.12`. Затем: клон `https://github.com/yakovglee/mecab-ko-fastapi.git` в `services/`, venv, `pip install -r requirements.txt`, `uvicorn app:app --host 127.0.0.1 --port 8000`. Заметки по коду сервиса: `Tagger()` создаётся на каждый запрос (приемлемо), пустой результат даёт 404, лицензия GPL-2.0 (процесс отдельный, для личного использования это допустимо).

- [x] **Step 1: Поднять сервис командой `bash scripts/analyzer.sh`, проверить `curl -s localhost:8000 -X POST -H 'content-type: application/json' -d '{"text":"비가 오거든요"}'` и записать реальные ответы для фикстур `tests/fixtures/mecab/`: `비가 오거든요`, `먹을 수 있어요`, `가 보세요`, `공부합니다`, `가니까`, `학교에 가요`, `채영이 😂 ㅠㅠ 웃었어`.** Если сервис не запускается, остановиться и сообщить владельцу.
- [x] **Step 2: Тесты (на фикстурах, без сети)**

```ts
it('toMorphs: глаголы получают 다, ᄇ нормализуется', () => { /* 입니다 → ['이다','ㅂ니다'] */ })
it('segmentText: сегменты по пробелам, морфемы разложены по сегментам', () => {})
it('segmentText: эмодзи и ㅠㅠ не ломают выравнивание', () => { /* сегмент без morphs, остальные на месте */ })
it('segmentText принимает NFD-ввод', () => {})
it('posGroup', () => { expect(posGroup('NNG')).toBe('noun'); expect(posGroup('EC')).toBe('func'); expect(posGroup('NNP')).toBe('skip') })
it('resolveMorphs: омоним 가다01/가다02 выбирается детерминированно, неизвестная лемма → unlisted', () => {})
it('grammarMatches', () => {
  expect(grammarMatches(g('-거든'), morphsOf('비가 오거든요'))).toBe(true)
  expect(grammarMatches(g('-(으)ㄹ 수 있다'), morphsOf('먹을 수 있어요'))).toBe(true)
  expect(grammarMatches(g('-아/어 보다'), morphsOf('가 보세요'))).toBe(true)
  expect(grammarMatches(g('-ㅂ/습니다'), morphsOf('공부합니다'))).toBe(true)
  expect(grammarMatches(g('-(으)니까'), morphsOf('가니까'))).toBe(true)
  expect(grammarMatches(g('-거든'), morphsOf('학교에 가요'))).toBe(false)
})
it('analyze: 404 → [], 500 и сетевая ошибка → AnalyzerError', async () => {})
```

- [x] **Step 3: Запустить `npx vitest run tests/analyzer.test.ts`. FAIL.**
- [x] **Step 4: Реализовать.**
- [x] **Step 5: Тесты проходят. Проверка на реальных данных: `analyzeToSegments` по трём фразам из `GRAMMAR_MAIN.md` и вывод владельцу, какие items нашлись.**
- [x] **Step 6: Commit `feat: morphological analysis via mecab-ko-fastapi`.**

---

### Task 6: База знаний: извлечение, OCR, индекс и поиск

**Files:**
- Create: `src/lib/kb/extract.ts`, `src/lib/kb/index.ts`, `src/lib/kb/search.ts`, `scripts/ingest-kb.ts`
- Test: `tests/kb.extract.test.ts`, `tests/kb.index.test.ts`, `tests/kb.search.test.ts`

**Interfaces:**
- Consumes: `LlmClient` (Task 4), `kb_*` таблицы (Task 1), `nfc` (Task 2).
- Produces:

```ts
export type KbKind = 'grammar' | 'textbook' | 'exam' | 'dict' | 'generated'
export interface PageText { page: number; text: string; via: 'text' | 'ocr' }
export interface KbHit { chunkId: number; docPath: string; page: number | null; ref: string; kind: KbKind; text: string; score: number }
export function renderPdfPage(path: string, page: number, dpi?: number): Promise<Buffer>  // PNG, по умолчанию 150 dpi
export function extractDocument(path: string, deps: { llm: LlmClient; cacheDir: string; render?: typeof renderPdfPage; minChars?: number }): Promise<PageText[]> // minChars по умолчанию 80
export function chunkPages(pages: PageText[], opts?: { maxChars?: number }): { page: number | null; ref: string; text: string }[] // maxChars 1500, режет по пустым строкам; ref — ближайший заголовок «#» или «стр. N»
export function indexDocument(db: Database, deps: { llm: LlmClient; cacheDir: string }, doc: { path: string; kind: KbKind }): Promise<{ chunks: number; ocrPages: number; skipped: boolean }> // идемпотентно по sha1 файла
export function embedMissing(db: Database, llm: LlmClient, opts?: { batch?: number }): Promise<number>
export function cosine(a: Float32Array, b: Float32Array): number
export function rrf(lists: number[][], k?: number): Map<number, number>  // reciprocal rank fusion, k=60
export function searchKb(db: Database, llm: LlmClient, query: string, opts: { k: number; kinds?: KbKind[] }): Promise<KbHit[]>
```

Правила: страница с текстовым слоем ≥ `minChars` символов берётся как есть (`via: 'text'`), иначе распознаётся визуальной моделью (`via: 'ocr'`); результат OCR кэшируется в `data/ocr/<sha1 файла>/<страница>.md`, повторный запуск не вызывает модель. Промпт OCR: дословно переписать страницу в Markdown, сохранить номера вопросов и варианты ①–④, таблицы как таблицы, ничего не пояснять. `.md` файлы режутся напрямую (одна «страница»). Векторы хранятся в колонке `vec vector(N)` (`pgvector`); `searchKb` — гибрид: до 20 по `pg_trgm` (`similarity`; для запроса короче 3 символов `ILIKE`) и до 20 по косинусу (`<=>`), слияние `rrf`; GIN-индекс `pg_trgm` по `text` создаётся миграцией. Скрипты `ingest-kb` и `ingest-exams` читают файлы из `KB_SOURCE_DIR` и кэш `data/ocr/` на Mac и пишут в Postgres только чанки и векторы; файлы и OCR-кэш в облако не отправляются.

- [x] **Step 1: Тесты**

```ts
it('chunkPages режет по пустым строкам и держит ref заголовка', () => {})
it('extractDocument: страница с текстом не вызывает llm.vision, пустая вызывает', async () => { /* render и llm подменены */ })
it('extractDocument: OCR кэшируется, второй запуск не вызывает vision', async () => {})
it('indexDocument идемпотентен по sha1', async () => { /* второй вызов skipped:true */ })
it('rrf объединяет два списка и поднимает элемент, попавший в оба', () => {})
it('cosine', () => expect(cosine(Float32Array.of(1, 0), Float32Array.of(1, 0))).toBeCloseTo(1))
it('searchKb: короткий запрос "도" находит по LIKE, "-거든" по FTS, фильтр kinds работает', async () => {})
it('NFD-запрос находит NFC-текст', async () => {})
```

- [x] **Step 2: Запустить `npx vitest run tests/kb.extract.test.ts tests/kb.index.test.ts tests/kb.search.test.ts`. FAIL.**
- [x] **Step 3: Реализовать.** Рендер PDF: `mupdf` (WASM) или `pdfjs-dist` с `@napi-rs/canvas`, выбрать по актуальной документации. `scripts/ingest-kb.ts` обходит рекурсивно `books/md/*.md`, `books/GRAMMAR_MAIN.md` (kind `grammar`), оба PDF `합격 레시피` (kind `textbook`) и все PDF в `books/TOPIK/` (kind `exam`); файлы с неотображаемыми именами и `.mp3`/`.djvu` пропускает с записью причины. Флаги `--dry-run` (подсчёт страниц без текстового слоя и оценка стоимости OCR по трём пробным страницам, без записи) и `--yes` (без него полный OCR не стартует).
- [x] **Step 4: Тесты проходят.**
- [ ] **Step 5: `npx tsx scripts/ingest-kb.ts --dry-run`: показать владельцу, сколько страниц надо распознавать и во сколько это обойдётся. После его согласия: пробное OCR трёх страниц (учебник, лист вопросов экзамена, таблица ответов), показать текст на сверку, затем полный запуск с `--yes`, затем `embedMissing`.**
- [ ] **Step 6: Commit `feat: knowledge base with ocr and hybrid search`.**

---

### Task 7: Русские значения слов (한국어기초사전)

**Files:**
- Create: `src/lib/krdict.ts`, `src/lib/ingest/glosses.ts`, `scripts/ingest-glosses.ts`
- Test: `tests/krdict.test.ts`, `tests/glosses.test.ts`, `tests/fixtures/krdict-가게.xml`

**Interfaces:**
- Consumes: `Item`, `item_notes`, `lemma_cache` (Task 1), `LlmClient` (Task 4), `splitHomograph` (Task 2).
- Produces:
  - `interface DictEntry { targetCode: string; headword: string; pos: string; senses: { order: number; definitionKo: string; definitionRu: string | null; translationRu: string | null }[] }`
  - `fetchKrdictEntries(headword: string, apiKey: string, fetchImpl?: typeof fetch): Promise<DictEntry[]>`
  - `pickEntry(entries: DictEntry[], item: { headword: string; pos: string; homograph: number }): DictEntry | null`
  - `ingestGlosses(db, opts: { apiKey: string; fetchImpl?: typeof fetch; delayMs?: number; limit?: number }): Promise<{ done: number; missing: number }>` (возобновляемо; `source='krdict'`)
  - `fillMissingGlossesWithAi(db, llm: LlmClient, opts?: { limit?: number }): Promise<number>` (`source='ai'`, роль `light`)
  - `lookupLemma(db, llm: LlmClient, lemma: string, pos: string, apiKey?: string, fetchImpl?: typeof fetch): Promise<{ glossRu: string | null; source: 'krdict' | 'ai' | null }>` (для слов вне списков, кэш в `lemma_cache`; если значения нет ни в словаре, ни у ИИ — `{ glossRu: null, source: null }`, в кэш не пишется, П-65)

**Блокер владельца:** нужен `KRDICT_API_KEY` (бесплатная регистрация открытого API 한국어기초사전). Без него скрипт печатает инструкцию и завершается. Перед запуском на всех словах прочитать условия использования API и данных и убедиться, что личное локальное использование допустимо.

- [ ] **Step 1: Получить один настоящий ответ API по слову «가게» с переводами на русский и сохранить как `tests/fixtures/krdict-가게.xml`.** Код языка «русский» и имена параметров взять из документации API, не по памяти.
- [ ] **Step 2: Тесты**

```ts
it('fetchKrdictEntries разбирает фикстуру', async () => {
  const xml = readFileSync('tests/fixtures/krdict-가게.xml', 'utf8')
  const entries = await fetchKrdictEntries('가게', 'KEY', async () => new Response(xml))
  expect(entries[0].headword).toBe('가게'); expect(entries[0].senses[0].translationRu).toMatch(/[а-яё]/i)
})
it('pickEntry выбирает по части речи и омониму', () => {})
it('ingestGlosses возобновляем и не дублирует', async () => { /* второй прогон не вызывает fetchImpl */ })
it('fillMissingGlossesWithAi ставит source=ai', async () => {})
it('lookupLemma использует кэш', async () => {})
it('lookupLemma: нет в словаре и ИИ не дал значения → { glossRu: null, source: null }, кэш пуст', async () => {})
```

- [ ] **Step 3: Запустить `npx vitest run tests/krdict.test.ts tests/glosses.test.ts`. FAIL.**
- [ ] **Step 4: Реализовать.** `delayMs` по умолчанию 150; ошибки HTTP повторять 3 раза, затем слово считается `missing`. Скрипт принимает `--limit N`.
- [ ] **Step 5: Тесты проходят; прогнать `--limit 30`, показать владельцу долю слов с русским переводом; затем все 5690 слов 1–4급; затем `fillMissingGlossesWithAi`.**
- [ ] **Step 6: Commit `feat: russian glosses from krdict`.**

---

### Task 8: Пояснения грамматики на русском (с опорой на базу знаний)

**Files:**
- Create: `src/lib/ingest/grammarNotes.ts`, `scripts/ingest-grammar-notes.ts`
- Test: `tests/grammarNotes.test.ts`

**Interfaces:**
- Consumes: `LlmClient` (Task 4), `searchKb`, `KbHit` (Task 6), `Item`, `item_notes` (Task 1).
- Produces:
  - `interface GrammarNote { glossRu: string; explanationRu: string; examples: { ko: string; ru: string }[] }`
  - `buildGrammarNote(llm: LlmClient, item: Item, hits: KbHit[]): Promise<GrammarNote>` (роль `write`, 3–5 примеров)
  - `ingestGrammarNotes(db, llm, opts?: { limit?: number }): Promise<{ done: number; reviewFile: string }>` (для каждой конструкции `searchKb(db, llm, item.headword + ' 의미와 용법', { k: 5, kinds: ['grammar', 'textbook'] })`; пишет `item_notes` с `source='ai'` и `sources_json` = `Source[]` (`{ doc, page }` из найденных фрагментов; шторка показывает «источник: документ, стр. N», `handleItem` отдаёт их в `sources`); 20 случайных записей кладёт в `data/review/grammar-notes-sample.md` с источниками для проверки владельцем)

- [ ] **Step 1: Тесты**

```ts
it('buildGrammarNote передаёт найденные фрагменты в промпт и возвращает note', async () => {
  const llm = fakeLlm({ glossRu: 'потому что', explanationRu: '…', examples: [{ ko: '비가 오거든요.', ru: 'Потому что идёт дождь.' }] })
  const note = await buildGrammarNote(llm, grammarItem('-거든'), [hit('-거든은 이유를…', 'GRAMMAR_MAIN.md', 12)])
  expect(llm.calls[0].user).toContain('-거든은 이유를'); expect(note.examples).toHaveLength(1)
})
it('ingestGrammarNotes пишет source=ai, ссылки на источники и файл для проверки', async () => {})
```

- [ ] **Step 2: Запустить `npx vitest run tests/grammarNotes.test.ts`. FAIL.**
- [ ] **Step 3: Реализовать.**
- [ ] **Step 4: Тесты проходят; запустить на всех 224 конструкциях 1–4급, показать владельцу `data/review/grammar-notes-sample.md` и ждать замечаний (переводы проверяются выборочно).**
- [ ] **Step 5: Commit `feat: grammar notes in russian`.**

---

### Task 9: Пост: сборка, валидация, хранение

**Files:**
- Create: `src/lib/posts.ts`
- Test: `tests/posts.test.ts`

**Interfaces:**
- Consumes: `Item`, `Segment`, `Paragraph`, `Post`, `Thread`, `Check` (Task 1); `analyzeToSegments`, `grammarMatches`, `segmentText`, `toMorphs` (Task 5).
- Produces:

```ts
export const POST_RULES = { UNLISTED_MAX_RATIO: 0.1, MAX_LEVEL: 4 } as const
export interface RawPost { authorName: string; authorHandle: string; title?: string; paragraphs: { lang: 'ko' | 'ru'; text: string }[]; stretchLemma?: string }
export interface RawCheck { stem: string; options: string[]; answerIndex: number }
export interface RawThread { posts: RawPost[]; check?: RawCheck }
export function buildPost(db: Database, raw: RawPost, analyzerUrl: string): Promise<{ post: Omit<Post, 'id' | 'threadId'>; itemIds: string[]; unlistedRatio: number }> // ru-абзацы не анализируются
export function validatePost(db: Database, built: Awaited<ReturnType<typeof buildPost>>, ctx: { mode: 'bank' | 'chat'; targets?: Item[]; stretchLemma?: string }): { ok: true } | { ok: false; errors: string[] }
export function buildCheck(db: Database, raw: RawCheck, analyzerUrl: string, source: Check['source']): Promise<{ ok: true; check: Omit<Check, 'id'> } | { ok: false; errors: string[] }>
export function saveThread(db: Database, thread: Thread, itemIds: string[], checks?: Check[]): void
export function loadThread(db: Database, id: string): Thread | null
export function saveCheck(db: Database, check: Check): void  // checks и check_items
export function loadCheck(db: Database, id: string): Check | null
```

`validatePost`, режим `bank`: (а) доля `unlisted` среди содержательных морфем ≤ 0.1; (б) нет items уровня > 4, кроме одного, чья лемма совпадает с `stretchLemma` и уровень 5–6; (в) все `targets` присутствуют (слова — по `itemIds`, конструкции — по `grammarMatches`). Режим `chat`: (а) и (б) не применяются. Везде: непустые абзацы.
`buildCheck`: в `stem` ровно один `___`; 4 различных варианта; `answerIndex` 0–3; `itemIds` = items, найденные в **вариантах ответа** и различающиеся между ними (объединение по вариантам минус пересечение); если для проверки нет ни одного item, она не годится (`ok: false`).

- [ ] **Step 1: Тесты**

```ts
it('buildPost: ru-абзац не анализируется, ko разбит на сегменты с itemIds', async () => {})
it('validatePost bank: unlisted > 10% → ok:false', async () => {})
it('validatePost bank: слово 5급 без stretchLemma → ok:false; со stretchLemma → ok:true', async () => {})
it('validatePost bank: цель-конструкция не встретилась → ok:false', async () => {})
it('validatePost chat: правила уровня не применяются', async () => {})
it('buildCheck: два "___" → ok:false; дублирующиеся варианты → ok:false', async () => {})
it('buildCheck: itemIds берутся из различающегося в вариантах, а не из stem', async () => {})
it('saveThread/loadThread и saveCheck/loadCheck: круговой обмен', () => {})
```

- [ ] **Step 2: Запустить `npx vitest run tests/posts.test.ts`. FAIL (анализатор подменён фикстурами из Task 5).**
- [ ] **Step 3: Реализовать.** `saveThread` пишет `threads`, `posts` (`body_json`, `stretch_item_id`, `sources_json`), `post_items`, `checks` в одной транзакции.
- [ ] **Step 4: Тесты проходят.**
- [ ] **Step 5: Commit `feat: post build, validation and storage`.**

---

### Task 10: Генерация банка постов

**Files:**
- Create: `src/lib/prompts.ts`, `src/lib/generate.ts`, `scripts/generate-bank.ts`, `scripts/bake-off.ts`
- Test: `tests/generate.test.ts`

**Interfaces:**
- Consumes: `LlmClient` (Task 4), `searchKb` (Task 6), `buildPost`, `validatePost`, `buildCheck`, `saveThread` (Task 9), `item_notes` (Task 7–8), `getState` (Task 3).
- Produces:
  - `GEN = { MAX_RETRIES: 2, STRETCH_RATE: 0.12, TARGETS_PER_CALL: 3, POSTS_PER_THREAD: { min: 1, max: 4 } } as const`
  - `generateBankThread(db, deps: { llm: LlmClient; cfg: Config; role?: 'write' }, targets: Item[], opts: { stretch?: Item; rng: () => number }): Promise<{ ok: true; threadId: string } | { ok: false; errors: string[] }>`
  - `generateChatThread(db, deps: { llm: LlmClient; cfg: Config }, message: string): Promise<{ ok: true; thread: Thread } | { ok: false; errors: string[] }>` (до 6 фрагментов из `searchKb` без `exam`; в посты кладёт `sources`; допускает `ru`-абзацы для объяснений)
  - `planBank(db, opts: { rng: () => number; limit?: number }): Item[][]` (группы целей до 3 items: сначала 3–4급, затем 1–2; каждое 3–4급 слово или конструкция получает ≥ 2 треда, 1–2급 — ≥ 1; считает уже существующие `post_items`, поэтому запуск возобновляем)

LLM возвращает `RawThread` (схема JSON). Требования к промпту (формулировку пишет исполнитель): живой естественный корейский, не учебный; стиль Threads (короткие реплики, ветки, диалоги) или Substack (3–6 абзацев, `title`); несколько разных авторов; никакой разметки в тексте; на каждую цель один `check`. В промпт идут русские значения целей, примеры из `item_notes` и до 4 фрагментов из `searchKb`. В 12% случаев передаётся `stretch` (случайное слово 5–6급). Невалидный ответ повторяется до `MAX_RETRIES` раз с текстом ошибок.

- [ ] **Step 1: Тесты (фейковый `LlmClient`, анализатор на фикстурах)**

```ts
it('generateBankThread сохраняет валидный тред и привязывает цели', async () => { /* post_items содержит все цели */ })
it('невалидный первый ответ повторяется, второй сохраняется', async () => { expect(llm.calls).toHaveLength(2) })
it('после MAX_RETRIES+1 неудач возвращает ok:false и ничего не сохраняет', async () => {})
it('AnalyzerError останавливает генерацию с понятной ошибкой и ничего не сохраняет', async () => {})
it('generateChatThread: объяснение на ru допустимо, sources сохраняются', async () => {})
it('planBank: возобновляем, группы ≤ 3, цели не дублируются между группами', () => {})
```

- [ ] **Step 2: Запустить `npx vitest run tests/generate.test.ts`. FAIL.**
- [ ] **Step 3: Реализовать.** `scripts/generate-bank.ts`: флаги `--limit N`, `--dry-run` (число групп и грубая оценка токенов без обращения к API), печатает сумму `usage` по ходу.
- [ ] **Step 4: Тесты проходят.**
- [ ] **Step 5: Сравнение моделей.** `scripts/bake-off.ts` генерирует по 10 тредов для одних и тех же целей четырьмя моделями (по умолчанию `anthropic/claude-sonnet-5.5`, `anthropic/claude-haiku-5.5`, `google/gemini-3.8-flash`, `openai/gpt-6.1-terra`; перед запуском проверить их наличие `check-models.ts`), складывает результаты в `data/review/bake-off.md` с ценой за тред. Показать владельцу и записать выбранную `MODEL_WRITE` в `.env.local`.
- [ ] **Step 6: Пробный `generate-bank --limit 20`, показать 5 тредов и расход. Полный запуск только по согласию владельца. Можно порциями: лента работает на том, что уже есть.**
- [ ] **Step 7: Commit `feat: bank generation and chat thread generation`.**

---

### Task 11: Настоящие вопросы TOPIK как мини-проверки

**Files:**
- Create: `src/lib/ingest/exams.ts`, `scripts/ingest-exams.ts`
- Test: `tests/exams.test.ts`

**Interfaces:**
- Consumes: `kb_docs`/`kb_chunks` с `kind='exam'` и `PageText` (Task 6), `LlmClient`, `buildCheck`, `saveCheck` (Task 9).
- Produces:
  - `parseAnswerKey(text: string): { section: 'listening' | 'reading' | 'writing'; answers: Record<number, number> }[]` (кружки ①–④ → 0–3; таблицы ответов TOPIK II)
  - `examMeta(pages: PageText[], path: string): { round: number | null; level: 'I' | 'II' | null; part: 'reading' | 'listening-writing' | 'answers' | null }` (по тексту первой страницы, имя файла запасной источник)
  - `structureQuestions(llm: LlmClient, pages: PageText[]): Promise<{ number: number; stem: string; passage?: string; options: string[]; hasImage: boolean }[]>` (роль `light`)
  - `isFeedEligible(q): boolean` (нет картинок, ровно 4 текстовых варианта, каждый ≤ 25 символов, `stem` ≤ 200 символов)
  - `ingestExamChecks(db, deps: { llm: LlmClient; cfg: Config }, opts?: { limit?: number }): Promise<{ checks: number; skipped: { file: string; reason: string }[] }>` (берёт распознанные листы чтения TOPIK II и таблицы ответов того же выпуска; `source='exam'`, `label` вида `TOPIK II 83회 №3`)

- [ ] **Step 1: Тесты**

```ts
it('parseAnswerKey', () => expect(parseAnswerKey(`읽기\n1 ③ 2 ① 3 ④ 4 ②`)[0].answers).toEqual({ 1: 2, 2: 0, 3: 3, 4: 1 }))
it('isFeedEligible: длинные варианты и картинки отсеиваются', () => {})
it('вопрос без различающихся items в вариантах пропускается с причиной', async () => {})
it('ответ из таблицы подставляется как answerIndex', async () => {})
it('выпуск без таблицы ответов пропускается с причиной', async () => {})
```

- [ ] **Step 2: Запустить `npx vitest run tests/exams.test.ts`. FAIL.**
- [ ] **Step 3: Реализовать.** Сначала отработать на одном выпуске (например 83회), показать владельцу 5 извлечённых вопросов с ответами; затем остальные. Номер выпуска и тип листа брать из текста страницы.
- [ ] **Step 4: Тесты проходят; показать сводку `checks` и `skipped`.**
- [ ] **Step 5: Commit `feat: real topik questions as mini-checks`.**

---

### Task 12: Вопросы «в стиле TOPIK» под слабые места

**Files:**
- Create: `src/lib/topikStyle.ts`, `scripts/generate-topik-style.ts`
- Test: `tests/topikStyle.test.ts`

**Interfaces:**
- Consumes: `LlmClient`, `searchKb` (Task 6), `buildCheck`, `saveCheck` (Task 9), `Item` (Task 1).
- Produces:
  - `generateTopikStyleCheck(db, deps: { llm: LlmClient; cfg: Config }, target: Item): Promise<{ ok: true; checkId: string } | { ok: false; reason: string }>`

Алгоритм: взять до 3 образцов настоящих вопросов (`searchKb(db, llm, target.headword + ' 문제', { k: 3, kinds: ['exam'] })`), роль `write` пишет вопрос (`stem` с `___`, 4 варианта, `answerIndex`), `buildCheck` отсеивает по форме и по различающимся items; затем **решатель** (`json` с ролью `verify`, другая модель, без подсказки ответа) выбирает вариант. Принимается только если выбор решателя равен `answerIndex` и `target` входит в items правильного варианта. Сохраняется `source='topik-style'`, `label` «в стиле TOPIK».

- [ ] **Step 1: Тесты**

```ts
it('принимает вопрос, когда решатель согласен и цель в правильном варианте', async () => {})
it('отклоняет, когда решатель выбрал другой вариант', async () => {})
it('отклоняет, когда цель не входит в правильный вариант', async () => {})
it('не обращается к решателю, если форма вопроса невалидна', async () => {})
```

- [ ] **Step 2: Запустить `npx vitest run tests/topikStyle.test.ts`. FAIL.**
- [ ] **Step 3: Реализовать.** `scripts/generate-topik-style.ts`: флаги `--per-item N` (по умолчанию 2), `--limit N`, `--dry-run`; цели — грамматика 3–4급 (около 134 конструкций), приоритет по слабости; печатает долю принятых.
- [ ] **Step 4: Тесты проходят; пробный запуск на 10 конструкциях, показать владельцу 5 принятых и 5 отклонённых с причиной.**
- [ ] **Step 5: Commit `feat: topik-style generated questions with solver check`.**

---

### Task 13: Выбор карточек в ленте

**Files:**
- Create: `src/lib/feed.ts`
- Test: `tests/feed.test.ts`

**Interfaces:**
- Consumes: `priority`, `getState` (Task 3), `loadThread`, `loadCheck` (Task 9), `Check` (Task 1).
- Produces:

```ts
export const FEED = { NEW_PER_DAY: 6, CHECK_EVERY: 12, STRETCH_RATE: 0.12, RECENT_DAYS: 7, CHECK_COOLDOWN_DAYS: 3 } as const
export type FeedCard = { type: 'thread'; thread: Thread } | { type: 'check'; check: Check }
export function localDayKey(ts: number, tz: string): string // 'YYYY-MM-DD'
export function pickFeed(db: Database, opts: { now: number; n: number; rng: () => number; tz: string }): FeedCard[]
export function pickCheck(db: Database, opts: { now: number; rng: () => number }): Check | null
export function recordDelivered(db: Database, cards: FeedCard[], now: number, tz: string): void
```

Алгоритм `pickFeed`: оценка треда = сумма `priority` слов и конструкций 1–4급, на которые он ссылается; кандидаты — топ-3n по оценке среди тредов, не показанных за `RECENT_DAYS`; взвешенная случайная выборка n; тред с «новыми» (`isNew`) сверх `NEW_PER_DAY` за локальный день исключается; с вероятностью `STRETCH_RATE` слот занимает тред с `stretch_item_id`. После каждых `CHECK_EVERY` карточек вставляется карточка-проверка (`pickCheck`: проверка с целью наибольшего приоритета, не отвеченная за `CHECK_COOLDOWN_DAYS`; источники `exam` и `topik-style` предпочтительнее `post`, чтобы экзаменационные задания встречались заметно чаще). `recordDelivered` проставляет `last_delivered_at` и `introduced_day`.

- [ ] **Step 1: Тесты (Review Focus 3)**

```ts
it('localDayKey учитывает tz', () => expect(localDayKey(Date.UTC(2026, 10, 14, 23, 30), 'Asia/Seoul')).toBe('2026-11-15'))
it('приоритет: тред со слабым словом идёт раньше треда с твёрдым', () => {})
it('тонкий банк: 1 тред, n=10 → вернётся 1 карточка, без зацикливания', () => {})
it('все посты недавно показаны → отдаются самые давно показанные (не пусто)', () => {})
it('NEW_PER_DAY: не больше 6 новых слов за локальный день', () => {})
it('CHECK_EVERY: на 24 карточки приходится 2 проверки, если проверки есть', () => {})
it('нет проверок → карточек-проверок нет, без ошибки', () => {})
it('pickCheck предпочитает exam/topik-style при равном приоритете', () => {})
```

- [ ] **Step 2: Запустить `npx vitest run tests/feed.test.ts`. FAIL.**
- [ ] **Step 3: Реализовать.**
- [ ] **Step 4: Тесты проходят.**
- [ ] **Step 5: Commit `feat: feed selection`.**

---

### Task 14: API

**Files:**
- Create: `src/lib/api.ts`, `src/lib/deps.ts`, `src/app/api/feed/route.ts`, `src/app/api/events/route.ts`, `src/app/api/checks/answer/route.ts`, `src/app/api/items/[id]/route.ts`, `src/app/api/lemma/route.ts`, `src/app/api/chat/route.ts`, `src/app/api/progress/route.ts`
- Test: `tests/api.test.ts`

**Interfaces:**
- Consumes: `pickFeed`, `recordDelivered` (Task 13), `applyEvent`, `getState`, `saveState` (Task 3), `generateChatThread` (Task 10), `lookupLemma` (Task 7), `loadCheck` (Task 9), `LlmClient`, `Config`.
- Produces:

```ts
export interface Deps { db: Database; llm: LlmClient; cfg: Config; now: () => number; rng: () => number; role: 'owner' | 'viewer' }
export function getDeps(): Deps
export function handleFeed(d: Deps, n: number): { cards: FeedCard[] }
export function handleEvent(d: Deps, body: { itemId: string; type: MemEvent; postId?: string; checkId?: string }): { ok: true; deduped: boolean }
export function handleCheckAnswer(d: Deps, body: { checkId: string; choice: number }): { correct: boolean; answerIndex: number }
export function handleItem(d: Deps, id: string): { item: Item; glossRu: string | null; explanationRu: string | null; examples: { ko: string; ru: string }[]; source: 'krdict' | 'ai' | null; sources: Source[]; attribution: string | null } | null
export function handleLemma(d: Deps, lemma: string, pos: string): Promise<{ glossRu: string | null; source: 'krdict' | 'ai' | null }>
export function handleChat(d: Deps, body: { message: string }): Promise<{ status: 200; thread: Thread } | { status: 400 | 403 | 409 | 429 | 502; error: string }>
export function handleProgress(d: Deps): { perLevel: { level: 1 | 2 | 3 | 4; total: number; learned: number; confirmed: number }[]; daysToExam: number | null }
```

**Роли (Task 18/19):** каждый `handle*` получает `role: 'owner' | 'viewer'` в `Deps`. Для `viewer`: `handleEvent`, `handleCheckAnswer` (запись), `handleChat`, `handleProgress` → `403` без побочных эффектов; `handleFeed` использует `pickViewerFeed` (случайный, без чат-веток, без `recordDelivered`); проверки только `topik-style`/`post`; `handleLemma` не вызывает ИИ (`glossRu: null` при промахе); значения `krdict` содержат `attribution`. Блокировки и дедупликация — в БД, а не в памяти процесса. `route.ts` проверяют `Origin` у `POST`, валидируют тело Zod и применяют `rate_limits`; `/api/chat` экспортирует `maxDuration`.

`handleEvent`: `tap` по тому же `itemId` в пределах 5000 мс → `{ deduped: true }`, состояние не меняется; все события пишутся в `events`. `handleCheckAnswer`: верно → `check_right`, неверно → `check_wrong` для `itemIds` проверки (то есть различающихся в вариантах), обновляет `last_answered_at`. `handleChat`: `message.trim()` пусто или длиннее 1000 → `400` без вызова ИИ; ошибка ИИ, невалидный ответ или `AnalyzerError` → `502` с текстом по-русски, ничего не сохраняется. `learned` = `stabilityDays >= 7 && retrievability >= 0.8`; `confirmed` = есть `check_right` за 30 дней; `daysToExam` из `EXAM_DATE`, иначе `null`.

- [ ] **Step 1: Тесты (Review Focus 1, 2, 4, 5)**

```ts
it('двойной tap за 2 секунды считается один раз', () => {
  handleEvent(d, { itemId: 'v:1', type: 'tap' }); const r = handleEvent(d, { itemId: 'v:1', type: 'tap' })
  expect(r.deduped).toBe(true); expect((await getState(d.db, 'v:1')).tapCount).toBe(1)
})
it('tap через 6 секунд считается снова', () => {})
it('чат: пустое сообщение → 400, llm не вызван', async () => {})
it('чат: 1001 символ → 400', async () => {})
it('чат: ошибка ИИ → 502, в posts ничего не добавилось, handleFeed работает', async () => {})
it('чат: AnalyzerError → 502, ничего не сохранено', async () => {})
it('чат: успех сохраняет тред origin=chat, sources, и возвращает его', async () => {})
it('check: неверный ответ ослабляет только itemIds проверки', () => {})
it('progress: learned/confirmed по уровням 1–4 и daysToExam', () => {})
it('чат: параллельный второй запрос → 409, ИИ вызван один раз (блокировка в БД)', async () => {})
it('check: повторный ответ на ту же проверку в окне 5 с не пишет второе событие', async () => {})
it('viewer: handleEvent/handleChat/handleProgress/handleCheckAnswer → 403, таблицы events и item_state не изменились', async () => {})
it('handleItem: source ai для слов без krdict; handleLemma кэширует', async () => {})
```

- [ ] **Step 2: Запустить `npx vitest run tests/api.test.ts`. FAIL.**
- [ ] **Step 3: Реализовать обработчики; `route.ts` — тонкие обёртки, парсящие запрос и вызывающие `handle*` с `getDeps()`.** `getDeps()` собирает `openRouterClient(loadConfig())`.
- [ ] **Step 4: Тесты проходят.**
- [ ] **Step 5: Commit `feat: http api`.**

---

### Task 15: Интерфейс ленты

**Files:**
- Create: `src/components/PostCard.tsx`, `src/components/GlossSheet.tsx`, `src/components/CheckCard.tsx`, `src/components/ChatBar.tsx`, `src/components/Feed.tsx`, `src/components/useViewed.ts`, `src/app/progress/page.tsx`; Modify: `src/app/page.tsx`, `src/app/layout.tsx`
- Test: `tests/ui/*.test.tsx`

**Interfaces:**
- Consumes: `FeedCard`, `Thread`, `Check`, `Segment`, `Paragraph` (Task 1/13), эндпоинты Task 14.
- Produces:
  - `PostCard({ thread, onTapSegment }: { thread: Thread; onTapSegment: (seg: Segment, postId: string) => void })`: сегмент с `itemIds` или `unlisted` рисуется как `<button>`; `ru`-абзацы выводятся обычным текстом; у постов с `sources` внизу строка «источник: …»
  - `GlossSheet({ segment, onClose })`: для каждого `itemId` запрашивает `/api/items/:id`, для каждого `unlisted` — `/api/lemma`; показывает значение и пояснение, бейдж «ИИ» при `source === 'ai'`; открытие шторки отправляет событие `tap` для каждого `itemId`; состояния `loading`, `error` (кнопка «повторить») и «значение не найдено» при `glossRu === null` (П-24, П-65); под пояснением грамматики строка «источник: документ, стр. N» из `sources`; доступность (П-61): `role="dialog"`, `aria-label`, фокус уходит в шторку и возвращается на сегмент при закрытии
  - `CheckCard({ check, onAnswer })`: четыре варианта, после выбора подсвечивает верный, кнопки блокируются и выбор изменить нельзя (П-33, П-66), у вариантов `aria-label`; для `topik-style` показывает пометку «в стиле TOPIK», для `exam` подпись `label`
  - `ChatBar`: поле и кнопка; пустое — кнопка отключена; при 4xx/5xx выводит текст ошибки; рисуется только для владельца (зрителю не рисуется вообще, `role` приходит с `/api/me`)
  - Для зрителя: нет ссылки на «Прогресс», нет подписей `exam`, внизу и в шторке видна атрибуция словаря «Значения: 한국어기초사전, CC BY-SA 2.0 KR» со ссылкой; ответы на проверки не отправляются на запись (запрос идёт в read-only обработчик); при `429` — короткое «слишком часто, подожди немного»
  - `useViewed(ref, onViewed, ms = 1500)`: вызывает `onViewed` после 1500 мс видимости карточки (шлёт `viewed` по `itemIds` треда)
  - `Feed`: подгружает следующие карточки, когда до конца осталось 3; новый тред из чата вставляется наверх

Внешний вид оставлен исполнителю при ограничениях: вертикальная лента одной колонкой шириной до 480 px, аватары-инициалы, стиль Threads для коротких постов и Substack для постов с `title`, светлая и тёмная тема (по умолчанию системная, кнопка в шапке переключает вручную, П-58), шрифты с корейскими глифами, зоны касания ≥ 44 px.

- [ ] **Step 1: Тесты**

```tsx
it('тап по сегменту вызывает onTapSegment и открывает GlossSheet со всеми словами сегмента', async () => {})
it('GlossSheet показывает "ИИ" для source=ai и не показывает для krdict', async () => {})
it('CheckCard: после выбора показывает верный вариант и вызывает onAnswer(choice)', async () => {})
it('CheckCard: повторный клик по другому варианту игнорируется, onAnswer вызван один раз', async () => {})
it('GlossSheet: loading → значение; ошибка запроса → «повторить»; glossRu null → «значение не найдено»; source krdict показывает «источник» у грамматики', async () => {})
it('useViewed: срабатывает через 1500 мс видимости и не срабатывает при уходе из вида раньше', () => { /* fake timers + мок IntersectionObserver */ })
it('ChatBar: пустой ввод отключён; ошибка 502 выводится текстом', async () => {})
```

- [ ] **Step 2: Запустить `npx vitest run tests/ui`. FAIL.**
- [ ] **Step 3: Реализовать компоненты и страницы.** Маршрут `/api/me` в этой задаче временная заглушка `{ role: 'owner' }`, Task 18 заменяет её реальной проверкой сессии. `/progress`: столбцы по уровням 1–4 (`learned` и `confirmed` раздельно) и «дней до экзамена», если `daysToExam` не `null`.
- [ ] **Step 4: Тесты проходят.**
- [ ] **Step 5: Запустить приложение (`preview_start` или `npm run dev`) вместе с анализатором на данных из Task 10, пройти ленту, тап, мини-проверку и чат; на ширине 375 px нет горизонтальной прокрутки.**
- [ ] **Step 6: Commit `feat: feed ui`.**

---

### Task 16: PWA и README

**Files:**
- Create: `public/manifest.webmanifest`, иконки в `public/`; Modify: `README.md`, `.env.example`

Токенный доступ (`checkToken`, `APP_TOKEN`, `start:lan`, Tailscale) из первоначального плана **отменён**: доступ — роли и пароль владельца (Task 18), деплой — Task 21.

- [ ] **Step 1: PWA-манифест** для добавления на экран «Домой» (`display: standalone`, иконки, `theme_color`/`background_color` под светлую и тёмную тему).
- [ ] **Step 2: `README.md`:** порядок первого запуска на Mac (`npm i`, `.env.local` из `.env.example`, `bash scripts/analyzer.sh`, миграции dev-проекта, `ingest-lists`, `ingest-kb`, `ingest-glosses`, `ingest-grammar-notes`, `ingest-exams`, `bake-off`, `generate-bank`, `generate-topik-style` — все по умолчанию в dev), перенос данных в prod, запуск тестов, где задаются `EXAM_DATE`, `PUBLIC_FEED`, `APP_TZ`.
- [ ] **Step 3: `npm test` целиком зелёный; `npm run build` проходит.**
- [ ] **Step 4: Commit `feat: pwa manifest and run docs`.**

---

### Task 17: Postgres-слой, миграции и RLS (Supabase dev и prod)

**Files:**
- Create: `supabase/migrations/*.sql`, `src/lib/db.ts` (доработка Task 1), `tests/helpers/testDb.ts`, `scripts/db-migrate.ts`, `scripts/db-verify-rls.ts`; Modify: `.env.example`
- Test: `tests/db.test.ts`

**Interfaces:**
- Produces: `openDb(url)`, `migrate(db)`, `openTestDb()` (PGlite), скрипт `db-migrate [--prod]` (по умолчанию dev), `db-verify-rls`.

**Правила:**
- Два проекта Supabase (`dev`, `prod`), регион Seoul. Расширения `vector`, `pg_trgm`.
- Все таблицы: `ENABLE ROW LEVEL SECURITY`, политик нет. `anon` и `authenticated` не имеют прав на схему `public`.
- Роль приложения (например `app_server`) — минимальные права (SELECT/INSERT/UPDATE/DELETE на нужные таблицы, без DDL и без `BYPASSRLS`, если политики не нужны; иначе явные политики для роли). Строка подключения — пулер Supavisor, порт 6543, transaction mode, `prepare: false`.
- `supabase-js`, anon-ключ и `service_role` в проекте не используются; `grep` в CI-скрипте проверяет их отсутствие.
- Скрипты `--prod` требуют явного флага и подтверждения «yes».

- [ ] **Step 1: Тесты**

```ts
it('миграции идемпотентны и создают все таблицы, включая rate_limits, chat_lock, login_attempts', async () => {})
it('на всех таблицах public включён RLS и нет политик для anon/authenticated', async () => {})
it('pg_trgm и vector доступны: поиск по similarity и по <=> возвращает ожидаемые строки', async () => {})
it('openDb использует prepare:false и порт пулера (проверка по конфигу)', () => {})
```

- [ ] **Step 2: Запустить `npx vitest run tests/db.test.ts`. FAIL.**
- [ ] **Step 3: Создать миграции, роль приложения, `db-migrate`, `db-verify-rls` (запрос к `pg_class`/`pg_policies`).** Применить к dev; для prod — только после Step 5.
- [ ] **Step 4: Тесты проходят.**
- [ ] **Step 5: Применить к prod, запустить `db-verify-rls --prod`, убедиться, что REST-запрос с anon-ключом к любой таблице возвращает пусто или 401.**
- [ ] **Step 6: Commit `feat: postgres layer, migrations and rls`.**

---

### Task 18: Роли, вход владельца, заголовки и анализатор-контейнер

**Files:**
- Create: `src/lib/auth.ts`, `src/lib/ratelimit.ts`, `src/lib/security.ts`, `src/app/login/page.tsx`, `src/app/api/login/route.ts`, `src/app/api/logout/route.ts`, `src/app/api/me/route.ts`, `src/middleware.ts`, `public/robots.txt`, `services/mecab-ko-fastapi/Dockerfile`, `services/mecab-ko-fastapi/fly.toml`, `scripts/hash-password.ts`
- Test: `tests/auth.test.ts`, `tests/ratelimit.test.ts`, `tests/security.test.ts`

**Interfaces:**
- Produces: `resolveRole(req, cfg): Promise<'owner' | 'viewer' | 'denied'>` (владелец — валидная подписанная cookie; иначе зритель при `PUBLIC_FEED=on`, при `off` — `denied`), `login(db, cfg, ip, password): Promise<{ ok: boolean; setCookie?: string; status: 200 | 401 | 429 }>`, `signSession(secret, now)`, `verifySession(secret, cookie, now)`, `hashPassword(pw)`, `verifyPassword(pw, hash)`, `rateLimit(db, key, limit, windowMs, now): Promise<{ ok: boolean; retryAfter?: number }>`, `securityHeaders(): Record<string, string>`, `withApi(handler, opts)` — общая обёртка `route.ts` (Zod, Origin для POST, ошибки на русском без стека).

**Правила:**
- Cookie: `HttpOnly`, `Secure`, `SameSite=Lax`, 30 дней, подпись HMAC на `SESSION_SECRET`, в cookie нет пароля.
- Пароль: scrypt или argon2, сравнение в константное время; хэш в `OWNER_PASSWORD_HASH`. Смена `SESSION_SECRET` отзывает все сессии.
- Вход: 5 попыток за 15 минут на IP (`login_attempts`, ключ — хэш IP), одинаковый ответ на любую ошибку.
- Заголовки: `Content-Security-Policy`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Robots-Tag: noindex, nofollow`; `robots.txt` — запрет всего.
- Анализатор: Dockerfile на Python 3.12, запуск `uvicorn` на `0.0.0.0`, проверка заголовка `X-Analyzer-Secret` (иначе 401); деплой на Fly.io, секрет задаётся `fly secrets`; в `src/lib/analyzer.ts` клиент добавляет заголовок и таймаут.

- [ ] **Step 1: Тесты**

```ts
it('resolveRole: валидная сессия → owner; нет cookie → viewer; PUBLIC_FEED=off и нет сессии → denied', async () => {})
it('сессия: подмена подписи, истёкший срок и смена SESSION_SECRET → не owner', () => {})
it('login: верный пароль → 200 и cookie; неверный → 401 с тем же телом; после 5 неверных → 429 даже с верным', async () => {})
it('rateLimit: окно, остаток, сброс по истечении', async () => {})
it('POST с чужим Origin → 403', async () => {})
it('заголовки безопасности и X-Robots-Tag присутствуют; robots.txt запрещает всё', async () => {})
it('ответ 500 не содержит стек и внутренних имён', async () => {})
it('анализатор: запрос без секрета → 401; клиент добавляет секрет; таймаут → AnalyzerError', async () => {})
```

- [ ] **Step 2: Запустить `npx vitest run tests/auth.test.ts tests/ratelimit.test.ts tests/security.test.ts`. FAIL.**
- [ ] **Step 3: Реализовать модули, страницу `/login`, маршруты, middleware (заголовки, редирект `/progress` без сессии на `/login`).** Подключить `withApi` ко всем `route.ts` Task 14. Собрать образ анализатора, задеплоить на Fly.io, проверить с Mac `curl -H 'X-Analyzer-Secret: …'`.
- [ ] **Step 4: Тесты проходят.**
- [ ] **Step 5: Commit `feat: roles, owner login, security headers, analyzer container`.**

---

### Task 19: Режим зрителя

**Files:**
- Modify: `src/lib/feed.ts`, `src/lib/api.ts`, `src/app/api/**/route.ts`, `src/components/*`, `src/app/page.tsx`
- Create: `src/lib/viewer.ts`, `src/app/about/page.tsx`
- Test: `tests/viewer.test.ts`, `tests/ui/viewer.test.tsx`

**Interfaces:**
- Produces: `pickViewerFeed(db, { n, exclude: string[], rng }): Promise<FeedCard[]>` (случайные ветки `origin='bank'`, без записи состояния), `pickViewerCheck(db, rng)` (`source IN ('topik-style','post')`), `kdAttribution` — константа с текстом и ссылкой.

**Правила:** см. П-68–П-77 и раздел «Режим зрителя» в `TECH.md`. Ответ ленты зрителя кэшируется на CDN (`s-maxage`), курсор — список `exclude` на клиенте. `/about` показывает атрибуцию словаря и описание (без деталей реализации).

- [ ] **Step 1: Тесты**

```ts
it('viewer feed: нет origin=chat, нет last_delivered_at, нет записей в events', async () => {})
it('viewer check: в SQL условие source IN (topik-style, post); ни одна exam-проверка не вернулась', async () => {})
it('viewer lemma: промах кэша → glossRu null, llm не вызван', async () => {})
it('viewer: /api/chat, /api/progress, /api/events → 403', async () => {})
it('UI: у зрителя нет ChatBar и ссылки на Прогресс; видна атрибуция', () => {})
it('PUBLIC_FEED=off: viewer → страница входа, API → 401/403', async () => {})
```

- [ ] **Step 2: Запустить `npx vitest run tests/viewer.test.ts tests/ui/viewer.test.tsx`. FAIL.**
- [ ] **Step 3: Реализовать `pickViewerFeed`, `pickViewerCheck`, read-only обработчики, атрибуцию, `/about`, кэш-заголовки.**
- [ ] **Step 4: Тесты проходят.**
- [ ] **Step 5: Commit `feat: viewer mode`.**

---

### Task 20: Лимиты публичных путей и защита от злоупотребления

**Files:**
- Modify: `src/lib/ratelimit.ts`, `src/lib/api.ts`, `src/app/api/**/route.ts`, `vercel.json`
- Test: `tests/ratelimit.test.ts`, `tests/api.test.ts`

**Правила:**
- Публичная лента: мягкий лимит на IP (например, 60 запросов в минуту); `/api/lemma`: строгий (например, 20 в минуту); чат (владелец): N в минуту и M в сутки; значения задаются конфигом, не кодом.
- При превышении: `429` с русским текстом и `Retry-After`, ИИ не вызывается.
- Проверить по документации Vercel, доступен ли Firewall rate limiting на Hobby; если да, дублировать правила для `/api/*`; если нет, достаточно счётчика в Postgres. Результат записать в `docs/progress.md` (в корне проекта вне репозитория; создать, если файла нет).
- Переключатель `PUBLIC_FEED` проверяется при каждом запросе (без пересборки).

- [ ] **Step 1: Тесты:** лимиты по путям, 429 с `Retry-After`, чат не вызывает ИИ при превышении, `PUBLIC_FEED=off` без пересборки.
- [ ] **Step 2: Запустить `npx vitest run tests/ratelimit.test.ts tests/api.test.ts`. FAIL.**
- [ ] **Step 3: Реализовать лимиты на всех публичных путях.**
- [ ] **Step 4: Тесты проходят.**
- [ ] **Step 5: Commit `feat: rate limits for public endpoints`.**

---

### Task 21: Раскатка на Vercel, бэкапы и приёмка

**Files:**
- Create: `vercel.json`, `.github/` (если нужен CI; необязательно), `scripts/backup.sh`, `scripts/restore.sh`, `scripts/launchd/com.korean-threads.backup.plist`; Modify: `README.md`, `.env.example`, `docs/progress.md` (вне репозитория)

**Порядок:**
1. До пуша: `gitleaks` по рабочему дереву и истории; убедиться, что `books/`, `data/`, `.env*`, `backups/`, `*.db` не отслеживаются.
2. Создать приватный репозиторий GitHub, запушить `main`.
3. Supabase dev и prod готовы (Task 17). Данные: `ingest-*` и `generate-*` на dev, после проверки перенос в prod скриптами с `--prod`.
4. Анализатор на Fly.io работает (Task 18), `ANALYZER_URL` и `ANALYZER_SECRET` готовы.
5. Vercel: подключить репозиторий (Git-интеграция, автодеплой `main`), регион функций `icn1`, `maxDuration` для `/api/chat` (проверить лимит плана по документации), переменные Production: `DATABASE_URL`, `OPENROUTER_API_KEY` (отдельный прод-ключ с месячным лимитом), `OWNER_PASSWORD_HASH`, `SESSION_SECRET`, `ANALYZER_URL`, `ANALYZER_SECRET`, `APP_TZ=Asia/Jayapura`, `PUBLIC_FEED=on`, `EXAM_DATE`, `MODEL_*`. Preview: выключить или значения dev-проекта; включить Deployment Protection.
6. Бэкапы: `backup.sh` (`pg_dump` в `~/backups/`, 14 копий), launchd раз в день, пробное восстановление `restore.sh` в локальную пустую БД, результат в `docs/progress.md`.
7. Приёмка по чек-листу `TECH.md` («Ручная приёмка на телефоне») и проверки ролей (зритель: нет чата и прогресса, 403 на запись, нет `exam`; 5 неверных паролей → блок; `PUBLIC_FEED=off`; `curl -I` показывает `noindex` и заголовки безопасности; Preview не ходит в prod).

- [ ] **Step 1: `gitleaks`, проверка `.gitignore`, пуш в приватный репозиторий.**
- [ ] **Step 2: Перенос данных в prod, `db-verify-rls --prod`.**
- [ ] **Step 3: Переменные Vercel, деплой `main`, проверка `/` и `/login` на `*.vercel.app`.**
- [ ] **Step 4: Бэкапы настроены и восстановление проверено.**
- [ ] **Step 5: Ручная приёмка на телефоне (владелец и зритель); результат записать в `docs/progress.md`.**
- [ ] **Step 6: Commit `chore: deployment config and backup scripts`.**
