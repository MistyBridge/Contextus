// M1a 实时机制测试：EventHub 广播 / 指纹轮询 tree-changed / SSE 端点流
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyReply } from "fastify";
import { createApp } from "../src/app.js";
import { EventHub, startTreePoller } from "../src/events.js";
import type { ServerEvent } from "../../src/web-api.js";
import { ROOT, initTwinRepo, commitRound, round, waitFor } from "./helpers.js";

const BASE = path.join(ROOT, ".tmp-m1-events-repo");

function capture(events: ServerEvent[]): FastifyReply {
  return {
    raw: {
      write: (s: string) => {
        for (const chunk of s.split("\n\n")) {
          if (chunk.startsWith("data: ")) events.push(JSON.parse(chunk.slice(6)) as ServerEvent);
        }
      },
    },
  } as unknown as FastifyReply;
}

test("EventHub：订阅广播 + 退订 + 断连清理", () => {
  const hub = new EventHub();
  const events: ServerEvent[] = [];
  const reply = capture(events);
  hub.subscribe(reply);
  assert.equal(hub.count(), 1);

  hub.broadcast({ type: "tree-changed" });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "tree-changed");

  hub.unsubscribe(reply);
  hub.broadcast({ type: "tree-changed" });
  assert.equal(events.length, 1, "退订后不再接收");

  // 断连清理：raw.write 抛错的客户端被自动移除
  const dead = { raw: { write: () => { throw new Error("gone"); } } } as unknown as FastifyReply;
  hub.subscribe(dead);
  assert.equal(hub.count(), 1);
  hub.broadcast({ type: "tree-changed" });
  assert.equal(hub.count(), 0, "断连客户端被清理");
});

test("指纹轮询：新提交 → tree-changed 广播", async () => {
  const repo = initTwinRepo(BASE);
  const events: ServerEvent[] = [];
  const hub = new EventHub();
  hub.subscribe(capture(events));

  const stop = startTreePoller(repo, hub, 100);
  await waitFor(() => true, 150); // 建立初始指纹基线
  assert.equal(events.length, 0, "基线阶段无广播");

  commitRound(repo, {
    sid: "sid-p", branch: "main", prompt: "第一问", records: round("第一问", null), decision: "initial",
  });
  await waitFor(() => events.some((e) => e.type === "tree-changed"));
  stop();
});

test("SSE 端点：/api/events 推送 connected 与 tree-changed", async () => {
  const repo = initTwinRepo(BASE);
  const app = createApp({ cwd: repo, pollIntervalMs: 100 });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as AddressInfo;

  const res = await fetch(`http://127.0.0.1:${addr.port}/api/events`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const nextEvent = async (): Promise<ServerEvent> => {
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("SSE 流已关闭");
      buf += decoder.decode(value, { stream: true });
      const idx = buf.indexOf("\n\n");
      if (idx < 0) continue;
      const line = buf.slice(0, idx);
      const m = line.match(/^data: (.*)$/m);
      if (m) return JSON.parse(m[1]) as ServerEvent;
    }
  };

  const first = await nextEvent();
  assert.equal(first.type, "connected");

  // 提交一轮 → 轮询发现指纹变化 → 广播
  commitRound(repo, {
    sid: "sid-s", branch: "main", prompt: "第一问", records: round("第一问", null), decision: "initial",
  });
  const second = await nextEvent();
  assert.equal(second.type, "tree-changed");

  await app.close();
});
