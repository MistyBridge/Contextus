// M4 回放协议（零 API）：restore → materialize → 逐 uuid 比对
// 协议与硬指标②一致：REPLAY_N 个历史会话逐个恢复物化校验（默认 30，可 REPLAY_N=1000 扩大）
// 真实「继续执行」抽样（50 次）由 headless twin-regression 承担（需信任，手动运行）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { twinInit, commitDelta, materializeNode, listSessions, loadIndex, writeJsonl } from "../src/twin.js";
import type { Record } from "../src/records.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = path.join(ROOT, "tests", ".tmp-replay-repo");
const N = Math.min(Math.max(parseInt(process.env.REPLAY_N ?? "30", 10) || 30, 5), 2000);

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

test(`回放协议：${N} 个历史会话 restore → materialize → 逐 uuid 一致`, () => {
  const cwd = freshRepo();
  git(["init", "-q", "-b", "main"], cwd);
  fs.writeFileSync(path.join(cwd, "README.md"), "replay\n");
  git(["add", "-A"], cwd);
  git(["commit", "-q", "-m", "init"], cwd);
  twinInit(cwd);
  const idx = loadIndex(cwd);

  // 构建 N 轮链（合成记录——回放校验只涉及 git 层，不涉及 claude resume）
  const expected: string[][] = [];
  const allUuids: string[] = [];
  const fullChain: Record[] = []; // 同时留作 live 会话文件内容（tip 物化确定「轮末」用）
  for (let i = 1; i <= N; i++) {
    const q = mkRec("user", `第${i}问`, fullChain.length ? fullChain[fullChain.length - 1].uuid! : null);
    const a = mkRec("assistant", `答${i}`, q.uuid);
    commitDelta(cwd, { sid: "s-r", branch: "main", prompt: `第${i}问`, records: [q, a], idx, decision: i === 1 ? "initial" : "continue" });
    fullChain.push(q, a);
    allUuids.push(q.uuid!, a.uuid!);
    expected.push([...allUuids]);
  }
  // tip 物化依赖 live 会话文件确定「轮末」——合成场景补一个（writeJsonl 不涉及 claude resume）
  writeJsonl("s-r", fullChain, cwd);

  // 逐个历史会话 restore（git 读 session）+ materialize + 比对
  const sessions = listSessions(cwd);
  assert.equal(sessions.length, N, "会话总数 = N");
  let checked = 0;
  for (let i = 0; i < N; i++) {
    const s = sessions[i];
    const chain = materializeNode(cwd, s, i === N - 1)
      .filter((r) => r.message)
      .map((r) => r.uuid);
    assert.deepEqual(chain, expected[i], `会话 ${i + 1} 物化链与预期一致（${chain.length} 条）`);
    checked += 1;
  }
  // 历史状态未被破坏：全部轮仍可索引
  const idx2 = loadIndex(cwd);
  assert.ok(allUuids.every((u) => idx2.has(u)), "全部记录 uuid 仍可索引");
  console.log(`  ✓ 回放校验 ${checked}/${N} 个会话全部一致（REPLAY_N=${N}）`);
});
