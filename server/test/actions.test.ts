// M1a 节点操作 API 测试（零 API，假终端注入）：
// enter tip 监控闭环 / enter 历史节点 fork / view 查看模式 / 守卫（脏/锁/冲突/不存在）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createApp } from "../src/app.js";
import { EventHub } from "../src/events.js";
import type { FastifyReply } from "fastify";
import type { ServerEvent, TreeSnapshot } from "../../src/web-api.js";
import { loadRecords } from "../../src/records.js";
import { ROOT, initTwinRepo, git, commitRound, round, writeLive, appendLive, liveFile, rmLiveDir, sleep } from "./helpers.js";

const BASE = path.join(ROOT, ".tmp-m1-actions-repo");

/** 捕获 hub 广播的假 reply */
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

test("enter tip：复用 live 会话；监控不提交单问；close 提交最后一轮", async () => {
  const repo = initTwinRepo(BASE);
  const r1 = round("第一问 初始化", null);
  const s1 = commitRound(repo, {
    sid: "sid-tip", branch: "main", prompt: "第一问 初始化", records: r1, decision: "initial",
  });
  // live 文件 = 已提交记录（uuid 在索引中，delta 为空——同真实场景）
  writeLive(repo, "sid-tip", r1);

  const launched: Array<{ cwd: string; sid: string }> = [];
  const events: ServerEvent[] = [];
  const hub = new EventHub();
  hub.subscribe(capture(events));
  const app = createApp({
    cwd: repo,
    spawnTerminal: (cwd, sid) => {
      launched.push({ cwd, sid });
      return "fake-terminal-cmd";
    },
    hub,
    pollIntervalMs: 60_000,
  });

  const res = await app.inject({ method: "POST", url: `/api/nodes/${s1.node}/enter`, payload: {} });
  assert.equal(res.statusCode, 200);
  const entered = res.json();
  assert.equal(entered.sid, "sid-tip");
  assert.equal(entered.branch, "main");
  assert.equal(entered.isTip, true);
  assert.equal(launched.length, 1);
  assert.equal(launched[0].sid, "sid-tip");

  // 树里出现 activeWindow
  const snap1 = (await app.inject({ method: "GET", url: "/api/tree" })).json() as TreeSnapshot;
  assert.ok(snap1.activeWindow, "activeWindow 已登记");
  assert.equal(snap1.activeWindow!.branch, "main");

  // 追加第二问（仅一轮新提问 → 不应提交，等下一轮）
  const r2 = round("第二问 继续", s1.node);
  appendLive(repo, "sid-tip", r2);
  await sleep(2500);
  assert.equal(events.filter((e) => e.type === "commit").length, 0, "仅一轮新提问时不提交");

  // 窗口关闭 → 提交最后一轮（T10）
  const closeRes = await app.inject({ method: "POST", url: "/api/window/close" });
  assert.equal(closeRes.statusCode, 200);
  const closed = closeRes.json();
  assert.equal(closed.committed, true);
  assert.ok(closed.commit.sha);
  const commitEvents = events.filter((e) => e.type === "commit");
  assert.equal(commitEvents.length, 1, "close 时同步提交并广播");
  assert.equal(commitEvents[0].branch, "main");
  assert.equal(commitEvents[0].node, r2[0].uuid);
  assert.ok(events.some((e) => e.type === "window-closed" && e.committed === true));

  // 树更新：2 个节点，新 tip = 第二问
  const snap2 = (await app.inject({ method: "GET", url: "/api/tree" })).json() as TreeSnapshot;
  assert.equal(snap2.nodes.length, 2);
  assert.equal(snap2.activeWindow, null);
  assert.equal(snap2.worldlines[0].tipNodeUuid, r2[0].uuid);

  // 无活动窗口时 close → 400
  const again = await app.inject({ method: "POST", url: "/api/window/close" });
  assert.equal(again.statusCode, 400);
  await app.close();
  rmLiveDir(repo);
});

