"use client";

import { Check, X } from "lucide-react";
import { Fragment, useState } from "react";
import type { QuizItem } from "@/lib/demo-data";

/**
 * Мини-проверка (П-28–П-36): четыре варианта, выбор нельзя изменить,
 * после выбора подсвечивается верный вариант и звучит отклик «딩동댕!» или «땡!».
 */
export function QuizCard({ item }: { item: QuizItem }) {
  const [picked, setPicked] = useState<number | null>(null);
  const answered = picked !== null;
  const correct = picked === item.answer;

  const pick = (i: number) => {
    if (answered) return;
    setPicked(i);
  };

  const stemParts = item.stem.split("___");

  return (
    <article className="card quiz" aria-label="Мини-проверка">
      <p className="quiz__stem" lang="ko">
        {stemParts.map((part, i) => (
          <Fragment key={i}>
            {part}
            {i < stemParts.length - 1 ? <span className="blank" role="img" aria-label="пропуск" /> : null}
          </Fragment>
        ))}
      </p>

      <ul className="options">
        {item.options.map((opt, i) => {
          const state = !answered ? "idle" : i === item.answer ? "correct" : i === picked ? "wrong" : "idle";
          return (
            <li key={i}>
              <button
                type="button"
                className="option"
                data-state={state}
                aria-disabled={answered}
                onClick={() => pick(i)}
              >
                <span className="option__n" aria-hidden="true">
                  {i + 1}
                </span>
                <span className="option__text" lang="ko">
                  {opt}
                </span>
                {state === "correct" ? <Check className="option__icon" size={22} strokeWidth={2.25} aria-hidden="true" /> : null}
                {state === "wrong" ? <X className="option__icon" size={22} strokeWidth={2.25} aria-hidden="true" /> : null}
              </button>
            </li>
          );
        })}
      </ul>

      <div aria-live="polite">
        {answered ? (
          <p className="verdict" data-ok={correct}>
            {correct ? (
              <Check size={26} strokeWidth={2.5} aria-hidden="true" />
            ) : (
              <X size={26} strokeWidth={2.5} aria-hidden="true" />
            )}
            <span lang="ko" aria-hidden="true">
              {correct ? "딩동댕!" : "땡!"}
            </span>
            <span className="sr-only">
              {correct ? "Верно" : `Неверно. Верный ответ: вариант ${item.answer + 1}`}
            </span>
          </p>
        ) : null}
      </div>

      {item.label ? <p className="quiz__meta">{item.label}</p> : null}
    </article>
  );
}
