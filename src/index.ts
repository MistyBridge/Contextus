#!/usr/bin/env node
// CLI 入口（M0 独立 store 模式）：list / tree / branch / exec / import / check
// 语义对齐已验证的 sm.py（实验 §4）与 demo_git_tree.py（实验 §5）
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runClaude } from "./claude.js";
import { git } from "./git.js";
import { encodeCwd, resolveStoreDir, CLAUDE_PROJECTS } from "./paths.js";
import {
  loadRecords,
  readSessionFile,
  questions,
  preview,
  ancestorPath,
  type Record,
} from "./records.js";
import { Store, findSessionFile } from "./store.js";
import { twinInit, isTwin, askTurn } from "./twin.js";
import { runUi } from "./ui.js";

const USAGE = `Contextus MVP — Twin 模式（在目标仓库内执行）

用法:
  sm twin-init                               启用 Twin（.contextus/ + 隔离四层权限 + 日志）
  sm ask "<问题>"                             执行一轮交互，轮后自动提交（代码 + 记录 + 日志）

独立 store 模式（实验回归用）:
  sm list                                    列出所有会话
  sm tree <sid>                              显示会话树
  sm branch <sid> <节点> "<问题>" [--branch <名>]   从节点分支新会话并执行
  sm exec <sid> "<问题>"                      在会话上继续
  sm import <sid|jsonl路径> [--branch <名>]   把会话导入 store（幂等）
  sm check <sid> <节点>                       物化一致性校验（store vs JSONL 祖先链）

节点定位: <数字> = 第 N 个用户提问 | <uuid> | last
选项: --store <目录>  指定独立 store 仓库（默认 ./store，可用 CONTEXTUS_STORE 覆盖）
`;

function die(msg: string): never {
  console.error(`错误: ${msg}`);
  process.exit(1);
}

interface Flags {
  positional: string[];
  store?: string;
  branch?: string;
}

function parseFlags(argv: string[]): Flags {
  const positional: string[] = [];
  let store: string | undefined;
  let branch: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--store") {
      store = argv[++i];
      if (!store) die("--store 需要参数");
    } else if (a === "--branch") {
      branch = argv[++i];
      if (!branch) die("--branch 需要参数");
    } else if (a === "--help" || a === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else {
      positional.push(a);
    }
  }
  return { positional, store, branch };
}

// ---------- 物化写入（路线 B，实验 §4.1 验证格式） ----------