test("close 提交失败可重试：锁冲突保留窗口状态，解除后重试成功", async () => {
  const repo = initTwinRepo(BASE);
  const r1 = round("第一问 初始化", null);
  const s1 = commitRound(repo, {
    sid: "sid-retry", branch: "main", prompt: "第一问 初始化", records: r1, decision: "initial",
  });
  writeLive(repo, "sid-retry", r1);

  const app = createApp({
    cwd: repo,
    spawnTerminal: () => "fake-terminal-cmd",
    pollIntervalMs: 60_000,
  });

  // 进入 tip + 追加一轮
  const entered = await app.inject({ method: "POST", url: `/api/nodes/${s1.node}/enter`, payload: {} });
  assert.equal(entered.statusCode, 200);
  const r2 = round("第二问 继续", s1.node);
  appendLive(repo, "sid-retry", r2);

  // 锁冲突 → close 失败（500），窗口状态保留
  fs.writeFileSync(path.join(repo, ".contextus", ".lock"), JSON.stringify({ pid: 1, ts: new Date().toISOString() }));
  const fail = await app.inject({ method: "POST", url: "/api/window/close" });
  assert.equal(fail.statusCode, 500);
  const stillActive = (await app.inject({ method: "GET", url: "/api/tree" })).json();
  assert.ok(stillActive.activeWindow, "提交失败后窗口状态保留（可重试）");

  // 解除锁 → 重试 close 成功提交
  fs.rmSync(path.join(repo, ".contextus", ".lock"));
  const retry = await app.inject({ method: "POST", url: "/api/window/close" });
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.json().committed, true, "重试后最后一轮提交成功");

  const snap = (await app.inject({ method: "GET", url: "/api/tree" })).json();
  assert.equal(snap.nodes.length, 2, "树含重试提交的新节点");
  await app.close();
  rmLiveDir(repo);
});

test("enter 历史节点：回溯即分叉（物化上下文 + 新世界线 + 新会话文件）", async () => {
  const repo = initTwinRepo(BASE);
  const s1 = commitRound(repo, {
    sid: "sid-main", branch: "main", prompt: "第一问 配置上下文",
    records: round("第一问 配置上下文", null), decision: "initial",
  });
  commitRound(repo, {
    sid: "sid-main", branch: "main", prompt: "第二问 任务A",
    records: round("第二问 任务A", s1.node), decision: "continue",
  });
  const mainTipBefore = git(["rev-parse", "refs/context/main"], repo);

  const app = createApp({
    cwd: repo,
    spawnTerminal: () => "fake-terminal-cmd",
    pollIntervalMs: 60_000,
  });

  const res = await app.inject({ method: "POST", url: `/api/nodes/${s1.node}/enter`, payload: { syncMode: false } });
  assert.equal(res.statusCode, 200);
  const entered = res.json();
  assert.equal(entered.branch, "main-2", "autoBranchName 新世界线");
  assert.equal(entered.isTip, false);
  assert.notEqual(entered.sid, "sid-main");

  // 物化文件：含第一问（历史上下文），不含第二问（回溯边界）
  const chain = loadRecords(fs.readFileSync(liveFile(repo, entered.sid), "utf8")).filter((r) => r.message);
  const texts = chain.filter((r) => r.type === "user").map((r) => String(r.message!.content));
  assert.equal(texts.length, 1);
  assert.ok(texts[0].includes("第一问"), "物化上下文截止锚点节点");
  assert.ok(!texts.some((t) => t.includes("第二问")), "不含锚点之后的轮次");

  // git 落位：context/main-2 = 锚点 commit；HEAD 附着新支；旧世界线不动
  assert.equal(git(["rev-parse", "refs/context/main-2"], repo), s1.sha);
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], repo), "main-2");
  assert.equal(git(["rev-parse", "refs/context/main"], repo), mainTipBefore, "旧世界线 ref 不动");

  // 树：新世界线出现
  const snap = (await app.inject({ method: "GET", url: "/api/tree" })).json() as TreeSnapshot;
  assert.deepEqual(snap.worldlines.map((w) => w.branch), ["main", "main-2"]);

  // 关闭（live 文件记录均已入库 → 无新提交）
  const closeRes = await app.inject({ method: "POST", url: "/api/window/close" });
  assert.equal(closeRes.json().committed, false);
  await app.close();
  rmLiveDir(repo);
});

