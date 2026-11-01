import { LoginForm } from "./login-form";

const ERRORS: Record<string, string> = {
  link: "Ссылка устарела или уже использована. Запроси новую.",
  denied: "Этого адреса больше нет в списке доступа.",
};

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { error } = await searchParams;
  const message = typeof error === "string" ? ERRORS[error] : undefined;

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-8 px-6 py-16">
      <div className="space-y-2">
        <p className="text-4xl font-bold tracking-tight">문법</p>
        <h1 className="text-xl font-semibold">Грамматика корейского короткими постами</h1>
        <p className="text-muted">Спроси что угодно про корейский — ответ придёт тредом, с опорой на твои учебники.</p>
      </div>
      {message && <p className="rounded-xl bg-bad-soft px-4 py-3 text-sm text-bad">{message}</p>}
      <LoginForm />
    </main>
  );
}
