# Ловушки

- Next.js 16 отличается от знакомых версий. Перед кодом смотреть node_modules/next/dist/docs/. `next dev` сам дописывает блок в AGENTS.md: это нормально, коммитить вместе с работой.
- Токены живут в двух местах: DESIGN.md и src/app/globals.css. Меняешь один, меняй и другой.
- PRODUCT.md в корне и specs/korean-threads/PRODUCT.md одинаковые: корневой читает /impeccable. Меняешь один, меняй и другой.
- Корейский внутри русского текста может рваться на узком экране. Проверять на ширине 320 px.
- Две сессии Claude уже правили одни файлы параллельно. Перед правками смотреть git status.
- Логика выбора темы записана дважды: инлайн-скрипт в layout.tsx и ThemeToggle.tsx. Меняешь одно, меняй и другое. useLayoutEffect в ThemeToggle не убирать: он ставит цвет theme-color, следит за системной темой и заново применяет data-theme (доки Next предупреждают, что в dev React может сбросить атрибуты <html>; в этом проекте сброс не наблюдался).
- Инлайн-скрипт темы в layout.tsx идёт без nonce. Когда появится Content-Security-Policy (TECH.md, Task 18), ему нужен nonce или hash, иначе скрипт заблокируется и тема будет мигать при загрузке.
- При правке layout.tsx на лету React в dev один раз пишет в консоль «Encountered a script tag…»: это инлайн-скрипт темы. При обычной загрузке ошибки нет.
- Проверка в браузере через Playwright оставляет в корне папку .playwright-mcp/. Она в .gitignore.
- gitleaks не установлен. Перед первым пушем поставить и прогнать (требование TECH.md).
- Vitest 4.x не ставится на npm 10.9 (ошибка arborist «edgesOut») и имеет критическую уязвимость. Vitest 5 требует @types/node ^22.
- Конфиг тестов называется vitest.config.mts: с расширением .ts Vite ругается на ESM в CommonJS.
- openDb (postgres.js) пока не запускался на настоящем Postgres: все тесты идут на PGlite. Проверить на Docker или Supabase dev не позже Task 17.
- migrate ищет supabase/migrations от process.cwd(): запускать из корня проекта.
