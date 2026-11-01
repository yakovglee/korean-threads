"use client";

import { useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { AnswerEvent, PostView, QuizItemView, SourceView } from "@/lib/types";
import { Composer } from "./composer";
import { PostCard, TypingIndicator } from "./post-card";
import { Quiz } from "./quiz";
import { Sources } from "./sources";

async function* readEvents(res: Response): AsyncGenerator<AnswerEvent> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) yield JSON.parse(line) as AnswerEvent;
  }
}

export function ThreadView({
  threadId,
  posts,
  sources,
  bookmarked,
  quiz,
  autoAsk,
}: {
  threadId: string;
  posts: PostView[];
  sources: SourceView[];
  bookmarked: string[];
  quiz: QuizItemView[] | null;
  autoAsk: boolean;
}) {
  const router = useRouter();
  const [streamed, setStreamed] = useState<PostView[]>([]);
  const [busy, setBusy] = useState(false);
  const [typing, setTyping] = useState(false);
  const [quizLoading, setQuizLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quote, setQuote] = useState<PostView | null>(null);
  const started = useRef(false);
  const answeredBefore = useRef(false);
  const bottom = useRef<HTMLDivElement>(null);

  const known = new Set(posts.map((p) => p.id));
  const all = [...posts, ...streamed.filter((p) => !known.has(p.id))];
  const last = all.at(-1);
  const unanswered = last?.author === "student";
  useEffect(() => {
    answeredBefore.current = all.some((p) => p.author === "bot");
  });

  const ask = useCallback(
    async (text?: string, quoteId?: string) => {
      const firstAnswer = !answeredBefore.current;
      setBusy(true);
      setError(null);
      setTyping(!text);
      try {
        const res = await fetch(`/api/threads/${threadId}/answer`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, quoteId }),
        });
        if (!res.ok || !res.body) throw new Error((await res.json().catch(() => null))?.error ?? "Ошибка сервера");
        for await (const event of readEvents(res)) {
          if (event.type === "typing") setTyping(true);
          if (event.type === "post") {
            setTyping(false);
            setStreamed((prev) => [...prev, event.post]);
          }
          if (event.type === "done") {
            setTyping(false);
            setQuizLoading(firstAnswer);
            router.refresh();
          }
          if (event.type === "quiz") router.refresh();
          if (event.type === "error") {
            setError(event.message);
            setStreamed((prev) => prev.filter((p) => p.author === "student"));
            router.refresh();
          }
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Нет связи");
      } finally {
        setBusy(false);
        setTyping(false);
        setQuizLoading(false);
      }
    },
    [threadId, router],
  );

  // Новый тред: вопрос уже сохранён, сразу просим ответ. Параметр ?new=1 убираем без перезагрузки.
  useEffect(() => {
    if (!autoAsk || started.current) return;
    started.current = true;
    window.history.replaceState(null, "", `/t/${threadId}`);
    if (unanswered) void Promise.resolve().then(() => ask());
  }, [autoAsk, unanswered, ask, threadId]);

  useEffect(() => {
    if (busy) bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [streamed.length, typing, busy]);

  const byId = new Map(all.map((p) => [p.id, p]));
  const firstAnswerId = all.find((p) => p.author === "bot")?.answerId ?? null;

  return (
    <div>
      {all.map((post, i) => {
        const next = all[i + 1];
        const endsAnswer = post.author === "bot" && next?.answerId !== post.answerId;
        const answerSources = endsAnswer ? sources.filter((s) => s.answerId === post.answerId) : [];
        return (
          <Fragment key={post.id}>
            <PostCard
              post={post}
              quoted={post.quotePostId ? byId.get(post.quotePostId) : null}
              bookmarked={bookmarked.includes(post.id)}
              connector={i < all.length - 1 || typing}
              onQuote={setQuote}
            />
            {endsAnswer && <Sources sources={answerSources} />}
            {endsAnswer && post.answerId === firstAnswerId && (quiz || quizLoading) && (
              <Quiz threadId={threadId} items={quiz ?? []} loading={quizLoading && !quiz?.length} />
            )}
          </Fragment>
        );
      })}

      {typing && <TypingIndicator />}

      {error && (
        <div className="my-4 rounded-2xl bg-bad-soft px-4 py-3 text-sm text-bad">
          {error}
          {unanswered && !busy && (
            <button type="button" onClick={() => ask()} className="ml-3 font-medium underline">
              Повторить
            </button>
          )}
        </div>
      )}

      {unanswered && !busy && !error && (
        <button type="button" onClick={() => ask()} className="my-4 rounded-full bg-surface px-4 py-2 text-sm">
          Получить ответ
        </button>
      )}

      <div ref={bottom} className="mt-6">
        <Composer
          placeholder="Уточнить…"
          disabled={busy || unanswered}
          quote={quote}
          onClearQuote={() => setQuote(null)}
          onSend={(text) => {
            const q = quote?.id;
            setQuote(null);
            ask(text, q);
          }}
        />
      </div>
    </div>
  );
}
