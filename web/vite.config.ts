/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // dev 代理本地服务（REST + SSE 同源）
      "/api": { target: "http://127.0.0.1:3999", changeOrigin: true },
    },
  },
  test: {
    environment: "node", // 布局纯函数测试跑 node 环境，无需 DOM
  },
});
