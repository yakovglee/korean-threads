import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getStudent } from "@/lib/auth";
import { generateAnswer } from "@/lib/bot";
import { addStudentPost } from "@/lib/threads";
import type { PostView } from "@/lib/types";

export const maxDuration = 300;

const body = z.object({
  text: z.string().trim().min(1).max(4000).optional(),
  quoteId: z.uuid().optional(),
});

// Уточнение (если передан text) и ответ бота потоком NDJSON: по событию на строку.
export async function POST(request: NextRequest, ctx: RouteContext<"/api/threads/[id]/answer">) {
  const student = await getStudent();
  if (!student?.level) return NextResponse.json({ error: "Нужно войти" }, { status: 401 });
  const { id } = await ctx.params;
  const parsed = body.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Неверный запрос" }, { status: 400 });

  let studentPost: PostView | null = null;
  if (parsed.data.text) {
    studentPost = await addStudentPost(student, id, parsed.data.text, parsed.data.quoteId ?? null);
    if (!studentPost) return NextResponse.json({ error: "Тред не найден" }, { status: 404 });
  }

  const level = student.level;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        if (studentPost) controller.enqueue(encoder.encode(`${JSON.stringify({ type: "post", post: studentPost })}\n`));
        for await (const event of generateAnswer({ ...student, level }, id)) {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        }
      } catch (error) {
        console.error("answer stream", error);
        controller.enqueue(encoder.encode(`${JSON.stringify({ type: "error", message: "Что-то сломалось" })}\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
}
