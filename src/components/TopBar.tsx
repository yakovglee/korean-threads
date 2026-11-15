"use client";

import { ChartNoAxesColumn } from "lucide-react";
import { useEffect, useState } from "react";
import { ThemeToggle } from "./ThemeToggle";

/** Тонкая шапка: прячется при прокрутке вниз, возвращается при прокрутке вверх */
export function TopBar({ viewer }: { viewer: boolean }) {
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    // Направление берём из жеста (колесо, касание), а не из позиции прокрутки:
    // мягкая привязка к карточкам сама подтягивает страницу на десятки пикселей,
    // и это не должно возвращать шапку.
    const HIDE_AFTER = 12;
    const SHOW_AFTER = 24;
    const TOP_ZONE = 80;
    let travel = 0; // >0 вниз, <0 вверх, накопление в одном направлении
    let touchY = 0;

    const apply = (delta: number) => {
      if (delta * travel < 0) travel = 0;
      travel += delta;
      if (travel > HIDE_AFTER && window.scrollY > TOP_ZONE) setHidden(true);
      else if (travel < -SHOW_AFTER) setHidden(false);
    };
    const onWheel = (e: WheelEvent) => apply(e.deltaY);
    const onTouchStart = (e: TouchEvent) => {
      touchY = e.touches[0].clientY;
      travel = 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0].clientY;
      apply(touchY - y);
      touchY = y;
    };
    // у самого верха шапка видна всегда
    const onScroll = () => {
      if (window.scrollY <= TOP_ZONE) setHidden(false);
    };

    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  return (
    <header className="topbar" data-hidden={hidden}>
      <div className="topbar__inner">
        <span className="topbar__title">Korean Threads</span>
        <div className="topbar__actions">
          <ThemeToggle />
          {/* «Прогресс» только у владельца (П-71); страница вне этого экрана */}
          {viewer ? null : (
            <button type="button" className="icon-btn" aria-label="Прогресс">
              <ChartNoAxesColumn size={24} strokeWidth={2} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
