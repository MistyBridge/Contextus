// 树快照组装：核心层函数 → Web DTO（纯映射，无业务逻辑）
// 布局由 web 端 layoutTree 纯函数负责，server 只给全量节点/边/世界线事实
import { git } from "../../src/git.js";
import { listSessions, worldlines, tipSession, commitOf } from "../../src/twin.js";
import type { ActiveWindowDto, TreeEdgeDto, TreeNodeDto, TreeSnapshot, WorldlineDto } from "../../src/web-api.js";

/** HEAD 落位（查看模式 detached 时 branch = "HEAD"） */
function headInfo(cwd: string): TreeSnapshot["head"] {
  try {
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd).trim();
    const sha = git(["rev-parse", "HEAD"], cwd).trim();
    return { branch, detached: branch === "HEAD", sha };
  } catch {
    return null; // 无 commit 的空仓库
  }
}

export function buildTreeSnapshot(cwd: string, activeWindow: ActiveWindowDto | null): TreeSnapshot {
  const sessions = listSessions(cwd);
  const branches = worldlines(cwd); // refs 顺序
  const branchSet = new Set(branches);

  const worldlineDtos: WorldlineDto[] = branches.map((b) => {
    const tip = tipSession(cwd, b);
    return {
      branch: b,
      tipNodeUuid: tip?.node_uuid ?? null,
      tipSha: tip ? commitOf(cwd, tip.node_uuid) : null,
    };
  });
  const tipByBranch = new Map(worldlineDtos.map((w) => [w.branch, w.tipNodeUuid]));

  // 孤儿世界线：ref 已 drop 但节点仍可索引（字典序排在世界线之后，web 灰显）
  const orphanBranches = [...new Set(sessions.map((s) => s.branch_id))]
    .filter((b) => !branchSet.has(b))
    .sort();

  const nodes: TreeNodeDto[] = sessions.map((s) => ({
    nodeUuid: s.node_uuid,
    parentUuid: s.parent_uuid,
    branchId: s.branch_id,
    decision: s.decision,
    userInput: s.user_input,
    createdAt: s.created_at,
    sha: commitOf(cwd, s.node_uuid),
    isTip: tipByBranch.get(s.branch_id) === s.node_uuid,
    hasFork: false, // 下方由边集合回填
  }));

  const byUuid = new Map(nodes.map((n) => [n.nodeUuid, n]));
  const edges: TreeEdgeDto[] = [];
  for (const n of nodes) {
    if (!n.parentUuid) continue;
    const parent = byUuid.get(n.parentUuid);
    if (!parent) continue; // 父记录不在会话集中（root 或跨库记录）——同 TUI depthOf 语义
    edges.push({
      from: parent.nodeUuid,
      to: n.nodeUuid,
      kind: parent.branchId === n.branchId ? "continue" : "fork",
    });
  }
  for (const e of edges) {
    if (e.kind === "fork") {
      const from = byUuid.get(e.from);
      if (from) from.hasFork = true;
    }
  }

  return {
    cwd,
    isTwin: true,
    head: headInfo(cwd),
    worldlines: worldlineDtos,
    orphanBranches,
    nodes,
    edges,
    activeWindow,
  };
}
