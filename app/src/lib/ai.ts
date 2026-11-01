import "server-only";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { embedMany, type ProviderMetadata } from "ai";
import { env } from "@/lib/env";
import { EMBEDDING_DIMENSIONS, embeddingOptions, toVector } from "@/lib/embedding";
import { createAdminClient } from "@/lib/supabase/server";

let provider: ReturnType<typeof createOpenRouter> | null = null;

function openrouter() {
  provider ??= createOpenRouter({
    apiKey: env.openrouterKey,
    baseURL: env.openrouterBaseUrl,
    compatibility: "strict",
    // Заголовки HTTP — только Latin-1, поэтому название латиницей.
    headers: { "X-Title": "Munbeop Grammatika" },
  });
  return provider;
}

// Модель ответа. Стоимость в потоковом режиме OpenRouter сообщает только по запросу.
export function chatModel(id: string) {
  return openrouter()(id, { usage: { include: true } });
}

export async function embedTexts(values: string[]): Promise<number[][]> {
  const { embeddings } = await embedMany({
    model: openrouter().textEmbeddingModel(env.embeddingModel),
    values,
    ...embeddingOptions(env.embeddingModel),
  });
  for (const e of embeddings) {
    if (e.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(`Эмбеддинг ${env.embeddingModel} имеет размерность ${e.length}, а база ждёт ${EMBEDDING_DIMENSIONS}`);
    }
  }
  return embeddings;
}

export function costOf(metadata: ProviderMetadata | undefined): number {
  const usage = metadata?.openrouter?.usage as { cost?: number } | undefined;
  return typeof usage?.cost === "number" ? usage.cost : 0;
}

export async function recordUsage(entry: {
  userId: string;
  model: string;
  kind: "answer" | "quiz" | "check";
  cost: number;
  inputTokens?: number;
  outputTokens?: number;
}) {
  await createAdminClient().from("usage").insert({
    user_id: entry.userId,
    model: entry.model,
    kind: entry.kind,
    cost: entry.cost,
    input_tokens: entry.inputTokens ?? null,
    output_tokens: entry.outputTokens ?? null,
  });
}

// Эмбеддинги постов для поиска по смыслу. Ошибка не мешает треду: пост просто не найдётся по смыслу.
export async function embedPosts(posts: { id: string; body: string }[]) {
  if (posts.length === 0) return;
  try {
    const embeddings = await embedTexts(posts.map((p) => p.body));
    const admin = createAdminClient();
    await Promise.all(
      posts.map((p, i) => admin.from("posts").update({ embedding: toVector(embeddings[i]) }).eq("id", p.id)),
    );
  } catch (error) {
    console.error("embedPosts", error);
  }
}
