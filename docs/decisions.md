# Решения

Архитектура и деплой: specs/korean-threads/TECH.md (в корне). Здесь только то, чего там нет.

- Код в korean-threads-app/ со своим git. Спеки, DESIGN.md и снимки ревью лежат в корне, корень не под git.
- Next.js 16, App Router, чистый CSS без Tailwind, иконки lucide-react.
- Источник дизайн-токенов DESIGN.md, src/app/globals.css их повторяет.
- В демо роль задаёт маршрут: / владелец, /viewer зритель.
- Работаем по схеме «Мозг и руки»: Opus 5.5 планирует и принимает, builder и reviewer на Haiku.
- Все субагенты по умолчанию на Haiku (CLAUDE_CODE_SUBAGENT_MODEL в .claude/settings.json). Исключение /impeccable: правки делает основная сессия на Opus, его субагенты запускаются с model: "opus".
- CLAUDE_CODE_SUBAGENT_MODEL_FORCE не включаем: он переведёт на Haiku и субагентов impeccable, несмотря на явный model.
