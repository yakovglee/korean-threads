// Общие правила эмбеддингов для приложения и скриптов индексации.

// Размерность колонок vector(1024) в базе.
export const EMBEDDING_DIMENSIONS = 1024;

// bge-m3 отдаёт 1024 сам; qwen3-embedding умеет укорачивать вектор (Matryoshka) по параметру dimensions.
export function embeddingOptions(model: string): { dimensions?: number } {
  return model.startsWith("qwen/") ? { dimensions: EMBEDDING_DIMENSIONS } : {};
}

// pgvector принимает вектор строкой вида [0.1,0.2,...].
export function toVector(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
