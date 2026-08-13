// 运行日志（T2）：逐行追加 JSON 事件，随轮提交入库，构成审计轨迹
// 日志本身只增不改（T9：审计信任锚点）
import fs from "node:fs";
import path from "node:path";

export interface LogEvent {
  ts: string;
  event: string;
  [k: string]: unknown;
}

export function logFile(cwd: string): string {
  return path.join(cwd, ".contextus", "logs", "runtime.log");
}

export function ensureLog(cwd: string): void {
  fs.mkdirSync(path.dirname(logFile(cwd)), { recursive: true });
  if (!fs.existsSync(logFile(cwd))) fs.writeFileSync(logFile(cwd), "", "utf8");
}

export function logEvent(cwd: string, event: string, fields: Record<string, unknown> = {}): void {
  ensureLog(cwd);
  const line: LogEvent = { ts: new Date().toISOString(), event, ...fields };
  fs.appendFileSync(logFile(cwd), JSON.stringify(line) + "\n", "utf8");
}
