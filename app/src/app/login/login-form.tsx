"use client";

import { useActionState } from "react";
import { sendMagicLink, type LoginState } from "@/app/actions";

export function LoginForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(sendMagicLink, {});

  if (state.sent) {
    return (
      <div className="rounded-2xl bg-surface px-5 py-4">
        <p className="font-medium">Письмо отправлено 📬</p>
        <p className="mt-1 text-sm text-muted">
          Открой ссылку из письма на {state.sent} — в этом же браузере.
        </p>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-3">
      <label className="block text-sm font-medium" htmlFor="email">
        Почта
      </label>
      <input
        id="email"
        name="email"
        type="email"
        required
        autoComplete="email"
        placeholder="you@example.com"
        className="w-full rounded-xl border border-line bg-background px-4 py-3 outline-none focus:border-accent"
      />
      {state.error && <p className="text-sm text-bad">{state.error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-xl bg-foreground px-4 py-3 font-medium text-background disabled:opacity-50"
      >
        {pending ? "Отправляю…" : "Прислать ссылку для входа"}
      </button>
    </form>
  );
}