test("view：查看模式 detached（不建线不提交）", async () => {
  const repo = initTwinRepo(BASE);
  const s1 = commitRound(repo, {
    sid: "sid-v", branch: "main", prompt: "第一问", records: round("第一问", null), decision: "initial",
  });
  commitRound(repo, {
    sid: "sid-v", branch: "main", prompt: "第二问",
    records: round("第二问", s1.node), decision: "continue",
  });

  const app = createApp({ cwd: repo, pollIntervalMs: 60_000 });
  const res = await app.inject({ method: "POST", url: `/api/nodes/${s1.node}/view` });
  assert.equal(res.statusCode, 200);
  const viewed = res.json();
  assert.equal(viewed.commit, s1.sha);
  assert.equal(viewed.detached, true);
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], repo), "HEAD", "detached 查看模式");

  const snap = (await app.inject({ method: "GET", url: "/api/tree" })).json() as TreeSnapshot;
  assert.equal(snap.head!.detached, true);
  assert.equal(snap.head!.sha, s1.sha);
  await app.close();
});

test("守卫：脏工作区（view/fork 拦，tip 不拦）/ 锁冲突 423 / 活动窗口 409 / 节点不存在 400", async () => {
  const repo = initTwinRepo(BASE);
  const s1 = commitRound(repo, {
    sid: "sid-g", branch: "main", prompt: "第一问", records: round("第一问", null), decision: "initial",
  });
  const s2 = commitRound(repo, {
    sid: "sid-g", branch: "main", prompt: "第二问",
    records: round("第二问", s1.node), decision: "continue",
  });

  const app = createApp({
    cwd: repo,
    spawnTerminal: () => "fake-terminal-cmd",
    pollIntervalMs: 60_000,
  });

  // 脏工作区：view（checkout 路径）拦
  fs.writeFileSync(path.join(repo, "dirty.txt"), "x");
  const dirtyView = await app.inject({ method: "POST", url: `/api/nodes/${s1.node}/view` });
  assert.equal(dirtyView.statusCode, 409);
  assert.equal(dirtyView.json().kind, "dirty-workspace");

  // 脏工作区：fork（历史节点 enter，checkout 路径）拦
  const dirtyFork = await app.inject({ method: "POST", url: `/api/nodes/${s1.node}/enter`, payload: {} });
  assert.equal(dirtyFork.statusCode, 409);
  assert.equal(dirtyFork.json().kind, "dirty-workspace");
  assert.ok(dirtyFork.json().detail.includes("dirty.txt"), "detail 列出脏文件");

  // 脏工作区：tip enter 不拦（不落地 checkout，未提交改动随下一轮 add -A 提交）
  const tipEnter = await app.inject({ method: "POST", url: `/api/nodes/${s2.node}/enter`, payload: {} });
  assert.equal(tipEnter.statusCode, 200, "tip 进入不受脏工作区守卫阻拦");
  const close1 = await app.inject({ method: "POST", url: "/api/window/close" });
  assert.equal(close1.statusCode, 200);
  assert.equal(close1.json().committed, false, "无 live 记录不提交");
  fs.rmSync(path.join(repo, "dirty.txt"));

  // 锁占用
  fs.writeFileSync(path.join(repo, ".contextus", ".lock"), JSON.stringify({ pid: 1, ts: new Date().toISOString() }));
  const locked = await app.inject({ method: "POST", url: `/api/nodes/${s2.node}/enter`, payload: {} });
  assert.equal(locked.statusCode, 423);
  assert.equal(locked.json().kind, "locked");
  fs.rmSync(path.join(repo, ".contextus", ".lock"));

  // 节点不存在
  const missing = await app.inject({
    method: "POST",
    url: "/api/nodes/00000000-0000-4000-8000-000000000000/enter",
    payload: {},
  });
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.json().kind, "bad-request");

  // 活动窗口冲突：enter 成功后 view 被拒
  const ok = await app.inject({ method: "POST", url: `/api/nodes/${s2.node}/enter`, payload: {} });
  assert.equal(ok.statusCode, 200);
  const conflict = await app.inject({ method: "POST", url: `/api/nodes/${s1.node}/view` });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().kind, "conflict");

  // 收尾：关窗（无 live 记录 → 不提交）+ 关停
  const closeRes = await app.inject({ method: "POST", url: "/api/window/close" });
  assert.equal(closeRes.json().committed, false);
  await app.close();
  rmLiveDir(repo);
});
