// M3 策略 Chunk 测试（零 API）：条目级 diff、增量注入、chunks_hash、注入记录不扰乱节点锚定
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  entryDiff,
  buildRuleInjection,
  policyAppend,
  policyHash,
  readPolicyWorktree,
  readPolicyAt,
} from "../src/policy.js";
import { twinInit, commitDelta, ruleInjectionRecord, loadIndex, listSessions } from "../src/twin.js";
import { isQuestion, type Record } from "../src/records.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = path.join(ROOT, "tests", ".tmp-twin-repo");

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

test("entryDiff：新增/修改/删除配对", () => {
  const d = entryDiff(
    ["规则一：输出中文", "规则二：写 docstring", "规则三：旧规则"],
    ["规则一：输出英文", "规则二：写 docstring", "规则四：新规则"],
  );
  assert.deepEqual(d.adds, ["规则四：新规则"], "新增识别");
  assert.deepEqual(d.updates, [{ old: "规则一：输出中文", next: "规则一：输出英文" }], "修改配对");
  assert.deepEqual(d.removes, ["规则三：旧规则"], "删除识别");
});

test("M3 集成：增量注入 + chunks_hash + 注入记录不扰乱锚定", () => {
  const cwd = freshRepo();
  git(["init", "-q", "-b", "main"], cwd);
  fs.writeFileSync(path.join(cwd, "README.md"), "m3\n");
  git(["add", "-A"], cwd);
  git(["commit", "-q", "-m", "init"], cwd);
  twinInit(cwd);

  // v1 规则 + 第 1 轮提交
  policyAppend(cwd, "规则一：输出中文");
  policyAppend(cwd, "规则二：写 docstring");
  const idx = loadIndex(cwd);
  const q1 = mkRec("user", "第一问", null);
  const a1 = mkRec("assistant", "答", q1.uuid);
  const c1 = commitDelta(cwd, { sid: "s-1", branch: "main", prompt: "第一问", records: [q1, a1], idx, decision: "initial" })!;
  assert.ok(c1);
  const s1 = listSessions(cwd)[0];
  assert.equal(s1.chunks_hash, policyHash(readPolicyWorktree(cwd)), "session.chunks_hash = 当时规则哈希");

  // v2：新增一条 + 修改一条 + 删除一条
  policyAppend(cwd, "规则三：提交前自查");
  const lines = readPolicyWorktree(cwd);
  fs.writeFileSync(
    path.join(cwd, ".contextus", "Chunks", "project_policy.md"),
    lines.map((l) => (l.startsWith("规则一") ? "规则一：输出英文" : l)).filter((l) => !l.startsWith("规则二")).join("\n") + "\n",
    "utf8",
  );

  // 注入 = base(第 1 轮 commit 的 Chunks 快照) vs 工作区
  const inj = buildRuleInjection(cwd, c1.sha)!;
  assert.ok(inj.includes("【规则新增】规则三：提交前自查"), "新增注入");
  assert.ok(inj.includes("【规则更新】规则一：输出英文") && inj.includes("【禁止】规则一：输出中文"), "修改注入 + 禁止旧文");
  assert.ok(inj.includes("【规则禁止】规则二：写 docstring"), "删除注入");

  // 版本一致 → 不注入
  const c1Rules = readPolicyAt(cwd, c1.sha);
  assert.ok(buildRuleInjection(cwd, c1.sha) !== null, "有差异时注入");
  // 把工作区改回与 c1 一致 → 不注入
  fs.writeFileSync(path.join(cwd, ".contextus", "Chunks", "project_policy.md"), c1Rules.join("\n") + "\n", "utf8");
  assert.equal(buildRuleInjection(cwd, c1.sha), null, "版本一致时不注入");
  // 恢复 v2 内容供后续
  policyAppend(cwd, "规则三：提交前自查");
  fs.writeFileSync(
    path.join(cwd, ".contextus", "Chunks", "project_policy.md"),
    "规则一：输出英文\n规则三：提交前自查\n",
    "utf8",
  );

  // 注入记录不扰乱节点锚定（< 开头 → 非提问）
  const rec = ruleInjectionRecord(cwd, c1.sha, "s-9", a1.uuid)!;
  assert.ok(rec, "注入记录已生成");
  assert.equal(isQuestion(rec), false, "注入记录不被识别为用户提问（节点锚定不受影响）");
  assert.ok(String(rec.message!.content).startsWith("<contextus-rule>"), "前缀 <contextus-rule>");

  // 第 2 轮提交：chunks_hash 更新为新规则
  const q2 = mkRec("user", "第二问", a1.uuid);
  const a2 = mkRec("assistant", "答", q2.uuid);
  const c2 = commitDelta(cwd, { sid: "s-1", branch: "main", prompt: "第二问", records: [q2, a2], idx, decision: "continue" })!;
  assert.equal(listSessions(cwd).at(-1)!.chunks_hash, policyHash(readPolicyWorktree(cwd)), "新规则哈希随轮提交");
  assert.notEqual(c1.sha, c2.sha);
});
