// M4 九场景断言套件（零 API）——覆盖 m2/m3/watch 未覆盖的场景缺口
// T1 连续编码任务 / T2 纯对话轮 / T4 分支世界线 / T7 配置边界分支 / T8 同步指令
// 其余场景深覆盖位置：T3（twin-regression，headless 真实 Agent）、T5（m2 find）、
//   T6（m3 规则更新 + 手动 CLAUDE.md 实测）、T9（m2 rename/drop）
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
  materializeNode,
  tipSession,
  commitOf,
  loadIndex,
  listSessions,
  syncInstruction,
  ruleInjectionRecord,
} from "../src/twin.js";
import { policyAppend } from "../src/policy.js";
import { isQuestion, type Record } from "../src/records.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = path.join(ROOT, "tests", ".tmp-scn-repo");

function freshRepo(): string {
  for (const cand of [BASE, `${BASE}-2`, `${BASE}-3`]) {
    try {
      fs.rmSync(cand, { recursive: true, force: true });
      fs.mkdirSync(cand, { recursive: true });
      return cand;
    } catch {
      continue;
    }
  }
  throw new Error("所有候选测试目录均被占用");
}

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function mkRec(type: "user" | "assistant", text: string, parent: string | null): Record {
  return {
    type,
    uuid: randomUUID(),
    parentUuid: parent,
    cwd: "",
    promptId: type === "user" ? randomUUID() : undefined,
    message: { role: type, content: type === "user" ? text : [{ type: "text", text }] },
  } as Record;
}

function round(prompt: string, parent: string | null): [Record, Record] {
  const q = mkRec("user", prompt, parent);
  return [q, mkRec("assistant", "答：" + prompt, q.uuid)];
}

