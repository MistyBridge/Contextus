// Session Tree UI（TUI，ink）— v3.1 用户主路径
// 浏览世界线/会话树 → 选中节点 → 物化上下文 → 开新终端窗口 claude --resume（交互模式）
// → 后台文件监控自动提交（检测新提问 → 提交上一轮；窗口关闭 → 提交最后一轮）
import React, { useCallback, useEffect, useState } from "react";
import { render, Box, Text, useInput } from "ink";
import { randomUUID } from "node:crypto";
import { git } from "./git.js";
import { spawnTerminal } from "./claude.js";
import { logEvent } from "./log.js";
import {
  listSessions,
  worldlines,
  tipSession,
  materializeNode,
  writeJsonl,
  autoBranchName,
  commitOf,
  watchSession,
  isTwin,
  syncInstruction,
} from "./twin.js";
import type { Session } from "./sessions.js";
import type { Record } from "./records.js";

interface TreeNode {
  session: Session;
  isTip: boolean;
  depth: number;
}

interface WindowState {
  sid: string;
  branch: string;
  label: string;
  watcher: { stop: () => void };
}

function buildNodes(cwd: string): TreeNode[] {
  const sessions = listSessions(cwd);
  const byUuid = new Map(sessions.map((s) => [s.node_uuid, s]));
  const depthOf = (s: Session, seen = new Set<string>()): number => {
    if (!s.parent_uuid || seen.has(s.node_uuid)) return 0;
    const p = byUuid.get(s.parent_uuid);
    return p ? depthOf(p, seen.add(s.node_uuid)) + 1 : 0;
  };
  const tips = new Map<string, string>(); // branch -> tip node_uuid
  for (const b of worldlines(cwd)) {
    const t = tipSession(cwd, b);
    if (t) tips.set(b, t.node_uuid);
  }
  const nodes: TreeNode[] = [];
  for (const s of sessions) {
    // 孤儿会话（世界线 ref 被 drop）同样可索引、可进入——用户原则：全部可执行节点永远可见
    nodes.push({ session: s, isTip: tips.get(s.branch_id) === s.node_uuid, depth: depthOf(s) });
  }
  // 按分支分组排序展示：分支顺序 = refs 顺序（孤儿排最后），分支内按时间
  const order = new Map(worldlines(cwd).map((b, i) => [b, i]));
  nodes.sort(
    (a, b) =>
      (order.get(a.session.branch_id) ?? 999) - (order.get(b.session.branch_id) ?? 999) ||
      a.session.created_at.localeCompare(b.session.created_at),
  );
  return nodes;
}

