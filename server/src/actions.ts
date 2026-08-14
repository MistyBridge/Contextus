// 节点操作：enter（tip 继续 / 历史 fork）/ view（查看模式）/ closeWindow（提交最后一轮）
// 语义与 TUI（src/ui.tsx enterNode）完全一致——server 只是把同一套核心层调用搬到 HTTP 后面。
// spawnTerminal 可注入（测试不真开终端）；提交事件经 hub 广播进 SSE。
import { randomUUID } from "node:crypto";
import { git } from "../../src/git.js";
import { spawnTerminal as realSpawnTerminal } from "../../src/claude.js";
import { logEvent } from "../../src/log.js";
import {
  acquireLock,
  appendToSession,
  autoBranchName,
  checkoutView,
  commitOf,
  lastRecordUuid,
  listSessions,
  materializeNode,
  ruleInjectionRecord,
  syncInstruction,
  tipSession,
  watchSession,
  writeJsonl,
} from "../../src/twin.js";
import type { Session } from "../../src/sessions.js";
import type { Record } from "../../src/records.js";
import type { ApiErrorKind, CloseResult, EnterResult, ViewResult } from "../../src/web-api.js";
import type { EventHub } from "./events.js";

/** 业务失败 → HTTP 错误映射（app.ts setErrorHandler 统一处理） */
export class ApiFail extends Error {
  constructor(
    message: string,
    public readonly kind: ApiErrorKind,
    public readonly detail?: string,
  ) {
    super(message);
  }
}

interface WindowHandle {
  sid: string;
  branch: string;
  label: string;
  startedAt: string;
  watcher: { stop: () => void };
}

export type SpawnTerminal = typeof realSpawnTerminal;

export class SessionActions {
  private window: WindowHandle | null = null;
  private lastCommit: { sha: string; records: number; node: string | null; branch: string } | null = null;

  constructor(
    private readonly cwd: string,
    private readonly hub: EventHub,
    private readonly spawnTerminal: SpawnTerminal = realSpawnTerminal,
  ) {}

  activeWindow(): WindowHandle | null {
    return this.window;
  }

  /** 脏工作区守卫（R9）：只拦用户代码改动；.contextus 尾迹与 CLAUDE.md 规则区块不构成阻塞 */
  private dirtyGuard(): string[] {
    return git(["status", "--porcelain"], this.cwd)
      .split("\n")
      .filter((l) => l.trim() && !l.includes(".contextus/") && !l.includes("CLAUDE.md"))
      .map((l) => l.trim());
  }

  private requireIdle(): void {
    if (this.window) {
      throw new ApiFail(`已有活动窗口（世界线 ${this.window.branch}），请先关闭`, "conflict");
    }
  }

  /** 取锁包裹执行：锁占用 → 423（acquireLock 抛普通 Error，须在 try 外先映射） */
  private withLock<T>(fn: () => T): T {
    let release: () => void;
    try {
      release = acquireLock(this.cwd);
    } catch (e) {
      throw new ApiFail(e instanceof Error ? e.message : String(e), "locked");
    }
    try {
      return fn();
    } finally {
      release();
    }
  }

  private requireClean(): void {
    const dirty = this.dirtyGuard();
    if (dirty.length > 0) {
      throw new ApiFail(
        `工作区有未提交改动（${dirty.length} 项）——请先清理（stash/commit）再操作`,
        "dirty-workspace",
        dirty.slice(0, 3).join("；"),
      );
    }
  }

