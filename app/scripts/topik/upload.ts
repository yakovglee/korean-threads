// Шаг 3 подготовки TOPIK: задания из books/topik-json → Supabase, аудио заданий → бакет topik-audio.
// Аудио пережимается встроенным afconvert в моно AAC (docs/SPEC.md). Экзамен загружается заново целиком.
// Запуск: npm run topik:upload            — все разобранные экзамены
//         npm run topik:upload -- 102 83  — только эти сессии
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeConstruction } from "../../src/lib/construction-name";
import { BOOKS_DIR, database } from "../lib/common";
import { EXAMS, examId, type ExamSource } from "./exams";
import { JSON_DIR, type ParsedExam } from "./parse";

const TOPIK_DIR = path.join(BOOKS_DIR, "TOPIK");
const BUCKET = "topik-audio";

// Трек задания: «1-07.mp3» — номер задания; «08 트랙 8.mp3» — трек 1 вступление, задание = трек − 1.
function trackFile(exam: ExamSource, number: number): string | null {
  const listening = exam.listening!;
  const dir = path.join(TOPIK_DIR, listening.audio);
  const files = fs.readdirSync(dir).filter((f) => /\.(mp3|wav|m4a)$/i.test(f));
  const wanted =
    listening.tracks === "dash"
      ? new RegExp(`^\\d-${String(number).padStart(2, "0")}\\.`)
      : new RegExp(`^${String(number + 1).padStart(2, "0")}\\D`);
  const file = files.find((f) => wanted.test(f));
  return file ? path.join(dir, file) : null;
}

function toAac(input: string): Buffer {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "topik-audio-")), "track.m4a");
  try {
    execFileSync("afconvert", ["-f", "m4af", "-d", "aac", "-c", "1", "-b", "48000", input, out]);
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
  }
}

async function upload(exam: ExamSource, parsed: ParsedExam, constructionId: Map<string, number>) {
  const db = database();
  const { data: row, error } = await db
    .from("exams")
    .upsert({ session: exam.session, level: exam.level }, { onConflict: "session,level" })
    .select("id")
    .single();
  if (error) throw error;
  await db.from("topik_tasks").delete().eq("exam_id", row.id);

  let audioCount = 0;
  for (const task of parsed.tasks) {
    let audioPath: string | null = null;
    if (task.section === "listening" && exam.listening) {
      const file = trackFile(exam, task.number);
      if (file) {
        audioPath = `${examId(exam)}/${task.number}.m4a`;
        const { error: audioError } = await db.storage
          .from(BUCKET)
          .upload(audioPath, toAac(file), { contentType: "audio/mp4", upsert: true });
        if (audioError) throw audioError;
        audioCount++;
      } else {
        console.warn(`${examId(exam)}: нет трека для задания ${task.number}`);
      }
    }

    const { data: inserted, error: taskError } = await db
      .from("topik_tasks")
      .insert({
        exam_id: row.id,
        section: task.section,
        number: task.number,
        instruction: task.instruction,
        passage: task.passage,
        options: task.options,
        answer: task.answer,
        explanation: task.explanation,
        script: task.script,
        audio_path: audioPath,
      })
      .select("id")
      .single();
    if (taskError) throw taskError;

    const links = new Map<number, string | null>();
    for (const c of task.constructions) {
      const id = constructionId.get(normalizeConstruction(c.name));
      if (id && !links.has(id)) links.set(id, c.form);
    }
    if (links.size) {
      const { error: linkError } = await db
        .from("topik_task_constructions")
        .insert([...links].map(([construction_id, form]) => ({ task_id: inserted.id, construction_id, form })));
      if (linkError) throw linkError;
    }
  }
  console.log(`${examId(exam)}: ${parsed.tasks.length} заданий, аудио ${audioCount}`);
}

async function main() {
  const only = process.argv.slice(2).map(Number).filter(Boolean);
  const { data: constructions, error } = await database().from("constructions").select("id, name").order("id");
  if (error) throw error;
  const constructionId = new Map<string, number>();
  for (const c of constructions) {
    const key = normalizeConstruction(c.name);
    if (!constructionId.has(key)) constructionId.set(key, c.id);
  }

  for (const exam of EXAMS) {
    if (only.length && !only.includes(exam.session)) continue;
    const file = path.join(JSON_DIR, `${examId(exam)}.json`);
    if (!fs.existsSync(file)) continue;
    await upload(exam, JSON.parse(fs.readFileSync(file, "utf8")), constructionId);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
