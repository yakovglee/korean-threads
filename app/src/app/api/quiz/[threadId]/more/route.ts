import { NextResponse, type NextRequest } from "next/server";
import { getStudent } from "@/lib/auth";
import { addMoreTasks } from "@/lib/quiz";

export const maxDuration = 120;

// Кнопка «ещё вопросы».
export async function POST(_request: NextRequest, ctx: RouteContext<"/api/quiz/[threadId]/more">) {
  const student = await getStudent();
  if (!student) return NextResponse.json({ error: "Нужно войти" }, { status: 401 });
  const { threadId } = await ctx.params;
  try {
    const added = await addMoreTasks(student, threadId);
    return NextResponse.json({ added });
  } catch (error) {
    console.error("quiz more", error);
    return NextResponse.json({ error: "Не получилось подобрать задания" }, { status: 500 });
  }
}
