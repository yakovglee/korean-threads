import "server-only";
import { generateText, Output } from "ai";
import { z } from "zod";
import { chatModel, costOf, recordUsage } from "@/lib/ai";
import type { Student } from "@/lib/auth";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import type { Json } from "@/lib/supabase/database.types";
import type {
  AttemptResult,
  Level,
  QuizItemContent,
  QuizItemKind,
  QuizItemView,
  QuizSolution,
} from "@/lib/types";

// Правила подбора — docs/adr/0005-topik-task-matching.md.
const READING_PER_BATCH = 3;
const MIN_READING = 2;

type ConstructionTag = { id: number; name: string; level: Level | null };

type NewItem = {
  kind: QuizItemKind;
  topik_task_id?: number | null;
  construction_id: number;
  content: QuizItemContent;
  solution: QuizSolution | null;
};

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function threadConstructions(threadId: string): Promise<ConstructionTag[]> {
  const { data } = await createAdminClient()
    .from("thread_tags")
    .select("construction_id, value, level")
    .eq("thread_id", threadId)
    .eq("kind", "construction")
    .not("construction_id", "is", null);
  return (data ?? []).map((t) => ({ id: t.construction_id!, name: t.value, level: t.level }));
}

async function topikItems(constructions: ConstructionTag[], usedTaskIds: Set<number>): Promise<NewItem[]> {
  const admin = createAdminClient();
  const ids = constructions.map((c) => c.id);
  const { data: links } = await admin
    .from("topik_task_constructions")
    .select("task_id, construction_id, form")
    .in("construction_id", ids)
    .limit(500);
  const fresh = (links ?? []).filter((l) => !usedTaskIds.has(l.task_id));
  if (fresh.length === 0) return [];

  const { data: tasks } = await admin
    .from("topik_tasks")
    .select("id, exam_id, section, number, instruction, passage, options, answer, explanation, script, audio_path")
    .in("id", [...new Set(fresh.map((l) => l.task_id))].slice(0, 200));
  const { data: exams } = await admin.from("exams").select("id, session");
  const session = new Map((exams ?? []).map((e) => [e.id, e.session]));
  const nameOf = new Map(constructions.map((c) => [c.id, c.name]));

  const reading = shuffle((tasks ?? []).filter((t) => t.section === "reading")).slice(0, READING_PER_BATCH);
  const listening = shuffle((tasks ?? []).filter((t) => t.section === "listening" && t.audio_path)).slice(0, 1);

  return [...reading, ...listening].map((t) => {
    const link = fresh.find((l) => l.task_id === t.id)!;
    const section = t.section === "reading" ? "읽기" : "듣기";
    return {
      kind: t.section as "reading" | "listening",
      topik_task_id: t.id,
      construction_id: link.construction_id,
      content: {
        instruction: t.instruction,
        passage: t.section === "reading" ? t.passage : null,
        options: t.options,
        source: `📝 TOPIK ${session.get(t.exam_id)}회 ${section} №${t.number}`,
        construction: nameOf.get(link.construction_id),
      },
      solution: {
        answer: t.answer,
        explanation: t.explanation,
        script: t.section === "listening" ? t.script : null,
        form: link.form,
      },
    };
  });
}

const generatedSchema = z.object({
  tasks: z.array(
    z.object({
      instruction: z.string().describe("Инструкция по-корейски, как в TOPIK"),
      passage: z.string().describe("1–3 корейских предложения с пропуском ( ) или подчёркнутой частью <u>…</u>"),
      options: z.array(z.string()).describe("Ровно 4 варианта, один верный"),
      answer: z.number().describe("Номер верного варианта, 1–4"),
      explanation: z.string().describe("Короткое объяснение по-русски на «ты», 1–2 предложения"),
    }),
  ),
});

