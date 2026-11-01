"use client";

import { useRef, useState } from "react";
import type { PostView } from "@/lib/types";

export function Composer({
  placeholder,
  disabled,
  quote,
  onClearQuote,
  onSend,
}: {
  placeholder: string;
  disabled?: boolean;
  quote?: PostView | null;
  onClearQuote?: () => void;
  onSend: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  const send = () => {
    const value = text.trim();
    if (!value || disabled) return;
    onSend(value);
    setText("");
  };

  return (
    <div className="rounded-2xl border border-line bg-background p-3 focus-within:border-accent">
      {quote && (
        <div className="mb-2 flex items-start gap-2 rounded-xl bg-surface px-3 py-2 text-sm text-muted">
          <p className="line-clamp-2 flex-1">{quote.body.replaceAll("**", "")}</p>
          <button type="button" onClick={onClearQuote} aria-label="Убрать цитату">
            ✕
          </button>
        </div>
      )}
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          e.target.style.height = "auto";
          e.target.style.height = `${e.target.scrollHeight}px`;
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
        }}
        rows={2}
        maxLength={4000}
        placeholder={placeholder}
        className="block max-h-60 w-full resize-none bg-transparent outline-none placeholder:text-muted"
      />
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          onClick={send}
          disabled={disabled || !text.trim()}
          className="rounded-full bg-foreground px-4 py-1.5 text-sm font-medium text-background disabled:opacity-40"
        >
          Отправить
        </button>
      </div>
    </div>
  );
}
