// Store（独立模式，M0）：git 仓库作为会话存储层
// 布局: records/<seq>-<uuid>.json  # 每轮新记录（round = commit，实验 §5.1 映射）
//       manifest.json             # claude 会话 → 世界线/父关系
//       refs/context/<branch>     # 世界线指针
// 关键事实（实验 §5.3）：commit tree 是累积的，物化必须按文件名去重
import fs from "node:fs";
import path from "node:path";
import { git } from "./git.js";
import { loadRecords, splitRounds, preview, type Record } from "./records.js";
import { CLAUDE_PROJECTS } from "./paths.js";

export interface ManifestEntry {
  claudeSessionId: string;
  branch: string;
  decision: string; // seed | fork | continue
  parentNodeUuid?: string;
  createdAt: string;
}

/** 按 sessionId 全局搜索会话文件并读取其记录的 cwd（实验 §4.3：取第一个非空 cwd） */
export function findSessionFile(sid: string): { file: string; cwd: string } | null {
  const walk = (dir: string): string | null => {
    let hit: string | null = null;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (hit) break;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) hit = walk(p);
      else if (ent.isFile() && ent.name === `${sid}.jsonl`) hit = p;
    }
    return hit;
  };
  const file = walk(CLAUDE_PROJECTS);
  if (!file) return null;
  let cwd = "";
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as Record;
      if (r.cwd) {
        cwd = r.cwd;
        break;
      }
    } catch {
      /* 跳过坏行 */
    }
  }
  return { file, cwd };
}

export class Store {
  /** uuid -> commit SHA（每次 open 全量重建；查询 O(1)，实验 §5.2 实测 2μs 量级） */
  private index = new Map<string, string>();
  private maxSeq = 0;
  private manifest: ManifestEntry[] = [];

  constructor(public readonly dir: string) {}

  exists(): boolean {
    return fs.existsSync(path.join(this.dir, ".git"));
  }

  init(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    git(["init", "-q", "-b", "main"], this.dir);
  }

  open(): void {
    this.buildIndex();
    this.loadManifest();
  }

  // ---------- 索引 ----------

  private buildIndex(): void {
    this.index.clear();
    this.maxSeq = 0;
    const shas = git(["rev-list", "--all"], this.dir, { allowFail: true })
      .split(/\s+/)
      .filter(Boolean);
    for (const sha of shas) {
      const names = git(["ls-tree", "-r", "--name-only", sha], this.dir)
        .split("\n")
        .filter(Boolean);
      for (const line of names) {
        const name = path.basename(line); // "00001-<uuid>.json"
        const dash = name.indexOf("-");
        const dot = name.lastIndexOf(".json");
        if (dash <= 0 || dot <= dash) continue;
        const uuid = name.slice(dash + 1, dot);
        if (!this.index.has(uuid)) this.index.set(uuid, sha);
        const seq = parseInt(name.slice(0, dash), 10);
        if (!Number.isNaN(seq) && seq > this.maxSeq) this.maxSeq = seq;
      }
    }
  }

  uuidCommit(uuid: string): string | null {
    return this.index.get(uuid) ?? null;
  }

  // ---------- manifest ----------

  private loadManifest(): void {
    const f = path.join(this.dir, "manifest.json");
    try {
      this.manifest = JSON.parse(fs.readFileSync(f, "utf8")) as ManifestEntry[];
    } catch {
      this.manifest = [];
    }
  }

  private saveManifest(): void {
    fs.writeFileSync(
      path.join(this.dir, "manifest.json"),
      JSON.stringify(this.manifest, null, 2),
      "utf8",
    );
  }

  manifestOf(sid: string): ManifestEntry | null {
    return this.manifest.find((m) => m.claudeSessionId === sid) ?? null;
  }

  // ---------- 导入 ----------

