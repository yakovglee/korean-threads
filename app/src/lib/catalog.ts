import "server-only";
import { normalizeConstruction } from "@/lib/construction-name";
import { createAdminClient } from "@/lib/supabase/server";
import type { Level } from "@/lib/types";

export type Construction = { id: number; name: string; level: Level | null };

let cached: { at: number; items: Construction[] } | null = null;
const TTL_MS = 10 * 60 * 1000;

// Каталог конструкций (одно имя — одна запись: омонимы «-거든1», «-거든2» сливаются).
export async function getCatalog(): Promise<Construction[]> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.items;
  const { data, error } = await createAdminClient()
    .from("constructions")
    .select("id, name, level")
    .order("id");
  if (error) throw error;
  const byName = new Map<string, Construction>();
  for (const c of data) if (!byName.has(c.name)) byName.set(c.name, c);
  cached = { at: Date.now(), items: [...byName.values()] };
  return cached.items;
}

export function resolveConstructions(names: string[], catalog: Construction[]): Construction[] {
  const index = new Map(catalog.map((c) => [normalizeConstruction(c.name), c]));
  const found = new Map<number, Construction>();
  for (const name of names) {
    const c = index.get(normalizeConstruction(name));
    if (c) found.set(c.id, c);
  }
  return [...found.values()];
}

export function catalogForPrompt(catalog: Construction[]): string {
  return catalog.map((c) => (c.level ? `${c.name} (${c.level})` : c.name)).join("; ");
}
