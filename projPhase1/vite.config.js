import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // 相对路径：dist 可以被放在任意子路径下服务（我们用 serve.mjs 从 /dist/ 直接看）
  base: "./",
  plugins: [react()],

  build: {
    target: "es2022",
    outDir: "dist",
    rollupOptions: {
      input: {
        main: "index.html",
        smoke: "smoke.html"      // 依赖冒烟页，验证完可删
      }
    }
  },

  server: {
    host: "127.0.0.1",
    port: 8100,
    strictPort: true
  }
});