test("T1+T2+T4+T7+T8 场景断言（零 API）", () => {
  const cwd = freshRepo();
  git(["init", "-q", "-b", "main"], cwd);
  fs.writeFileSync(path.join(cwd, "code.txt"), "v1\n");
  git(["add", "-A"], cwd);
  git(["commit", "-q", "-m", "init"], cwd);
  twinInit(cwd);
  const idx = loadIndex(cwd);
  const sid = "s-1";
  policyAppend(cwd, "规则X：初版"); // 让第 1 轮 commit 携带规则快照（T8 注入的 base）

  // ---- T1 连续编码任务：3 轮，每轮改代码 ----
  const rounds: Array<{ q: Record; a: Record; commit: string }> = [];
  let parent: string | null = null;
  const prompts = ["第一轮：搭建骨架", "第二轮：修改配置", "第三轮：补充测试"];
  for (let i = 0; i < 3; i++) {
    const [q, a] = round(prompts[i], parent);
    fs.writeFileSync(path.join(cwd, "code.txt"), `v${i + 2}\n`);
    const c = commitDelta(cwd, { sid, branch: "main", prompt: prompts[i], records: [q, a], idx, decision: i === 0 ? "initial" : "continue" })!;
    rounds.push({ q, a, commit: c.sha });
    parent = a.uuid;
  }
  const subjects = git(["log", "--format=%s", "refs/context/main"], cwd).split("\n").filter(Boolean);
  assert.ok(subjects[0] === "第三轮：补充测试", "T1 每轮恰一个 commit，名称为请求原文（≤20 字）");
  assert.ok(subjects.every((s) => s.length <= 20), "T1 commit 名称 ≤20 字");
  assert.equal(rounds[1].commit, commitOf(cwd, rounds[1].q.uuid!), "T1 节点 → commit 索引一致");
  const s2 = listSessions(cwd).find((s) => s.node_uuid === rounds[1].q.uuid)!;
  assert.equal(s2.code_before, rounds[0].commit, "T1 S_n 的 code_after(索引) == S_{n+1} 的 code_before");

  // ---- T2 纯对话轮（不改代码）----
  const [q4, a4] = round("第四轮：纯对话", parent);
  const c4 = commitDelta(cwd, { sid, branch: "main", prompt: "第四轮：纯对话", records: [q4, a4], idx, decision: "continue" })!;
  const codeDiff = git(["diff", "--stat", rounds[2].commit, c4.sha, "--", ".", ":(exclude).contextus"], cwd);
  assert.equal(codeDiff, "", "T2 纯对话轮代码树与父 commit 相同");
  assert.ok(fs.readFileSync(path.join(cwd, ".contextus", "logs", "runtime.log"), "utf8").includes('"commit"'), "T2 日志增量在链");

  // ---- T4 分支世界线：从第 3 轮节点 fork 两条线 ----
  const forkBase = rounds[2].q.uuid!;
  // 线 A：exp-a
  git(["branch", "-q", "exp-a", commitOf(cwd, forkBase)!], cwd);
  git(["update-ref", "refs/context/exp-a", commitOf(cwd, forkBase)!], cwd);
  git(["checkout", "-q", commitOf(cwd, forkBase)!, "--", ".", ":(exclude).contextus"], cwd);
  git(["symbolic-ref", "HEAD", "refs/heads/exp-a"], cwd);
  const [qa, aa] = round("线A的第五轮", rounds[2].a.uuid);
  const ca = commitDelta(cwd, { sid: "s-a", branch: "exp-a", prompt: "线A的第五轮", records: [qa, aa], idx, decision: "fork" })!;
  // 线 B：main 继续
  git(["checkout", "-q", commitOf(cwd, forkBase)!, "--", ".", ":(exclude).contextus"], cwd);
  git(["symbolic-ref", "HEAD", "refs/heads/main"], cwd);
  const [qb, ab] = round("线B的第五轮", rounds[2].a.uuid);
  const cb = commitDelta(cwd, { sid: "s-b", branch: "main", prompt: "线B的第五轮", records: [qb, ab], idx, decision: "fork" })!;
  assert.notEqual(ca.sha, cb.sha, "T4 两线各自独立 commit");
  const chainA = materializeNode(cwd, listSessions(cwd).find((s) => s.node_uuid === qa.uuid)!, false)
    .filter((r) => r.message)
    .map((r) => r.uuid);
  const chainB = materializeNode(cwd, listSessions(cwd).find((s) => s.node_uuid === qb.uuid)!, false)
    .filter((r) => r.message)
    .map((r) => r.uuid);
  assert.ok(chainA.includes(qa.uuid) && !chainA.includes(qb.uuid), "T4 线A 不可见线B 后续");
  assert.ok(chainB.includes(qb.uuid) && !chainB.includes(qa.uuid), "T4 线B 不可见线A 后续");

  // ---- T7 配置边界分支：从第 3 轮节点物化不含第 4/5 轮 ----
  const chainAt3 = materializeNode(cwd, listSessions(cwd).find((s) => s.node_uuid === rounds[2].q.uuid)!, false)
    .filter((r) => r.message)
    .map((r) => r.uuid);
  assert.ok(chainAt3.includes(rounds[2].a.uuid), "T7 物化含配置边界节点轮完整");
  assert.ok(!chainAt3.includes(q4.uuid) && !chainAt3.includes(qb.uuid), "T7 物化不含边界之后的任务上下文（零冗余）");

  // ---- T8 同步指令 + 注入载体 ----
  const inst = syncInstruction("shaHIST", "shaLATEST");
  assert.ok(inst.includes("shaHIST") && inst.includes("shaLATEST") && inst.startsWith("【Contextus 同步指令】"), "T8 同步指令文本");
  // 修改规则（相对第 1 轮快照 = 修改）→ 触发纠错注入（v3.2：纯新增不注入）
  fs.writeFileSync(path.join(cwd, ".contextus", "Chunks", "project_policy.md"), "规则X：修改版\n", "utf8");
  const rec = ruleInjectionRecord(cwd, rounds[0].commit, sid, null);
  assert.equal(rec?.type, "assistant", "T8/规则 注入载体 = assistant 记录（显示且进上下文）");
  assert.equal(isQuestion(rec!), false, "注入记录不是提问（节点锚定不受影响）");
});