  /**
   * 进入节点：tip → 复用 live 会话继续；历史节点 → 回溯即分叉（物化 + 新世界线 + 新会话文件）。
   * 两者均开真实终端 + 启动 watchSession（检测新提问 → 提交上一轮）。
   * 脏工作区守卫只拦 fork 路径（其 checkout 会覆盖工作区）：tip 进入不落地任何代码，
   * 工作区未提交改动本就会随下一轮 add -A 提交——守卫是纯阻力，不设。
   */
  enter(nodeUuid: string, syncMode: boolean): EnterResult {
    this.requireIdle();
    const s = listSessions(this.cwd).find((x) => x.node_uuid === nodeUuid);
    if (!s) throw new ApiFail(`节点不存在: ${nodeUuid.slice(0, 8)}`, "bad-request");
    if (!this.isTipNode(s)) this.requireClean(); // 仅 fork（checkout 路径）需要守卫
    return this.withLock(() => {
      let sid: string;
      let branch: string;
      let isTip: boolean;
      let firstDecision: "continue" | "fork";
      let anchor: string | null = null;

      if (this.isTipNode(s)) {
        // 世界线 tip：直接复用 live 会话文件（同一世界线继续）
        sid = s.claude_session_id;
        branch = s.branch_id;
        firstDecision = "continue";
        // 规则增量注入（T7）：tip commit 的 Chunks 快照 vs 工作区 → 差异追加到 live 文件
        const tipSha = git(["rev-parse", "--verify", `refs/context/${branch}`], this.cwd).trim();
        const ruleInj = ruleInjectionRecord(this.cwd, tipSha, sid, lastRecordUuid(this.cwd, sid));
        if (ruleInj) appendToSession(this.cwd, sid, ruleInj);
        isTip = true;
      } else {
        // 历史节点：回溯即分叉——建新世界线、物化上下文、新会话文件
        const sha = commitOf(this.cwd, s.node_uuid);
        if (!sha) throw new ApiFail(`节点 ${s.node_uuid.slice(0, 8)} 无对应 commit（索引缺失？）`, "bad-request");
        branch = autoBranchName(this.cwd, s.branch_id);
        git(["branch", "-q", branch, sha], this.cwd); // 新 heads 支
        git(["update-ref", `refs/context/${branch}`, sha], this.cwd);
        // 只回退代码世界（.contextus 工作区保留——日志尾迹不被覆盖），HEAD 附着到新支
        git(["checkout", "-q", sha, "--", ".", ":(exclude).contextus"], this.cwd);
        git(["symbolic-ref", "HEAD", `refs/heads/${branch}`], this.cwd);
        let chain = materializeNode(this.cwd, s, false);
        sid = randomUUID();
        if (syncMode) {
          // T8：历史上下文 + 最新代码空间——同步指令注入为链尾 user 消息（历史节点不动）
          const latest = tipSession(this.cwd, s.branch_id);
          const latestSha = latest ? commitOf(this.cwd, latest.node_uuid) : null;
          if (latestSha) {
            const inst: Record = {
              type: "user",
              uuid: randomUUID(),
              parentUuid: chain[chain.length - 1]?.uuid ?? undefined,
              sessionId: sid,
              cwd: this.cwd,
              promptId: randomUUID(),
              message: { role: "user", content: syncInstruction(sha, latestSha) },
            };
            chain = [...chain, inst];
          }
        }
        // 规则增量注入（T7）：发送顺序 = 历史 → （同步指令）→ 规则增量 → 用户请求
        const ruleInj = ruleInjectionRecord(this.cwd, sha, sid, chain[chain.length - 1]?.uuid ?? null);
        if (ruleInj) chain = [...chain, ruleInj];
        writeJsonl(sid, chain, this.cwd);
        firstDecision = "fork";
        anchor = s.node_uuid;
        isTip = false;
      }

      const launchCmd = this.spawnTerminal(this.cwd, sid, () => {});
      logEvent(this.cwd, "window_spawn", { sid, branch, cmd: launchCmd });
      const watcher = watchSession(
        this.cwd,
        { sid, branch, firstDecision, anchorNodeUuid: anchor },
        (r) => {
          this.lastCommit = { sha: r.sha, records: r.records, node: r.node, branch };
          this.hub.broadcast({ type: "commit", ...this.lastCommit });
        },
      );
      this.window = { sid, branch, label: s.user_input.slice(0, 30), startedAt: new Date().toISOString(), watcher };
      return { sid, branch, nodeUuid: s.node_uuid, isTip, launchCmd };
    });
  }

  /** tip 判定：会话内缓存按分支 tip 比对（同 TUI isTip 语义） */
  private isTipNode(s: Session): boolean {
    const tip = tipSession(this.cwd, s.branch_id);
    return tip?.node_uuid === s.node_uuid;
  }

  /** 查看模式：detached 落位，不建线不提交（读历史不建提交——用户定调） */
  view(nodeUuid: string): ViewResult {
    this.requireIdle();
    this.requireClean();
    return this.withLock(() => {
      const s = listSessions(this.cwd).find((x) => x.node_uuid === nodeUuid);
      if (!s) throw new ApiFail(`节点不存在: ${nodeUuid.slice(0, 8)}`, "bad-request");
      const r = checkoutView(this.cwd, nodeUuid);
      return { commit: r.commit, label: r.label, detached: true };
    });
  }

  /** 服务关停兜底：停 watcher（提交最后一轮，T10 语义与 TUI 窗口关闭一致） */
  dispose(): void {
    if (!this.window) return;
    try {
      this.window.watcher.stop();
    } catch {
      /* 关停阶段忽略错误 */
    }
    this.window = null;
  }

  /** 窗口关闭：停 watcher → 提交最后一轮（T10，半成品也提交）；提交事件经 onCommit 广播 */
  close(): CloseResult {
    const w = this.window;
    if (!w) throw new ApiFail("无活动窗口", "bad-request");
    this.window = null;
    const before = this.lastCommit;
    try {
      w.watcher.stop(); // 同步执行：若有未提交记录，onCommit 同步触发并广播
    } catch (e) {
      this.hub.broadcast({ type: "error", message: e instanceof Error ? e.message : String(e) });
      throw new ApiFail(e instanceof Error ? e.message : String(e), "internal");
    }
    const committed = this.lastCommit !== before;
    this.hub.broadcast({ type: "window-closed", branch: w.branch, committed });
    return { branch: w.branch, committed, commit: committed ? this.lastCommit : null };
  }
}
