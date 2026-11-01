import { updateProfile } from "@/app/actions";
import { LEVEL_INFO } from "@/components/level-info";
import { requireStudent } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { LEVELS } from "@/lib/types";

export default async function ProfilePage({ searchParams }: PageProps<"/profile">) {
  const student = await requireStudent();
  const { saved } = await searchParams;
  const supabase = await createClient();
  const { data: models } = await supabase.from("models").select("id, label").order("position");

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-bold">Профиль</h1>
        <p className="text-sm text-muted">{student.email}</p>
      </div>

      <form action={updateProfile} className="space-y-6">
        <fieldset className="space-y-2">
          <legend className="mb-2 font-medium">Уровень</legend>
          {LEVELS.map((level) => (
            <label key={level} className="flex cursor-pointer gap-3 rounded-2xl border border-line px-4 py-3 has-checked:border-accent has-checked:bg-accent-soft">
              <input type="radio" name="level" value={level} defaultChecked={student.level === level} className="mt-1" />
              <span>
                <span className="font-semibold">{level}</span> <span className="text-muted">{LEVEL_INFO[level].title}</span>
                <span className="block text-sm text-muted">{LEVEL_INFO[level].hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <label className="block space-y-2">
          <span className="font-medium">Модель</span>
          <select
            name="model"
            defaultValue={student.model}
            className="block w-full rounded-xl border border-line bg-background px-3 py-2.5"
          >
            {(models ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <span className="block text-sm text-muted">Модели разрешает админ.</span>
        </label>

        <div className="flex items-center gap-3">
          <button type="submit" className="rounded-xl bg-foreground px-5 py-2.5 font-medium text-background">
            Сохранить
          </button>
          {saved && <span className="text-sm text-good">Сохранено ✓</span>}
        </div>
      </form>

      <form action="/auth/signout" method="post">
        <button type="submit" className="text-sm text-muted hover:text-bad">
          Выйти
        </button>
      </form>
    </div>
  );
}
