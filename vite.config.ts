import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const API_TARGET = process.env.TOKMON_API_URL ?? "http://localhost:3000";

export default defineConfig({
  root: path.resolve("src/web"),
  plugins: [react(), tailwindcss()],
  build: {
    outDir: path.resolve("dist/web"),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: false,
    open: true,
    proxy: {
      "^/api/": {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  },
});
