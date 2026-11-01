// Сравнение моделей эмбеддингов (docs/SPEC.md): вопросы по-русски → статьи каталога конструкций.
// Считает долю вопросов, где нужная конструкция в первой выдаче (hit@1) и в первых пяти (hit@5), и MRR.
// Запуск: npm run eval:embeddings -- baai/bge-m3 qwen/qwen3-embedding-8b
import fs from "node:fs";
import { cosineSimilarity } from "ai";
import { embedAll } from "./lib/common";
import { readCatalog } from "./lib/grammar-main";

type Case = { q: string; expect: string };

async function main() {
  const models = process.argv.slice(2).length ? process.argv.slice(2) : ["baai/bge-m3", "qwen/qwen3-embedding-8b"];
  const cases: Case[] = JSON.parse(fs.readFileSync("scripts/data/embedding-eval.json", "utf8"));
  const catalog = readCatalog();
  const docs = catalog.map((e) => `${e.name}\n${e.meaning ?? ""}\n${e.text.slice(0, 1200)}`);

  for (const model of models) {
    const [docVectors, queryVectors] = [await embedAll(docs, model), await embedAll(cases.map((c) => c.q), model)];
    let hit1 = 0;
    let hit5 = 0;
    let mrr = 0;
    const misses: string[] = [];
    cases.forEach((c, i) => {
      const ranked = docVectors
        .map((v, j) => ({ name: catalog[j].name, score: cosineSimilarity(queryVectors[i], v) }))
        .sort((a, b) => b.score - a.score);
      const names = [...new Set(ranked.map((r) => r.name))];
      const rank = names.indexOf(c.expect) + 1;
      if (rank === 1) hit1++;
      if (rank >= 1 && rank <= 5) hit5++;
      if (rank >= 1) mrr += 1 / rank;
      if (rank !== 1) misses.push(`  ${c.expect}: место ${rank || "—"}, первым ${names[0]}`);
    });
    const n = cases.length;
    console.log(`\n${model}: hit@1 ${hit1}/${n}, hit@5 ${hit5}/${n}, MRR ${(mrr / n).toFixed(3)}`);
    console.log(misses.join("\n"));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
