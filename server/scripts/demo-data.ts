// 演示数据生成（M1 人工验收用）：
//   main 线 = 真实 claude 三轮纯对话（约 3 次 API ≈ $0.1，同 tests/watch.test.ts 约定）→ 节点可真实进入/分叉
//   fixture 线 = 合成记录（零 API）：exp（孤儿灰显）、main-2（含失败轮红叉）——仅视觉展示，进入会报 No conversation found
// 用法: npx tsx scripts/demo-data.ts [目标目录]    （默认 server/.tmp-m1-demo）
import fs from "node:fs";
import path from "node:path";
import { runClaude, runClaudeFresh } from "../../src/claude.js";
import { commitDelta, deltaRecords, dropWorldline, loadIndex } from "../../src/twin.js";
import { CLAUDE_PROJECTS, encodeCwd } from "../../src/paths.js";
import { branchFrom, commitRound, git, initTwinRepo, rmLiveDir, round } from "../test/helpers.js";

const repo = path.resolve(process.argv[2] ?? ".tmp-m1-demo");
const r = initTwinRepo(repo);
rmLiveDir(r); // 清掉历史测试残留的会话文件

function sessionDirFiles(): Set<string> {
  const dir = path.join(CLAUDE_PROJECTS, encodeCwd(r));
  const s = new Set<string>();
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (f.endsWith(".jsonl")) s.add(f);
  return s;
}

function commitReal(sid: string, prompt: string, decision: "initial" | "continue"): { sha: string; node: string | null } {
  const idx = loadIndex(r);
  const recs = deltaRecords(r, sid, idx);
  const c = commitDelta(r, { sid, branch: "main", prompt, records: recs, idx, decision });
  if (!c) throw new Error("commitDelta 未产生 commit（无新记录）");
  return c;
}

// ---------- main 线：真实 claude 三轮（纯对话，无工具权限依赖） ----------

const q1 = "第一问：请记住，这个测试的代号是小桥。简短确认。";
const before = sessionDirFiles();
const r1 = runClaudeFresh(q1, r, true);
if (r1.rc !== 0) throw new Error(`第 1 轮失败 rc=${r1.rc}`);
const sid = [...sessionDirFiles()].filter((f) => !before.has(f))[0]?.replace(/\.jsonl$/, "") ?? "";
if (!sid) throw new Error("未发现新会话文件（claude 未写入）");
const n1 = commitReal(sid, q1, "initial");

const q2 = "第二问：再记一个话题，话题二是世界线分叉。简短确认。";
if (runClaude(sid, q2, r) !== 0) throw new Error("第 2 轮退出码非 0");
const n2 = commitReal(sid, q2, "continue");

const q3 = "第三问：请用一句话回答，我们讨论过哪两个话题？";
if (runClaude(sid, q3, r) !== 0) throw new Error("第 3 轮退出码非 0");
const n3 = commitReal(sid, q3, "continue");

// ---------- 合成 fixture 线（视觉展示；进入会报 No conversation found） ----------

// exp：从真实第 1 问 fork 一轮，随后 drop → 孤儿灰显
branchFrom(r, "exp", n1.sha!);
const n4 = commitRound(r, {
  sid: "fixture-exp", branch: "exp", prompt: "实验方案 A",
  records: round("实验方案 A", n1.node), decision: "fork", anchorNodeUuid: n1.node,
});

// main-2：从 exp tip 再 fork（exp 的 commit 保持可达 → drop 后可索引），含一轮失败（红叉视觉）
branchFrom(r, "main-2", n4.sha);
const n5 = commitRound(r, {
  sid: "fixture-b", branch: "main-2", prompt: "继承实验继续",
  records: round("继承实验继续", n4.node), decision: "fork", anchorNodeUuid: n4.node,
});
commitRound(r, {
  sid: "fixture-b", branch: "main-2", prompt: "尝试接入 API（失败）",
  records: round("尝试接入 API（失败）", n5.node), decision: "failed",
});

git(["checkout", "-q", "main"], r);
dropWorldline(r, "exp");

console.log(`演示仓库就绪: ${r}`);
console.log("main = 真实 3 轮（tip 可进入/继续；从任意 main 节点可 fork 出真实新世界线）");
console.log("exp（孤儿灰显）/ main-2（含失败红叉）= 合成 fixture，仅视觉展示");
