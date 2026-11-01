import "server-only";
import { XMLParser } from "fast-xml-parser";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/server";
import type { WordCard } from "@/lib/types";

// 한국어기초사전 Open API: search и view, XML, перевод на русский (trans_lang=10).
const BASE = "https://krdict.korean.go.kr/api";
const CACHE_DAYS = 30;

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) =>
    [
      "item",
      "sense",
      "translation",
      "sense_info",
      "example_info",
      "pronunciation_info",
      "multimedia_info",
      "pos_info",
      "comm_pattern_info",
    ].includes(name),
});

type Xml = Record<string, unknown>;

function text(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  return null;
}

function list(value: unknown): Xml[] {
  return Array.isArray(value) ? (value as Xml[]) : value ? [value as Xml] : [];
}

// Первое значение по имени тега где угодно в дереве (структура view API глубокая и плавает).
function find(node: unknown, key: string): unknown {
  if (!node || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const v = find(child, key);
      if (v !== undefined) return v;
    }
    return undefined;
  }
  const obj = node as Xml;
  if (key in obj) return obj[key];
  for (const child of Object.values(obj)) {
    const v = find(child, key);
    if (v !== undefined) return v;
  }
  return undefined;
}

async function request(method: "search" | "view", params: Record<string, string>): Promise<Xml> {
  const key = env.krdictKey;
  if (!key) throw new Error("KRDICT_API_KEY не задан");
  const url = new URL(`${BASE}/${method}`);
  url.search = new URLSearchParams({ key, translated: "y", trans_lang: "10", ...params }).toString();
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`krdict ${method}: HTTP ${res.status}`);
  const doc = parser.parse(await res.text()) as Xml;
  if (doc.error) throw new Error(`krdict ${method}: ${JSON.stringify(doc.error)}`);
  return (doc.channel as Xml) ?? {};
}

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const admin = createAdminClient();
  const { data } = await admin.from("dict_cache").select("data, fetched_at").eq("key", key).maybeSingle();
  if (data && Date.now() - new Date(data.fetched_at).getTime() < CACHE_DAYS * 864e5) {
    return data.data as T;
  }
  const value = await load();
  if (value !== null) {
    await admin.from("dict_cache").upsert({ key, data: value as never, fetched_at: new Date().toISOString() });
  }
  return value;
}

type SearchItem = {
  targetCode: string;
  word: string;
  level: string | null;
  pos: string | null;
  pronunciation: string | null;
  senses: { translation: string | null; definition: string | null; definitionKo: string | null }[];
  link: string | null;
};

function parseSearchItems(channel: Xml): SearchItem[] {
  return list(channel.item).map((item) => ({
    targetCode: text(item.target_code) ?? "",
    word: text(item.word) ?? "",
    level: text(item.word_grade),
    pos: text(item.pos),
    pronunciation: text(item.pronunciation),
    link: text(item.link),
    senses: list(item.sense).map((sense) => {
      const tr = list(sense.translation)[0];
      return {
        translation: text(tr?.trans_word),
        definition: text(tr?.trans_dfn),
        definitionKo: text(sense.definition),
      };
    }),
  }));
}

const LEVEL_ORDER: Record<string, number> = { 초급: 0, 중급: 1, 고급: 2 };

// Поиск для бота: несколько статей с переводами.
export async function searchDictionary(query: string): Promise<SearchItem[]> {
  const q = query.trim();
  if (!q) return [];
  return cached(`search:${q}`, async () => {
    const channel = await request("search", { q, part: "word", num: "10", sort: "dict" });
    return parseSearchItems(channel).slice(0, 5);
  });
}

// Карточка слова: перевод, уровень, произношение, пример и запись произношения, если она есть.
export async function wordCard(lemma: string): Promise<WordCard | null> {
  const q = lemma.trim();
  if (!q) return null;
  return cached(`card:${q}`, async () => {
    const items = parseSearchItems(await request("search", { q, part: "word", num: "10", sort: "dict" }));
    const exact = items.filter((i) => i.word.replace(/\d+$/, "") === q);
    const pick = (exact.length ? exact : items).sort(
      (a, b) => (LEVEL_ORDER[a.level ?? ""] ?? 3) - (LEVEL_ORDER[b.level ?? ""] ?? 3),
    )[0];
    if (!pick) return null;

    let example: string | null = null;
    let audioUrl: string | null = null;
    let pronunciation = pick.pronunciation;
    try {
      const view = await request("view", { method: "target_code", q: pick.targetCode });
      const examples = list(find(view, "example_info"));
      example =
        text(examples.find((e) => text(e.type) === "문장")?.example) ?? text(examples[0]?.example) ?? null;
      const pron = list(find(view, "pronunciation_info"));
      pronunciation = text(pron[0]?.pronunciation) ?? pronunciation;
      const media = list(find(view, "multimedia_info"));
      audioUrl =
        text(pron.find((p) => text(p.link))?.link) ??
        text(media.find((m) => /소리|음성|sound/i.test(text(m.type) ?? ""))?.link) ??
        null;
    } catch (error) {
      console.error("krdict view", error);
    }

    const sense = pick.senses[0];
    return {
      word: pick.word.replace(/\d+$/, ""),
      translation: sense?.translation ?? null,
      definition: sense?.definition ?? sense?.definitionKo ?? null,
      level: pick.level,
      pos: pick.pos,
      pronunciation,
      example,
      audioUrl: audioUrl?.replace(/^http:/, "https:") ?? null,
      link: pick.link,
    } satisfies WordCard;
  });
}
