import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // PGlite с миграцией на каждый тест: под нагрузкой 5 секунд по умолчанию не хватает
    testTimeout: 30_000,
  },
});
