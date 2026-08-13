// Twin 核心：一仓两层 + 轮后自动提交 + 1:1 绑定 + 失败轮提交 + 文件监控
// 在目标代码仓库内工作：.contextus/ 入库、refs/heads 与 refs/context 同步前进
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { git, catFileBatch } from "./git.js";
import { runClaude, runClaudeFresh } from "./claude.js";
import { logEvent } from "./log.js";
import { writeSession, type Session } from "./sessions.js";
import { loadRecords, isQuestion, type Record } from "./records.js";
import { encodeCwd, CLAUDE_PROJECTS } from "./paths.js";

const CTX = ".contextus";

// ---------- 隔离四层权限（T2，v3.0）----------

/** 本地 git 写命令全禁（读命令开放）；sm CLI 禁调 */
const GIT_WRITE_DENY = [
  "Bash(git add:*)", "Bash(git commit:*)", "Bash(git checkout:*)", "Bash(git switch:*)",
  "Bash(git branch:*)", "Bash(git merge:*)", "Bash(git rebase:*)", "Bash(git reset:*)",
  "Bash(git stash:*)", "Bash(git tag:*)", "Bash(git cherry-pick:*)", "Bash(git revert:*)",
  "Bash(git push:*)", "Bash(git pull:*)", "Bash(git fetch:*)", "Bash(git clean:*)",
  "Bash(git rm:*)", "Bash(git mv:*)", "Bash(git apply:*)", "Bash(git am:*)",
  "Bash(git init:*)", "Bash(sm:*)", "Bash(sm.py:*)", "Bash(sm.js:*)",
];

/** 文件工具 deny：.git/** 与 .contextus 敏感路径（Chunks 放行——人下命令 Agent 修改） */
const FILE_DENY = [
  "Edit(.git/**)", "Write(.git/**)",
  "Edit(.contextus/records/**)", "Write(.contextus/records/**)",
  "Edit(.contextus/sessions/**)", "Write(.contextus/sessions/**)",
  "Edit(.contextus/logs/**)", "Write(.contextus/logs/**)",
  "Edit(.contextus/index/**)", "Write(.contextus/index/**)",
];

function mergeDeny(cwd: string): void {
  const sf = path.join(cwd, ".claude", "settings.json");
  const deny = [...GIT_WRITE_DENY, ...FILE_DENY];
  let settings: { permissions?: { deny?: string[] } } = {};
  if (fs.existsSync(sf)) {
    try {
      settings = JSON.parse(fs.readFileSync(sf, "utf8"));
    } catch {
      settings = {};
    }
  }
  const existing = settings.permissions?.deny ?? [];
  settings.permissions = { ...(settings.permissions ?? {}), deny: [...new Set([...existing, ...deny])] };
  fs.mkdirSync(path.dirname(sf), { recursive: true });
  fs.writeFileSync(sf, JSON.stringify(settings, null, 2), "utf8");
}

// ---------- twin-init ----------

export function twinInit(cwd: string): void {
  if (!fs.existsSync(path.join(cwd, ".git"))) throw new Error("当前目录不是 git 仓库");
  const ctx = path.join(cwd, CTX);
  for (const sub of ["records", "sessions", "logs", "index", "Chunks"]) {
    fs.mkdirSync(path.join(ctx, sub), { recursive: true });
  }
  mergeDeny(cwd);
  // 锁文件与派生索引不进入历史（.git/info/exclude 只影响本仓库，不污染 .gitignore）
  const excl = path.join(cwd, ".git", "info", "exclude");
  const markers = `/.contextus/.lock\n/.contextus/index/\n`;
  if (!fs.readFileSync(excl, "utf8").includes("/.contextus/.lock")) {
    fs.appendFileSync(excl, `\n# contextus\n${markers}`);
  }
  logEvent(cwd, "twin_init", {});
  if (!hasTrust(cwd)) {
    console.warn(
      `\n⚠ 该目录尚未在 Claude Code 中接受信任：无头模式下工具权限会被忽略（实验 §4.3 陷阱）。\n` +
        `  请先在该目录交互式运行一次 claude 并接受信任，再使用 sm ask。\n`,
    );
  }
}

