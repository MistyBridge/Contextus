// 提交监控测试（v3.1）：零 API 成本，本地模拟会话文件追加
// 验证：检测新提问 → 提交上一轮；stop()（窗口关闭）→ 提交最后一轮；materializeNode 链完整
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  twinInit,
  commitDelta,
  watchSession,
  materializeNode,
  tipSession,
  loadIndex,
  writeJsonl,
  type Session,
} from "../src/twin.js";
import { encodeCwd, CLAUDE_PROJECTS } from "../src/paths.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.join(ROOT, "tests", ".tmp-twin-repo");

function git(args: string[], cwd = REPO): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Rec {
  type: string;
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  cwd: string;
  promptId?: string;
  message?: { role: string; content: string | Array<{ type: string; text?: string }> };
}

function mkUser(text: string, parent: string | null, sid: string): Rec {
  return {
    type: "user",
    uuid: randomUUID(),
    parentUuid: parent,
    sessionId: sid,
    cwd: REPO,
    promptId: randomUUID(),
    message: { role: "user", content: text },
  };
}

function mkAssistant(text: string, parent: string | null, sid: string): Rec {
  return {
    type: "assistant",
    uuid: randomUUID(),
    parentUuid: parent,
    sessionId: sid,
    cwd: REPO,
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

function appendJsonl(sid: string, recs: Rec[]): void {
  const file = path.join(CLAUDE_PROJECTS, encodeCwd(REPO), `${sid}.jsonl`);
  fs.appendFileSync(file, recs.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

function headSha(): string {
  return git(["rev-parse", "HEAD"]);
}

test("监控提交：新提问→提交上一轮；stop→提交最后一轮；物化链完整", async () => {
  // ---- 重置 ----
  fs.rmSync(REPO, { recursive: true, force: true });
  fs.mkdirSync(REPO, { recursive: true });
  git(["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(REPO, "README.md"), "watch test\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
  twinInit(REPO);

  const sid = randomUUID();

  // ---- 第 1 轮（模拟历史会话：直接本地提交，不经 claude）----
  const q1 = mkUser("第一问：初始化任务", null, sid);
  const a1 = mkAssistant("第一答", q1.uuid, sid);
  writeJsonl(sid, [q1, a1], REPO);
  const idx = loadIndex(REPO);
  const c1 = commitDelta(REPO, {
    sid,
    branch: "main",
    prompt: "第一问：初始化任务",
    records: [q1, a1],
    idx,
    decision: "initial",
  });
  assert.ok(c1, "第 1 轮已提交");
  assert.equal(headSha(), git(["rev-parse", "refs/context/main"]), "双 ref 同步");

  // ---- 模拟交互窗口：tip 进入（复用同文件），用户连问两轮 ----
  const committed: string[] = [];
  const watcher = watchSession(
    REPO,
    { sid, branch: "main", firstDecision: "continue", anchorNodeUuid: null },
    (r) => committed.push(r.sha),
  );

  // 第 2 轮完整（问 + 答），随后第 3 轮提问出现 → 触发提交第 2 轮
  const q2 = mkUser("第二问：改点代码", a1.uuid, sid);
  const a2 = mkAssistant("第二答", q2.uuid, sid);
  appendJsonl(sid, [q2, a2]);
  const q3 = mkUser("第三问：再加一轮", a2.uuid, sid);
  appendJsonl(sid, [q3]);
  await sleep(2600); // 轮询间隔 2s
  assert.equal(committed.length, 1, "检测到第 3 问 → 第 2 轮已自动提交");

  // 第 3 轮答完 → stop（窗口关闭）→ 提交最后一轮
  const a3 = mkAssistant("第三答", q3.uuid, sid);
  appendJsonl(sid, [a3]);
  watcher.stop();
  assert.equal(committed.length, 2, "stop 后最后一轮已提交");

  // ---- 断言：commit 链与双 ref ----
  const commits = git(["rev-list", "--count", "refs/context/main"]);
  assert.equal(parseInt(commits, 10), 4, "世界线 4 个 commit（含 init + 3 轮会话）");
  assert.equal(headSha(), git(["rev-parse", "refs/context/main"]), "stop 后双 ref 同步");
  assert.equal(git(["status", "--porcelain"]), "", "工作区干净");

  // ---- session 文件与索引 ----
  const sessions = fs.readdirSync(path.join(REPO, ".contextus", "sessions"));
  assert.equal(sessions.length, 3, "3 个 session.json");
  const tip = tipSession(REPO, "main");
  assert.ok(tip, "tip session 可读");
  assert.equal(tip!.node_uuid, q3.uuid, "tip = 第 3 问节点");
  assert.equal(tip!.code_before, committed[0], "第 3 轮 code_before = 第 2 轮 commit");
  const idx2 = loadIndex(REPO);
  assert.equal(idx2.get(q1.uuid), c1!.sha, "uuid2commit 索引正确");

  // ---- materializeNode：tip 链完整（第 1 轮到第 3 轮全部记录）----
  const chain = materializeNode(REPO, tip!, true);
  assert.deepEqual(
    chain.map((r) => r.uuid),
    [q1.uuid, a1.uuid, q2.uuid, a2.uuid, q3.uuid, a3.uuid],
    "物化链 = 全部 6 条记录，顺序正确",
  );

  // ---- 锁：占用时提交被拒 ----
  const lock = path.join(REPO, ".contextus", ".lock");
  fs.writeFileSync(lock, JSON.stringify({ pid: 1, ts: new Date().toISOString() }));
  const q4 = mkUser("第四问", a3.uuid, sid);
  assert.throws(
    () => commitDelta(REPO, { sid, branch: "main", prompt: "x", records: [q4], idx: idx2, decision: "continue" }),
    /占用/,
    "锁占用时提交被拒",
  );
  fs.rmSync(lock, { force: true });
});
