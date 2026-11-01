import "server-only";
import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import type { Level } from "@/lib/types";

export type Student = {
  id: string;
  email: string;
  level: Level | null;
  model: string;
  isAdmin: boolean;
};

const FALLBACK_MODEL = "anthropic/claude-sonnet-5.5";

// Ученик текущего запроса. null — нет сессии или адрес убрали из списка доступа.
export const getStudent = cache(async (): Promise<Student | null> => {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (!claims?.sub || !claims.email) return null;

  const [profile, access, settings, models] = await Promise.all([
    supabase.from("profiles").select("id, email, level, model").eq("id", claims.sub).maybeSingle(),
    createAdminClient().from("access_list").select("is_admin").eq("email", claims.email.toLowerCase()).maybeSingle(),
    supabase.from("app_settings").select("default_model").maybeSingle(),
    supabase.from("models").select("id"),
  ]);
  if (!profile.data || !access.data) return null;

  const enabled = new Set((models.data ?? []).map((m) => m.id));
  const chosen = profile.data.model && enabled.has(profile.data.model) ? profile.data.model : null;

  return {
    id: profile.data.id,
    email: profile.data.email,
    level: profile.data.level,
    model: chosen ?? settings.data?.default_model ?? FALLBACK_MODEL,
    isAdmin: access.data.is_admin,
  };
});

export async function requireStudent(): Promise<Student> {
  const student = await getStudent();
  if (!student) redirect("/auth/signout?denied=1");
  return student;
}

// Ученик, который уже выбрал уровень (иначе — на экран выбора уровня).
export async function requireOnboardedStudent(): Promise<Student & { level: Level }> {
  const student = await requireStudent();
  if (!student.level) redirect("/welcome");
  return student as Student & { level: Level };
}

export async function requireAdmin(): Promise<Student> {
  const student = await requireStudent();
  if (!student.isAdmin) notFound();
  return student;
}
