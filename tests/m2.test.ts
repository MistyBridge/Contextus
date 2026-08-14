// M2 恢复与查询 + 维护通道测试（零 API：合成记录仅进 git，不涉及 claude resume）
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
  sessionOfCommit,
  diffSessions,
  checkoutView,
  renameTip,
  dropWorldline,
  listSessions,
  worldlines,
  tipSession,
  commitOf,
  loadIndex,
} from "../src/twin.js";
import type { Record } from "../src/records.js";

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

function round(prompt: string, parent: string | null): Record[] {
  const q = mkRec("user", prompt, parent);
  const a = mkRec("assistant", "答：" + prompt, q.uuid);
  return [q, a];
}

test("M2：find/diff/checkout/rename/drop + 孤儿节点可索引", () => {
  const cwd = freshRepo();
  git(["init", "-q", "-b", "main"], cwd);
  fs.writeFileSync(path.join(cwd, "code.txt"), "v1\n");
  git(["add", "-A"], cwd);
  git(["commit", "-q", "-m", "init"], cwd);
  twinInit(cwd);

  const idx = loadIndex(cwd);

  // 两轮 + 中间代码变化
  const r1 = round("第一问：搭建骨架", null);
  fs.writeFileSync(path.join(cwd, "code.txt"), "v2\n");
  const c1 = commitDelta(cwd, { sid: "s-1", branch: "main", prompt: "第一问：搭建骨架", records: r1, idx, decision: "initial" })!;
  assert.ok(c1);

  const r2 = round("第二问：修改配置", r1[1].uuid);
  fs.writeFileSync(path.join(cwd, "code.txt"), "v3\n");
  const c2 = commitDelta(cwd, { sid: "s-1", branch: "main", prompt: "第二问：修改配置", records: r2, idx, decision: "continue" })!;
  assert.ok(c2);

  // ---- find ----
  const s1 = sessionOfCommit(cwd, c1.sha);
  assert.ok(s1 && s1.node_uuid === r1[0].uuid, "find(轮1 commit) → 会话节点");
  const initSha = git(["rev-list", "--max-parents=0", "HEAD"], cwd);
  assert.equal(sessionOfCommit(cwd, initSha), null, "find(init) → 非会话提交");

  // ---- diff ----
  const d = diffSessions(cwd, r1[0].uuid!, r2[0].uuid!);
  assert.ok(d.includes("v3") && d.includes("code.txt"), "diff 含两轮间的代码变化");

  // ---- checkout 查看模式 ----
  const v = checkoutView(cwd, r1[0].uuid!);
  assert.equal(git(["rev-parse", "HEAD"], cwd), v.commit, "checkout 落位到节点 commit");
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], cwd), "HEAD", "detached 查看模式");
  checkoutView(cwd, "main"); // 查看模式 → detached 于 main tip
  assert.equal(git(["rev-parse", "HEAD"], cwd), c2.sha, "checkout 世界线名回到 tip");
  git(["checkout", "-q", "main"], cwd); // 回到分支（rename 需处于 tip 分支）

  // ---- rename（仅 tip）----
  const before = c2.sha;
  const rn = renameTip(cwd, "改名后的第二问");
  assert.notEqual(rn.after, before, "rename 改变 sha");
  assert.ok(git(["log", "-1", "--format=%s", rn.after], cwd).includes("改名后的第二问"), "subject 已改");
  assert.ok(git(["log", "-1", "--format=%B", rn.after], cwd).includes(`Node: ${r2[0].uuid}`), "尾注保留");
  assert.equal(commitOf(cwd, r2[0].uuid!), rn.after, "索引更新到新 sha");
  assert.ok(fs.readFileSync(path.join(cwd, ".contextus", "logs", "runtime.log"), "utf8").includes('"rename"'), "审计日志记录 rename");

  // 非 tip 拒绝：checkout 到轮 1 后再 rename（detached 或非 tip 均拒绝）
  checkoutView(cwd, r1[0].uuid!);
  assert.throws(() => renameTip(cwd, "非法改名"), /仅限 tip|detached/, "非 tip 时 rename 被拒");
  checkoutView(cwd, "main");

  // ---- drop 世界线 + 孤儿可索引 ----
  git(["branch", "-q", "exp", c1.sha], cwd);
  git(["update-ref", "refs/context/exp", c1.sha], cwd);
  const nBefore = listSessions(cwd).length;
  git(["checkout", "-q", git(["rev-parse", "refs/context/main"], cwd), "--", ".", ":(exclude).contextus"], cwd);
  git(["symbolic-ref", "HEAD", "refs/heads/main"], cwd); // 路径更新 + 附着（checkout <branch> -- <path> 不切换分支）
  dropWorldline(cwd, "exp");
  assert.ok(!worldlines(cwd).includes("exp"), "世界线 ref 已删除");
  assert.equal(listSessions(cwd).length, nBefore, "孤儿节点仍可索引（唯一不变索引原则）");
  // drop 使用中的世界线被拒
  assert.throws(() => dropWorldline(cwd, "main"), /正在使用/, "drop 使用中的世界线被拒");

  // ---- tip 一致性 ----
  const tip = tipSession(cwd, "main");
  assert.ok(tip && tip.node_uuid === r2[0].uuid, "tip = 第二轮节点");
});
