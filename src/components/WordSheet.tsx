"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { keepSuffix, type Part } from "@/lib/demo-data";

export type OpenWord = { key: string; surface: string; parts: Part[]; el: HTMLButtonElement };

/** Состояние подтягивания значения: словарное значение есть сразу, значение «ИИ» грузится (П-9, П-24) */
export type LookupStatus = "ready" | "loading" | "failed";

type Props = {
  word: OpenWord;
  status: LookupStatus;
  /** Идёт анимация закрытия */
  closing: boolean;
  onClose: () => void;
  onRetry: () => void;
};

const DRAG_START = 4;
const DRAG_CLOSE = 80;

/**
 * Нижняя шторка со значением слова (П-18–П-24, П-61).
 * Пост остаётся виден: если слово оказалось под шторкой, лента подкручивается.
 * Фокус не уходит под шторку: Tab ходит по кругу внутри неё.
 */
export function WordSheet({ word, status, closing, onClose, onRetry }: Props) {
  const titleId = useId();
  const sheetRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const drag = useRef({ startY: 0, dy: 0, active: false, pointer: -1 });

  // фокус на заголовок при открытии и при смене слова
  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, [word.key]);

  // пока шторка открыта, лента под ней не прокручивается (см. html[data-sheet] в globals.css)
  useEffect(() => {
    document.documentElement.dataset.sheet = "open";
    return () => {
      delete document.documentElement.dataset.sheet;
    };
  }, []);

  // слово не должно оказаться под шторкой
  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    const frame = requestAnimationFrame(() => {
      const limit = window.innerHeight - sheet.offsetHeight - 24;
      const bottom = word.el.getBoundingClientRect().bottom;
      if (bottom > limit) {
        const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        window.scrollBy({ top: bottom - limit, behavior: calm ? "auto" : "smooth" });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [word.key, word.el]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const sheet = sheetRef.current;
      if (!sheet) return;
      const items = Array.from(sheet.querySelectorAll<HTMLElement>("button, a[href]"));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!active || !sheet.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && (active === first || active === titleRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const setDrag = (dy: number, dragging: boolean) => {
    const el = sheetRef.current;
    if (!el) return;
    el.style.setProperty("--drag", `${dy}px`);
    el.dataset.dragging = String(dragging);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    drag.current = { startY: e.clientY, dy: 0, active: false, pointer: e.pointerId };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d.pointer !== e.pointerId) return;
    const dy = Math.max(0, e.clientY - d.startY);
    if (!d.active && dy > DRAG_START) {
      d.active = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    if (d.active) {
      d.dy = dy;
      setDrag(dy, true);
    }
  };

  const onPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d.pointer !== e.pointerId) return;
    const wasActive = d.active;
    const dy = d.dy;
    drag.current = { startY: 0, dy: 0, active: false, pointer: -1 };
    if (!wasActive) return;
    setDrag(0, false);
    if (dy > DRAG_CLOSE) onClose();
  };

  // Касание вне шторки закрывает её (П-23). Если под пальцем другое слово,
  // шторка переключается на него: иначе на каждое слово ушло бы два касания.
  // Смотрим только верхний элемент под затемнением: слово, скрытое под шапкой или полем чата, не откроется.
  const onScrimClick = (e: React.MouseEvent) => {
    const under = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el !== e.currentTarget);
    const hit = under?.closest<HTMLElement>(".w");
    if (hit) hit.click();
    else onClose();
  };

  return (
    <>
      <div className="scrim" data-open={!closing} onClick={onScrimClick} aria-hidden="true" />
      <div
        ref={sheetRef}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={status === "loading"}
        data-open={!closing}
      >
        <div
          className="sheet__grab"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
        >
          <h2 id={titleId} ref={titleRef} className="sheet__title" lang="ko" tabIndex={-1}>
            {word.surface}
          </h2>
          <button type="button" className="icon-btn" aria-label="Закрыть" onClick={onClose}>
            <X size={24} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>

        <div className="sheet__body">
          {word.parts.length > 0 ? (
            word.parts.map((p) => (
              <section key={p.form} className="part">
                <div className="part__head">
                  <span className="part__form" lang="ko">
                    {p.form}
                  </span>
                  {p.pos ? <span className="part__pos">{p.pos}</span> : null}
                  {p.ai ? <span className="badge-ai">ИИ</span> : null}
                </div>

                {p.ai && status === "loading" ? (
                  <div className="part__load" role="status">
                    <div className="sk-line" />
                    <span className="sr-only">Значение загружается</span>
                  </div>
                ) : p.ai && status === "failed" ? (
                  <div className="part__error" role="alert">
                    <span>Не получилось загрузить значение.</span>
                    <button type="button" className="part__retry" onClick={onRetry}>
                      Повторить
                    </button>
                  </div>
                ) : (
                  <>
                    <p className="part__ru">{keepSuffix(p.ru)}</p>
                    {p.note ? <p className="part__note">{keepSuffix(p.note)}</p> : null}
                    {p.example ? (
                      <div className="example">
                        <p className="example__ko" lang="ko">
                          {p.example.ko}
                        </p>
                        <p className="example__ru">{keepSuffix(p.example.ru)}</p>
                      </div>
                    ) : null}
                  </>
                )}
              </section>
            ))
          ) : (
            <section className="part">
              <div className="part__head">
                <span className="part__form" lang="ko">
                  {word.surface}
                </span>
              </div>
              <p className="part__missing">значение не найдено</p>
            </section>
          )}

          {/* П-75: атрибуция словаря только у значений из словаря. В демо значения написаны вручную, так и сказано. */}
          <p className="attrib">
            Значения в демо написаны вручную. В рабочей версии:{" "}
            <a href="https://krdict.korean.go.kr/" target="_blank" rel="noopener noreferrer" lang="ko">
              한국어기초사전
            </a>
            , CC BY-SA 2.0 KR
          </p>
        </div>
      </div>
    </>
  );
}
