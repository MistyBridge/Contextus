// Fastify 应用工厂：树快照 / 节点操作 / SSE + tip 指纹轮询
// 单进程绑定一个目标仓库 cwd（本地单用户应用，MVP 不做多仓库切换）
// prod 形态：同时托管 web/dist（dev 形态走 Vite 5173 代理 /api）
import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { isTwin, worldlines } from "../../src/twin.js";
import { buildTreeSnapshot } from "./tree.js";
import { EventHub, startTreePoller } from "./events.js";
import { ApiFail, SessionActions, type SpawnTerminal } from "./actions.js";
import type { ApiErrorKind } from "../../src/web-api.js";

const HTTP_STATUS: Record<ApiErrorKind, number> = {
  "not-twin": 409,
  "dirty-workspace": 409,
  locked: 423,
  conflict: 409,
  "bad-request": 400,
  internal: 500,
};

export interface AppOptions {
  cwd: string;
  /** 终端唤起注入点（测试注入假实现，不真开窗口） */
  spawnTerminal?: SpawnTerminal;
  /** 事件中枢注入点（测试捕获广播） */
  hub?: EventHub;
  /** 指纹轮询间隔（测试缩短） */
  pollIntervalMs?: number;
}

export function createApp(opts: AppOptions): FastifyInstance {
  // forceCloseConnections：关停时销毁 keep-alive 连接（SSE 长连接否则让 close 挂起）
  const app = Fastify({ logger: false, forceCloseConnections: true });
  const hub = opts.hub ?? new EventHub();
  const actions = new SessionActions(opts.cwd, hub, opts.spawnTerminal);
  const stopPoller = startTreePoller(opts.cwd, hub, opts.pollIntervalMs);

  // 统一错误映射：业务失败 ApiFail → 结构化 ApiError JSON
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiFail) {
      const status = HTTP_STATUS[err.kind] ?? 500;
      return reply.status(status).send({ error: err.message, kind: err.kind, ...(err.detail ? { detail: err.detail } : {}) });
    }
    reply.status(500).send({ error: err instanceof Error ? err.message : String(err), kind: "internal" as const });
  });

  app.get("/api/health", async () => ({
    isTwin: isTwin(opts.cwd),
    cwd: opts.cwd,
    worldlines: isTwin(opts.cwd) ? worldlines(opts.cwd) : [],
  }));

  // 工作区信息（文件管理体系 v1.1）：agent 清单 = .claude/agents/ 下的定义文件名
  app.get("/api/workspace", async () => {
    const agentsDir = path.join(opts.cwd, ".claude", "agents");
    let agents: string[] = [];
    if (fs.existsSync(agentsDir)) {
      agents = fs
        .readdirSync(agentsDir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.replace(/\.md$/, ""))
        .sort();
    }
    return { cwd: opts.cwd, isTwin: isTwin(opts.cwd), agents };
  });

  app.get("/api/tree", async () => {
    if (!isTwin(opts.cwd)) {
      throw new ApiFail("当前仓库未启用 Twin（请先运行 sm twin-init）", "not-twin");
    }
    return buildTreeSnapshot(opts.cwd, actions.activeWindow());
  });

  app.post<{ Params: { uuid: string }; Body: { syncMode?: boolean } }>("/api/nodes/:uuid/enter", async (req) => {
    if (!isTwin(opts.cwd)) {
      throw new ApiFail("当前仓库未启用 Twin（请先运行 sm twin-init）", "not-twin");
    }
    return actions.enter(req.params.uuid, req.body?.syncMode === true);
  });

  app.post<{ Params: { uuid: string } }>("/api/nodes/:uuid/view", async (req) => {
    if (!isTwin(opts.cwd)) {
      throw new ApiFail("当前仓库未启用 Twin（请先运行 sm twin-init）", "not-twin");
    }
    return actions.view(req.params.uuid);
  });

  app.post("/api/window/close", async () => actions.close());

  app.get("/api/events", (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    reply.raw.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
    hub.subscribe(reply);
    req.raw.on("close", () => hub.unsubscribe(reply));
  });

  app.addHook("onClose", async () => {
    actions.dispose();
    stopPoller();
    hub.closeAll(); // 结束 SSE 响应流（连接销毁由 forceCloseConnections 负责）
  });

  // prod 形态：托管 web 构建产物（存在时）；SPA 回退：非 /api 路径 → index.html
  const webDist = path.resolve(import.meta.dirname, "../..", "web", "dist");
  if (fs.existsSync(webDist)) {
    app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith("/api")) {
        return reply.status(404).send({ error: "not found", kind: "internal" });
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}
