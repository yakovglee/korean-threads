import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getStudent } from "@/lib/auth";
import { answerChoice, answerSentence } from "@/lib/quiz";

export const maxDuration = 60;

const body = z.union([
  z.object({ choice: z.number().int().min(1).max(4) }),
  z.object({ sentence: z.string().trim().min(1).max(500) }),
]);

// Попытка: вариант ответа или своё предложение. Возвращает результат и решение.
export async function POST(request: NextRequest, ctx: RouteContext<"/api/quiz/items/[id]/attempt">) {
  const student = await getStudent();
  if (!student) return NextResponse.json({ error: "Нужно войти" }, { status: 401 });
  const { id } = await ctx.params;
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Неверный запрос" }, { status: 400 });

  try {
    const result =
      "choice" in parsed.data
        ? await answerChoice(student, id, parsed.data.choice)
        : await answerSentence(student, id, parsed.data.sentence);
    return result ? NextResponse.json(result) : NextResponse.json({ error: "Задание не найдено" }, { status: 404 });
  } catch (error) {
    console.error("attempt", error);
    return NextResponse.json({ error: "Не получилось проверить" }, { status: 500 });
  }
}
