-- 문법 · Грамматика — схема первой версии (docs/SPEC.md, GLOSSARY.md).
-- Ученик читает свои данные напрямую через RLS; всё, что пишет бот, считает расход
-- или хранит ответы заданий, пишет сервер приложения ключом service role.

create extension if not exists vector with schema extensions;
create extension if not exists pg_trgm with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create type public.level as enum ('초급', '중급', '고급');

-- Ученики и доступ ----------------------------------------------------------

-- Список доступа: только эти адреса могут войти. Читает и пишет только сервер.
create table public.access_list (
  email text primary key check (email = lower(email)),
  is_admin boolean not null default false,
  added_at timestamptz not null default now()
);

-- Модели, которые разрешил админ (id — идентификатор OpenRouter).
create table public.models (
  id text primary key,
  label text not null,
  enabled boolean not null default true,
  position int not null default 0
);

create table public.app_settings (
  id boolean primary key default true check (id),
  default_model text references public.models (id) on update cascade on delete set null
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  level public.level,
  model text references public.models (id) on update cascade on delete set null,
  created_at timestamptz not null default now()
);
create index profiles_model_idx on public.profiles (model);

-- Вход разрешён только адресам из списка доступа: без записи в списке
-- пользователь Auth не создаётся, а с записью сразу получает профиль.
create function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.access_list a where a.email = lower(new.email)) then
    raise exception 'email is not in the access list' using errcode = '42501';
  end if;
  insert into public.profiles (id, email) values (new.id, lower(new.email));
  return new;
end;
$$;
revoke execute on function private.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- Каталог конструкций и база знаний ------------------------------------------

create table public.constructions (
  id int generated always as identity primary key,
  key text not null unique,          -- заголовок каталога как есть: «-거든2»
  name text not null,                -- имя для тегов: «-거든»
  pos text,
  level public.level,
  meaning text
);
create index constructions_name_idx on public.constructions (name);

create table public.books (
  id int generated always as identity primary key,
  slug text not null unique,
  title text not null
);

-- Фрагменты учебников с эмбеддингами. Размерность 1024 подходит обоим
-- кандидатам: bge-m3 (родная) и qwen3-embedding-8b (с параметром dimensions).
create table public.chunks (
  id bigint generated always as identity primary key,
  book_id int not null references public.books (id) on delete cascade,
  page int,                          -- номер страницы PDF; у каталога конструкций его нет
  label text,                        -- для каталога — имя конструкции
  construction_id int references public.constructions (id) on delete set null,
  content text not null,
  embedding extensions.vector(1024) not null
);
create index chunks_book_idx on public.chunks (book_id);
create index chunks_construction_idx on public.chunks (construction_id);
create index chunks_embedding_idx on public.chunks using hnsw (embedding extensions.vector_cosine_ops);
create index chunks_content_trgm_idx on public.chunks using gin (content extensions.gin_trgm_ops);

-- Треды и посты ------------------------------------------------------------

create table public.threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  title text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index threads_user_updated_idx on public.threads (user_id, updated_at desc);

