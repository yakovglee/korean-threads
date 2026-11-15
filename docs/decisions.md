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
