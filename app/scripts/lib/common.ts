// Общее для локальных скриптов (ADR 0003): книги лежат в ../books и в репозиторий не попадают.
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createClient } from "@supabase/supabase-js";
import { embedMany } from "ai";
import { config } from "dotenv";
import path from "node:path";
import { EMBEDDING_DIMENSIONS, embeddingOptions } from "../../src/lib/embedding";
import type { Database } from "../../src/lib/supabase/database.types";

config({ path: ".env.local", quiet: true });

export const BOOKS_DIR = path.resolve(process.cwd(), "..", "books");

export function need(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Нужна переменная ${name} в app/.env.local`);
    process.exit(1);
  }
  return value;
}

export function database() {
  return createClient<Database>(need("NEXT_PUBLIC_SUPABASE_URL"), need("SUPABASE_SECRET_KEY"), {
    auth: { persistSession: false },
  });
}

export function openrouter() {
  return createOpenRouter({
    apiKey: need("OPENROUTER_API_KEY"),
    baseURL: process.env.OPENROUTER_BASE_URL || undefined,
    compatibility: "strict",
  });
}

// Эмбеддинги пачками с повтором при сбоях сети.
export async function embedAll(
  values: string[],
  model = process.env.EMBEDDING_MODEL || "baai/bge-m3",
  onProgress?: (done: number) => void,
): Promise<number[][]> {
  const provider = openrouter();
  const out: number[][] = [];
  const batch = 64;
  for (let i = 0; i < values.length; i += batch) {
    const slice = values.slice(i, i + batch);
    for (let attempt = 1; ; attempt++) {
      try {
        const { embeddings } = await embedMany({
          model: provider.textEmbeddingModel(model),
          values: slice,
          maxRetries: 3,
          ...embeddingOptions(model),
        });
        if (embeddings.some((e) => e.length !== EMBEDDING_DIMENSIONS)) {
          throw new Error(`${model}: размерность ${embeddings[0].length}, а база ждёт ${EMBEDDING_DIMENSIONS}`);
        }
        out.push(...embeddings);
        break;
      } catch (error) {
        if (attempt >= 4) throw error;
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    onProgress?.(out.length);
  }
  return out;
}

// Режет текст на куски до limit знаков по абзацам (длинный абзац — по предложениям).
export function chunkText(text: string, limit = 1500): string[] {
  const pieces = text
    .split(/\n{2,}/)
    .flatMap((p) => (p.length <= limit ? [p] : p.split(/(?<=[.!?。다요])\s+/)))
    .map((p) => p.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (current && current.length + piece.length + 2 > limit) {
      chunks.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${piece}` : piece.slice(0, limit);
  }
  if (current) chunks.push(current);
  return chunks;
}