function App({ cwd }: { cwd: string }) {
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [selected, setSelected] = useState(0);
  const [win, setWin] = useState<WindowState | null>(null);
  const [status, setStatus] = useState<string>("");
  const [syncMode, setSyncMode] = useState(false); // T8：历史上下文 + 最新代码空间

  const refresh = useCallback(() => setNodes(buildNodes(cwd)), [cwd]);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const finalizeWindow = useCallback(() => {
    setWin((w) => {
      if (w) {
        w.watcher.stop(); // 提交最后一轮（T10）
        setStatus(`窗口已关闭：最后一轮已提交（世界线 ${w.branch}）`);
      }
      return null;
    });
    refresh();
  }, [refresh]);

  const enterNode = useCallback(
    (node: TreeNode) => {
      // 脏工作区守卫（R9）：只拦用户的代码改动；.contextus 自身尾迹（日志/派生数据）
      // 随下一轮提交入库，不构成阻塞
      const dirty = git(["status", "--porcelain"], cwd)
        .split("\n")
        .filter((l) => l.trim() && !l.includes(".contextus/"));
      if (dirty.length > 0) {
        setStatus(
          `⚠ 工作区有未提交改动（${dirty.length} 项），请先清理（stash/commit）再进入节点：${dirty
            .slice(0, 3)
            .map((l) => l.trim())
            .join("；")}`,
        );
        return;
      }
      const s = node.session;
      let sid: string;
      let branch: string;
      let firstDecision: "initial" | "continue" | "fork";
      let anchor: string | null = null;

      if (node.isTip) {
        // 世界线 tip：直接复用 live 会话文件（同一世界线继续）
        sid = s.claude_session_id;
        branch = s.branch_id;
        firstDecision = "continue";
      } else {
        // 历史节点：回溯即分叉——建新世界线、物化上下文、新会话文件
        const sha = commitOf(cwd, s.node_uuid);
        if (!sha) {
          setStatus(`⚠ 节点 ${s.node_uuid.slice(0, 8)} 无对应 commit（索引缺失？）`);
          return;
        }
        branch = autoBranchName(cwd, s.branch_id);
        git(["branch", "-q", branch, sha], cwd); // 新 heads 支
        git(["update-ref", `refs/context/${branch}`, sha], cwd);
        // 只回退代码世界（.contextus 工作区保留——日志尾迹不被覆盖），
        // 然后 symbolic-ref 附着到新支（checkout <branch> -- <path> 形式不切换分支）
        git(["checkout", "-q", sha, "--", ".", ":(exclude).contextus"], cwd);
        git(["symbolic-ref", "HEAD", `refs/heads/${branch}`], cwd);
        let chain = materializeNode(cwd, s, false);
        sid = randomUUID();
        if (syncMode) {
          // T8：历史上下文 + 最新代码空间——同步指令注入为链尾 user 消息（历史节点不动）
          const latest = tipSession(cwd, s.branch_id);
          const latestSha = latest ? commitOf(cwd, latest.node_uuid) : null;
          if (latestSha) {
            const inst: Record = {
              type: "user",
              uuid: randomUUID(),
              parentUuid: chain[chain.length - 1]?.uuid ?? undefined,
              sessionId: sid,
              cwd,
              promptId: randomUUID(),
              message: { role: "user", content: syncInstruction(sha, latestSha) },
            };
            chain = [...chain, inst];
          }
        }
        writeJsonl(sid, chain, cwd);
        firstDecision = "fork";
        anchor = s.node_uuid;
      }

      const launchCmd = spawnTerminal(cwd, sid, (msg) => setStatus(`⚠ ${msg}`));
      logEvent(cwd, "window_spawn", { sid, branch, cmd: launchCmd });
      setStatus(`已发起窗口: ${launchCmd}`);
      const watcher = watchSession(cwd, { sid, branch, firstDecision, anchorNodeUuid: anchor }, (r) => {
        setStatus(`已提交 ${r.sha.slice(0, 12)} [${r.records} 条记录，世界线 ${branch}]`);
        refresh();
      });
      setWin({ sid, branch, label: s.user_input.slice(0, 30), watcher });
      setStatus(`窗口已打开（世界线 ${branch}）——在其中问答；关闭窗口后回到这里按 Enter 提交并刷新`);
    },
    [cwd, refresh],
  );

  useInput((input, key) => {
    if (win) {
      if (key.return) finalizeWindow();
      return;
    }
    if (key.upArrow) setSelected((i) => Math.max(0, i - 1));
    if (key.downArrow) setSelected((i) => Math.min(nodes.length - 1, i + 1));
    if (key.return && nodes[selected]) enterNode(nodes[selected]);
    if (input === "s") setSyncMode((v) => !v);
    if (input === "r") refresh();
    if (input === "q") process.exit(0);
  });

  if (win) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="green">
          窗口进行中 — 世界线 {win.branch}（{win.label}）
        </Text>
        <Text dimColor>在窗口内提问；监控自动提交每一轮。关闭窗口后按 Enter 提交最后一轮并返回树视图。</Text>
        <Text dimColor>注意：窗口打开期间请勿关闭本 TUI。</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>
        Contextus — Session Tree（{cwd}）
      </Text>
      {nodes.length === 0 && <Text dimColor>（空树——还没有会话，先在仓库里 twin-init 并完成首轮）</Text>}
      {nodes.map((n, i) => {
        const tipMark = n.isTip ? " ●" : "";
        const line = `${"  ".repeat(n.depth)}${n.session.user_input.slice(0, 40)}${tipMark}`;
        return (
          <Text key={n.session.node_uuid} inverse={i === selected} color={n.isTip ? "cyan" : undefined}>
            {i === selected ? "▶ " : "  "}[{n.session.branch_id}] {line}
          </Text>
        );
      })}
      <Box marginTop={1}>
        <Text dimColor>
          ↑↓ 选择 · Enter 进入节点（开 CLI 窗口）· s 同步最新代码: {syncMode ? "开" : "关"} · r 刷新 · q 退出
        </Text>
      </Box>
      {status && (
        <Text color="yellow">
          {status}
        </Text>
      )}
    </Box>
  );
}

export function runUi(cwd: string): void {
  if (!isTwin(cwd)) {
    console.error("当前仓库未启用 Twin（先运行 sm twin-init）");
    process.exit(1);
  }
  render(<App cwd={cwd} />);
}