/** 检查 ~/.claude.json 中该项目是否已接受信任（hasTrustDialogAccepted） */
export function hasTrust(cwd: string): boolean {
  const cf = path.join(os.homedir(), ".claude.json");
  try {
    const data = JSON.parse(fs.readFileSync(cf, "utf8"));
    return data.projects?.[cwd]?.hasTrustDialogAccepted === true;
  } catch {
    return false;
  }
}

export function isTwin(cwd: string): boolean {
  return fs.existsSync(path.join(cwd, CTX, "Chunks"));
}

// ---------- 并发锁（P1-1）----------

const LOCK_STALE_MS = 30 * 60 * 1000;

function lockPath(cwd: string): string {
  return path.join(cwd, CTX, ".lock");
}

export function acquireLock(cwd: string): () => void {
  const p = lockPath(cwd);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // 过期锁：进程崩溃残留（pid + 时间戳 + 过期判定）
  if (fs.existsSync(p)) {
    const age = Date.now() - fs.statSync(p).mtimeMs;
    if (age > LOCK_STALE_MS) fs.rmSync(p, { force: true });
  }
  try {
    fs.writeFileSync(p, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }), { flag: "wx" });
  } catch {
    throw new Error("已有另一个 sm 操作在运行（.contextus/.lock 被占用）");
  }
  return () => fs.rmSync(p, { force: true });
}

// ---------- uuid 索引（持久化 + 增量维护）----------

function indexFile(cwd: string): string {
  return path.join(cwd, CTX, "index", "uuid2commit.json");
}

export function loadIndex(cwd: string): Map<string, string> {
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(indexFile(cwd), "utf8"))));
  } catch {
    return new Map();
  }
}

/** 索引 = 派生数据（R23），从 git 全量重建：扫描 commit 树中的 records/ 文件 */
export function rebuildIndex(cwd: string): Map<string, string> {
  const idx = new Map<string, string>();
  const shas = git(["rev-list", "--all"], cwd, { allowFail: true }).split(/\s+/).filter(Boolean);
  for (const sha of shas) {
    const names = git(["ls-tree", "-r", "--name-only", sha], cwd).split("\n").filter(Boolean);
    for (const line of names) {
      if (!line.startsWith(`${CTX}/records/`)) continue;
      const name = path.basename(line);
      const dash = name.indexOf("-");
      const dot = name.lastIndexOf(".json");
      if (dash <= 0 || dot <= dash) continue;
      const uuid = name.slice(dash + 1, dot);
      if (!idx.has(uuid)) idx.set(uuid, sha);
    }
  }
  saveIndex(cwd, idx);
  return idx;
}

function saveIndex(cwd: string, idx: Map<string, string>): void {
  fs.mkdirSync(path.dirname(indexFile(cwd)), { recursive: true });
  fs.writeFileSync(indexFile(cwd), JSON.stringify(Object.fromEntries(idx), null, 2), "utf8");
}

/** 世界线 tip 的 session（经 tip commit 尾注 Node → git show 读取——工作区可能 checkout 回退） */
export function tipSession(cwd: string, branch: string): Session | null {
  const tip = git(["rev-parse", "--verify", `refs/context/${branch}`], cwd, { allowFail: true }).trim();
  if (!tip) return null;
  const body = git(["log", "-1", "--format=%B", tip], cwd);
  const m = body.match(/^Node: ([0-9a-f-]{36})/m);
  if (!m) return null;
  try {
    return JSON.parse(git(["show", `${tip}:${CTX}/sessions/${m[1]}.json`], cwd)) as Session;
  } catch {
    return null;
  }
}

/** 目标仓库当前 heads 分支（世界线 = 同名 context 分支） */
function currentBranch(cwd: string): string {
  const b = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd).trim();
  if (b === "HEAD") throw new Error("HEAD 处于 detached 状态");
  return b;
}

