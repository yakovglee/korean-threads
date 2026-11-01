"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/server";

// Каждое действие админки заново проверяет, что его вызывает админ.

export async function addAccess(formData: FormData) {
  await requireAdmin();
  const email = z.email().parse(String(formData.get("email") ?? "").trim().toLowerCase());
  await createAdminClient()
    .from("access_list")
    .upsert({ email, is_admin: formData.get("is_admin") === "on" }, { onConflict: "email" });
  revalidatePath("/admin");
}

export async function removeAccess(formData: FormData) {
  const admin = await requireAdmin();
  const email = z.email().parse(formData.get("email"));
  if (email === admin.email) return; // себя не удаляем, иначе админка закроется
  await createAdminClient().from("access_list").delete().eq("email", email);
  revalidatePath("/admin");
}

export async function addModel(formData: FormData) {
  await requireAdmin();
  const id = z.string().trim().regex(/^[\w.-]+\/[\w.:-]+$/).parse(formData.get("id"));
  const label = z.string().trim().min(1).parse(formData.get("label"));
  const db = createAdminClient();
  const { count } = await db.from("models").select("id", { count: "exact", head: true });
  await db.from("models").upsert({ id, label, enabled: true, position: count ?? 0 }, { onConflict: "id" });
  revalidatePath("/admin");
}

export async function toggleModel(formData: FormData) {
  await requireAdmin();
  const id = z.string().parse(formData.get("id"));
  const enabled = formData.get("enabled") === "true";
  await createAdminClient().from("models").update({ enabled }).eq("id", id);
  revalidatePath("/admin");
}

export async function removeModel(formData: FormData) {
  await requireAdmin();
  const id = z.string().parse(formData.get("id"));
  await createAdminClient().from("models").delete().eq("id", id);
  revalidatePath("/admin");
}

export async function setDefaultModel(formData: FormData) {
  await requireAdmin();
  const id = z.string().parse(formData.get("id"));
  await createAdminClient().from("app_settings").upsert({ id: true, default_model: id });
  revalidatePath("/admin");
}
