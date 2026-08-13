// 提交监控测试（v3.1）：真实 claude 轮次（约 3 次 API ≈ $0.1）
// 重要：会话文件必须由真实 claude 记录构成——Claude Code 会校验文件结构，
// 合成记录会被拒（"No conversation found"）；因此本测试不伪造记录
// 验证：检测新提问 → 提交上一轮；stop()（窗口关闭）→ 提交最后一轮；物化链完整；锁拒绝
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runClaude, runClaudeFresh } from "../src/claude.js";
import {
  twinInit,
  commitDelta,
  watchSession,
  materializeNode,
  tipSession,
  loadIndex,
  deltaRecords,
  listSessions,
} from "../src/twin.js";
import { encodeCwd, CLAUDE_PROJECTS } from "../src/paths.js";
import { loadRecords, isQuestion, preview, type Record } from "../src/records.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_BASE = path.join(ROOT, "tests", ".tmp-twin-repo");

/** 取一个可用（可清空）的测试仓库目录：被窗口/进程占用时换候选（实验 §5.3 同款处理） */
function freshRepo(): string {
  const candidates = [REPO_BASE, `${REPO_BASE}-2`, `${REPO_BASE}-3`];
  for (const cand of candidates) {
    try {
      fs.rmSync(cand, { recursive: true, force: true });
      fs.mkdirSync(cand, { recursive: true });
      return cand;
    } catch {
      continue; // EBUSY：有终端窗口停留在该目录
    }
  }
  throw new Error("所有候选测试目录均被占用——请关闭停留在 tests/.tmp-twin-repo* 的终端窗口");
}

let REPO = REPO_BASE;

function git(args: string[], cwd = REPO): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sessionDirFiles(): Set<string> {
  const dir = path.join(CLAUDE_PROJECTS, encodeCwd(REPO));
  const s = new Set<string>();
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (f.endsWith(".jsonl")) s.add(f);
  return s;
}

/** 会话文件中按序的消息记录（user/assistant，含 message） */
function msgRecords(sid: string): Record[] {
  const file = path.join(CLAUDE_PROJECTS, encodeCwd(REPO), `${sid}.jsonl`);
  return loadRecords(fs.readFileSync(file, "utf8")).filter(
    (r) => (r.type === "user" || r.type === "assistant") && r.message,
  );
}

test("监控提交：真实轮次 → 新提问提交上一轮；stop 提交末轮；物化链完整", async () => {
  // ---- 重置（被占用则换候选目录）----
  REPO = freshRepo();
  git(["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(REPO, "README.md"), "watch test\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
  twinInit(REPO);

  // ---- 第 1 轮：真实 claude 新会话（纯对话，无需工具权限）----
  const before = sessionDirFiles();
  const r1 = runClaudeFresh("第一问：请记住，这个测试的代号是小桥。简短确认。", REPO, true);
  assert.equal(r1.rc, 0, "第 1 轮退出码 0");
  const sid = [...sessionDirFiles()].filter((f) => !before.has(f))[0]?.replace(/\.jsonl$/, "") ?? "";
  assert.ok(sid.length > 0, "发现第 1 轮会话文件");
  const idx = loadIndex(REPO);
  const rec1 = deltaRecords(REPO, sid, idx);
  const c1 = commitDelta(REPO, { sid, branch: "main", prompt: "第一问：请记住，这个测试的代号是小桥。简短确认。", records: rec1, idx, decision: "initial" });
  assert.ok(c1, "第 1 轮已提交");
  assert.equal(git(["rev-parse", "HEAD"]), git(["rev-parse", "refs/context/main"]), "双 ref 同步");

  // ---- 第 2/3 轮：真实 resume 轮次 + 监控 ----
  const committed: string[] = [];
  const watcher = watchSession(
    REPO,
    { sid, branch: "main", firstDecision: "continue", anchorNodeUuid: null },
    (r) => committed.push(r.sha),
  );

  const r2 = runClaude(sid, "第二问：再记一个话题，话题二是监控提交。简短确认。", REPO);
  assert.equal(r2, 0, "第 2 轮退出码 0");
  await sleep(2500); // 只有 1 条新提问 → 不应提交
  assert.equal(committed.length, 0, "仅一轮新提问时未提交（等待下一轮）");

  const r3 = runClaude(sid, "第三问：现在请回答，我们讨论过哪两个话题？一句话。", REPO);
  assert.equal(r3, 0, "第 3 轮退出码 0");
  await sleep(2500); // 检测到第 3 问 → 提交第 2 轮
  assert.equal(committed.length, 1, "检测到新提问 → 上一轮已自动提交");

  watcher.stop(); // 窗口关闭 → 提交最后一轮
  assert.equal(committed.length, 2, "stop 后最后一轮已提交");

  // ---- 断言：commit 链与双 ref ----
  assert.equal(parseInt(git(["rev-list", "--count", "refs/context/main"]), 10), 4, "世界线 4 commit（init + 3 轮）");
  assert.equal(git(["rev-parse", "HEAD"]), git(["rev-parse", "refs/context/main"]), "stop 后双 ref 同步");
  assert.equal(git(["status", "--porcelain"]), "", "工作区干净");

  // ---- session 文件与链 ----
  const sessions = listSessions(REPO);
  assert.equal(sessions.length, 3, "3 个 session.json");
  const tip = tipSession(REPO, "main");
  assert.ok(tip, "tip session 可读");
  assert.ok(tip!.user_input.includes("第三问"), "tip = 第 3 问节点");
  assert.equal(tip!.code_before, committed[0], "第 3 轮 code_before = 第 2 轮 commit");
  assert.equal(tip!.root_uuid, sessions[0].node_uuid, "root 贯穿三轮");

  // ---- materializeNode：tip 链完整（三问依序出现）----
  const chain = materializeNode(REPO, tip!, true).filter((r) => r.message);
  const qs = chain.filter((r) => isQuestion(r));
  assert.equal(qs.length, 3, "物化链含 3 个提问");
  assert.ok(qs[0].message && String(qs[0].message.content).includes("第一问"), "第 1 问在链首");
  assert.ok(qs[2].message && String(qs[2].message.content).includes("第三问"), "第 3 问在链尾");

  // ---- 锁：占用时提交被拒 ----
  const lock = path.join(REPO, ".contextus", ".lock");
  fs.writeFileSync(lock, JSON.stringify({ pid: 1, ts: new Date().toISOString() }));
  const recAfter = deltaRecords(REPO, sid, idx);
  if (recAfter.length > 0) {
    assert.throws(
      () => commitDelta(REPO, { sid, branch: "main", prompt: "x", records: recAfter, idx, decision: "continue" }),
      /占用/,
      "锁占用时提交被拒",
    );
  }
  fs.rmSync(lock, { force: true });
});
