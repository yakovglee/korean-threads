import "server-only";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/server";
import type { WordSpan } from "@/lib/types";

// Морфологический разбор через mecab-ko-fastapi админа (ADR 0006): POST / {"text"} →
// список токенов. Из него получаем нажимаемые слова поста в словарной форме.

type MecabToken = {
  word: { surface: string; pos: string };
  parsed_expression: { lemma: string; pos: string }[] | null;
};

type Located = { start: number; end: number; tag: string; morphs: { lemma: string; pos: string }[]; surface: string };

const NOUN = new Set(["NNG", "NNP", "NNB", "NR", "NP", "XR"]);
const PREDICATE = new Set(["VV", "VA", "VX", "VCN"]);
const STANDALONE = new Set(["MAG", "MAJ", "MM", "IC"]);
const DERIVATIONAL = new Set(["XSV", "XSA"]);

const firstTag = (pos: string) => pos.split("+")[0];
const isTail = (tag: string) => tag.startsWith("J") || tag.startsWith("S");

// Токены mecab не несут смещений: находим их по порядку в исходном тексте.
function locate(text: string, tokens: MecabToken[]): Located[] {
  const out: Located[] = [];
  let cursor = 0;
  for (const t of tokens) {
    const start = text.indexOf(t.word.surface, cursor);
    if (start < 0) continue;
    const end = start + t.word.surface.length;
    out.push({
      start,
      end,
      tag: firstTag(t.word.pos),
      surface: t.word.surface,
      morphs: t.parsed_expression?.length ? t.parsed_expression : [{ lemma: t.word.surface, pos: t.word.pos }],
    });
    cursor = end;
  }
  return out;
}

// Конец сказуемого: последний токен словоформы, который не частица и не знак.
function predicateEnd(word: Located[], from: number): number {
  let end = word[from].end;
  for (let k = from; k < word.length; k++) if (!isTail(word[k].tag)) end = word[k].end;
  return end;
}

// 먹었어요 → 먹다, 공부했어요 → 공부하다, 도와요 → 돕다, 학교에 → 학교 (частица не входит).
export function spansFromTokens(text: string, tokens: MecabToken[]): WordSpan[] {
  const located = locate(text, tokens);
  const words: Located[][] = [];
  for (const t of located) {
    const last = words.at(-1)?.at(-1);
    if (last && last.end === t.start) words.at(-1)!.push(t);
    else words.push([t]);
  }

  const spans: WordSpan[] = [];
  for (const word of words) {
    const i = word.findIndex((t) => NOUN.has(t.tag) || PREDICATE.has(t.tag) || STANDALONE.has(t.tag));
    if (i < 0) continue;
    const head = word[i];
    let lemma: string;
    let end: number;

    if (NOUN.has(head.tag)) {
      lemma = head.surface;
      end = head.end;
      let k = i + 1;
      while (k < word.length && NOUN.has(word[k].tag) && word[k].tag !== "NNB") {
        lemma += word[k].surface;
        end = word[k].end;
        k++;
      }
      if (k < word.length && DERIVATIONAL.has(word[k].tag)) {
        lemma += `${word[k].morphs[0].lemma}다`;
        end = predicateEnd(word, k);
      }
    } else if (PREDICATE.has(head.tag)) {
      lemma = `${head.morphs[0].lemma}다`;
      end = predicateEnd(word, i);
    } else {
      lemma = head.surface;
      end = head.end;
    }

    if (/[가-힣]/.test(lemma)) spans.push({ s: head.start, e: end, l: lemma });
  }
  return spans;
}

// null — сервис недоступен или не настроен: слова пока не нажимаются, разбор можно повторить.
export async function analyzeWords(text: string): Promise<WordSpan[] | null> {
  if (!/[가-힣]/.test(text)) return [];
  const url = env.mecabUrl;
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`mecab: HTTP ${res.status}`);
    return spansFromTokens(text, (await res.json()) as MecabToken[]);
  } catch (error) {
    console.error("analyzeWords", error);
    return null;
  }
}

export async function analyzePosts(posts: { id: string; body: string }[]) {
  const admin = createAdminClient();
  await Promise.all(
    posts.map(async (p) => {
      const words = await analyzeWords(p.body);
      if (words) await admin.from("posts").update({ words }).eq("id", p.id);
    }),
  );
}
