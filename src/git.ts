// git 子进程封装（store 仓库专用；目标仓库的提交走 twin.ts，M1 实现）
import { spawnSync } from "node:child_process";

export function git(args: string[], cwd: string, opts: { allowFail?: boolean } = {}): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`git ${args.join(" ")} 失败: ${(r.stderr ?? "").trim()}`);
  }
  return r.stdout ?? "";
}

/**
 * 批量读取 git 对象（一次进程）：输入 <sha>:<path> 行，输出对应文件内容。
 * 输出格式: <sha> <type> <size>\n<content>\n——size 是**字节数**，须按字节切（Buffer）。
 * 替代逐文件 git show——Windows 下每次 spawn ~50-100ms，批量可省 N-1 次。
 */
export function catFileBatch(cwd: string, refs: string[]): string[] {
  if (refs.length === 0) return [];
  const input = refs.map((r) => `${r}\n`).join("");
  const r = spawnSync("git", ["cat-file", "--batch"], {
    cwd,
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  const buf = r.stdout as Buffer;
  const out: string[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) break;
    const header = buf.subarray(pos, nl).toString("utf8");
    pos = nl + 1;
    if (!header || header.includes(" missing") || header.includes(" ambiguous")) continue;
    const size = parseInt(header.split(" ")[2] ?? "0", 10);
    out.push(buf.subarray(pos, pos + size).toString("utf8"));
    pos += size + 1; // 内容 + 尾随 \n
  }
  return out;
}
