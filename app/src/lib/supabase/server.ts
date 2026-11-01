import "server-only";
import { createServerClient } from "@supabase/ssr";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { env } from "@/lib/env";
import type { Database } from "./database.types";

// Клиент от имени ученика: RLS отдаёт только его данные.
export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient<Database>(env.supabaseUrl, env.supabaseKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Вызов из Server Component: сессию обновляет proxy.
        }
      },
    },
  });
}

let adminClient: ReturnType<typeof createSupabaseClient<Database>> | null = null;

// Клиент сервера (service role): посты бота, расход, ответы заданий, список доступа.
// Каждый вызов должен сам проверять, что ученик имеет право на эти данные.
export function createAdminClient() {
  adminClient ??= createSupabaseClient<Database>(env.supabaseUrl, env.supabaseSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return adminClient;
}
