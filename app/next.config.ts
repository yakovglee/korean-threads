import type { NextConfig } from "next";

// Всё приложение — за входом и читает сессию на каждый запрос, поэтому
// Cache Components не включён: страницы просто динамические.
const nextConfig: NextConfig = {
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
