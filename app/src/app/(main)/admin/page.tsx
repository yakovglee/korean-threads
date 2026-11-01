import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { addAccess, addModel, removeAccess, removeModel, setDefaultModel, toggleModel } from "./actions";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });

function monthBounds(month: string) {
  const [y, m] = month.split("-").map(Number);
  return { from: new Date(Date.UTC(y, m - 1, 1)).toISOString(), to: new Date(Date.UTC(y, m, 1)).toISOString() };
}

function shiftMonth(month: string, delta: number) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default async function AdminPage({ searchParams }: PageProps<"/admin">) {
  const me = await requireAdmin();
  const params = await searchParams;
  const now = new Date();
  const current = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const month = typeof params.month === "string" && /^\d{4}-\d{2}$/.test(params.month) ? params.month : current;
  const { from, to } = monthBounds(month);

  const db = createAdminClient();
  const [{ data: access }, { data: models }, { data: settings }, { data: usage }, { data: profiles }] = await Promise.all([
    db.from("access_list").select("email, is_admin, added_at").order("added_at"),
    db.from("models").select("id, label, enabled, position").order("position"),
    db.from("app_settings").select("default_model").maybeSingle(),
    db.from("usage").select("user_id, model, kind, cost").gte("created_at", from).lt("created_at", to),
    db.from("profiles").select("id, email"),
  ]);

  const emailOf = new Map((profiles ?? []).map((p) => [p.id, p.email]));
  type Row = { email: string; model: string; answers: number; cost: number };
  const rows = new Map<string, Row>();
  for (const u of usage ?? []) {
    const key = `${u.user_id}|${u.model}`;
    const row = rows.get(key) ?? { email: emailOf.get(u.user_id) ?? u.user_id, model: u.model, answers: 0, cost: 0 };
    if (u.kind === "answer") row.answers += 1;
    row.cost += Number(u.cost);
    rows.set(key, row);
  }
  const table = [...rows.values()].sort((a, b) => a.email.localeCompare(b.email) || b.cost - a.cost);
  const total = table.reduce((s, r) => s + r.cost, 0);

  return (
    <div className="space-y-10">
      <h1 className="text-xl font-bold">Админка</h1>

      <section className="space-y-3">
        <h2 className="font-semibold">Список доступа</h2>
        <ul className="divide-y divide-line rounded-2xl border border-line">
          {(access ?? []).map((a) => (
            <li key={a.email} className="flex items-center gap-3 px-4 py-2.5">
              <span className="min-w-0 flex-1 truncate">{a.email}</span>
              {a.is_admin && <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs text-accent">админ</span>}
              {a.email !== me.email && (
                <form action={removeAccess}>
                  <input type="hidden" name="email" value={a.email} />
                  <button className="text-sm text-muted hover:text-bad">Убрать</button>
                </form>
              )}
            </li>
          ))}
        </ul>
        <form action={addAccess} className="flex flex-wrap items-center gap-2">
          <input
            name="email"
            type="email"
            required
            placeholder="friend@example.com"
            className="min-w-0 flex-1 rounded-xl border border-line bg-background px-3 py-2"
          />
          <label className="flex items-center gap-1.5 text-sm text-muted">
            <input type="checkbox" name="is_admin" /> админ
          </label>
          <button className="rounded-xl bg-foreground px-4 py-2 text-sm font-medium text-background">Добавить</button>
        </form>
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold">Модели</h2>
        <ul className="divide-y divide-line rounded-2xl border border-line">
          {(models ?? []).map((m) => {
            const isDefault = settings?.default_model === m.id;
            return (
              <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className={m.enabled ? "" : "text-muted line-through"}>{m.label}</span>
                  <span className="block truncate text-xs text-muted">{m.id}</span>
                </span>
                {isDefault ? (
                  <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs text-accent">по умолчанию</span>
                ) : (
                  m.enabled && (
                    <form action={setDefaultModel}>
                      <input type="hidden" name="id" value={m.id} />
                      <button className="text-sm text-muted hover:text-foreground">По умолчанию</button>
                    </form>
                  )
                )}
                {!isDefault && (
                  <form action={toggleModel}>
                    <input type="hidden" name="id" value={m.id} />
                    <input type="hidden" name="enabled" value={String(!m.enabled)} />
                    <button className="text-sm text-muted hover:text-foreground">{m.enabled ? "Выключить" : "Включить"}</button>
                  </form>
                )}
                {!isDefault && (
                  <form action={removeModel}>
                    <input type="hidden" name="id" value={m.id} />
                    <button className="text-sm text-muted hover:text-bad">Удалить</button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
        <form action={addModel} className="flex flex-wrap gap-2">
          <input
            name="id"
            required
            placeholder="anthropic/claude-sonnet-5.5"
            className="min-w-0 flex-1 rounded-xl border border-line bg-background px-3 py-2"
          />
          <input
            name="label"
            required
            placeholder="Название"
            className="w-40 rounded-xl border border-line bg-background px-3 py-2"
          />
          <button className="rounded-xl bg-foreground px-4 py-2 text-sm font-medium text-background">Добавить</button>
        </form>
        <p className="text-xs text-muted">Идентификатор — как на openrouter.ai/models.</p>
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-3">
          <h2 className="mr-auto font-semibold">Расход</h2>
          <Link href={`/admin?month=${shiftMonth(month, -1)}`} className="text-muted hover:text-foreground" aria-label="Предыдущий месяц">
            ←
          </Link>
          <span className="tabular-nums">{month}</span>
          <Link href={`/admin?month=${shiftMonth(month, 1)}`} className="text-muted hover:text-foreground" aria-label="Следующий месяц">
            →
          </Link>
        </div>
        {table.length === 0 ? (
          <p className="text-sm text-muted">В этом месяце расхода нет.</p>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-line">
            <table className="w-full text-sm">
              <thead className="text-left text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Ученик</th>
                  <th className="px-4 py-2 font-medium">Модель</th>
                  <th className="px-4 py-2 text-right font-medium">Ответов</th>
                  <th className="px-4 py-2 text-right font-medium">Стоимость</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {table.map((r) => (
                  <tr key={`${r.email}|${r.model}`}>
                    <td className="px-4 py-2">{r.email}</td>
                    <td className="px-4 py-2 text-muted">{r.model}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.answers}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{usd.format(r.cost)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-line font-medium">
                  <td className="px-4 py-2" colSpan={3}>
                    Всего
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{usd.format(total)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        <p className="text-xs text-muted">Стоимость каждого ответа, задания и проверки сообщает OpenRouter.</p>
      </section>
    </div>
  );
}
