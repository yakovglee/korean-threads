-- Локальная разработка: модели и админ. Письма со ссылкой для входа — в Mailpit (http://127.0.0.1:54324).
insert into public.models (id, label, position) values
  ('anthropic/claude-sonnet-5.5', 'Claude Sonnet 5.5', 0),
  ('anthropic/claude-opus-5.5', 'Claude Opus 5.5', 1),
  ('anthropic/claude-haiku-5.5', 'Claude Haiku 5.5', 2),
  ('google/gemini-3.5-flash', 'Gemini 3.5 Flash', 3)
on conflict (id) do nothing;

insert into public.app_settings (id, default_model) values (true, 'anthropic/claude-sonnet-5.5')
on conflict (id) do update set default_model = excluded.default_model;

insert into public.access_list (email, is_admin) values ('admin@example.com', true)
on conflict (email) do nothing;
