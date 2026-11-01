// Шаг 2 подготовки TOPIK: страницы экзаменов (картинка + текст OCR) → задания, ответы из ключа,
// скрипты аудирования и теги конструкций. Разовая обработка через модель OpenRouter (docs/SPEC.md).
// Результат — books/topik-json/<сессия>-<уровень>.json; готовые файлы пропускаются.
// Запуск: npm run topik:parse            — все экзамены
//         npm run topik:parse -- 102 83  — только эти сессии
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateText, Output, type ModelMessage } from "ai";
import { z } from "zod";
import { normalizeConstruction } from "../../src/lib/construction-name";
import { BOOKS_DIR, openrouter } from "../lib/common";
import { readCatalog } from "../lib/grammar-main";
import { EXAMS, examId, type ExamSource } from "./exams";
import { ocrPath } from "./ocr";

const MODEL = process.env.TOPIK_MODEL || "anthropic/claude-sonnet-5.5";
export const JSON_DIR = path.join(BOOKS_DIR, "topik-json");
const TOPIK_DIR = path.join(BOOKS_DIR, "TOPIK");
const PDF2PNG = path.resolve(process.cwd(), "..", "tools", "ocr", "pdf2png");

type Section = "reading" | "listening";

export type ParsedTask = {
  section: Section;
  number: number;
  instruction: string;
  passage: string | null;
  options: string[];
  answer: number;
  script: string | null;
  explanation: string | null;
  constructions: { name: string; form: string | null }[];
};

export type ParsedExam = { session: number; level: "I" | "II"; tasks: ParsedTask[] };

type Page = { n: number; text: string; image: Buffer };

