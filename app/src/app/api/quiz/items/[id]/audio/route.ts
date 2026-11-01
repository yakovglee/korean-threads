import { NextResponse, type NextRequest } from "next/server";
import { getStudent } from "@/lib/auth";
import { audioUrl } from "@/lib/quiz";

// Аудио задания на аудирование: подписанная ссылка на приватный бакет.
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/quiz/items/[id]/audio">) {
  const student = await getStudent();
  if (!student) return NextResponse.json({ error: "Нужно войти" }, { status: 401 });
  const { id } = await ctx.params;
  const url = await audioUrl(student, id);
  return url ? NextResponse.redirect(url) : NextResponse.json({ error: "Аудио не найдено" }, { status: 404 });
}
