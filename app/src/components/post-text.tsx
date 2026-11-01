"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { WordSpan } from "@/lib/types";
import { useWordCard } from "./word-card";

// Разбор слов, который не удался при сохранении, повторяем один раз за показ страницы.
const retried = new Set<string>();

// Текст поста: корейские слова нажимаются и открывают карточку слова, **так** — жирный.
export function PostText({ postId, body, words }: { postId?: string; body: string; words: WordSpan[] | null }) {
  const openWord = useWordCard();
  const [fetched, setFetched] = useState<WordSpan[] | null>(null);
  const spans = words ?? fetched;

  useEffect(() => {
    if (spans || !postId || retried.has(postId) || !/[가-힣]/.test(body)) return;
    retried.add(postId);
    fetch(`/api/posts/${postId}/words`, { method: "POST" })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => json?.words && setFetched(json.words))
      .catch(() => {});
  }, [spans, postId, body]);

  const out: ReactNode[] = [];
  let bold = false;
  let cursor = 0;

  const plain = (text: string) => {
    text.split("**").forEach((part, i) => {
      if (i > 0) bold = !bold;
      if (part) out.push(bold ? <strong key={out.length}>{part}</strong> : part);
    });
  };

  for (const span of [...(spans ?? [])].sort((a, b) => a.s - b.s)) {
    if (span.s < cursor || span.e > body.length) continue;
    plain(body.slice(cursor, span.s));
    const text = body.slice(span.s, span.e);
    out.push(
      <button
        key={out.length}
        type="button"
        onClick={() => openWord(span.l)}
        className={`rounded-sm decoration-accent/40 underline-offset-4 hover:bg-accent-soft hover:underline ${bold ? "font-bold" : ""}`}
      >
        {text}
      </button>,
    );
    cursor = span.e;
  }
  plain(body.slice(cursor));

  return <div className="whitespace-pre-wrap break-words leading-relaxed">{out}</div>;
}