// ---------- 会话文件工具 ----------

function sessionDir(cwd: string): string {
  return path.join(CLAUDE_PROJECTS, encodeCwd(cwd));
}

function sessionFilePath(cwd: string, sid: string): string {
  return path.join(sessionDir(cwd), `${sid}.jsonl`);
}

function snapshotFiles(cwd: string): Set<string> {
  const s = new Set<string>();
  if (fs.existsSync(sessionDir(cwd))) {
    for (const f of fs.readdirSync(sessionDir(cwd))) if (f.endsWith(".jsonl")) s.add(f);
  }
  return s;
}

/** 物化写入（路线 B，实验 §4.1 验证格式）：祖先链 → 新会话文件 */
export function writeJsonl(sid: string, chain: Record[], cwd: string): string {
  const dir = sessionDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const out = sessionFilePath(cwd, sid);
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

/** 轮记录 delta = live JSONL 中 uuid 不在已入库集合中的记录（免疫 compaction 重写） */
export function deltaRecords(cwd: string, sid: string, idx: Map<string, string>): Record[] {
  const file = sessionFilePath(cwd, sid);
  if (!fs.existsSync(file)) return [];
  const out: Record[] = [];
  for (const rec of loadRecords(fs.readFileSync(file, "utf8"))) {
    if (rec.uuid && !idx.has(rec.uuid) && (rec.type === "user" || rec.type === "assistant") && rec.message) {
      out.push(rec);
    }
  }
  return out;
}

function maxSeqOf(cwd: string): number {
  // git 视角（跨世界线）——新写入的序号必须超过所有已提交序号，避免碰撞
  let max = 0;
  for (const { line } of contextFilesFromGit(cwd, "records")) {
    const m = path.basename(line).match(/^(\d+)-/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

// ---------- 提交原语（无头 ask 与 UI 监控共用）----------

export interface CommitResult {
  sha: string;
  records: number;
  node: string | null;
}

/**
 * 提交一轮：写 records/session → git add -A（代码 + 记录 + 日志）→ commit → 双 ref 前进
 * 失败轮同样提交（T10）；records 为空时返回 null（不产生 commit）
 */
export function commitDelta(
  cwd: string,
  opts: {
    sid: string;
    branch: string;
    prompt: string;
    records: Record[];
    idx: Map<string, string>;
    decision: "initial" | "continue" | "fork" | "failed";
    anchorNodeUuid?: string | null;
    rc?: number;
  },
): CommitResult | null {
  if (opts.records.length === 0) return null;
  const release = acquireLock(cwd);
  try {
    const codeBefore = git(["rev-parse", "HEAD"], cwd).trim();
    const question = opts.records.find((r) => isQuestion(r)) ?? opts.records[0];
    const nodeUuid = question.uuid ?? null;
    const tip = tipSession(cwd, opts.branch);

    // 写记录文件（序号单调递增）
    let seq = maxSeqOf(cwd);
    for (const rec of opts.records) {
      seq += 1;
      const fname = `${String(seq).padStart(5, "0")}-${rec.uuid}.json`;
      fs.writeFileSync(path.join(cwd, CTX, "records", fname), JSON.stringify(rec), "utf8");
    }

    // session.json（code_after 由索引派生，不落存储——v3.0）
    if (nodeUuid) {
      writeSession(cwd, {
        node_uuid: nodeUuid,
        parent_uuid: question.parentUuid ?? null,
        root_uuid: tip?.root_uuid ?? nodeUuid,
        branch_id: opts.branch,
        decision: opts.decision,
        anchor_node_uuid: opts.anchorNodeUuid ?? null,
        claude_session_id: opts.sid,
        chunks_hash: null, // M3 填充
        code_before: codeBefore,
        user_input: opts.prompt,
        created_at: new Date().toISOString(),
      });
    }

    // 日志先写后提交（审计轨迹入 commit，工作区保持干净；sha 由 Node 尾注/索引派生）
    logEvent(cwd, "commit", { decision: opts.decision, node: nodeUuid, records: opts.records.length });

    // 提交（--no-verify：hooks 属代码世界政策，turn 提交是状态快照 R8）
    const subject = opts.prompt.length <= 20 ? opts.prompt : opts.prompt.slice(0, 20);
    const body = nodeUuid
      ? `\n\nNode: ${nodeUuid}\nClaude: ${opts.sid}\nDecision: ${opts.decision}`
      : `\n\nClaude: ${opts.sid}\nDecision: ${opts.decision}`;
    git(["add", "-A"], cwd);
    git(["commit", "-q", "--no-verify", "-m", `${subject}${body}`], cwd);
    const newSha = git(["rev-parse", "HEAD"], cwd).trim();
    git(["update-ref", `refs/context/${opts.branch}`, newSha], cwd);

    // 索引在工作区更新（派生数据，不入库、不弄脏工作区——.git/info/exclude 排除）
    for (const rec of opts.records) if (rec.uuid) opts.idx.set(rec.uuid, newSha);
    saveIndex(cwd, opts.idx);
    return { sha: newSha, records: opts.records.length, node: nodeUuid };
  } finally {
    release();
  }
}

// ---------- 无头一轮（自动化/回归路径）----------

export function askTurn(cwd: string, prompt: string): number {
  const branch = currentBranch(cwd);
  const idx = loadIndex(cwd);
  logEvent(cwd, "turn_start", { branch, prompt: prompt.slice(0, 80) });
  const tip = tipSession(cwd, branch);

  const res = tip
    ? { rc: runClaude(tip.claude_session_id, prompt, cwd), sid: tip.claude_session_id }
    : freshRun(cwd, prompt);
  logEvent(cwd, "turn_end", { rc: res.rc });

  const records = deltaRecords(cwd, res.sid, idx);
  const decision: "initial" | "continue" | "failed" = res.rc !== 0 ? "failed" : tip ? "continue" : "initial";
  const r = commitDelta(cwd, { sid: res.sid, branch, prompt, records, idx, decision });
  console.log(
    `\n(返回码 ${res.rc}；已提交${r ? ` ${r.sha.slice(0, 12)} [${decision}]，delta ${r.records} 条` : "（无新记录）"}，世界线 ${branch})`,
  );
  return res.rc;
}

/** 新世界线首轮：直跑 claude（无 --resume），并从会话目录快照差中发现新文件 */
function freshRun(cwd: string, prompt: string): { rc: number; sid: string } {
  const before = snapshotFiles(cwd);
  const rc = runClaudeFresh(prompt, cwd, false).rc;
  const after = snapshotFiles(cwd);
  const fresh = [...after].filter((f) => !before.has(f));
  const sid = fresh[0]?.replace(/\.jsonl$/, "") ?? "";
  if (!sid) throw new Error("未发现新会话文件（claude 可能未写入）");
  return { rc, sid };
}

// ---------- UI 进入节点：物化 + 世界线落位 ----------

/**
 * 唯一不变的索引 = git 历史（rev-list --all）——不可重写，任何 checkout/分支/drop
 * 操作都不改变它，全部可执行节点永远可索引（含世界线 ref 被 drop 的孤儿节点）。
 * 世界线 refs 仅是最小锚点，不参与节点索引。
 */
function allCommits(cwd: string): string[] {
  return git(["rev-list", "--all"], cwd, { allowFail: true }).split(/\s+/).filter(Boolean);
}

/** 历史中某子目录下的文件（git 视角——工作区可能 checkout 回退，不得依赖工作区文件） */
function contextFilesFromGit(cwd: string, sub: string): Array<{ sha: string; line: string }> {
  const out: Array<{ sha: string; line: string }> = [];
  for (const sha of allCommits(cwd)) {
    for (const line of git(["ls-tree", "-r", "--name-only", sha, `.contextus/${sub}`], cwd)
      .split("\n")
      .filter(Boolean)) {
      out.push({ sha, line });
    }
  }
  return out;
}

/** 批量读取 <sha>:<line> 对象内容（一次 cat-file --batch 进程） */
function readObjects(cwd: string, entries: Array<{ sha: string; line: string }>): string[] {
  return catFileBatch(cwd, entries.map((e) => `${e.sha}:${e.line}`));
}

/** 世界线 tip 指纹（会话内索引缓存失效依据：任何提交都会改变某个 tip） */
function tipsFingerprint(cwd: string): string {
  return git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/context"], cwd);
}

// 会话内索引缓存：树数据构建一次，tip 指纹不变即复用（提交事件会改变 tip → 自动失效）
let sessionsCache: { cwd: string; tips: string; sessions: Session[] } | null = null;
let gitRecordsCache: { cwd: string; tips: string; records: Map<string, Record> } | null = null;

/** 全部已知记录（git 历史全量 records + live 文件合并，按 uuid；会话内缓存） */
function allRecords(cwd: string): Map<string, Record> {
  const fp = tipsFingerprint(cwd);
  if (gitRecordsCache && gitRecordsCache.cwd === cwd && gitRecordsCache.tips === fp) {
    return new Map(gitRecordsCache.records); // 副本防外部修改
  }
  const map = new Map<string, Record>();
  const entries = contextFilesFromGit(cwd, "records").filter((e) => e.line.endsWith(".json"));
  for (const text of readObjects(cwd, entries)) {
    try {
      const rec = JSON.parse(text) as Record;
      if (rec.uuid) map.set(rec.uuid, rec);
    } catch {
      /* 跳过坏文件 */
    }
  }
  gitRecordsCache = { cwd, tips: fp, records: new Map(map) };
  // live 文件合并（未提交尾部）
  if (fs.existsSync(sessionDir(cwd))) {
    for (const f of fs.readdirSync(sessionDir(cwd))) {
      if (!f.endsWith(".jsonl")) continue;
      try {
        for (const rec of loadRecords(fs.readFileSync(path.join(sessionDir(cwd), f), "utf8"))) {
          if (rec.uuid) map.set(rec.uuid, rec);
        }
      } catch {
        /* 跳过坏文件 */
      }
    }
  }
  return map;
}

/**
 * 物化节点完整上下文：从该轮「结束记录」沿 parentUuid 回溯到根。
 * 结束记录 = 子会话提问的 parentUuid；无子（tip）= 世界线 live 文件最后一条记录。
 */
export function materializeNode(cwd: string, node: Session, tip: boolean): Record[] {
  const map = allRecords(cwd);
  let endUuid: string | undefined;
  if (tip) {
    const live = sessionFilePath(cwd, node.claude_session_id);
    if (fs.existsSync(live)) {
      const recs = loadRecords(fs.readFileSync(live, "utf8"));
      endUuid = recs[recs.length - 1]?.uuid;
    }
  }
  if (!endUuid) {
    // 找同世界线中 parent_uuid 链上以本节点为父的「子」会话 → 子提问的 parentUuid
    const sessions = listSessions(cwd).filter((s) => s.branch_id === node.branch_id);
    const child = sessions.find((s) => s.parent_uuid && s.root_uuid === node.root_uuid && after(s, node));
    endUuid = child ? (map.get(child.node_uuid)?.parentUuid ?? undefined) : node.node_uuid;
  }
  if (!endUuid) endUuid = node.node_uuid;
  const chain: Record[] = [];
  let cur: Record | undefined = map.get(endUuid);
  while (cur) {
    chain.push(cur);
    cur = cur.parentUuid ? map.get(cur.parentUuid) : undefined;
  }
  return chain.reverse();
}

function after(a: Session, b: Session): boolean {
  return new Date(a.created_at) > new Date(b.created_at);
}

// ---------- Session 列表（UI 树数据源）----------

export interface SessionEntry extends Session {
  commit: string | null; // uuid2commit 索引派生（code_after）
}

export function listSessions(cwd: string): Session[] {
  // 唯一不变的索引（git 历史全量）——任何操作后全部可执行节点仍可索引
  // 会话内缓存：tip 指纹不变即复用（提交/分支/drop 会改变指纹 → 自动失效重建）
  const fp = tipsFingerprint(cwd);
  if (sessionsCache && sessionsCache.cwd === cwd && sessionsCache.tips === fp) {
    return sessionsCache.sessions;
  }
  const byUuid = new Map<string, Session>();
  const entries = contextFilesFromGit(cwd, "sessions").filter((e) => e.line.endsWith(".json"));
  for (const text of readObjects(cwd, entries)) {
    try {
      const s = JSON.parse(text) as Session;
      byUuid.set(s.node_uuid, s);
    } catch {
      /* 跳过坏文件 */
    }
  }
  const out = [...byUuid.values()];
  out.sort((a, b) => a.created_at.localeCompare(b.created_at));
  sessionsCache = { cwd, tips: fp, sessions: out };
  return out;
}

export function worldlines(cwd: string): string[] {
  // refname:short 只去掉 refs/ 前缀（得到 context/main），这里手动剥到世界线名
  const out = git(["for-each-ref", "--format=%(refname)", "refs/context"], cwd);
  return out
    .split("\n")
    .filter(Boolean)
    .map((r) => r.replace(/^refs\/context\//, ""));
}

/** 新世界线命名：<父>-2、-3… */
export function autoBranchName(cwd: string, parent: string): string {
  const refs = new Set(worldlines(cwd));
  let n = 2;
  while (refs.has(`${parent}-${n}`)) n += 1;
  return `${parent}-${n}`;
}

/** 提交 commit 的 sha（索引派生 = code_after，v3.0） */
export function commitOf(cwd: string, nodeUuid: string): string | null {
  return loadIndex(cwd).get(nodeUuid) ?? null;
}

// ---------- 提交监控（交互窗口，v3.1）----------

export interface WatchState {
  sid: string;
  branch: string;
  firstDecision: "initial" | "continue" | "fork";
  anchorNodeUuid: string | null;
}

function questionText(q: Record): string {
  const c = q.message?.content;
  return typeof c === "string" ? c : "[multimodal]";
}

/**
 * 监控会话 JSONL：每检测到第二条新提问 → 上一轮完成 → 提交；
 * stop()（窗口关闭）→ 提交最后一轮（完整或半成品，T10）。
 */
export function watchSession(
  cwd: string,
  state: WatchState,
  onCommit: (r: CommitResult) => void,
): { stop: () => void } {
  const idx = loadIndex(cwd);
  let first = true;
  const timer = setInterval(() => {
    const records = deltaRecords(cwd, state.sid, idx);
    if (records.length === 0) return;
    const freshQuestions = records.filter((r) => isQuestion(r));
    if (freshQuestions.length < 2) return; // 第二轮提问未出现，继续等
    const boundary = records.indexOf(freshQuestions[1]);
    const round = records.slice(0, boundary);
    const r = commitDelta(cwd, {
      sid: state.sid,
      branch: state.branch,
      prompt: questionText(freshQuestions[0]),
      records: round,
      idx,
      decision: first ? state.firstDecision : "continue",
      anchorNodeUuid: first ? state.anchorNodeUuid : null,
    });
    first = false;
    if (r) onCommit(r);
  }, 2000);
  return {
    stop: () => {
      clearInterval(timer);
      const records = deltaRecords(cwd, state.sid, idx);
      if (records.length === 0) return;
      const q = records.find((r) => isQuestion(r)) ?? records[0];
      const complete = records[records.length - 1].type === "assistant";
      const r = commitDelta(cwd, {
        sid: state.sid,
        branch: state.branch,
        prompt: questionText(q),
        records,
        idx,
        decision: complete ? (first ? state.firstDecision : "continue") : "failed",
        anchorNodeUuid: first ? state.anchorNodeUuid : null,
      });
      if (r) onCommit(r);
    },
  };
}
