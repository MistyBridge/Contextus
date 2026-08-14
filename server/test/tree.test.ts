// M1a 树快照 API 测试（零 API）：多世界线 / tip / 孤儿 / fork 边 / HEAD 落位 / 未启用 Twin
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createApp } from "../src/app.js";
import type { TreeSnapshot } from "../../src/web-api.js";
import { dropWorldline } from "../../src/twin.js";
import { ROOT, initRepo, initTwinRepo, git, commitRound, round, branchFrom } from "./helpers.js";

const BASE = path.join(ROOT, ".tmp-m1-tree-repo");

test("树快照：多世界线 + fork 边 + tip + 孤儿 + HEAD 落位", async () => {
  const repo = initTwinRepo(BASE);

  // main 线两轮
  const s1 = commitRound(repo, {
    sid: "sid-a", branch: "main", prompt: "第一问 初始化项目",
    records: round("第一问 初始化项目", null), decision: "initial",
  });
  const s2 = commitRound(repo, {
    sid: "sid-a", branch: "main", prompt: "第二问 加个测试",
    records: round("第二问 加个测试", s1.node), decision: "continue",
  });

  // exp 线：从第一问 fork 一轮
  branchFrom(repo, "exp", s1.sha);
  const s3 = commitRound(repo, {
    sid: "sid-b", branch: "exp", prompt: "实验问 换方案",
    records: round("实验问 换方案", s1.node), decision: "fork", anchorNodeUuid: s1.node,
  });

  // main-2 线：从 exp 的 tip 再 fork —— 使 exp 的 commit 仍可从 main-2 到达
  branchFrom(repo, "main-2", s3.sha);
  const s4 = commitRound(repo, {
    sid: "sid-c", branch: "main-2", prompt: "分支问 继承实验",
    records: round("分支问 继承实验", s3.node), decision: "fork", anchorNodeUuid: s3.node,
  });

  // drop exp → 其节点成为孤儿（commit 仍经 main-2 可达 → 保持可索引）；先回到 main 再 drop
  git(["checkout", "-q", "main"], repo);
  dropWorldline(repo, "exp");

  const app = createApp({ cwd: repo, pollIntervalMs: 60_000 });
  const res = await app.inject({ method: "GET", url: "/api/tree" });
  assert.equal(res.statusCode, 200);
  const snap = res.json() as TreeSnapshot;

  // 世界线与孤儿
  assert.deepEqual(snap.worldlines.map((w) => w.branch), ["main", "main-2"]);
  assert.deepEqual(snap.orphanBranches, ["exp"]);
  assert.equal(snap.worldlines[0].tipNodeUuid, s2.node, "main 的 tip = 第二问");
  assert.equal(snap.worldlines[0].tipSha, s2.sha);
  assert.equal(snap.worldlines[1].tipNodeUuid, s4.node, "main-2 的 tip = 继承实验");

  // 节点全量（含孤儿）
  assert.equal(snap.nodes.length, 4);
  const n1 = snap.nodes.find((n) => n.nodeUuid === s1.node)!;
  const n2 = snap.nodes.find((n) => n.nodeUuid === s2.node)!;
  const n3 = snap.nodes.find((n) => n.nodeUuid === s3.node)!;
  const n4 = snap.nodes.find((n) => n.nodeUuid === s4.node)!;
  assert.equal(n1.decision, "initial");
  assert.equal(n1.sha, s1.sha);
  assert.equal(n2.isTip, true);
  assert.equal(n2.hasFork, false);
  assert.equal(n3.isTip, false, "孤儿节点不再是 tip");
  assert.equal(n3.branchId, "exp");
  assert.equal(n1.hasFork, true, "分叉点可视化标记");
  assert.equal(n3.hasFork, true, "孤儿节点仍可是下游的分叉点");
  assert.equal(n4.isTip, true);

  // 边：main 链 1 条 continue + 2 条 fork（main→exp、exp→main-2）
  assert.deepEqual(snap.edges.filter((e) => e.kind === "continue").map((e) => [e.from, e.to]), [[s1.node, s2.node]]);
  assert.deepEqual(snap.edges.filter((e) => e.kind === "fork"), [
    { from: s1.node, to: s3.node, kind: "fork" },
    { from: s3.node, to: s4.node, kind: "fork" },
  ]);

  // HEAD：回到 main 后非 detached
  assert.equal(snap.head!.detached, false);
  assert.equal(snap.head!.branch, "main");

  // activeWindow 空
  assert.equal(snap.activeWindow, null);
  await app.close();
});

test("未启用 Twin：/api/tree 409 not-twin；/api/health 200 报告状态", async () => {
  const repo = initRepo(path.join(ROOT, ".tmp-m1-notwin-repo"));
  const app = createApp({ cwd: repo, pollIntervalMs: 60_000 });

  const health = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().isTwin, false);
  assert.deepEqual(health.json().worldlines, []);

  const res = await app.inject({ method: "GET", url: "/api/tree" });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().kind, "not-twin");
  await app.close();
});
