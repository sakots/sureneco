import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig({
  base: "./",
  plugins: [react()],
  server: {
    watch: {
      // Tauri watches native sources; Vite must not traverse SDKs/build caches.
      ignored: [/(?:^|[\\/])(?:\.android-sdk|src-tauri|release)(?:[\\/]|$)/],
    },
  },
  build: { outDir: "dist/renderer" },
  test: { environment: "node" },
});
