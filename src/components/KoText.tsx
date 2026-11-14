import { createElement, Fragment } from "react";
import { chunkKorean, type Part } from "@/lib/demo-data";

export type WordTap = { key: string; surface: string; parts: Part[] };

type Props = {
  text: string;
  /** Уникальный префикс для ключей слов внутри карточки */
  scope: string;
  activeKey: string | null;
  onWord: (tap: WordTap, el: HTMLButtonElement) => void;
  as?: "p" | "h3";
  className?: string;
};

/** Корейский текст: каждый распознанный сегмент касается и открывает шторку (П-18) */
export function KoText({ text, scope, activeKey, onWord, as = "p", className = "ko" }: Props) {
  const chunks = chunkKorean(text);
  const children = chunks.map((c, i) => {
    if (c.kind === "text") return <Fragment key={i}>{c.text}</Fragment>;
    const key = `${scope}:${i}`;
    return (
      // кавычки и знаки держатся вместе со словом и не отрываются на другую строку
      <span key={i} className="nb">
        {c.lead}
        <button
          type="button"
          className="w"
          data-active={activeKey === key}
          aria-haspopup="dialog"
          onClick={(e) => onWord({ key, surface: c.surface, parts: c.parts }, e.currentTarget)}
        >
          {c.label}
        </button>
        {c.trail}
      </span>
    );
  });
  return createElement(as, { className, lang: "ko" }, children);
}