  /**
   * 把 claude 会话文件中的记录导入 store（幂等：uuid 已入库的记录自动跳过）。
   * 每个含新记录的回合 = 一个 commit；commit parent 由首条新记录的 parentUuid
   * 决定（跨文件/跨世界线自然成立分支 DAG）；无 parentUuid = 根 commit。
   */
  importClaudeFile(
    sid: string,
    opts: { branch: string; decision: string; parentNodeUuid?: string; userInput?: string },
  ): { commits: number; records: number; branch: string } {
    const found = findSessionFile(sid);
    if (!found) throw new Error(`找不到会话: ${sid}`);
    const records = loadRecords(fs.readFileSync(found.file, "utf8"));
    const rounds = splitRounds(records);

    let commits = 0;
    let addedRecords = 0;
    let prevSha: string | null = null;

    for (const round of rounds) {
      const fresh = round.filter((r) => r.uuid && !this.index.has(r.uuid!));
      if (fresh.length === 0) continue;

      // 确定 parent：首条新记录的 parentUuid 所在的 commit（跨链分支语义）
      const first = fresh[0];
      let parent = first.parentUuid ? (this.index.get(first.parentUuid) ?? null) : null;
      if (parent === null && prevSha) parent = prevSha; // 兜底：同批导入的上一 commit

      // 先落位工作区（根 commit 则清空工作区），再写新记录——顺序不能反
      if (parent) {
        git(["checkout", "-q", "--detach", parent], this.dir);
      } else {
        git(["branch", "-q", "-D", "_ctxus_orphan"], this.dir, { allowFail: true }); // 清残留
        git(["checkout", "-q", "--orphan", "_ctxus_orphan"], this.dir);
        for (const ent of fs.readdirSync(this.dir)) {
          if (ent !== ".git") fs.rmSync(path.join(this.dir, ent), { recursive: true, force: true });
        }
      }

      // 写本轮新记录文件
      const question = round[0];
      fs.mkdirSync(path.join(this.dir, "records"), { recursive: true });
      for (const rec of fresh) {
        this.maxSeq += 1;
        const fname = `${String(this.maxSeq).padStart(5, "0")}-${rec.uuid}.json`;
        fs.writeFileSync(
          path.join(this.dir, "records", fname),
          JSON.stringify(rec),
          "utf8",
        );
      }

      // manifest 随 commit 入库
      this.upsertManifest({
        claudeSessionId: sid,
        branch: opts.branch,
        decision: opts.decision,
        parentNodeUuid: opts.parentNodeUuid,
        createdAt: new Date().toISOString(),
      });
      this.saveManifest();

      // 提交：名称 = 请求前 20 字；尾注 Node/Claude（T2/T3 约定）
      // 整轮全新时用调用方给的 userInput（分支轮 = 用户本次提问原文）
      const subject =
        opts.userInput && fresh.length === round.length
          ? truncate(opts.userInput, 20)
          : truncate(preview(question, 20) || "[无内容]", 20);
      const msg = `${subject}\n\nNode: ${question.uuid}\nClaude: ${sid}\nDecision: ${opts.decision}`;
      git(["add", "-A"], this.dir);
      git(["commit", "-q", "--no-verify", "-m", msg], this.dir);
      const newSha = git(["rev-parse", "HEAD"], this.dir).trim();
      if (!parent) {
        // 孤儿分支收尾：HEAD 转 detached，删临时分支
        git(["checkout", "-q", "--detach", newSha], this.dir);
        git(["branch", "-q", "-D", "_ctxus_orphan"], this.dir);
      }

      // 世界线前进（双 ref 的 context 侧；heads 侧在 twin 模式维护）
      git(["update-ref", `refs/context/${opts.branch}`, newSha], this.dir);
      git(["update-ref", "HEAD", newSha], this.dir);

      // 增量维护索引
      for (const rec of fresh) this.index.set(rec.uuid!, newSha);
      prevSha = newSha;
      commits += 1;
      addedRecords += fresh.length;
    }

    return { commits, records: addedRecords, branch: opts.branch };
  }

  private upsertManifest(entry: ManifestEntry): void {
    const i = this.manifest.findIndex((m) => m.claudeSessionId === entry.claudeSessionId);
    if (i >= 0) this.manifest[i] = entry;
    else this.manifest.push(entry);
  }

  // ---------- 物化 ----------

  /**
   * 物化 stopUuid 的祖先链：沿 commit 链（git log --reverse）读记录文件，
   * 按文件名去重（实验 §5.3 陷阱），读到 stopUuid 为止。
   */
  materialize(stopUuid: string): Record[] {
    const sha = this.index.get(stopUuid);
    if (!sha) throw new Error(`节点不在 store 中: ${stopUuid}`);
    const out: Record[] = [];
    const seen = new Set<string>();
    const shas = git(["rev-list", "--reverse", sha], this.dir)
      .split(/\s+/)
      .filter(Boolean);
    for (const s of shas) {
      const lines = git(["ls-tree", "-r", "--name-only", s], this.dir)
        .split("\n")
        .filter(Boolean);
      for (const line of lines) {
        if (!line.startsWith("records/")) continue; // 只物化记录文件（manifest 等不是会话记录）
        if (seen.has(line)) continue; // commit tree 累积 → 每个文件只读一次
        seen.add(line);
        const rec = JSON.parse(git(["show", `${s}:${line}`], this.dir)) as Record;
        out.push(rec);
        if (rec.uuid === stopUuid) return out;
      }
    }
    return out;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n);
}
