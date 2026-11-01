// Разбор GRAMMAR_MAIN.md — выгрузки 한국어교수학습샘터 «문법·표현 내용 검색»: каталог конструкций.
import fs from "node:fs";
import path from "node:path";
import { BOOKS_DIR } from "./common";

export type CatalogEntry = {
  key: string; // как в каталоге: «-거든2»
  name: string; // без номера омонима: «-거든»
  pos: string | null;
  level: "초급" | "중급" | "고급" | null;
  meaning: string | null;
  text: string; // вся статья без HTML
};

const ENTRY_START = "# 한국어교수학습샘터-문법·표현 내용 검색-통합 검색";

function stripHtml(html: string): string {
  return html
    .replace(/<sup>.*?<\/sup>/g, "")
    .replace(/<br\s*\/?>|<\/(p|tr|li|table)>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function cleanText(md: string): string {
  return stripHtml(md)
    .replace(/\*\*/g, "")
    .replace(/^\s*\|?\s*-{3}.*$/gm, "")
    .replace(/\|/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/^ +| +$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function readCatalog(): CatalogEntry[] {
  const source = fs.readFileSync(path.join(BOOKS_DIR, "GRAMMAR_MAIN.md"), "utf8");
  const entries: CatalogEntry[] = [];
  for (const raw of source.split(ENTRY_START).slice(1)) {
    const key = stripHtml(raw.match(/문법\/표현<\/th><td[^>]*>(.*?)<\/td>/)?.[1] ?? "").trim();
    if (!key) continue;
    const pos = raw.match(/품사<\/th><td>(.*?)<\/td>/)?.[1]?.trim() || null;
    const level = raw.match(/토픽 등급<\/th><td>(.*?)<\/td>/)?.[1]?.trim();
    const meaningBlock = raw.split("의미와 용법")[1]?.split("\n\n")[1] ?? "";
    const body = raw.split("상세 정보")[1] ?? raw;
    entries.push({
      key,
      name: key.replace(/\d+$/, ""),
      pos,
      level: level === "초급" || level === "중급" || level === "고급" ? level : null,
      meaning: cleanText(meaningBlock).replace(/^-\s*/, "") || null,
      text: cleanText(body),
    });
  }
  return entries;
}