// Страницы PDF: текст из шага OCR и картинка для сверки.
function readPages(pdf: string): Page[] {
  const ocr = fs.readFileSync(ocrPath(pdf), "utf8").split(/^## Page (\d+)\s*$/m);
  const text = new Map<number, string>();
  for (let i = 1; i < ocr.length; i += 2) text.set(Number(ocr[i]), ocr[i + 1].trim());

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "topik-"));
  try {
    execFileSync(PDF2PNG, [path.join(TOPIK_DIR, pdf), tmp, "2"]);
    return fs
      .readdirSync(tmp)
      .filter((f) => f.endsWith(".png"))
      .map((f) => parseInt(f))
      .sort((a, b) => a - b)
      .map((n) => ({ n, text: text.get(n) ?? "", image: fs.readFileSync(path.join(tmp, `${n}.png`)) }));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function pagesMessage(intro: string, pages: Page[]): ModelMessage[] {
  return [
    {
      role: "user",
      content: [
        { type: "text", text: `${intro}\n\n${pages.map((p) => `### Страница ${p.n} (OCR)\n${p.text}`).join("\n\n")}` },
        ...pages.map((p) => ({ type: "image" as const, image: p.image, mediaType: "image/png" })),
      ],
    },
  ];
}

const model = () => openrouter()(MODEL, { usage: { include: true } });

const extractedSchema = z.object({
  tasks: z.array(
    z.object({
      number: z.number(),
      instruction: z.string(),
      passage: z.string().nullable(),
      options: z.array(z.string()),
      script: z.string().nullable(),
    }),
  ),
});

async function extractTasks(exam: ExamSource, pdf: string, section: Section) {
  const pages = readPages(pdf);
  const found = new Map<number, z.infer<typeof extractedSchema>["tasks"][number]>();
  const name = section === "reading" ? "읽기 (чтение)" : "듣기 (аудирование, буклет со скриптами)";
  // Окна по три страницы с шагом два: текст и вопросы к нему бывают на соседних страницах.
  for (let i = 0; i < pages.length; i += 2) {
    const window = pages.slice(i, i + 3);
    const { output } = await generateText({
      model: model(),
      output: Output.object({ schema: extractedSchema }),
      messages: pagesMessage(
        `Это страницы ${window[0].n}–${window.at(-1)!.n} экзамена TOPIK ${exam.level}, ${exam.session}회, раздел ${name}.
Даны картинки страниц и распознанный текст (в нём бывают ошибки — сверяйся с картинкой).
Извлеки задания с выбором ответа, которые целиком видны на этих страницах:
- number — номер задания, как напечатан;
- instruction — общая инструкция группы без номеров в квадратных скобках, например «다음은 무엇에 대한 글인지 고르십시오.»;
- passage — текст задания (у заданий с общим текстом — этот текст у каждого); null, если текста нет;
- options — четыре варианта ①–④ без значков; если варианты — картинки, задание пропусти;
- script — текст аудиозаписи задания, если он напечатан; иначе null.
Задания на письмо (쓰기) пропускай. Переписывай текст точно, исправляя ошибки распознавания по картинке. Подчёркнутое оборачивай в <u>…</u>, пропуск пиши как ( ).`,
        window,
      ),
    });
    for (const task of output.tasks) {
      if (task.options.length !== 4) continue;
      const prev = found.get(task.number);
      if (!prev || (task.passage?.length ?? 0) > (prev.passage?.length ?? 0)) found.set(task.number, task);
    }
    process.stdout.write(`\r${examId(exam)} ${section}: стр. ${window.at(-1)!.n}/${pages.length}, заданий ${found.size}`);
  }
  console.log();
  return [...found.values()];
}

const keySchema = z.object({
  listening: z.array(z.object({ number: z.number(), answer: z.number() })),
  reading: z.array(z.object({ number: z.number(), answer: z.number() })),
});

async function readKeys(exam: ExamSource) {
  const answers = { listening: new Map<number, number>(), reading: new Map<number, number>() };
  for (const pdf of exam.keys) {
    const { output } = await generateText({
      model: model(),
      output: Output.object({ schema: keySchema }),
      messages: pagesMessage(
        `Это ключ ответов (정답표) экзамена TOPIK ${exam.level}, ${exam.session}회. Для разделов 듣기 и 읽기 выпиши номер задания и номер правильного варианта (1–4; ① = 1). 쓰기 пропусти. Если раздела в ключе нет — пустой список.`,
        readPages(pdf),
      ),
    });
    for (const k of output.listening) answers.listening.set(k.number, k.answer);
    for (const k of output.reading) answers.reading.set(k.number, k.answer);
  }
  return answers;
}

const tagSchema = z.object({
  items: z.array(
    z.object({
      number: z.number(),
      constructions: z.array(z.object({ name: z.string(), form: z.string().nullable() })),
      explanation: z.string(),
    }),
  ),
});

// Теги по правилам ADR 0005: чтение — конструкцию прямо проверяют; аудирование — она звучит в скрипте.
async function tagTasks(exam: ExamSource, section: Section, tasks: Omit<ParsedTask, "constructions" | "explanation">[]) {
  const catalog = readCatalog();
  const names = [...new Set(catalog.map((e) => e.name))];
  const known = new Map(names.map((n) => [normalizeConstruction(n), n]));
  const rule =
    section === "reading"
      ? "конструкции, которые задание прямо проверяет: вставить пропуск или выбрать близкое по смыслу к подчёркнутому. Если задание проверяет понимание текста, а не конструкцию, — пустой список"
      : "конструкции, которые звучат в скрипте (3–6 самых заметных)";
  const out = new Map<number, { constructions: ParsedTask["constructions"]; explanation: string }>();

  for (let i = 0; i < tasks.length; i += 10) {
    const batch = tasks.slice(i, i + 10);
    const { output } = await generateText({
      model: model(),
      output: Output.object({ schema: tagSchema }),
      prompt: `Задания TOPIK ${exam.level} (${exam.session}회), раздел ${section === "reading" ? "чтение" : "аудирование"}.
Для каждого задания укажи:
- constructions — ${rule}. Имена ровно как в каталоге ниже; form — как конструкция написана в тексте (например, в «먹었더라고요» — «더라고요»);
- explanation — 1–2 предложения по-русски на «ты»: почему верен указанный ответ.

Каталог: ${names.join("; ")}

${JSON.stringify(batch, null, 1)}`,
    });
    for (const item of output.items) {
      out.set(item.number, {
        explanation: item.explanation,
        constructions: item.constructions
          .map((c) => ({ name: known.get(normalizeConstruction(c.name)) ?? "", form: c.form }))
          .filter((c) => c.name),
      });
    }
  }
  return out;
}

async function parseExam(exam: ExamSource): Promise<ParsedExam> {
  const keys = await readKeys(exam);
  const tasks: ParsedTask[] = [];
  const sections: [Section, string][] = [["reading", exam.reading]];
  if (exam.listening) sections.push(["listening", exam.listening.script]);

  for (const [section, pdf] of sections) {
    const extracted = (await extractTasks(exam, pdf, section)).filter((t) =>
      // В TOPIK I чтение — задания 31–70 общего буклета; в TOPIK II у аудирования 51–54 — письмо.
      section === "reading" ? exam.level === "II" || t.number >= 31 : t.number <= (exam.level === "I" ? 30 : 50),
    );
    const withAnswers = extracted.flatMap((t) => {
      const answer = keys[section].get(t.number);
      return answer && answer >= 1 && answer <= 4
        ? [{ ...t, section, answer, script: section === "listening" ? t.script : null }]
        : [];
    });
    const tags = await tagTasks(exam, section, withAnswers);
    for (const t of withAnswers) {
      const tag = tags.get(t.number);
      tasks.push({ ...t, explanation: tag?.explanation ?? null, constructions: tag?.constructions ?? [] });
    }
  }
  return { session: exam.session, level: exam.level, tasks };
}

async function main() {
  const only = process.argv.slice(2).map(Number).filter(Boolean);
  fs.mkdirSync(JSON_DIR, { recursive: true });
  for (const exam of EXAMS) {
    if (only.length && !only.includes(exam.session)) continue;
    const out = path.join(JSON_DIR, `${examId(exam)}.json`);
    if (fs.existsSync(out)) continue;
    if (exam.keys.length === 0) {
      console.warn(`${examId(exam)}: нет ключа ответов, пропускаю`);
      continue;
    }
    const missing = [exam.reading, ...exam.keys, ...(exam.listening ? [exam.listening.script] : [])].filter(
      (pdf) => !fs.existsSync(ocrPath(pdf)),
    );
    if (missing.length) {
      console.warn(`${examId(exam)}: сначала npm run topik:ocr (нет ${missing.join(", ")})`);
      continue;
    }
    const parsed = await parseExam(exam);
    fs.writeFileSync(out, JSON.stringify(parsed, null, 1));
    const tagged = parsed.tasks.filter((t) => t.constructions.length).length;
    console.log(`${examId(exam)}: ${parsed.tasks.length} заданий, с тегами ${tagged}`);
  }
}

if (process.argv[1]?.endsWith("parse.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
