-- 0001: схема Korean Threads (Postgres / Supabase).
-- Таблицы учёта миграций нет, поэтому каждый оператор идемпотентен (IF NOT EXISTS, повторный enable RLS безвреден).
-- Внешние ключи не добавляем. Политик RLS нет: все таблицы закрыты для anon и authenticated.

create extension if not exists vector;
create extension if not exists pg_trgm;

-- Словарь: v:<номер> и g:<номер> по общему списку.
create table if not exists items (
  id text primary key,
  kind text not null check (kind in ('vocab', 'grammar')),
  level smallint not null check (level between 1 and 6),
  headword text not null,
  homograph smallint not null default 0,
  pos text not null default '',
  hint text not null default '',
  related text not null default '',
  seq integer not null default 0
);

create table if not exists item_notes (
  item_id text primary key,
  gloss_ru text,
  explanation_ru text,
  examples_json jsonb,
  source text,
  krdict_code text,
  sources_json jsonb
);

create table if not exists lemma_cache (
  lemma text,
  pos text,
  gloss_ru text,
  source text,
  primary key (lemma, pos)
);

-- Память (только для 1–4급). Время в миллисекундах.
create table if not exists item_state (
  item_id text primary key,
  stability_days double precision not null default 0,
  last_event_at bigint,
  is_new boolean not null default true,
  tap_count integer not null default 0,
  introduced_day text
);

-- Журнал событий. at — миллисекунды (bigint), id — bigserial.
create table if not exists events (
  id bigserial primary key,
  at bigint not null,
  item_id text,
  type text not null,
  post_id text,
  check_id text
);
create index if not exists events_item_at_idx on events (item_id, at);

create table if not exists threads (
  id text primary key,
  origin text not null,
  created_at bigint not null
);

create table if not exists posts (
  id text primary key,
  thread_id text not null,
  position integer not null default 0,
  body_json jsonb not null,
  stretch_item_id text,
  sources_json jsonb,
  last_delivered_at bigint
);
create index if not exists posts_thread_position_idx on posts (thread_id, position);

create table if not exists post_items (
  post_id text,
  item_id text,
  primary key (post_id, item_id)
);
create index if not exists post_items_item_idx on post_items (item_id);

create table if not exists checks (
  id text primary key,
  source text not null,
  body_json jsonb not null,
  created_at bigint not null,
  last_answered_at bigint
);

create table if not exists check_items (
  check_id text,
  item_id text,
  primary key (check_id, item_id)
);
create index if not exists check_items_item_idx on check_items (item_id);

-- База знаний: в облако идут только чанки и векторы.
create table if not exists kb_docs (
  id text primary key,
  path text not null,
  kind text,
  sha1 text,
  pages integer,
  ocr_pages integer
);

create table if not exists kb_chunks (
  id bigserial primary key,
  doc_id text not null,
  kind text,
  page integer,
  ref text,
  text text not null,
  vec vector(1024)
);
create index if not exists kb_chunks_text_trgm_idx on kb_chunks using gin (text gin_trgm_ops);

-- Служебные таблицы.
create table if not exists rate_limits (
  key text,
  window_start bigint,
  count integer not null default 0,
  primary key (key, window_start)
);

create table if not exists chat_lock (
  id text primary key,
  until bigint not null
);

create table if not exists login_attempts (
  ip_hash text,
  window_start bigint,
  count integer not null default 0,
  primary key (ip_hash, window_start)
);

-- RLS на всех таблицах, политик нет.
alter table items enable row level security;
alter table item_notes enable row level security;
alter table lemma_cache enable row level security;
alter table item_state enable row level security;
alter table events enable row level security;
alter table threads enable row level security;
alter table posts enable row level security;
alter table post_items enable row level security;
alter table checks enable row level security;
alter table check_items enable row level security;
alter table kb_docs enable row level security;
alter table kb_chunks enable row level security;
alter table rate_limits enable row level security;
alter table chat_lock enable row level security;
alter table login_attempts enable row level security;
