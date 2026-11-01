"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import type { AttemptResult, QuizItemView } from "@/lib/types";

const MARKS = ["①", "②", "③", "④"];

// Текст задания: ( ) — пропуск, <u>…</u> — подчёркнутая часть, как в бланке TOPIK.
function TaskText({ text }: { text: string }) {
  return (
    <p className="whitespace-pre-wrap leading-relaxed">
      {text.split(/(<u>[\s\S]*?<\/u>)/g).map((part, i) =>
        part.startsWith("<u>") ? (
          <u key={i} className="underline-offset-4">
            {part.slice(3, -4)}
          </u>
        ) : (
          part
        ),
      )}
    </p>
  );
}

// Скрипт аудирования с выделенной конструкцией.
function Script({ script, form }: { script: string; form?: string | null }) {
  const parts: ReactNode[] = form ? [] : [script];
  if (form) {
    script.split(form).forEach((chunk, i) => {
      if (i > 0) parts.push(<mark key={i} className="rounded bg-accent-soft px-0.5 text-accent">{form}</mark>);
      parts.push(chunk);
    });
  }
  return (
    <div className="mt-3 rounded-xl bg-background px-3 py-2 text-sm">
      <p className="mb-1 font-medium">Скрипт</p>
      <p className="whitespace-pre-wrap leading-relaxed">{parts}</p>
    </div>
  );
}

function ChoiceTask({ item, attempt, onAttempt }: { item: QuizItemView; attempt: AttemptResult | null; onAttempt: (a: AttemptResult) => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async (choice: number) => {
    if (attempt || pending) return;
    setPending(true);
    setError(null);
    const res = await fetch(`/api/quiz/items/${item.id}/attempt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice }),
    }).catch(() => null);
    setPending(false);
    if (res?.ok) onAttempt(await res.json());
    else setError("Не получилось проверить, попробуй ещё раз");
  };

  const answer = attempt?.solution?.answer;

  return (
    <>
      {item.kind === "listening" && (
        <audio controls preload="none" src={`/api/quiz/items/${item.id}/audio`} className="mt-3 w-full" />
      )}
      <div className="mt-3 grid gap-2">
        {item.content.options?.map((option, i) => {
          const n = i + 1;
          const state = !attempt ? "idle" : n === answer ? "right" : n === attempt.choice ? "wrong" : "idle";
          return (
            <button
              key={n}
              type="button"
              disabled={!!attempt || pending}
              onClick={() => choose(n)}
              className={`flex gap-2 rounded-xl border px-3 py-2 text-left transition ${
                state === "right"
                  ? "border-good bg-good-soft"
                  : state === "wrong"
                    ? "border-bad bg-bad-soft"
                    : "border-line bg-background enabled:hover:border-accent"
              }`}
            >
              <span>{MARKS[i]}</span>
              <span>{option}</span>
            </button>
          );
        })}
      </div>
      {error && <p className="mt-2 text-sm text-bad">{error}</p>}
      {attempt && (
        <div className="mt-3 text-sm">
          <p className={attempt.correct ? "font-medium text-good" : "font-medium text-bad"}>
            {attempt.correct ? "Верно! 🎉" : `Неверно: правильный ответ ${MARKS[(answer ?? 1) - 1]}`}
          </p>
          {attempt.solution?.explanation && <p className="mt-1">{attempt.solution.explanation}</p>}
          {attempt.solution?.script && <Script script={attempt.solution.script} form={attempt.solution.form} />}
        </div>
      )}
    </>
  );
}

function SentenceTask({ item, attempt, onAttempt }: { item: QuizItemView; attempt: AttemptResult | null; onAttempt: (a: AttemptResult) => void }) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = async () => {
    if (!text.trim() || pending) return;
    setPending(true);
    setError(null);
    const res = await fetch(`/api/quiz/items/${item.id}/attempt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sentence: text.trim() }),
    }).catch(() => null);
    setPending(false);
    if (res?.ok) {
      onAttempt(await res.json());
      setText("");
    } else setError("Не получилось проверить, попробуй ещё раз");
  };

  return (
    <div className="mt-3">
      {attempt?.sentence && (
        <div className="mb-3 text-sm">
          <p className="rounded-xl bg-background px-3 py-2">{attempt.sentence}</p>
          <p className={`mt-2 ${attempt.correct ? "text-good" : "text-bad"}`}>{attempt.correct ? "Всё верно 👍" : "Есть что поправить"}</p>
          {attempt.feedback && <p className="mt-1 whitespace-pre-wrap">{attempt.feedback}</p>}
        </div>
      )}
      <div className="flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && check()}
          maxLength={500}
          placeholder={attempt ? "Попробовать ещё" : "Твоё предложение по-корейски"}
          className="min-w-0 flex-1 rounded-xl border border-line bg-background px-3 py-2 outline-none focus:border-accent"
        />
        <button
          type="button"
          onClick={check}
          disabled={pending || !text.trim()}
          className="rounded-xl bg-foreground px-3 py-2 text-sm font-medium text-background disabled:opacity-40"
        >
          {pending ? "…" : "Проверить"}
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-bad">{error}</p>}
    </div>
  );
}

// Квиз в конце первого ответа: задания TOPIK, сгенерированные задания и «своё предложение».
export function Quiz({ threadId, items, loading }: { threadId: string; items: QuizItemView[]; loading: boolean }) {
  const router = useRouter();
  const [attempts, setAttempts] = useState<Record<string, AttemptResult>>({});
  const [more, setMore] = useState<"idle" | "pending" | "empty" | "error">("idle");

  const loadMore = async () => {
    setMore("pending");
    const res = await fetch(`/api/quiz/${threadId}/more`, { method: "POST" }).catch(() => null);
    if (!res?.ok) return setMore("error");
    const { added } = await res.json();
    setMore(added ? "idle" : "empty");
    router.refresh();
  };

  return (
    <section className="mb-6 ml-12 rounded-2xl border border-line p-4">
      <p className="font-semibold">🧩 Проверь себя</p>
      {loading && <p className="mt-2 text-sm text-muted">Подбираю задания…</p>}
      <ol className="mt-3 space-y-5">
        {items.map((item) => {
          const attempt = attempts[item.id] ?? item.attempt;
          const onAttempt = (a: AttemptResult) => setAttempts((prev) => ({ ...prev, [item.id]: a }));
          return (
            <li key={item.id} className="rounded-xl bg-surface p-4">
              <p className="text-xs text-muted">
                {item.content.source}
                {item.content.construction ? ` · ${item.content.construction}` : ""}
              </p>
              <div className="mt-2 font-medium">
                <TaskText text={item.content.instruction} />
              </div>
              {item.content.passage && (
                <div className="mt-2 rounded-xl bg-background px-3 py-2">
                  <TaskText text={item.content.passage} />
                </div>
              )}
              {item.kind === "own_sentence" ? (
                <SentenceTask item={item} attempt={attempt} onAttempt={onAttempt} />
              ) : (
                <ChoiceTask item={item} attempt={attempt} onAttempt={onAttempt} />
              )}
            </li>
          );
        })}
      </ol>
      {items.length > 0 && (
        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={loadMore}
            disabled={more === "pending"}
            className="rounded-full bg-surface px-4 py-2 text-sm disabled:opacity-50"
          >
            {more === "pending" ? "Подбираю…" : "Ещё вопросы"}
          </button>
          {more === "empty" && <span className="text-sm text-muted">Новых заданий не нашлось</span>}
          {more === "error" && <span className="text-sm text-bad">Не получилось, попробуй ещё раз</span>}
        </div>
      )}
    </section>
  );
}
