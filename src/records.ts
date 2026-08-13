// 会话记录（Claude Code JSONL 行）的解析与操作
// 全部语义来自实验 §3（uuid/parentUuid 树结构、promptId 去重、message.id 归组）
import fs from "node:fs";

export interface ContentPart {
  type?: string;
  [k: string]: unknown;
}

export interface Record {
  type?: string;
  uuid?: string;
  parentUuid?: string;
  sessionId?: string;
  cwd?: string;
  promptId?: string;
  message?: { role?: string; content?: string | ContentPart[] };
  [k: string]: unknown;
}

/** 逐行解析 JSONL（忽略空行） */
export function loadRecords(text: string): Record[] {
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record);
}

/** 读取会话文件（~/.claude/projects 下的 JSONL） */
export function readSessionFile(file: string): Record[] {
  return loadRecords(fs.readFileSync(file, "utf8"));
}

/** 用户提问（区别于 tool_result 消息和本地命令伪消息）——实验验证语义 */
export function isQuestion(rec: Record): boolean {
  if (rec.type !== "user") return false;
  const content = rec.message?.content;
  if (typeof content === "string") return !content.startsWith("<");
  return !Array.isArray(content) || !content.some((p) => p.type === "tool_result");
}

/** 按 promptId 去重后的用户提问列表（同一提问被编辑重试会记录多次；无 promptId 的记录不参与去重） */
export function questions(records: Record[]): Record[] {
  const seen = new Set<string>();
  const out: Record[] = [];
  for (const rec of records) {
    if (!isQuestion(rec)) continue;
    if (rec.promptId !== undefined && seen.has(rec.promptId)) continue;
    if (rec.promptId !== undefined) seen.add(rec.promptId);
    out.push(rec);
  }
  return out;
}

/** 记录摘要（用于展示与 commit 命名） */
export function preview(rec: Record, limit = 60): string {
  const content = rec.message?.content;
  if (typeof content === "string") return content.slice(0, limit);
  if (Array.isArray(content)) return "[" + content.map((p) => p.type ?? "").join(" + ") + "]";
  return "";
}

/** 沿 parentUuid 回溯到根，返回按时间顺序的链（含目标）——实验 ancestor_path 验证语义 */
export function ancestorPath(byUuid: Map<string, Record>, targetUuid: string): Record[] {
  const chain: Record[] = [];
  let cur = byUuid.get(targetUuid);
  while (cur) {
    chain.push(cur);
    cur = cur.parentUuid ? byUuid.get(cur.parentUuid) : undefined;
  }
  return chain.reverse();
}

/** 按用户提问切分回合：每回合以提问记录开头，到下一个提问前结束——demo_git_tree 验证逻辑 */
export function splitRounds(records: Record[]): Record[][] {
  const rounds: Record[][] = [];
  let cur: Record[] | null = null;
  for (const rec of records) {
    if ((rec.type === "user" || rec.type === "assistant") && rec.message) {
      if (isQuestion(rec)) {
        cur = [rec]; // 提问记录是本回合的第一条
        rounds.push(cur);
      } else if (cur !== null) {
        cur.push(rec);
      }
    }
  }
  return rounds.filter((r) => r.length > 0);
}
