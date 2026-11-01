import { redirect } from "next/navigation";
import { chooseLevel } from "@/app/actions";
import { requireStudent } from "@/lib/auth";
import { LEVEL_INFO } from "@/components/level-info";
import { LEVELS } from "@/lib/types";

export default async function WelcomePage() {
  const student = await requireStudent();
  if (student.level) redirect("/");

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 px-6 py-16">
      <div className="space-y-2">
        <h1 className="text-2xl font-bold">Привет! 👋</h1>
        <p className="text-muted">
          Какой у тебя уровень? От него зависит глубина объяснений и сложность примеров. Поменять можно в профиле.
        </p>
      </div>
      <form action={chooseLevel} className="space-y-3">
        {LEVELS.map((level) => (
          <button
            key={level}
            name="level"
            value={level}
            className="block w-full rounded-2xl border border-line px-5 py-4 text-left hover:border-accent hover:bg-accent-soft"
          >
            <span className="text-lg font-semibold">{level}</span>
            <span className="ml-2 text-muted">{LEVEL_INFO[level].title}</span>
            <span className="mt-1 block text-sm text-muted">{LEVEL_INFO[level].hint}</span>
          </button>
        ))}
      </form>
    </main>
  );
}
