# Решения

Архитектура и деплой: specs/korean-threads/TECH.md. Здесь только то, чего там нет.

- Всё в одном репозитории: код, спеки, PRODUCT.md, DESIGN.md, .impeccable/ и конфиг Claude. Claude Code открывается в этой папке. Книги и OCR лежат вне репозитория, в ../books/.
- Next.js 16, App Router, чистый CSS без Tailwind, иконки lucide-react.
- Источник дизайн-токенов DESIGN.md, src/app/globals.css их повторяет.
- В демо роль задаёт маршрут: / владелец, /viewer зритель.
- Работаем по схеме «Мозг и руки»: Opus 5.5 планирует и принимает, builder и reviewer на Haiku.
- Все субагенты по умолчанию на Haiku (CLAUDE_CODE_SUBAGENT_MODEL в .claude/settings.json). Исключение /impeccable: правки делает основная сессия на Opus, его субагенты запускаются с model: "opus".
- CLAUDE_CODE_SUBAGENT_MODEL_FORCE не включаем: он переведёт на Haiku и субагентов impeccable, несмотря на явный model.
- Тема (П-58, изменено 15.11.2026): по умолчанию системная, кнопка в шапке переключает светлую и тёмную. Тема живёт в атрибуте data-theme на <html>. Выбор хранится в localStorage «theme» и стирается, когда совпадает с системной темой. До отрисовки его применяет инлайн-скрипт в layout.tsx.
- Пока открыта шторка слова, лента заблокирована: WordSheet ставит html[data-sheet="open"], CSS даёт overflow: hidden. Приём с position: fixed на body не берём: страница перестаёт быть прокручиваемой, и подкрутка слова над шторкой (window.scrollBy) не сработает.
- Тесты на Vitest 5. Ему нужны типы Node 22+, поэтому @types/node поднят с ^20 до ^22 (в системе Node 22). БД в тестах: PGlite в памяти с расширениями vector (отдельный пакет @electric-sql/pglite-pgvector) и pg_trgm.
- Драйвер Postgres: postgres.js с prepare: false (пулер Supavisor, transaction mode). bigint читается как number: время в мс и счётчики умещаются в 2^53.
- Слой БД: интерфейс Db (query, tx, close) в src/lib/db.ts. В params только примитивы, JSON передаётся строкой с ::jsonb. Вложенные tx запрещены.
- Миграции лежат в supabase/migrations/*.sql. Таблицы учёта нет: каждая миграция идемпотентна (IF NOT EXISTS). Пересмотреть в Task 17.
- kb_chunks.vec имеет тип vector(1024) под baai/bge-m3. Смена модели эмбеддингов потребует миграции.
- loadConfig не бросает исключений: обязательность DATABASE_URL проверяет openDb. Пустая строка в переменной считается «не задано». Параметр имеет тип Record<string, string | undefined>, а не NodeJS.ProcessEnv: типы Next делают NODE_ENV обязательным, и loadConfig({}) не проходит tsc.
- PUBLIC_FEED: лента открыта, только если переменная не задана или равна on, true, 1, yes. Любое другое значение, включая опечатку, закрывает ленту.
