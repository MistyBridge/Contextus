// Claude Code 执行对接（路线 B：claude -p --resume）
// Windows 陷阱（实验 §4.3）：裸名 CreateProcess 解析失败（WinError 2）；
// Claude Code 2.x 为原生二进制（bin/claude.exe），直接 spawn 零引号风险；
// 老版本 cli.js / .cmd shim 仅作兜底。勿用 --debug（破坏恢复，实验 §4.3）。
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

type Launcher =
  | { kind: "exe"; exe: string } // 原生二进制直跑（首选）
  | { kind: "node"; script: string } // 老版本 cli.js 经 node 直跑
  | { kind: "shim"; exe: string }; // .cmd shim 经 cmd.exe（末选）

function npmRoots(): string[] {
  const roots: string[] = [];
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, "npm", "node_modules"));
  const viaNpm = spawnSync("npm", ["root", "-g"], { encoding: "utf8" }).stdout?.trim();
  if (viaNpm) roots.push(viaNpm);
  return [...new Set(roots)];
}

/** 解析 claude 启动方式：优先原生 exe，其次 cli.js，最后 .cmd shim */
export function resolveClaude(): Launcher {
  const roots = npmRoots();
  for (const root of roots) {
    const exe = path.join(root, "@anthropic-ai", "claude-code", "bin", "claude.exe");
    if (fs.existsSync(exe)) return { kind: "exe", exe };
  }
  for (const root of roots) {
    const cliJs = path.join(root, "@anthropic-ai", "claude-code", "cli.js");
    if (fs.existsSync(cliJs)) return { kind: "node", script: cliJs };
  }
  const r = spawnSync("where", ["claude"], { encoding: "utf8" });
  const lines = (r.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const exe = lines.find((l) => l.toLowerCase().endsWith(".cmd")) ?? lines[0] ?? "claude";
  return { kind: "shim", exe };
}

function spawnClaude(
  sid: string | null,
  prompt: string,
  cwd: string,
  capture: boolean,
): { rc: number; stdout: string; stderr: string } {
  const launcher = resolveClaude();
  let exec: string;
  let args: string[];
  if (launcher.kind === "exe") {
    exec = launcher.exe;
    args = sid ? ["-p", "--resume", sid, prompt] : ["-p", prompt];
  } else if (launcher.kind === "node") {
    exec = process.execPath;
    args = sid ? [launcher.script, "-p", "--resume", sid, prompt] : [launcher.script, "-p", prompt];
  } else {
    // cmd.exe /d /s /c：外层引号被剥掉，内层引号原样保留
    const escaped = prompt.replace(/"/g, '""');
    const inner = sid
      ? `"${launcher.exe}" -p --resume ${sid} "${escaped}"`
      : `"${launcher.exe}" -p "${escaped}"`;
    exec = "cmd.exe";
    args = ["/d", "/s", "/c", `"${inner}"`];
  }
  console.log(`\n>>> ${cwd}$ ${exec} ${args.join(" ")}\n`);
  const r = spawnSync(exec, args, {
    cwd,
    stdio: capture ? "pipe" : "inherit",
    encoding: "utf8",
  });
  return { rc: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * 执行一轮：claude -p --resume <sid> "<prompt>"
 * stdio 继承（实时输出）；返回退出码（非 0 = 失败轮，由调用方按 T10 处理）
 */
export function runClaude(sid: string, prompt: string, cwd: string): number {
  return spawnClaude(sid, prompt, cwd, false).rc;
}

/** 新会话直跑（不 --resume）；capture=true 时捕获输出（回归测试用） */
export function runClaudeFresh(prompt: string, cwd: string, capture = false) {
  return spawnClaude(null, prompt, cwd, capture);
}

/**
 * 开新终端窗口运行交互式 claude --resume（用户主路径，v3.1）：
 * 真实 TTY——信任对话框/权限提示可正常应答。
 * wt（Windows Terminal）优先，cmd /c start 兜底（R27）。
 */
export function spawnTerminal(cwd: string, sid: string): void {
  const wt = path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WindowsApps", "wt.exe");
  if (fs.existsSync(wt)) {
    const p = spawn(wt, ["-d", cwd, "cmd.exe", "/k", `claude --resume ${sid}`], {
      detached: true,
      stdio: "ignore",
    });
    p.on("error", (e) => console.error(`wt 启动失败: ${e.message}`));
    p.unref();
  } else {
    const p = spawn(
      "cmd.exe",
      ["/c", "start", "", "cmd", "/k", `cd /d "${cwd}" && claude --resume ${sid}`],
      { detached: true, stdio: "ignore", windowsVerbatimArguments: true },
    );
    p.on("error", (e) => console.error(`cmd start 启动失败: ${e.message}`));
    p.unref();
  }
}
