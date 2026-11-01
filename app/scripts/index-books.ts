// Индексация базы знаний: учебники из books/md и статьи каталога → фрагменты с эмбеддингами в Supabase.
// Запуск: npm run index            — все книги
//         npm run index -- kgiu-1  — только указанные (slug)
// Книга индексируется заново целиком: её старые фрагменты удаляются.
import fs from "node:fs";
import path from "node:path";
import { toVector } from "../src/lib/embedding";
import { BOOKS_DIR, chunkText, database, embedAll } from "./lib/common";
import { readCatalog } from "./lib/grammar-main";

// Состав базы знаний — docs/SPEC.md. Сторонние TOPIK-сборники не входят (ADR 0004).
const BOOKS = [
  { slug: "niied-1", file: "1. NIIED_초급.md", title: "NIIED 초급" },
  { slug: "niied-2", file: "2. NIIED_중급.md", title: "NIIED 중급" },
  { slug: "kgiu-1", file: "1_Korean_Grammar_in_Use_Beginner.md", title: "Korean Grammar in Use 1" },
  { slug: "kgiu-2", file: "2_Korean_Grammar_in_Use_Intermediate.md", title: "Korean Grammar in Use 2" },
  { slug: "kgiu-3", file: "3_Korean_Grammar_in_Use_Advance.md", title: "Korean Grammar in Use 3" },
  { slug: "ramstedt", file: "korean_grammar.md", title: "A Korean Grammar (Ramstedt)" },
  { slug: "wongwan-1", file: "vongvan.md", title: "Вон Гван · Курс для продолжающих" },
  { slug: "wongwan-2", file: "Von_Gvan_-_Osnovnoy_kurs.md", title: "Вон Гван · Основной курс" },
  { slug: "kiip-1", file: "KIIP_1.md", title: "KIIP 1" },
  { slug: "kiip-2", file: "KIIP_2.md", title: "KIIP 2" },
  { slug: "kiip-3", file: "KIIP_3.md", title: "KIIP 3" },
  { slug: "kiip-4", file: "KIIP_4.md", title: "KIIP 4" },
];
const CATALOG = { slug: "grammar-main", title: "한국어교수학습샘터" };

type Chunk = { page: number | null; label: string | null; construction_id: number | null; content: string };

// Страницы вида «## Page N». Номер — страница PDF, он может не совпадать с напечатанным.
function bookChunks(file: string): Chunk[] {
  const text = fs.readFileSync(path.join(BOOKS_DIR, "md", file), "utf8");
  const chunks: Chunk[] = [];
  const parts = text.split(/^## Page (\d+)\s*$/m);
  for (let i = 1; i < parts.length; i += 2) {
    const page = Number(parts[i]);
    const clean = (parts[i + 1] ?? "").replace(/\*\[Image OCR\]/g, "").trim();
    if (clean.replace(/\s/g, "").length < 80) continue;
    for (const content of chunkText(clean)) chunks.push({ page, label: null, construction_id: null, content });
  }
  return chunks;
}

async function catalogChunks(): Promise<Chunk[]> {
  const { data, error } = await database().from("constructions").select("id, key");
  if (error) throw error;
  if (data.length === 0) throw new Error("Каталог пуст: сначала npm run catalog");
  const idOf = new Map(data.map((c) => [c.key, c.id]));
  return readCatalog().flatMap((entry) =>
    chunkText(entry.text).map((content) => ({
      page: null,
      label: entry.name,
      construction_id: idOf.get(entry.key) ?? null,
      content: `${entry.name}\n${content}`,
    })),
  );
}

async function index(slug: string, title: string, chunks: Chunk[]) {
  const db = database();
  const { data: book, error } = await db
    .from("books")
    .upsert({ slug, title }, { onConflict: "slug" })
    .select("id")
    .single();
  if (error) throw error;

  const started = Date.now();
  const embeddings = await embedAll(
    chunks.map((c) => c.content),
    undefined,
    (done) => process.stdout.write(`\r${title}: ${done}/${chunks.length}`),
  );

  await db.from("chunks").delete().eq("book_id", book.id);
  const rows = chunks.map((c, i) => ({ ...c, book_id: book.id, embedding: toVector(embeddings[i]) }));
  for (let i = 0; i < rows.length; i += 200) {
    const { error: insertError } = await db.from("chunks").insert(rows.slice(i, i + 200));
    if (insertError) throw insertError;
  }
  console.log(`\r${title}: ${rows.length} фрагментов за ${Math.round((Date.now() - started) / 1000)} с`);
}

async function main() {
  const only = new Set(process.argv.slice(2));
  const pick = (slug: string) => only.size === 0 || only.has(slug);

  if (pick(CATALOG.slug)) await index(CATALOG.slug, CATALOG.title, await catalogChunks());
  for (const book of BOOKS) {
    if (!pick(book.slug)) continue;
    if (!fs.existsSync(path.join(BOOKS_DIR, "md", book.file))) {
      console.warn(`Нет файла books/md/${book.file}, пропускаю`);
      continue;
    }
    await index(book.slug, book.title, bookChunks(book.file));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
