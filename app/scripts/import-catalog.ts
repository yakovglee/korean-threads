// Каталог конструкций из GRAMMAR_MAIN.md → таблица constructions. Эмбеддинги не нужны.
// Запуск: npm run catalog
import { database } from "./lib/common";
import { readCatalog } from "./lib/grammar-main";

async function main() {
  const entries = readCatalog();
  const unique = [...new Map(entries.map((e) => [e.key, e])).values()];

  const { error } = await database()
    .from("constructions")
    .upsert(
      unique.map((e) => ({ key: e.key, name: e.name, pos: e.pos, level: e.level, meaning: e.meaning })),
      { onConflict: "key" },
    );
  if (error) throw error;

  const names = new Set(unique.map((e) => e.name));
  console.log(`Каталог: ${unique.length} статей, ${names.size} конструкций.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
