// server 测试共用工具：合成仓库 + 合成记录轮（零 API，同 tests/m2.test.ts 约定）
// 注意：helpers.ts 不以 .test.ts 结尾，tsx --test 不会把它当作测试执行
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { twinInit, commitDelta, loadIndex } from "../../src/twin.js";
import { encodeCwd, CLAUDE_PROJECTS } from "../../src/paths.js";
import type { Record } from "../../src/records.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 取一个可用（可清空）的测试仓库目录：被占用时换候选 */
export function freshRepo(base: string): string {
  const candidates = [base, `${base}-2`, `${base}-3`];
  for (const cand of candidates) {
    try {
      fs.rmSync(cand, { recursive: true, force: true });
      fs.mkdirSync(cand, { recursive: true });
      return cand;
    } catch {
      continue;
    }
  }
  throw new Error(`所有候选测试目录均被占用: ${base}`);
}

export function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** 空 git 仓库（不启用 Twin——not-twin 用例） */
export function initRepo(base: string): string {
  const repo = freshRepo(base);
  git(["init", "-q", "-b", "main"], repo);
  return repo;
}

/** 启用 Twin 的测试仓库（初始 commit + twinInit） */
export function initTwinRepo(base: string): string {
  const repo = initRepo(base);
  fs.writeFileSync(path.join(repo, "README.md"), "ctxus test\n");
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "init"], repo);
  twinInit(repo);
  return repo;
}

export function mkRec(type: "user" | "assistant", text: string, parent: string | null): Record {
  return {
    type,
    uuid: randomUUID(),
    parentUuid: parent,
    cwd: "",
    promptId: type === "user" ? randomUUID() : undefined,
    message: { role: type, content: type === "user" ? text : [{ type: "text", text }] },
  } as Record;
}

/** 一问一答 = 一轮（父链由 question 的 parentUuid 表达） */
export function round(prompt: string, parent: string | null): Record[] {
  const q = mkRec("user", prompt, parent);
  const a = mkRec("assistant", "答：" + prompt, q.uuid);
  return [q, a];
}

/** 合成一轮并提交；返回 { sha, records, node } */
export function commitRound(
  repo: string,
  opts: {
    sid: string;
    branch: string;
    prompt: string;
    records: Record[];
    decision: "initial" | "continue" | "fork" | "failed";
    anchorNodeUuid?: string | null;
  },
) {
  const idx = loadIndex(repo);
  const r = commitDelta(repo, {
    sid: opts.sid,
    branch: opts.branch,
    prompt: opts.prompt,
    records: opts.records,
    idx,
    decision: opts.decision,
    anchorNodeUuid: opts.anchorNodeUuid,
  });
  if (!r) throw new Error("commitDelta 未产生 commit");
  return r;
}

/** 模拟 ui.tsx fork 路径的 git 前置：从锚点 sha 建新世界线分支并落位（代码世界回退 + HEAD 附着） */
export function branchFrom(repo: string, branch: string, sha: string): void {
  git(["branch", "-q", branch, sha], repo);
  git(["symbolic-ref", "HEAD", `refs/heads/${branch}`], repo);
  git(["checkout", "-q", sha, "--", ".", ":(exclude).contextus"], repo);
}

/** live 会话文件路径（~/.claude/projects/<cwd编码>/<sid>.jsonl） */
export function liveFile(repo: string, sid: string): string {
  return path.join(CLAUDE_PROJECTS, encodeCwd(repo), `${sid}.jsonl`);
}

/** 写 live 会话文件（合成记录即可——watcher 只查 uuid 成员与提问语义，不跑真 claude） */
export function writeLive(repo: string, sid: string, records: Record[]): void {
  const f = liveFile(repo, sid);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const lines: Record[] = [
    { type: "mode", mode: "normal", sessionId: sid },
    { type: "permission-mode", permissionMode: "default", sessionId: sid },
    ...records,
  ];
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
}

export function appendLive(repo: string, sid: string, records: Record[]): void {
  fs.appendFileSync(liveFile(repo, sid), records.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
}

/** 清理测试写入 ~/.claude/projects 的会话目录 */
export function rmLiveDir(repo: string): void {
  fs.rmSync(path.join(CLAUDE_PROJECTS, encodeCwd(repo)), { recursive: true, force: true });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 轮询等待条件成立（超时抛错） */
export async function waitFor(cond: () => boolean, timeoutMs = 3000, stepMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(stepMs);
  }
  throw new Error("waitFor 超时");
}
