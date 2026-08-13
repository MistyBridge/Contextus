// 路径与环境解析：cwd 编码、Claude 会话目录、store 定位
import os from "node:os";
import path from "node:path";

/** Claude Code 会话文件目录：~/.claude/projects/<cwd编码>/<sessionId>.jsonl */
export const CLAUDE_PROJECTS = path.join(os.homedir(), ".claude", "projects");

/**
 * cwd -> 项目目录名。实测规则（2026-08-13 非 ASCII 回归修正）：
 * **每个非字母数字字符 → 一个 '-'**（含每个 CJK 字符单独占一个 '-'）：
 *   C:\Users\admin    -> C--Users-admin        （实验 §4.3 已验证）
 *   D:\开发\Contextus -> D-----Contextus       （: + \ + 开 + 发 + \ = 5 个 '-'）
 * 编码错误则 --resume 按 cwd 作用域找不到会话文件。
 */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** store 定位：--store 参数 > CONTEXTUS_STORE 环境变量 > 项目默认 ./store */
export function resolveStoreDir(flag?: string): string {
  if (flag) return path.resolve(flag);
  if (process.env.CONTEXTUS_STORE) return path.resolve(process.env.CONTEXTUS_STORE);
  // 项目根 = 本文件上溯两级（src/ -> 根）
  return path.resolve(__dirname, "..", "store");
}
