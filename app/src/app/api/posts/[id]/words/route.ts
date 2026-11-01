import { NextResponse, type NextRequest } from "next/server";
import { getStudent } from "@/lib/auth";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { analyzeWords } from "@/lib/words";

// Повторный разбор слов поста, если при сохранении сервис mecab не ответил.
export async function POST(_request: NextRequest, ctx: RouteContext<"/api/posts/[id]/words">) {
  if (!(await getStudent())) return NextResponse.json({ error: "Нужно войти" }, { status: 401 });
  const { id } = await ctx.params;
  const supabase = await createClient();
  const { data: post } = await supabase.from("posts").select("id, body, words").eq("id", id).maybeSingle();
  if (!post) return NextResponse.json({ error: "Пост не найден" }, { status: 404 });
  if (post.words) return NextResponse.json({ words: post.words });

  const words = await analyzeWords(post.body);
  if (!words) return NextResponse.json({ words: null }, { status: 503 });
  await createAdminClient().from("posts").update({ words }).eq("id", id);
  return NextResponse.json({ words });
}
