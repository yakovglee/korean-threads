"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireOnboardedStudent, requireStudent } from "@/lib/auth";
import { env } from "@/lib/env";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { createThread } from "@/lib/threads";
import { LEVELS } from "@/lib/types";

export type LoginState = { error?: string; sent?: string };

// Ссылка для входа — только адресам из списка доступа.
export async function sendMagicLink(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!z.email().safeParse(email).success) return { error: "Похоже, это не адрес почты" };

  const { data: allowed } = await createAdminClient().from("access_list").select("email").eq("email", email).maybeSingle();
  if (!allowed) return { error: "Этого адреса нет в списке доступа. Попроси админа добавить тебя." };

  const origin = (await headers()).get("origin") ?? env.siteUrl;
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${origin}/auth/confirm` },
  });
  if (error) return { error: `Не получилось отправить письмо: ${error.message}` };
  return { sent: email };
}

const levelSchema = z.enum(LEVELS);

export async function chooseLevel(formData: FormData) {
  const student = await requireStudent();
  const level = levelSchema.parse(formData.get("level"));
  const supabase = await createClient();
  await supabase.from("profiles").update({ level }).eq("id", student.id);
  redirect("/");
}

export async function updateProfile(formData: FormData) {
  const student = await requireStudent();
  const level = levelSchema.parse(formData.get("level"));
  const model = String(formData.get("model") ?? "") || null;
  const supabase = await createClient();
  const { error } = await supabase.from("profiles").update({ level, model }).eq("id", student.id);
  if (error) throw error;
  redirect("/profile?saved=1");
}

export async function askQuestion(formData: FormData) {
  const student = await requireOnboardedStudent();
  const text = String(formData.get("text") ?? "").trim();
  if (!text) return;
  const id = await createThread(student, text.slice(0, 4000));
  redirect(`/t/${id}?new=1`);
}

export async function deleteThread(formData: FormData) {
  await requireStudent();
  const id = z.uuid().parse(formData.get("id"));
  const supabase = await createClient();
  await supabase.from("threads").delete().eq("id", id);
  redirect("/");
}

export async function setBookmark(postId: string, on: boolean) {
  const student = await requireStudent();
  const supabase = await createClient();
  if (on) {
    await supabase.from("bookmarks").upsert({ user_id: student.id, post_id: postId }, { ignoreDuplicates: true });
  } else {
    await supabase.from("bookmarks").delete().eq("post_id", postId);
  }
}
