"use client";

import { createContext, use, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { WordCard as Card } from "@/lib/types";

type State = { word: string; card: Card | null; error: string | null } | null;

const WordCardContext = createContext<(word: string) => void>(() => {});

export function useWordCard() {
  return use(WordCardContext);
}

// Карточка слова из 한국어기초사전: открывается нажатием на любое корейское слово в посте.
export function WordCardProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(null);
  const audio = useRef<HTMLAudioElement>(null);

  const open = useCallback((word: string) => {
    setState({ word, card: null, error: null });
    fetch(`/api/dict?w=${encodeURIComponent(word)}`)
      .then(async (res) => {
        const json = await res.json();
        setState((s) => (s?.word === word ? { word, card: res.ok ? json : null, error: res.ok ? null : json.error } : s));
      })
      .catch(() => setState((s) => (s?.word === word ? { word, card: null, error: "Нет связи со словарём" } : s)));
  }, []);

  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setState(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state]);

  const card = state?.card;

  return (
    <WordCardContext value={open}>
      {children}
      {state && (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true">
          <button aria-label="Закрыть" className="absolute inset-0 bg-black/30" onClick={() => setState(null)} />
          <div className="relative w-full max-w-md rounded-t-3xl bg-background p-6 shadow-xl sm:rounded-3xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-3xl font-bold">{card?.word ?? state.word}</p>
                {card?.pronunciation && <p className="mt-1 text-muted">[{card.pronunciation}]</p>}
              </div>
              <div className="flex items-center gap-2">
                {card?.audioUrl && (
                  <>
                    <audio ref={audio} src={card.audioUrl} preload="none" />
                    <button
                      onClick={() => audio.current?.play()}
                      className="rounded-full bg-surface px-3 py-2 text-sm"
                      aria-label="Послушать произношение"
                    >
                      ▶
                    </button>
                  </>
                )}
                <button onClick={() => setState(null)} className="rounded-full px-2 py-1 text-muted" aria-label="Закрыть">
                  ✕
                </button>
              </div>
            </div>

            {!card && !state.error && <p className="mt-4 text-muted">Ищу в словаре…</p>}
            {state.error && <p className="mt-4 text-muted">{state.error}</p>}

            {card && (
              <div className="mt-4 space-y-3">
                <div className="flex flex-wrap gap-2 text-xs">
                  {card.level && <span className="rounded-full bg-accent-soft px-2 py-1 text-accent">{card.level}</span>}
                  {card.pos && <span className="rounded-full bg-surface px-2 py-1 text-muted">{card.pos}</span>}
                </div>
                {card.translation && <p className="text-lg font-semibold">{card.translation}</p>}
                {card.definition && <p className="text-muted">{card.definition}</p>}
                {card.example && <p className="rounded-xl bg-surface px-4 py-3">{card.example}</p>}
                <p className="text-xs text-muted">
                  📖 한국어기초사전
                  {card.link && (
                    <>
                      {" · "}
                      <a href={card.link} target="_blank" rel="noreferrer" className="underline">
                        статья
                      </a>
                    </>
                  )}
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </WordCardContext>
  );
}
