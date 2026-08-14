#!/usr/bin/env node
// Contextus Web 本地服务入口
// 用法: npm run server -- --cwd <仓库>    （默认当前目录；端口 3999 可用 CONTEXTUS_PORT 覆盖）
import path from "node:path";
import { createApp } from "./app.js";

function parseCwd(): string {
  const i = process.argv.indexOf("--cwd");
  return i >= 0 ? path.resolve(process.argv[i + 1] ?? ".") : process.cwd();
}

const PORT = parseInt(process.env.CONTEXTUS_PORT ?? "3999", 10);
const cwd = parseCwd();
const app = createApp({ cwd });

await app.listen({ port: PORT, host: "127.0.0.1" });
console.log(`Contextus web server: http://127.0.0.1:${PORT}  (仓库 ${cwd})`);
console.log("  API  http://127.0.0.1:3999/api/tree · SSE /api/events");
console.log("  提示: web 界面由 Vite dev (web/) 代理本服务；prod 产物由本服务托管");
