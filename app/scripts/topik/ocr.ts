// Шаг 1 подготовки TOPIK: распознаёт PDF экзаменов (сканы без текстового слоя) на Apple Vision.
// Результат — books/topik-ocr/<имя PDF>.md со страницами «## Page N». Готовые файлы пропускаются.
// Нужны собранные tools/ocr/ocr и tools/ocr/pdf2png (см. tools/ocr).
// Запуск: npm run topik:ocr            — все PDF из манифеста
//         npm run topik:ocr -- 102 83  — только эти сессии
//         npm run topik:ocr -- --check — только проверить, что все файлы на месте
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BOOKS_DIR } from "../lib/common";
import { EXAMS } from "./exams";

const TOPIK_DIR = path.join(BOOKS_DIR, "TOPIK");
export const OCR_DIR = path.join(BOOKS_DIR, "topik-ocr");
const TOOLS = path.resolve(process.cwd(), "..", "tools", "ocr");

export function ocrPath(pdf: string) {
  return path.join(OCR_DIR, `${path.basename(pdf, ".pdf")}.md`);
}

function pdfs(): string[] {
  const only = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
  const exams = only.length ? EXAMS.filter((e) => only.includes(e.session)) : EXAMS;
  const all = exams.flatMap((e) => [e.reading, ...e.keys, ...(e.listening ? [e.listening.script] : [])]);
  return [...new Set(all)];
}

function recognize(pdf: string) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "topik-"));
  try {
    execFileSync(path.join(TOOLS, "pdf2png"), [path.join(TOPIK_DIR, pdf), tmp]);
    const pages = fs
      .readdirSync(tmp)
      .filter((f) => f.endsWith(".png"))
      .sort((a, b) => parseInt(a) - parseInt(b));
    let out = "";
    for (let i = 0; i < pages.length; i += 10) {
      const batch = pages.slice(i, i + 10);
      const text = execFileSync(path.join(TOOLS, "ocr"), batch.map((f) => path.join(tmp, f)), {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      text
        .split("\x1e")
        .slice(0, batch.length)
        .forEach((page, j) => (out += `## Page ${parseInt(batch[j])}\n\n${page.trim()}\n\n`));
      process.stdout.write(`\r${pdf}: ${Math.min(i + 10, pages.length)}/${pages.length}`);
    }
    fs.writeFileSync(ocrPath(pdf), out);
    console.log();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function main() {
  const missing = pdfs().filter((p) => !fs.existsSync(path.join(TOPIK_DIR, p)));
  const audio = EXAMS.flatMap((e) => (e.listening ? [e.listening.audio] : [])).filter(
    (d) => !fs.existsSync(path.join(TOPIK_DIR, d)),
  );
  for (const m of [...missing, ...audio]) console.warn(`Нет в books/TOPIK: ${m}`);
  if (process.argv.includes("--check")) return;

  for (const tool of ["ocr", "pdf2png"]) {
    if (!fs.existsSync(path.join(TOOLS, tool))) {
      console.error(`Сначала соберите tools/ocr/${tool}: swiftc -O ${tool}.swift -o ${tool}`);
      process.exit(1);
    }
  }
  fs.mkdirSync(OCR_DIR, { recursive: true });
  for (const pdf of pdfs()) {
    if (missing.includes(pdf) || fs.existsSync(ocrPath(pdf))) continue;
    recognize(pdf);
  }
}

if (process.argv[1]?.endsWith("ocr.ts")) main();
