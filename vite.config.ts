import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig(({ command }) => ({
  base: "./",
  plugins: [
    react(),
    ...(command === "serve"
      ? [
          {
            name: "development-csp",
            transformIndexHtml: {
              order: "pre" as const,
              handler: (html: string) =>
                html.replace(
                  "script-src 'self'",
                  "script-src 'self' 'unsafe-inline'",
                ),
            },
          },
        ]
      : []),
  ],
  build: { outDir: "dist/renderer" },
  test: { environment: "node" },
}));
