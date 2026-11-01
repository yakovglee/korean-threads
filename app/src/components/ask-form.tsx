"use client";

import { useFormStatus } from "react-dom";
import { askQuestion } from "@/app/actions";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-full bg-foreground px-4 py-1.5 text-sm font-medium text-background disabled:opacity-40"
    >
      {pending ? "Отправляю…" : "Спросить"}
    </button>
  );
}

// Новый тред: вопрос сохраняется, и открывается тред, где бот сразу начинает отвечать.
export function AskForm() {
  return (
    <form action={askQuestion} className="rounded-2xl border border-line p-3 focus-within:border-accent">
      <textarea
        name="text"
        required
        rows={3}
        maxLength={4000}
        placeholder="Спроси про корейский: «чем -더라고요 отличается от -았어요?» или пришли предложение на проверку"
        className="block w-full resize-none bg-transparent outline-none placeholder:text-muted"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
        }}
      />
      <div className="mt-2 flex justify-end">
        <Submit />
      </div>
    </form>
  );
}
