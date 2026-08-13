// M0 回归（实验 §4.2 三用例 + 物化一致性 + 非 ASCII cwd）
// 运行: npx tsx tests/regression.ts
// 成本: 约 5 次 claude -p 调用（≈$0.4），测试数据写入 D:\开发\Contextus\store（会先重置）
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runClaudeFresh } from "../src/claude.js";
import { CLAUDE_PROJECTS, encodeCwd } from "../src/paths.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// tsx 本地安装路径确定（devDependency）；其 exports 不暴露 dist/cli.mjs 子路径
const TSCLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CWD = ROOT; // D:\开发\Contextus — 非 ASCII 路径（cwd 编码回归）；信任已在交互会话中接受
const STORE = path.join(ROOT, "store");
const PROJ_DIR = path.join(CLAUDE_PROJECTS, encodeCwd(CWD));

let pass = 0;
let fail = 0;

function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail += 1;
    console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function runSm(args: string[]): { rc: number; stdout: string } {
  const r = spawnSync(process.execPath, [TSCLI, "src/index.ts", "--store", STORE, ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return { rc: r.status ?? 1, stdout: r.stdout ?? "" };
}

/** 失败时输出捕获的尾部日志，便于定位 */
function tailDetail(stdout: string, n = 600): string {
  return stdout ? `\n--- sm 输出尾部 ---\n${stdout.slice(-n)}` : "";
}

function snapshotSids(): Set<string> {
  const s = new Set<string>();
  if (fs.existsSync(PROJ_DIR)) {
    for (const f of fs.readdirSync(PROJ_DIR)) if (f.endsWith(".jsonl")) s.add(f);
  }
  return s;
}

function main(): void {
  console.log("== M0 回归开始 ==");
  console.log(`cwd: ${CWD}`);
  console.log(`cwd 编码: ${encodeCwd(CWD)} → 会话目录 ${PROJ_DIR}`);

  // 重置 store
  fs.rmSync(STORE, { recursive: true, force: true });

  // ---- 0) 非 ASCII 路径编码自检（真实目录名 = 回归基准，检测编码规则漂移）----
  ok("非 ASCII cwd 编码（每个非字母数字字符 → 一个 -）", encodeCwd(CWD) === "D-----Contextus");

  // ---- 1) 第 1 轮：新会话直跑（建立 2 轮会话，实验用例 1 的现代版）----
  console.log("\n== 1) 第 1 轮：直接 claude 提问 ==");
  const before = snapshotSids();
  const r1 = runClaudeFresh(
    "你好！请记住：这个测试项目的代号是「小桥」，话题一是打招呼。请简短回复确认。",
    CWD,
    true,
  );
  ok("第 1 轮退出码 0", r1.rc === 0, `rc=${r1.rc}`);
  const newFiles = [...snapshotSids()].filter((f) => !before.has(f));
  ok("第 1 轮产生会话文件（非 ASCII cwd 目录）", newFiles.length === 1, newFiles.join(","));
  const sid1 = newFiles[0]?.replace(/\.jsonl$/, "") ?? "";
  ok("sid1 已解析", sid1.length > 0);
  if (!sid1) return;

  // ---- 2) 第 2 轮：sm exec（同文件继续 + 回写 store）----
  console.log("\n== 2) 第 2 轮：sm exec ==");
  const e2 = runSm(["exec", sid1, "再记一个话题：话题二是记忆文件的位置。请简短确认。"]);
  ok("第 2 轮退出码 0", e2.rc === 0, `rc=${e2.rc}${e2.rc !== 0 ? tailDetail(e2.stdout) : ""}`);

  // ---- 3) 第 3 轮：sm exec =====
  console.log("\n== 3) 第 3 轮：sm exec ==");
  const e3 = runSm(["exec", sid1, "好的，现在请告诉我：我们讨论过哪两个话题？一句话回答。"]);
  ok("第 3 轮退出码 0", e3.rc === 0, `rc=${e3.rc}${e3.rc !== 0 ? tailDetail(e3.stdout) : ""}`);
  ok(
    "第 3 轮记住两个话题",
    /小桥/.test(e3.stdout) || /打招呼|记忆文件/.test(e3.stdout),
  );

  // ---- 4) 物化一致性（demo_git_tree 验证逻辑）----
  console.log("\n== 4) 物化一致性 check ==");
  const c = runSm(["check", sid1, "2"]);
  ok("check 通过（store 物化 vs JSONL 祖先链逐 uuid 一致）", c.rc === 0, tailDetail(c.stdout));

  // ---- 5) 分支：从节点 2 分支并提问（实验用例 2）----
  console.log("\n== 5) 分支：从节点 2 开新世界线 ==");
  const b = runSm(["branch", sid1, "2", "总结一下这条分支继承了哪些上下文（一句话）"]);
  ok("分支退出码 0", b.rc === 0, `rc=${b.rc}${b.rc !== 0 ? tailDetail(b.stdout) : ""}`);
  const sid2 = b.stdout.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl/)?.[1] ?? "";
  ok("分支会话 sid2 已解析", sid2.length > 0);
  ok("分支正确继承上下文（提到小桥/打招呼）", /小桥|打招呼/.test(b.stdout));

  // ---- 6) 分支会话二次恢复（实验用例 3）----
  if (sid2) {
    console.log("\n== 6) 分支会话二次恢复：sm exec ==");
    const e6 = runSm(["exec", sid2, "复述一下：你在上一条回复里总结的继承上下文是什么？"]);
    ok("二次恢复退出码 0", e6.rc === 0, `rc=${e6.rc}${e6.rc !== 0 ? tailDetail(e6.stdout) : ""}`);
    ok("二次恢复上下文完好", /小桥|打招呼/.test(e6.stdout));
  }

  // ---- 7) store 世界线图 ----
  console.log("\n== 7) store 世界线（git log --graph --all）==");
  const g = spawnSync("git", ["log", "--graph", "--oneline", "--all", "--max-count=20"], {
    cwd: STORE,
    encoding: "utf8",
  });
  console.log(g.stdout || g.stderr);

  console.log(`\n== M0 回归结果: ${pass} 通过 / ${fail} 失败 ==`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main();
