// Session 状态模型（T3）：.contextus/sessions/<node_uuid>.json，随轮 commit 提交
import fs from "node:fs";
import path from "node:path";

export interface Session {
  node_uuid: string; // 节点 ID = 该轮提问记录的 uuid（对外标识）
  parent_uuid: string | null; // 树边 = 该记录的 parentUuid
  root_uuid: string; // 世界线根节点（tip 传递，O(1)，无需链回溯）
  branch_id: string; // 世界线 = refs/context/<branch>
  decision: "initial" | "continue" | "fork" | "failed";
  anchor_node_uuid: string | null; // fork 时的锚点
  claude_session_id: string; // 执行层 JSONL 文件 ID
  chunks_hash: string | null; // 生效规则快照（M3 填充）
  code_before: string; // 父 commit（提交前已知；code_after 由索引派生，不存储）
  user_input: string;
  created_at: string;
}

export function sessionFile(cwd: string, nodeUuid: string): string {
  return path.join(cwd, ".contextus", "sessions", `${nodeUuid}.json`);
}

export function writeSession(cwd: string, s: Session): void {
  fs.mkdirSync(path.dirname(sessionFile(cwd, s.node_uuid)), { recursive: true });
  fs.writeFileSync(sessionFile(cwd, s.node_uuid), JSON.stringify(s, null, 2), "utf8");
}

export function readSession(cwd: string, nodeUuid: string): Session | null {
  try {
    return JSON.parse(fs.readFileSync(sessionFile(cwd, nodeUuid), "utf8")) as Session;
  } catch {
    return null;
  }
}