// Сгенерированное задание — когда подходящего задания TOPIK нет. Всегда помечено.
async function generatedItems(student: Student, construction: ConstructionTag, count: number): Promise<NewItem[]> {
  const level = construction.level ?? student.level ?? "초급";
  const result = await generateText({
    model: chatModel(student.model),
    output: Output.object({ schema: generatedSchema }),
    instructions:
      "Ты составляешь задания в формате экзамена TOPIK для ученика, который учит корейский. Инструкции и тексты — по-корейски, объяснения — по-русски.",
    prompt: `Составь ${count} задания на конструкцию ${construction.name} (уровень ${level}).
Каждое задание прямо проверяет эту конструкцию: вставить пропуск («( )에 들어갈 가장 알맞은 것을 고르십시오.») или выбрать близкое по смыслу («밑줄 친 부분과 의미가 비슷한 것을 고르십시오.»).
Неверные варианты — правдоподобные: похожие конструкции, а не случайные слова. Верный ответ ставь на разные позиции.`,
  });
  await recordUsage({
    userId: student.id,
    model: student.model,
    kind: "quiz",
    cost: result.steps.reduce((sum, step) => sum + costOf(step.providerMetadata), 0),
    inputTokens: result.totalUsage.inputTokens,
    outputTokens: result.totalUsage.outputTokens,
  });
  return result.output.tasks
    .filter((t) => t.options.length === 4 && Number.isInteger(t.answer) && t.answer >= 1 && t.answer <= 4)
    .slice(0, count)
    .map((t) => ({
      kind: "generated",
      construction_id: construction.id,
      content: {
        instruction: t.instruction,
        passage: t.passage,
        options: t.options,
        source: "🤖 Сгенерированное задание",
        construction: construction.name,
      },
      solution: { answer: t.answer, explanation: t.explanation },
    }));
}

async function addBatch(student: Student, quizId: string, threadId: string, batch: number): Promise<number> {
  const admin = createAdminClient();
  const constructions = await threadConstructions(threadId);
  if (constructions.length === 0) return 0;

  const { data: existing } = await admin.from("quiz_items").select("topik_task_id").eq("quiz_id", quizId);
  const used = new Set((existing ?? []).map((i) => i.topik_task_id).filter((id): id is number => id !== null));

  const items = await topikItems(constructions, used);
  const main = constructions[batch % constructions.length];
  const readingCount = items.filter((i) => i.kind === "reading").length;
  if (readingCount < MIN_READING) {
    items.push(...(await generatedItems(student, main, READING_PER_BATCH - readingCount)));
  }
  items.push({
    kind: "own_sentence",
    construction_id: main.id,
    content: {
      instruction: `Придумай своё предложение с ${main.name} — я проверю 😉`,
      source: "✍️ Своё предложение",
      construction: main.name,
    },
    solution: null,
  });

  const { error } = await admin.from("quiz_items").insert(
    items.map((item, position) => ({
      quiz_id: quizId,
      user_id: student.id,
      batch,
      position,
      kind: item.kind,
      topik_task_id: item.topik_task_id ?? null,
      construction_id: item.construction_id,
      content: item.content as unknown as { [key: string]: Json },
      solution: item.solution as unknown as Json,
    })),
  );
  if (error) throw error;
  return items.length;
}

export async function createQuiz(student: Student, threadId: string) {
  const { data: quiz, error } = await createAdminClient()
    .from("quizzes")
    .insert({ thread_id: threadId, user_id: student.id })
    .select("id")
    .single();
  if (error) throw error;
  await addBatch(student, quiz.id, threadId, 0);
}

