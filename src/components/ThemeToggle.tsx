"use client";

import { Moon, Sun } from "lucide-react";
import { useLayoutEffect } from "react";

type Theme = "light" | "dark";

const DARK_QUERY = "(prefers-color-scheme: dark)";
// те же цвета, что в viewport.themeColor в layout.tsx
const THEME_COLOR: Record<Theme, string> = { light: "#FFFBEB", dark: "#171412" };

function savedTheme(): Theme | null {
  try {
    const t = localStorage.getItem("theme");
    return t === "light" || t === "dark" ? t : null;
  } catch {
    return null; // хранилища нет: тема только системная
  }
}

function systemTheme(): Theme {
  return matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
  document
    .querySelectorAll('meta[name="theme-color"]')
    .forEach((m) => m.setAttribute("content", THEME_COLOR[theme]));
}

/** Кнопка темы в шапке: луна в светлой теме, солнце в тёмной (показ решает CSS по data-theme) */
export function ThemeToggle() {
  // Применяем тему заново: так совпадает цвет theme-color, и это страховка из доков Next
  // (в dev React может сбросить атрибуты <html>, поставленные скриптом из layout).
  // Пока выбора нет, следим за системной темой.
  useLayoutEffect(() => {
    applyTheme(savedTheme() ?? systemTheme());
    const mql = matchMedia(DARK_QUERY);
    const onSystemChange = () => {
      if (savedTheme() === null) applyTheme(systemTheme());
    };
    mql.addEventListener("change", onSystemChange);
    return () => mql.removeEventListener("change", onSystemChange);
  }, []);

  function toggle() {
    const next: Theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    try {
      // совпало с системной: выбор не нужен, возвращаемся к «как в системе»
      if (next === systemTheme()) localStorage.removeItem("theme");
      else localStorage.setItem("theme", next);
    } catch {
      // хранилища нет: тема сменится до перезагрузки
    }
    applyTheme(next);
  }

  return (
    <button type="button" className="icon-btn" aria-label="Сменить тему" onClick={toggle}>
      <Moon className="theme-toggle__moon" size={24} strokeWidth={2} aria-hidden="true" />
      <Sun className="theme-toggle__sun" size={24} strokeWidth={2} aria-hidden="true" />
    </button>
  );
}