-- Ответ: серия постов бота на вопрос или уточнение.
create table public.answers (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.threads (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  model text not null,
  general_knowledge boolean not null default false,
  off_topic boolean not null default false,
  created_at timestamptz not null default now()
);
create index answers_thread_idx on public.answers (thread_id);
create index answers_user_idx on public.answers (user_id);

create table public.posts (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  thread_id uuid not null references public.threads (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  author text not null check (author in ('student', 'bot')),
  answer_id uuid references public.answers (id) on delete cascade,
  quote_post_id uuid references public.posts (id) on delete set null,
  body text not null check (length(body) between 1 and 8000),
  -- Нажимаемые слова: [{"s": начало, "e": конец, "l": "먹다"}]; null — разбор ещё не сделан.
  words jsonb,
  embedding extensions.vector(1024),
  created_at timestamptz not null default now()
);
create index posts_thread_seq_idx on public.posts (thread_id, seq);
create index posts_user_idx on public.posts (user_id);
create index posts_answer_idx on public.posts (answer_id);
create index posts_quote_idx on public.posts (quote_post_id);
create index posts_body_trgm_idx on public.posts using gin (body extensions.gin_trgm_ops);
create index posts_embedding_idx on public.posts using hnsw (embedding extensions.vector_cosine_ops);

-- Источники ответа. Цитата копируется, чтобы переиндексация учебников не ломала старые треды.
create table public.answer_sources (
  answer_id uuid not null references public.answers (id) on delete cascade,
  position int not null,
  user_id uuid not null references public.profiles (id) on delete cascade,
  title text not null,
  page int,
  label text,
  quote text not null,
  primary key (answer_id, position)
);
create index answer_sources_user_idx on public.answer_sources (user_id);

create table public.thread_tags (
  id bigint generated always as identity primary key,
  thread_id uuid not null references public.threads (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('construction', 'word')),
  value text not null,
  construction_id int references public.constructions (id) on delete set null,
  level public.level,
  unique (thread_id, kind, value)
);
create index thread_tags_user_value_idx on public.thread_tags (user_id, kind, value);
create index thread_tags_construction_idx on public.thread_tags (construction_id);

create table public.bookmarks (
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  post_id uuid not null references public.posts (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, post_id)
);
create index bookmarks_post_idx on public.bookmarks (post_id);

-- TOPIK и квизы --------------------------------------------------------------

create table public.exams (
  id int generated always as identity primary key,
  session int not null,              -- 64 для 64회
  level text not null check (level in ('I', 'II')),
  unique (session, level)
);

create table public.topik_tasks (
  id int generated always as identity primary key,
  exam_id int not null references public.exams (id) on delete cascade,
  section text not null check (section in ('reading', 'listening')),
  number int not null,
  instruction text not null,
  passage text,
  options text[] not null check (cardinality(options) = 4),
  answer smallint not null check (answer between 1 and 4),
  explanation text,
  script text,
  audio_path text,                   -- путь в бакете topik-audio
  unique (exam_id, section, number)
);

create table public.topik_task_constructions (
  task_id int not null references public.topik_tasks (id) on delete cascade,
  construction_id int not null references public.constructions (id) on delete cascade,
  form text,                         -- как конструкция выглядит в тексте, для выделения в скрипте
  primary key (task_id, construction_id)
);
create index topik_task_constructions_construction_idx on public.topik_task_constructions (construction_id);

create table public.quizzes (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null unique references public.threads (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index quizzes_user_idx on public.quizzes (user_id);

create table public.quiz_items (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references public.quizzes (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  batch int not null default 0,
  position int not null,
  kind text not null check (kind in ('reading', 'listening', 'generated', 'own_sentence')),
  topik_task_id int references public.topik_tasks (id) on delete set null,
  construction_id int references public.constructions (id) on delete set null,
  content jsonb not null,            -- то, что видит ученик до ответа
  solution jsonb,                    -- ответ, объяснение, скрипт: отдаётся только после попытки
  created_at timestamptz not null default now()
);
create index quiz_items_quiz_idx on public.quiz_items (quiz_id, batch, position);
create index quiz_items_user_idx on public.quiz_items (user_id);
create index quiz_items_task_idx on public.quiz_items (topik_task_id);
create index quiz_items_construction_idx on public.quiz_items (construction_id);

create table public.attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  quiz_item_id uuid not null references public.quiz_items (id) on delete cascade,
  choice smallint check (choice between 1 and 4),
  sentence text,
  correct boolean,
  feedback text,
  created_at timestamptz not null default now()
);
create index attempts_user_idx on public.attempts (user_id);
create index attempts_item_idx on public.attempts (quiz_item_id);

-- Служебное -------------------------------------------------------------------

create table public.dict_cache (
  key text primary key,
  data jsonb not null,
  fetched_at timestamptz not null default now()
);

-- Расход отдельно от тредов: удалённый тред не стирает статистику админа.
create table public.usage (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  model text not null,
  kind text not null check (kind in ('answer', 'quiz', 'check')),
  cost numeric(12, 6) not null default 0,
  input_tokens int,
  output_tokens int,
  created_at timestamptz not null default now()
);
create index usage_user_created_idx on public.usage (user_id, created_at);

-- Доступ --------------------------------------------------------------------------

alter table public.access_list enable row level security;
alter table public.models enable row level security;
alter table public.app_settings enable row level security;
alter table public.profiles enable row level security;
alter table public.constructions enable row level security;
alter table public.books enable row level security;
alter table public.chunks enable row level security;
alter table public.threads enable row level security;
alter table public.answers enable row level security;
alter table public.posts enable row level security;
alter table public.answer_sources enable row level security;
alter table public.thread_tags enable row level security;
alter table public.bookmarks enable row level security;
alter table public.exams enable row level security;
alter table public.topik_tasks enable row level security;
alter table public.topik_task_constructions enable row level security;
alter table public.quizzes enable row level security;
alter table public.quiz_items enable row level security;
alter table public.attempts enable row level security;
alter table public.dict_cache enable row level security;
alter table public.usage enable row level security;

-- Явные гранты: не зависим от того, открывает ли проект новые таблицы Data API сам.
revoke all on all tables in schema public from anon, authenticated;
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

grant select on public.models, public.app_settings, public.constructions, public.books to authenticated;
create policy "enabled models are visible" on public.models
  for select to authenticated using (enabled);
create policy "settings are visible" on public.app_settings
  for select to authenticated using (true);
create policy "catalog is visible" on public.constructions
  for select to authenticated using (true);
create policy "book titles are visible" on public.books
  for select to authenticated using (true);

grant select on public.profiles to authenticated;
grant update (level, model) on public.profiles to authenticated;
create policy "own profile" on public.profiles
  for select to authenticated using ((select auth.uid()) = id);
create policy "own profile update" on public.profiles
  for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

grant select, delete on public.threads to authenticated;
create policy "own threads" on public.threads
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "own threads delete" on public.threads
  for delete to authenticated using ((select auth.uid()) = user_id);

grant select on public.answers, public.posts, public.answer_sources, public.thread_tags to authenticated;
create policy "own answers" on public.answers
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "own posts" on public.posts
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "own sources" on public.answer_sources
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "own tags" on public.thread_tags
  for select to authenticated using ((select auth.uid()) = user_id);

grant select, insert, delete on public.bookmarks to authenticated;
create policy "own bookmarks" on public.bookmarks
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "bookmark own posts" on public.bookmarks
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.posts p where p.id = post_id and p.user_id = (select auth.uid()))
  );
create policy "remove own bookmarks" on public.bookmarks
  for delete to authenticated using ((select auth.uid()) = user_id);

-- Решения заданий ученик не читает напрямую: колонка solution закрыта.
grant select on public.quizzes, public.attempts to authenticated;
grant select (id, quiz_id, user_id, batch, position, kind, construction_id, content, created_at)
  on public.quiz_items to authenticated;
create policy "own quizzes" on public.quizzes
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "own quiz items" on public.quiz_items
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "own attempts" on public.attempts
  for select to authenticated using ((select auth.uid()) = user_id);

-- access_list, chunks, exams, topik_tasks, topik_task_constructions, dict_cache, usage:
-- без грантов и политик, только service role.

-- Поиск -------------------------------------------------------------------------

-- Фрагменты учебников для ответа: ближайшие по смыслу плюс те, где прямо встречаются
-- ключевые слова вопроса (например, сама конструкция «더라고요»; такие помечены lexical).
-- Вызывает только сервер.
create function public.match_chunks(
  query_embedding extensions.vector(1024),
  keywords text[] default '{}',
  match_count int default 8
)
returns table (
  id bigint, title text, page int, label text, content text,
  similarity double precision, lexical boolean
)
language sql
stable
set search_path = ''
as $$
  with semantic as (
    select c.id, c.embedding operator(extensions.<=>) query_embedding as distance, false as lexical
    from public.chunks c
    order by c.embedding operator(extensions.<=>) query_embedding
    limit match_count
  ),
  lexical as (
    select c.id, c.embedding operator(extensions.<=>) query_embedding as distance, true as lexical
    from public.chunks c
    where exists (select 1 from unnest(keywords) k where length(k) >= 2 and c.content like '%' || k || '%')
    order by c.embedding operator(extensions.<=>) query_embedding
    limit match_count
  ),
  merged as (
    select u.id, min(u.distance) as distance, bool_or(u.lexical) as lexical
    from (select * from semantic union all select * from lexical) u
    group by u.id
  )
  select c.id, b.title, c.page, c.label, c.content, 1 - m.distance, m.lexical
  from merged m
  join public.chunks c on c.id = m.id
  join public.books b on b.id = c.book_id
  order by m.distance;
$$;
revoke execute on function public.match_chunks(extensions.vector, text[], int) from public, anon, authenticated;

-- Поиск по своим тредам: точное вхождение (-더라고요) и по смыслу. RLS работает как обычно.
create function public.search_posts(
  query text,
  query_embedding extensions.vector(1024) default null,
  match_count int default 30
)
returns table (
  post_id uuid, thread_id uuid, thread_title text, body text, author text,
  created_at timestamptz, exact boolean, similarity double precision
)
language sql
stable
security invoker
set search_path = ''
as $$
  with exact as (
    select p.id, true as exact, 1.0::double precision as similarity
    from public.posts p
    where p.user_id = (select auth.uid())
      and length(query) > 0
      and strpos(lower(p.body), lower(query)) > 0
    order by p.created_at desc
    limit match_count
  ),
  semantic as (
    select p.id, false as exact,
      1 - (p.embedding operator(extensions.<=>) query_embedding) as similarity
    from public.posts p
    where query_embedding is not null
      and p.user_id = (select auth.uid())
      and p.embedding is not null
    order by p.embedding operator(extensions.<=>) query_embedding
    limit 10
  ),
  merged as (
    select u.id, bool_or(u.exact) as exact, max(u.similarity) as similarity
    from (select * from exact union all select * from semantic) u
    group by u.id
  )
  select p.id, p.thread_id, t.title, p.body, p.author, p.created_at, m.exact, m.similarity
  from merged m
  join public.posts p on p.id = m.id
  join public.threads t on t.id = p.thread_id
  order by m.exact desc, m.similarity desc
  limit match_count;
$$;
revoke execute on function public.search_posts(text, extensions.vector, int) from public, anon;
grant execute on function public.search_posts(text, extensions.vector, int) to authenticated;

-- Аудио заданий на аудирование: приватный бакет, ученик получает подписанную ссылку от сервера.
insert into storage.buckets (id, name, public)
values ('topik-audio', 'topik-audio', false)
on conflict (id) do nothing;
