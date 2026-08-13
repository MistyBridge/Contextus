// git 子进程封装（store 仓库专用；目标仓库的提交走 twin.ts，M1 实现）
import { spawnSync } from "node:child_process";

export function git(args: string[], cwd: string, opts: { allowFail?: boolean } = {}): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`git ${args.join(" ")} 失败: ${(r.stderr ?? "").trim()}`);
  }
  return r.stdout ?? "";
}
