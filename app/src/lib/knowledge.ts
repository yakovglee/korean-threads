import "server-only";
import { embedTexts } from "@/lib/ai";
import { toVector } from "@/lib/embedding";
import { createAdminClient } from "@/lib/supabase/server";

export type Fragment = {
  n: number;
  title: string;
  page: number | null;
  label: string | null;
  content: string;
  similarity: number;
};

const MATCH_COUNT = 8;
// Ниже этого сходства фрагмент почти наверняка не про вопрос.
const MIN_SIMILARITY = 0.3;

// Ключевые слова для точного поиска в учебниках: прежде всего конструкции, помеченные дефисом
// («-더라고요» → «더라고요»), а если таких нет — корейские слова вопроса.
export function koreanKeywords(text: string): string[] {
  const marked = [...text.matchAll(/[-~]\s?([가-힣]+(?:\s[가-힣]+)?)/g)].map((m) => m[1]).filter((k) => k.length >= 2);
  const words = text.match(/[가-힣]{2,}/g) ?? [];
  return [...new Set(marked.length ? marked : words)].slice(0, 4);
}

// Поиск по базе знаний. Если эмбеддинги недоступны, бот отвечает по общим знаниям.
export async function findFragments(query: string): Promise<Fragment[]> {
  try {
    const [embedding] = await embedTexts([query]);
    const { data, error } = await createAdminClient().rpc("match_chunks", {
      query_embedding: toVector(embedding),
      keywords: koreanKeywords(query),
      match_count: MATCH_COUNT,
    });
    if (error) throw error;
    // Совпадение по самой конструкции оставляем даже при невысоком сходстве по смыслу.
    return data
      .filter((row) => row.similarity >= MIN_SIMILARITY || row.lexical)
      .slice(0, MATCH_COUNT)
      .map((row, i) => ({
        n: i + 1,
        title: row.title,
        page: row.page,
        label: row.label,
        content: row.content,
        similarity: row.similarity,
      }));
  } catch (error) {
    console.error("findFragments", error);
    return [];
  }
}

export function fragmentsForPrompt(fragments: Fragment[]): string {
  if (fragments.length === 0) return "Подходящих фрагментов в учебниках не нашлось.";
  return fragments
    .map((f) => {
      const where = [f.title, f.page ? `стр. ${f.page}` : null, f.label].filter(Boolean).join(", ");
      return `[${f.n}] ${where}\n${f.content}`;
    })
    .join("\n\n");
}
