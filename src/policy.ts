// 策略 Chunk（T7）：.contextus/Chunks/project_policy.md（条目化：每行一条规则）
// 版本 = git 历史快照；回放用当前规则——文档一致性比对 + 增量注入（【禁止】中和）
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { git } from "./git.js";

export const POLICY_NAME = "project_policy.md";

export function policyPath(cwd: string): string {
  return path.join(cwd, ".contextus", "Chunks", POLICY_NAME);
}

/** 工作区规则条目（无文件 = 空规则集） */
export function readPolicyWorktree(cwd: string): string[] {
  const f = policyPath(cwd);
  if (!fs.existsSync(f)) return [];
  return splitEntries(fs.readFileSync(f, "utf8"));
}

/** 某 commit 的规则快照（base 比对源） */
export function readPolicyAt(cwd: string, sha: string): string[] {
  const out = git(["show", `${sha}:.contextus/Chunks/${POLICY_NAME}`], cwd, { allowFail: true });
  return splitEntries(out);
}

function splitEntries(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export function policyHash(entries: string[]): string {
  return createHash("sha256").update(entries.join("\n")).digest("hex").slice(0, 16);
}

export interface RuleDelta {
  adds: string[]; // 新增
  updates: Array<{ old: string; next: string }>; // 修改（新文 + 禁止旧文）
  removes: string[]; // 删除（废止）
}

/** 两行是否视为同一规则的不同版本：公共前缀 ≥4 字符，或 bigram Jaccard ≥ 0.5 */
function similar(a: string, b: string): boolean {
  if (a === b) return true;
  const prefix = a.slice(0, 4);
  if (prefix.length >= 3 && b.startsWith(prefix)) return true;
  return bigramJaccard(a, b) >= 0.5;
}

function bigramJaccard(a: string, b: string): number {
  const ga = new Set<string>();
  for (let i = 0; i < a.length - 1; i++) ga.add(a.slice(i, i + 2));
  const gb = new Set<string>();
  for (let i = 0; i < b.length - 1; i++) gb.add(b.slice(i, i + 2));
  if (ga.size === 0 || gb.size === 0) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter += 1;
  return inter / (ga.size + gb.size - inter);
}

/**
 * 条目级 diff（v2.7）：相似度序列对齐（LCS）——相似而不同的行配对为「修改」，
 * 未配对的 base 行 = 删除（废止）、target 行 = 新增。
 */
export function entryDiff(base: string[], target: string[]): RuleDelta {
  const n = base.length;
  const m = target.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = similar(base[i], target[j])
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const adds: string[] = [];
  const updates: Array<{ old: string; next: string }> = [];
  const removes: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (similar(base[i], target[j]) && dp[i][j] === dp[i + 1][j + 1] + 1) {
      if (base[i] !== target[j]) updates.push({ old: base[i], next: target[j] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      removes.push(base[i]);
      i += 1;
    } else {
      adds.push(target[j]);
      j += 1;
    }
  }
  while (i < n) removes.push(base[i++]);
  while (j < m) adds.push(target[j++]);
  return { adds, updates, removes };
}

/**
 * 规则增量注入文本（base 快照 → 工作区当前）——纠错通道（v3.2）：
 * 生效靠 CLAUDE.md（system prompt 通道，不可见）；注入只保留【禁止】项，
 * 中和历史上下文中嵌入的旧表述：修改 = 【规则更新】新文 + 【禁止】旧文；
 * 删除 = 【规则禁止】旧文。纯新增 → null（CLAUDE.md 已覆盖，零注入完全不可见）。
 * 无差异/无禁止项 → null 不注入。
 * 载体为 assistant 类型记录（见 twin.ruleInjectionRecord）——
 * 不能用 "<" 前缀 user 消息：Claude Code 会将其视为本地命令并从上下文排除（实测）。
 */
export function buildRuleInjection(cwd: string, baseSha: string): string | null {
  const base = readPolicyAt(cwd, baseSha);
  const target = readPolicyWorktree(cwd);
  if (base.join("\n") === target.join("\n")) return null;
  const d = entryDiff(base, target);
  const parts: string[] = [];
  for (const u of d.updates) parts.push(`【规则更新】${u.next}　【禁止】${u.old}`);
  for (const r of d.removes) parts.push(`【规则禁止】${r}（已废止，禁止执行）`);
  if (parts.length === 0) return null;
  return `【Contextus 规则纠错】历史中的旧规则表述已被以下禁令中和：\n` + parts.join("\n");
}

/** 追加一条规则（工作区文件；随下一轮提交入库，O(1) 零全树遍历） */
export function policyAppend(cwd: string, entry: string): void {
  const f = policyPath(cwd);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, entry.trim() + "\n", "utf8");
  syncRulesToClaudeMd(cwd);
}

const RULES_START = "<!-- contextus:rules:start -->";
const RULES_END = "<!-- contextus:rules:end -->";

/**
 * 规则生效通道（用户理想态：看不到但生效）：同步当前规则全文到 CLAUDE.md 标记区块。
 * CLAUDE.md 是 Claude Code 的项目记忆文件——位于 system prompt（对话中不可见、
 * 每次运行必然加载、享缓存断点），任何会话（含历史回放）自动生效当前规则。
 */
export function syncRulesToClaudeMd(cwd: string): void {
  const entries = readPolicyWorktree(cwd);
  const mdPath = path.join(cwd, "CLAUDE.md");
  const block = entries.length
    ? `${RULES_START}\n**Contextus 项目规则**（由 Contextus 管理；请用 sm policy 修改，勿手改本区块）\n\n${entries
        .map((e, i) => `${i + 1}. ${e}`)
        .join("\n")}\n\n${RULES_END}\n`
    : "";
  const existing = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, "utf8") : "";
  const sIdx = existing.indexOf(RULES_START);
  const eIdx = existing.indexOf(RULES_END);
  let next: string;
  if (sIdx >= 0 && eIdx > sIdx) {
    next = existing.slice(0, sIdx) + block + existing.slice(eIdx + RULES_END.length);
  } else {
    next = existing.trimEnd() + (existing.trimEnd() ? "\n\n" : "") + block;
  }
  fs.writeFileSync(mdPath, next, "utf8");
}
