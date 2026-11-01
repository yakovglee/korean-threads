"use client";

import { useState, useTransition } from "react";
import { setBookmark } from "@/app/actions";
import type { PostView } from "@/lib/types";
import { PostText } from "./post-text";

export const BOT_NAME = "문법 · Грамматика";

export function Avatar({ author }: { author: PostView["author"] }) {
  return author === "bot" ? (
    <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground text-sm font-bold text-background">
      문
    </div>
  ) : (
    <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm font-semibold text-accent">
      Ты
    </div>
  );
}

function BookmarkIcon({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="size-[18px]" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8">
      <path d="M6 3.5h12v17l-6-4.2-6 4.2z" strokeLinejoin="round" />
    </svg>
  );
}

export function PostCard({
  post,
  quoted,
  bookmarked,
  connector = false,
  onQuote,
}: {
  post: PostView;
  quoted?: PostView | null;
  bookmarked: boolean;
  connector?: boolean;
  onQuote?: (post: PostView) => void;
}) {
  const [saved, setSaved] = useState(bookmarked);
  const [, startTransition] = useTransition();

  const toggle = () => {
    const next = !saved;
    setSaved(next);
    startTransition(() => setBookmark(post.id, next));
  };

  return (
    <article className="post-in flex gap-3">
      <div className="flex flex-col items-center">
        <Avatar author={post.author} />
        {connector && <div className="mt-1 w-0.5 flex-1 rounded-full bg-line" />}
      </div>
      <div className="min-w-0 flex-1 pb-5">
        <p className="text-sm font-semibold">{post.author === "bot" ? BOT_NAME : "Ты"}</p>
        {quoted && (
          <blockquote className="mt-2 line-clamp-3 rounded-xl border border-line px-3 py-2 text-sm text-muted">
            {quoted.body.replaceAll("**", "")}
          </blockquote>
        )}
        <div className="mt-1">
          <PostText postId={post.id} body={post.body} words={post.words} />
        </div>
        <div className="mt-2 flex gap-4 text-muted">
          {onQuote && (
            <button type="button" onClick={() => onQuote(post)} className="text-sm hover:text-foreground">
              Цитировать
            </button>
          )}
          <button
            type="button"
            onClick={toggle}
            aria-pressed={saved}
            aria-label={saved ? "Убрать из закладок" : "В закладки"}
            className={saved ? "text-accent" : "hover:text-foreground"}
          >
            <BookmarkIcon filled={saved} />
          </button>
        </div>
      </div>
    </article>
  );
}

export function TypingIndicator() {
  return (
    <div className="flex gap-3" aria-label="Бот печатает">
      <Avatar author="bot" />
      <div className="flex items-center gap-1 pt-3">
        {[0, 1, 2].map((i) => (
          <span key={i} className="typing-dot size-2 rounded-full bg-muted" style={{ animationDelay: `${i * 0.15}s` }} />
        ))}
      </div>
    </div>
  );
}
