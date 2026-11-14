"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { DEMO_CHAT_THREAD, demoBatch, type FeedItem } from "@/lib/demo-data";
import { ChatBar } from "./ChatBar";
import { QuizCard } from "./QuizCard";
import { ThreadCard } from "./ThreadCard";
import { TopBar } from "./TopBar";
import { WordSheet, type LookupStatus, type OpenWord } from "./WordSheet";
import type { WordTap } from "./KoText";

type KeyedItem = FeedItem & { key: string };

/** Подгрузка за столько карточек до конца ленты (П-11) */
const PRELOAD_AHEAD = 3;

/** Демо повторяет ветки по кругу, поэтому id постов делаем уникальными в каждой порции */
function withRound(item: FeedItem, tag: string): KeyedItem {
  const key = `${item.id}#${tag}`;
  if (item.type === "thread") {
    return { ...item, key, posts: item.posts.map((p) => ({ ...p, id: `${p.id}#${tag}` })) };
  }
  return { ...item, key };
}

function batch(round: number): KeyedItem[] {
  return demoBatch(round).map((item) => withRound(item, String(round)));
}

function SkeletonCard() {
  return (
    <div className="skeleton" aria-hidden="true">
      <div className="sk-line" />
      <div className="sk-line" />
      <div className="sk-line" />
    </div>
  );
}

export function Feed({ viewer }: { viewer: boolean }) {
  const [items, setItems] = useState<KeyedItem[]>(() => batch(0));
  const [loadingMore, setLoadingMore] = useState(false);
  const [word, setWord] = useState<OpenWord | null>(null);
  const [closing, setClosing] = useState(false);
  const [status, setStatus] = useState<LookupStatus>("ready");

  const lookupTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lookupTries = useRef<Record<string, number>>({});
  const round = useRef(0);
  const sentinel = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const loading = useRef(false);
  const revealTop = useRef(false);

  const loadMore = useCallback(() => {
    if (loading.current) return;
    loading.current = true;
    setLoadingMore(true);
    // демо: в боевой версии здесь запрос следующей порции; пустого «конца ленты» нет (П-11)
    setTimeout(() => {
      round.current += 1;
      const next = batch(round.current);
      setItems((prev) => [...prev, ...next]);
      setLoadingMore(false);
      loading.current = false;
    }, 450);
  }, []);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { rootMargin: "0px 0px 240px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [items.length, loadMore]);

  useEffect(
    () => () => {
      clearTimeout(closeTimer.current);
      clearTimeout(lookupTimer.current);
    },
    [],
  );

  /**
   * Значение «ИИ» подтягивается в момент касания (П-9, П-24): шторка открывается сразу,
   * на месте значения индикатор. Демо: на первый запрос слова «덧붙여요» приходит ошибка,
   * повтор проходит. В боевой версии здесь запрос к серверу.
   */
  const lookup = useCallback((surface: string, parts: OpenWord["parts"]) => {
    clearTimeout(lookupTimer.current);
    if (!parts.some((p) => p.ai)) {
      setStatus("ready");
      return;
    }
    setStatus("loading");
    lookupTimer.current = setTimeout(() => {
      const tries = (lookupTries.current[surface] = (lookupTries.current[surface] ?? 0) + 1);
      setStatus(tries === 1 ? "failed" : "ready");
    }, 900);
  }, []);

  const closeWord = useCallback(() => {
    const trigger = word?.el;
    setClosing(true);
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      setWord(null);
      setClosing(false);
      // фокус возвращается на слово, с которого открыли шторку
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    }, 200);
  }, [word]);

  const openWord = (tap: WordTap, el: HTMLButtonElement) => {
    // повторное касание открытого слова закрывает шторку, а не перезапускает загрузку
    if (word && !closing && word.key === tap.key) {
      closeWord();
      return;
    }
    clearTimeout(closeTimer.current);
    setClosing(false);
    setWord({ ...tap, el });
    lookup(tap.surface, tap.parts);
  };

  const retryLookup = () => {
    if (word) lookup(word.surface, word.parts);
  };

  const ask = useCallback(async (question: string): Promise<boolean> => {
    // демо: ответ собран заранее; строка, начинающаяся с «!fail», показывает состояние ошибки (П-44)
    await new Promise((resolve) => setTimeout(resolve, 1200));
    if (question.startsWith("!fail")) return false;
    const reply = withRound(DEMO_CHAT_THREAD, `chat${Date.now()}`);
    revealTop.current = true;
    setItems((prev) => [reply, ...prev]);
    return true;
  }, []);

  // Ответ чата вставляется наверх и открывается в ленте (П-39). Прокручиваем после обновления DOM,
  // иначе браузер сначала удерживает прежнее содержимое и сдвигает страницу вниз.
  useEffect(() => {
    if (!revealTop.current) return;
    revealTop.current = false;
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: calm ? "auto" : "smooth" });
  }, [items]);

  const activeKey = word && !closing ? word.key : null;
  const sentinelAt = items.length - PRELOAD_AHEAD;

  return (
    <>
      <TopBar viewer={viewer} />
      <main className={`feed${viewer ? " feed--viewer" : ""}`} aria-label="Лента">
        {items.map((item, i) => (
          <Fragment key={item.key}>
            {i === sentinelAt ? <div ref={sentinel} className="sentinel" aria-hidden="true" /> : null}
            {item.type === "thread" ? (
              <ThreadCard item={item} activeKey={activeKey} onWord={openWord} />
            ) : (
              <QuizCard item={item} />
            )}
          </Fragment>
        ))}
        {loadingMore ? <SkeletonCard /> : null}
      </main>
      {viewer ? null : <ChatBar onAsk={ask} />}
      {word ? (
        <WordSheet word={word} status={status} closing={closing} onClose={closeWord} onRetry={retryLookup} />
      ) : null}
    </>
  );
}
