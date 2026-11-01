function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Не задана переменная окружения ${name} (см. .env.example)`);
  return value;
}

export const env = {
  get supabaseUrl() {
    return required("NEXT_PUBLIC_SUPABASE_URL");
  },
  get supabaseKey() {
    return required("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  },
  get supabaseSecretKey() {
    return required("SUPABASE_SECRET_KEY");
  },
  get openrouterKey() {
    return required("OPENROUTER_API_KEY");
  },
  // Необязательно: OpenRouter-совместимый прокси вместо https://openrouter.ai/api/v1.
  get openrouterBaseUrl() {
    return process.env.OPENROUTER_BASE_URL || undefined;
  },
  get embeddingModel() {
    return process.env.EMBEDDING_MODEL || "baai/bge-m3";
  },
  get krdictKey() {
    return process.env.KRDICT_API_KEY || null;
  },
  get mecabUrl() {
    return process.env.MECAB_URL || null;
  },
  get siteUrl() {
    return process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
  },
};
