// M1 Twin 写入回归：twin-init + ask 闭环 + 隔离四层 + 并发锁
// 运行: npx tsx tests/twin-regression.ts   （约 4 次 claude 调用 ≈ $0.3）
// 验收（方案 §6 M1）：连续 3 轮 → 3 commit、双 ref 同步、工作区干净、
//   Agent 写命令被拒而读命令可用、并发 ask 被锁拒绝
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSCLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const REPO = path.join(ROOT, "tests", ".tmp-twin-repo");

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

function git(args: string[], cwd = REPO): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return r.stdout?.trim() ?? "";
}

function runSm(args: string[], cwd = REPO): { rc: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [TSCLI, path.join(ROOT, "src", "index.ts"), ...args], {
    cwd,
    encoding: "utf8",
  });
  return { rc: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function headSha(): string {
  return git(["rev-parse", "HEAD"]);
}

function ctxSha(branch: string): string {
  return git(["rev-parse", "--verify", `refs/context/${branch}`]);
}

function lastRecordFiles(): string[] {
  const dir = path.join(REPO, ".contextus", "records");
  return fs
    .readdirSync(dir)
    .sort()
    .slice(-6);
}

function readLastRecords(): string {
  return lastRecordFiles()
    .map((f) => fs.readFileSync(path.join(REPO, ".contextus", "records", f), "utf8"))
    .join("\n");
}

function main(): void {
  console.log("== M1 Twin 回归开始 ==");

  // ---- 0) 重置测试仓库 ----
  fs.rmSync(REPO, { recursive: true, force: true });
  fs.mkdirSync(REPO, { recursive: true });
  git(["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(REPO, "README.md"), "twin test repo\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
  const base = headSha();

  // ---- 1) twin-init ----
  console.log("\n== 1) twin-init ==");
  const ti = runSm(["twin-init"]);
  ok("twin-init 退出码 0", ti.rc === 0, ti.stderr.trim());
  ok(".contextus 目录结构", ["records", "sessions", "logs", "index", "Chunks"].every((d) => fs.existsSync(path.join(REPO, ".contextus", d))));
  const settings = JSON.parse(fs.readFileSync(path.join(REPO, ".claude", "settings.json"), "utf8"));
  const deny = settings.permissions?.deny ?? [];
  ok("settings.json 隔离四层 deny 已写入", deny.some((d: string) => d.includes("git commit")) && deny.some((d: string) => d.includes(".git/**")) && deny.some((d: string) => d.includes("sm")));
  ok(".git/info/exclude 排除锁文件", fs.readFileSync(path.join(REPO, ".git", "info", "exclude"), "utf8").includes(".contextus/.lock"));

  // ---- 2) 第 1 轮：Agent 创建文件 ----
  console.log("\n== 2) 第 1 轮：ask（创建 hello.txt）==");
  const a1 = runSm(["ask", "创建 hello.txt，内容为 hello"]);
  ok("第 1 轮退出码 0", a1.rc === 0, a1.stderr.trim());
  ok("hello.txt 已创建且内容正确", fs.readFileSync(path.join(REPO, "hello.txt"), "utf8").trim() === "hello");
  const c1 = headSha();
  ok("第 1 轮产生 commit 且名称 = 请求前 20 字", git(["log", "-1", "--format=%s", c1]) === "创建 hello.txt，内容为 hello");
  ok("双 ref 同步（heads == context/main）", c1 === ctxSha("main"), `heads=${c1.slice(0, 8)} ctx=${ctxSha("main").slice(0, 8)}`);
  ok("工作区干净", git(["status", "--porcelain"]) === "");
  ok("records/sessions/日志 已入库", lastRecordFiles().length > 0 && fs.readdirSync(path.join(REPO, ".contextus", "sessions")).length === 1 && fs.existsSync(path.join(REPO, ".contextus", "logs", "runtime.log")));
  const s1 = JSON.parse(fs.readFileSync(path.join(REPO, ".contextus", "sessions", fs.readdirSync(path.join(REPO, ".contextus", "sessions"))[0]), "utf8"));
  ok("session.json 字段（decision=initial，code_before=初始 commit）", s1.decision === "initial" && s1.code_before === base);

  // ---- 3) 第 2 轮：Agent 修改文件 ----
  console.log("\n== 3) 第 2 轮：ask（修改 hello.txt）==");
  const a2 = runSm(["ask", "把 hello.txt 的内容改为 world"]);
  ok("第 2 轮退出码 0", a2.rc === 0, a2.stderr.trim());
  ok("hello.txt 内容 = world", fs.readFileSync(path.join(REPO, "hello.txt"), "utf8").trim() === "world");
  const c2 = headSha();
  ok("第 2 轮 commit 链：code_before == 第 1 轮 commit", (() => {
    const files = fs.readdirSync(path.join(REPO, ".contextus", "sessions")).sort();
    const s2 = JSON.parse(fs.readFileSync(path.join(REPO, ".contextus", "sessions", files[files.length - 1]), "utf8"));
    return s2.decision === "continue" && s2.code_before === c1 && s2.root_uuid === s1.node_uuid;
  })(), `heads=${c2.slice(0, 8)}`);
  ok("双 ref 同步", c2 === ctxSha("main"));
  ok("工作区干净", git(["status", "--porcelain"]) === "");

  // ---- 4) 第 3 轮：纯对话轮（不改代码，日志增量兜底）----
  console.log("\n== 4) 第 3 轮：ask（纯对话）==");
  const a3 = runSm(["ask", "你好，我们打个招呼吧"]);
  ok("第 3 轮退出码 0", a3.rc === 0, a3.stderr.trim());
  const c3 = headSha();
  ok("第 3 轮 commit 存在", c3 !== c2);
  ok("代码树与父 commit 相同（除 .contextus）", git(["diff", "--stat", c2, c3, "--", ".", ":(exclude).contextus"]) === "");
  ok("双 ref 同步", c3 === ctxSha("main"));
  ok("工作区干净", git(["status", "--porcelain"]) === "");

  // ---- 5) 隔离四层：读命令可用、写命令被拒 ----
  console.log("\n== 5) 隔离验证：读 git 可用 / 写 git 被拒 ==");
  const before = git(["rev-list", "--count", "HEAD"]);
  const a4 = runSm(["ask", "先运行 git log --oneline -1 并复述输出，然后尝试运行 git commit --allow-empty -m forbidden-test，报告结果"]);
  ok("隔离验证轮退出码 0", a4.rc === 0, a4.stderr.trim());
  const after = git(["rev-list", "--count", "HEAD"]);
  ok("commit 数只 +1（Agent 的 git commit 未生效，仅轮提交）", parseInt(after, 10) === parseInt(before, 10) + 1, `${before} -> ${after}`);
  const rec = readLastRecords();
  ok("读命令可用（复述出 git log 输出）", /打个招呼吧/.test(rec));
  ok("写命令被拒（回复含拒绝语义）", /拒绝|denied|不允许|permission|not allowed|forbidden/i.test(rec));

  // ---- 6) 并发锁：占用时 ask 被拒 ----
  console.log("\n== 6) 并发锁 ==");
  const lock = path.join(REPO, ".contextus", ".lock");
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999, ts: new Date().toISOString() }));
  const l1 = runSm(["ask", "这条不该执行"]);
  ok("锁占用时 ask 被拒绝（无 API 调用）", l1.rc !== 0 && /锁|占用/.test(l1.stderr + l1.stdout));
  fs.rmSync(lock, { force: true });
  const l2 = runSm(["ask", "锁释放后能跑吗？请回答 可以"]);
  ok("锁释放后 ask 正常", l2.rc === 0, l2.stderr.trim());

  // ---- 7) 世界线图 ----
  console.log("\n== 7) 世界线（git log --graph refs/context/main）==");
  console.log(git(["log", "--graph", "--oneline", "refs/context/main", "--max-count=8"]));

  console.log(`\n== M1 回归结果: ${pass} 通过 / ${fail} 失败 ==`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main();
