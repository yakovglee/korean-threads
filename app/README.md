# 문법 · Грамматика — приложение

Код по [docs/SPEC.md](../docs/SPEC.md); термины — в [GLOSSARY.md](../GLOSSARY.md), решения — в [docs/adr](../docs/adr).
Next.js 16 (App Router) + Supabase (Postgres, pgvector, Auth, Storage) + AI SDK 7 с провайдером OpenRouter.

## Что где

| Путь | Что |
|---|---|
| `src/lib/bot.ts` | Ответ бота: поиск по учебникам, словарь как инструмент модели, тред из постов, источники, теги, расход |
| `src/lib/quiz.ts` | Квиз: задания TOPIK по тегам (ADR 0005), сгенерированные задания, «своё предложение» |
| `src/lib/knowledge.ts` | Поиск фрагментов учебников: по смыслу и по самой конструкции |
| `src/lib/krdict.ts` | 한국어기초사전 Open API, кэш в `dict_cache` |
| `src/lib/words.ts` | Словарные формы слов через mecab-ko-fastapi (ADR 0006) |
| `src/app/api/threads/[id]/answer` | Уточнение и ответ бота потоком NDJSON — посты по одному |
| `supabase/migrations` | Схема, RLS, поиск (`match_chunks`, `search_posts`), бакет `topik-audio` |
| `scripts/` | Локальная подготовка данных из `../books` (ADR 0003) |

## Локальный запуск

Нужны Docker и Node 22.

```bash
npm install
npx supabase start
```

Скопируйте `.env.example` в `.env.local`. Значения Supabase печатает `npx supabase status -o env`: `API_URL` → `NEXT_PUBLIC_SUPABASE_URL`, `PUBLISHABLE_KEY` → `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SECRET_KEY` → `SUPABASE_SECRET_KEY`. Затем загрузите каталог конструкций и запустите сервер:

```bash
npm run catalog
npm run dev
```

Вход — `admin@example.com` из `supabase/seed.sql`. Письмо со ссылкой приходит в Mailpit: http://127.0.0.1:54324.

Без `OPENROUTER_API_KEY` бот не ответит, без `KRDICT_API_KEY` не откроются карточки слов, без `MECAB_URL` слова в постах не нажимаются. Приложение при этом работает.

## База знаний

Модель эмбеддингов выбирается сравнением кандидатов на вопросах из `scripts/data/embedding-eval.json`:

```bash
npm run eval:embeddings -- baai/bge-m3 qwen/qwen3-embedding-8b
```

Впишите победителя в `EMBEDDING_MODEL` и проиндексируйте учебники (книга индексируется заново целиком; можно указать отдельные slug из `scripts/index-books.ts`):

```bash
npm run index
```

При смене модели эмбеддингов переиндексируйте всё: старые векторы с новыми несовместимы.

## Задания TOPIK

Манифест экзаменов — `scripts/topik/exams.ts`. Сначала соберите инструменты распознавания в `../tools/ocr`:

```bash
cd ../tools/ocr && swiftc -O ocr.swift -o ocr && swiftc -O pdf2png.swift -o pdf2png
```

Дальше три шага, каждый пропускает уже готовое; номер сессии ограничивает прогон (`-- 102 83`):

```bash
npm run topik:ocr
```

```bash
npm run topik:parse
```

```bash
npm run topik:upload
```

1. `topik:ocr` распознаёт PDF на Apple Vision в `books/topik-ocr`.
2. `topik:parse` отдаёт модели OpenRouter (`TOPIK_MODEL`, по умолчанию Claude Sonnet 5.5) картинку и текст каждой страницы. Модель выделяет задания, сопоставляет их с ключом и ставит теги конструкций. Результат пишется в `books/topik-json`.
3. `topik:upload` загружает задания в базу, а аудио пережимает `afconvert` в моно AAC и кладёт в бакет `topik-audio`.

Перед загрузкой просмотрите JSON: распознавание и разбор не бывают идеальными. Ключей 41-го экзамена и 96-го TOPIK II в `books/TOPIK` нет, поэтому эти экзамены пропускаются.

## Продакшен

1. Создайте проект Supabase, привяжите его и примените миграцию:

   ```bash
   npx supabase link
   ```

   ```bash
   npx supabase db push
   ```

2. В Auth → URL Configuration укажите Site URL приложения и добавьте `https://<домен>/auth/confirm` в Redirect URLs.
3. В SQL Editor добавьте себя админом и выполните из `supabase/seed.sql` вставки `models` и `app_settings`:

   ```sql
   insert into public.access_list (email, is_admin) values ('you@example.com', true);
   ```

4. На Vercel: Root Directory — `app`, переменные окружения — как в `.env.example`, с ключами продакшена.
5. Каталог, база знаний и TOPIK заливаются скриптами с машины, где лежит `books/`, когда `.env.local` указывает на продакшен.

## Проверки

```bash
npm run typecheck
```

```bash
npm run lint
```

После изменения схемы обновите типы: `npm run db:types`.