// «Ещё вопросы»: новая порция заданий без повторов.
export async function addMoreTasks(student: Student, threadId: string): Promise<boolean> {
  const supabase = await createClient();
  const { data: quiz } = await supabase.from("quizzes").select("id").eq("thread_id", threadId).maybeSingle();
  if (!quiz) return false;
  const { data: last } = await supabase
    .from("quiz_items")
    .select("batch")
    .eq("quiz_id", quiz.id)
    .order("batch", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (await addBatch(student, quiz.id, threadId, (last?.batch ?? -1) + 1)) > 0;
}

// Квиз треда для страницы. Решение отдаём только по заданиям, на которые уже ответили.
export async function loadQuiz(threadId: string): Promise<QuizItemView[] | null> {
  const supabase = await createClient();
  const { data: quiz } = await supabase.from("quizzes").select("id").eq("thread_id", threadId).maybeSingle();
  if (!quiz) return null;
  const { data: items } = await supabase
    .from("quiz_items")
    .select("id, batch, position, kind, content")
    .eq("quiz_id", quiz.id)
    .order("batch")
    .order("position");
  if (!items?.length) return [];

  const ids = items.map((i) => i.id);
  const { data: attempts } = await supabase
    .from("attempts")
    .select("quiz_item_id, choice, sentence, correct, feedback, created_at")
    .in("quiz_item_id", ids)
    .order("created_at", { ascending: false });
  const latest = new Map<string, NonNullable<typeof attempts>[number]>();
  for (const a of attempts ?? []) if (!latest.has(a.quiz_item_id)) latest.set(a.quiz_item_id, a);

  const answered = ids.filter((id) => latest.has(id));
  const { data: solutions } = answered.length
    ? await createAdminClient().from("quiz_items").select("id, solution").in("id", answered)
    : { data: [] };
  const solutionOf = new Map((solutions ?? []).map((s) => [s.id, s.solution as QuizSolution | null]));

  return items.map((item) => {
    const a = latest.get(item.id);
    return {
      id: item.id,
      batch: item.batch,
      kind: item.kind as QuizItemKind,
      content: item.content as QuizItemContent,
      attempt: a
        ? {
            correct: a.correct,
            choice: a.choice,
            sentence: a.sentence,
            feedback: a.feedback,
            solution: solutionOf.get(item.id) ?? null,
          }
        : null,
    };
  });
}

async function ownItem(student: Student, itemId: string) {
  const { data } = await createAdminClient()
    .from("quiz_items")
    .select("id, user_id, kind, content, solution, topik_task_id")
    .eq("id", itemId)
    .maybeSingle();
  return data && data.user_id === student.id ? data : null;
}

export async function answerChoice(student: Student, itemId: string, choice: number): Promise<AttemptResult | null> {
  const item = await ownItem(student, itemId);
  if (!item || item.kind === "own_sentence") return null;
  const solution = item.solution as QuizSolution;
  const { data: earlier } = await createAdminClient()
    .from("attempts")
    .select("choice, correct")
    .eq("quiz_item_id", itemId)
    .limit(1)
    .maybeSingle();
  if (earlier) return { correct: earlier.correct, choice: earlier.choice, sentence: null, feedback: null, solution };
  const correct = solution.answer === choice;
  await createAdminClient().from("attempts").insert({ user_id: student.id, quiz_item_id: itemId, choice, correct });
  return { correct, choice, sentence: null, feedback: null, solution };
}

const checkSchema = z.object({
  correct: z.boolean().describe("Предложение грамматически верно и конструкция употреблена к месту"),
  feedback: z.string().describe("2–4 предложения по-русски на «ты»: что хорошо, что исправить, исправленный вариант"),
});

// «Своё предложение» проверяет бот.
export async function answerSentence(student: Student, itemId: string, sentence: string): Promise<AttemptResult | null> {
  const item = await ownItem(student, itemId);
  if (!item || item.kind !== "own_sentence") return null;
  const construction = (item.content as QuizItemContent).construction ?? "";
  const result = await generateText({
    model: chatModel(student.model),
    output: Output.object({ schema: checkSchema }),
    instructions:
      "Ты проверяешь корейское предложение ученика. Тон дружелюбный, на «ты», 1 эмодзи. Корейские примеры — с переводом.",
    prompt: `Конструкция: ${construction}. Уровень ученика: ${student.level ?? "초급"}.\nПредложение ученика: ${sentence}`,
  });
  await recordUsage({
    userId: student.id,
    model: student.model,
    kind: "check",
    cost: result.steps.reduce((sum, step) => sum + costOf(step.providerMetadata), 0),
    inputTokens: result.totalUsage.inputTokens,
    outputTokens: result.totalUsage.outputTokens,
  });
  const { correct, feedback } = result.output;
  await createAdminClient()
    .from("attempts")
    .insert({ user_id: student.id, quiz_item_id: itemId, sentence, correct, feedback });
  return { correct, choice: null, sentence, feedback, solution: null };
}

export async function audioUrl(student: Student, itemId: string): Promise<string | null> {
  const item = await ownItem(student, itemId);
  if (!item || item.kind !== "listening" || !item.topik_task_id) return null;
  const admin = createAdminClient();
  const { data: task } = await admin.from("topik_tasks").select("audio_path").eq("id", item.topik_task_id).single();
  if (!task?.audio_path) return null;
  const { data } = await admin.storage.from("topik-audio").createSignedUrl(task.audio_path, 3600);
  return data?.signedUrl ?? null;
}
