// 仅供沙盒里的浏览器预览（演示模式，无 Electron）；正式构建用 electron.vite.config.ts
import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  root: resolve("src/renderer"),
  base: "./",
  resolve: { alias: { "@renderer": resolve("src/renderer/src") } },
  plugins: [react()],
  server: { host: "0.0.0.0", port: 5173, strictPort: true, allowedHosts: true, cors: true },
  cacheDir: resolve("node_modules/.vite-preview"),
});