function writeJsonl(sid: string, chain: Record[], cwd: string): string {
  const dir = path.join(CLAUDE_PROJECTS, encodeCwd(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${sid}.jsonl`);
  const rewrite = (rec: Record): Record => {
    const s = JSON.stringify(rec);
    const old = rec.sessionId;
    return old ? (JSON.parse(s.split(old).join(sid)) as Record) : rec;
  };
  const conversation = chain.filter(
    (r) => (r.type === "user" || r.type === "assistant") && r.message,
  );
  const lines: Record[] = [
    { type: "mode", mode: "normal", sessionId: sid },
    { type: "permission-mode", permissionMode: "default", sessionId: sid },
    ...conversation.map(rewrite),
  ];
  fs.writeFileSync(out, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  return out;
}

/** 节点定位: 数字=第N个提问 | uuid | last（sm.py 验证语义） */
function findNode(records: Record[], nodeArg: string): Record {
  const qs = questions(records);
  if (nodeArg === "last") return qs[qs.length - 1];
  if (/^\d+$/.test(nodeArg)) {
    const idx = parseInt(nodeArg, 10) - 1;
    if (idx < 0 || idx >= qs.length) die(`只有 ${qs.length} 个用户提问`);
    return qs[idx];
  }
  const hit = records.find((r) => r.uuid === nodeArg);
  if (!hit) die(`找不到节点 ${nodeArg}`);
  return hit;
}

function openStore(storeFlag?: string): Store {
  const store = new Store(resolveStoreDir(storeFlag));
  if (!store.exists()) store.init();
  store.open();
  return store;
}

function worldlineRefs(store: Store): Set<string> {
  const out = git(["for-each-ref", "--format=%(refname:short)", "refs/context"], store.dir);
  return new Set(out.split("\n").filter(Boolean));
}

function autoBranchName(store: Store, parent: string): string {
  const refs = worldlineRefs(store);
  let n = 2;
  while (refs.has(`${parent}-${n}`)) n += 1;
  return `${parent}-${n}`;
}

// ---------- 命令 ----------

function cmdList(): void {
  const rows: { sid: string; mtime: number; n: number; first: string }[] = [];
  const walk = (dir: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && ent.name.endsWith(".jsonl")) {
        try {
          const records = loadRecords(fs.readFileSync(p, "utf8"));
          const qs = questions(records);
          if (qs.length === 0) continue;
          rows.push({
            sid: path.basename(p, ".jsonl"),
            mtime: fs.statSync(p).mtimeMs,
            n: qs.length,
            first: preview(qs[0], 40),
          });
        } catch {
          /* 跳过不可读文件 */
        }
      }
    }
  };
  walk(CLAUDE_PROJECTS);
  rows.sort((a, b) => b.mtime - a.mtime);
  console.log(`${"sessionId".padEnd(38)} ${"提问数".padStart(4)}  首问摘要`);
  for (const r of rows) console.log(`${r.sid.padEnd(38)} ${String(r.n).padStart(4)}  ${r.first}`);
  console.log(`\n共 ${rows.length} 个会话`);
}

function cmdTree(sid: string): void {
  const found = findSessionFile(sid);
  if (!found) die(`找不到会话: ${sid}`);
  const records = loadRecords(fs.readFileSync(found.file, "utf8"));
  console.log(`会话 ${sid}  (${found.cwd})`);
  for (const rec of records) {
    const t = rec.type ?? "";
    if (!["user", "assistant"].includes(t) || !rec.message) continue;
    console.log(`  ${t.padEnd(9)} ${(rec.message.role ?? "").padEnd(9)} ${preview(rec)}`);
  }
}

function cmdImport(sidOrPath: string, branchFlag: string | undefined, storeFlag: string | undefined): void {
  const store = openStore(storeFlag);
  let sid = sidOrPath;
  if (sid.endsWith(".jsonl") && fs.existsSync(sid)) sid = path.basename(sid, ".jsonl");
  const branch = branchFlag ?? "main";
  const r = store.importClaudeFile(sid, { branch, decision: "seed" });
  console.log(`导入完成: ${r.records} 条新记录 → ${r.commits} 个 commit（世界线 ${r.branch}）`);
}

function cmdExec(sid: string, prompt: string, storeFlag: string | undefined): number {
  const found = findSessionFile(sid);
  if (!found) die(`找不到会话: ${sid}`);
  const store = openStore(storeFlag);
  // 执行前确保会话已入库（幂等）
  const entry = store.manifestOf(sid);
  const branch = entry?.branch ?? "main";
  store.importClaudeFile(sid, { branch, decision: entry?.decision ?? "seed" });

  const rc = runClaude(sid, prompt, found.cwd);
  // 轮后回写：新记录导入 store（失败轮同样提交，T10）
  const r = store.importClaudeFile(sid, {
    branch,
    decision: rc === 0 ? "continue" : "failed",
    userInput: prompt,
  });
  console.log(
    `\n(返回码 ${rc}；回写 ${r.records} 条新记录 → ${r.commits} 个 commit，世界线 ${r.branch})`,
  );
  return rc;
}

function cmdBranch(
  sid: string,
  nodeArg: string,
  prompt: string,
  branchFlag: string | undefined,
  storeFlag: string | undefined,
): number {
  const found = findSessionFile(sid);
  if (!found) die(`找不到会话: ${sid}`);
  const records = readSessionFile(found.file);
  const node = findNode(records, nodeArg);

  const store = openStore(storeFlag);
  // 祖先会话入库（幂等）→ 索引齐备后物化
  const parentEntry = store.manifestOf(sid);
  const parentBranch = parentEntry?.branch ?? "main";
  store.importClaudeFile(sid, { branch: parentBranch, decision: parentEntry?.decision ?? "seed" });

  const chain = store.materialize(node.uuid!);
  const newSid = randomUUID();
  const out = writeJsonl(newSid, chain, found.cwd);
  console.log(
    `已创建分支会话: ${out}\n  上下文 ${chain.length} 条记录（截止节点 ${node.uuid!.slice(0, 8)}…）`,
  );

  // 新世界线命名：--branch 指定，缺省 <父世界线>-2、-3…
  const newBranch = branchFlag ?? autoBranchName(store, parentBranch);

  const rc = runClaude(newSid, prompt, found.cwd);
  const r = store.importClaudeFile(newSid, {
    branch: newBranch,
    decision: rc === 0 ? "fork" : "failed",
    parentNodeUuid: node.uuid,
    userInput: prompt,
  });
  console.log(
    `\n(返回码 ${rc}；回写 ${r.records} 条新记录 → ${r.commits} 个 commit，世界线 ${r.branch})`,
  );
  return rc;
}

/** 物化一致性校验：store 物化 vs JSONL 祖先链逐 uuid 比对（demo_git_tree 验证逻辑） */
function cmdCheck(sid: string, nodeArg: string, storeFlag: string | undefined): void {
  const found = findSessionFile(sid);
  if (!found) die(`找不到会话: ${sid}`);
  const records = readSessionFile(found.file);
  const node = findNode(records, nodeArg);

  const store = openStore(storeFlag);
  store.importClaudeFile(sid, { branch: "main", decision: "seed" });

  const fromStore = store.materialize(node.uuid!);

  const byUuid = new Map<string, Record>();
  for (const r of records) if (r.uuid) byUuid.set(r.uuid, r);
  const chain = ancestorPath(byUuid, node.uuid!).filter((r) => r.message);

  const ok =
    fromStore.length === chain.length && fromStore.every((r, i) => r.uuid === chain[i].uuid);
  console.log(
    `[check] store 物化 ${fromStore.length} 条 vs JSONL 祖先链 ${chain.length} 条: ` +
      (ok ? "✅ 完全一致" : "❌ 不一致"),
  );
  if (!ok) {
    const n = Math.max(fromStore.length, chain.length);
    for (let i = 0; i < n; i++) {
      const a = fromStore[i]?.uuid?.slice(0, 8) ?? "—";
      const b = chain[i]?.uuid?.slice(0, 8) ?? "—";
      if (a !== b) console.log(`  第 ${i} 条: store=${a} jsonl=${b}`);
    }
    process.exitCode = 1;
  }
}

// ---------- 入口 ----------

function main(): void {
  const { positional, store, branch } = parseFlags(process.argv.slice(2));
  const [cmd, ...rest] = positional;

  if (!cmd) {
    console.log(USAGE);
    process.exit(0);
  }

  try {
    switch (cmd) {
      case "twin-init":
        twinInit(process.cwd());
        console.log(`已启用 Twin: ${path.join(process.cwd(), ".contextus")}（隔离四层权限已写入 .claude/settings.json）`);
        break;
      case "ask":
        if (!rest[0]) die('ask 需要 "<问题>"');
        if (!isTwin(process.cwd())) die("当前仓库未启用 Twin（先运行 sm twin-init）");
        process.exitCode = askTurn(process.cwd(), rest[0]);
        break;
      case "ui":
        runUi(process.cwd());
        break;
      case "list":
        cmdList();
        break;
      case "tree":
        if (!rest[0]) die("tree 需要 <sid>");
        cmdTree(rest[0]);
        break;
      case "import":
        if (!rest[0]) die("import 需要 <sid|jsonl路径>");
        cmdImport(rest[0], branch, store);
        break;
      case "exec":
        if (!rest[0] || !rest[1]) die('exec 需要 <sid> "<问题>"');
        process.exitCode = cmdExec(rest[0], rest[1], store);
        break;
      case "branch":
        if (!rest[0] || !rest[1] || !rest[2]) die('branch 需要 <sid> <节点> "<问题>"');
        process.exitCode = cmdBranch(rest[0], rest[1], rest[2], branch, store);
        break;
      case "check":
        if (!rest[0] || !rest[1]) die("check 需要 <sid> <节点>");
        cmdCheck(rest[0], rest[1], store);
        break;
      default:
        die(`未知命令: ${cmd}\n\n${USAGE}`);
    }
  } catch (e) {
    die(e instanceof Error ? e.message : String(e));
  }
}

main();
