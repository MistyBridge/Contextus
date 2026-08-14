// 世界线树布局（GitKraken 式行列，技术方案 §4.1 / 设计规范 §5）
// 列 = 世界线泳道（refs 顺序 + 孤儿字典序排后）；行 = 全部节点按 createdAt 全局排序。
// 核心层保证严格单父（T6，无 merge）→ 列内时间单调、列内直线无交叉；
// fork 边跨列 = 分叉点可视化。纯函数、零依赖、可单测。
import type { TreeSnapshot, TreeEdgeDto } from "../../../src/web-api";

export const LANE_WIDTH = 260;
export const ROW_HEIGHT = 92;
export const HEADER_H = 48; // 画布顶部车道列头区（列头随画布平移缩放）
export const CARD_W = 228; // 节点卡片
export const CARD_H = 64;
export const CARD_SLOT_PAD = (ROW_HEIGHT - CARD_H) / 2; // 卡片在行槽内垂直居中偏移

export interface LaneInfo {
  branch: string;
  index: number; // 列序号（活世界线在前，孤儿在后）
  orphan: boolean; // 孤儿灰显（唯一的世界线专项色，D9）
  x: number;
}

export type LayoutNode = {
  id: string; // nodeUuid
  x: number;
  y: number;
  row: number; // 全局时间行
  lane: number; // 列
  branchId: string;
  decision: "initial" | "continue" | "fork" | "failed";
  userInput: string;
  sha: string | null;
  createdAt: string;
  isTip: boolean;
  hasFork: boolean;
  orphan: boolean;
};

export interface LayoutEdge {
  id: string;
  source: string;
  target: string;
  kind: TreeEdgeDto["kind"]; // continue = 列内直线；fork = 跨列弧线
}

export interface TreeLayout {
  lanes: LaneInfo[];
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
}

export function layoutTree(snap: TreeSnapshot): TreeLayout {
  // 列：活世界线按 refs 顺序；孤儿世界线字典序排后（D9：不按世界线名配色，只标 orphan）
  const lanes: LaneInfo[] = [];
  snap.worldlines.forEach((w, i) => {
    lanes.push({ branch: w.branch, index: i, orphan: false, x: i * LANE_WIDTH });
  });
  snap.orphanBranches.forEach((b, i) => {
    lanes.push({ branch: b, index: snap.worldlines.length + i, orphan: true, x: (snap.worldlines.length + i) * LANE_WIDTH });
  });
  const laneByBranch = new Map(lanes.map((l) => [l.branch, l]));

  // 行：createdAt 全局稳定排序（并列时按 branch → uuid，保证确定性）
  const sorted = [...snap.nodes].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.branchId.localeCompare(b.branchId) || a.nodeUuid.localeCompare(b.nodeUuid),
  );

  const nodes: LayoutNode[] = sorted.map((n, row) => {
    const lane = laneByBranch.get(n.branchId) ?? { index: -1, orphan: true, x: 0 };
    return {
      id: n.nodeUuid,
      x: lane.x,
      y: row * ROW_HEIGHT,
      row,
      lane: lane.index,
      branchId: n.branchId,
      decision: n.decision,
      userInput: n.userInput,
      sha: n.sha,
      createdAt: n.createdAt,
      isTip: n.isTip,
      hasFork: n.hasFork,
      orphan: lane.orphan,
    };
  });

  const edges: LayoutEdge[] = snap.edges.map((e, i) => ({
    id: `${e.from}->${e.to}`,
    source: e.from,
    target: e.to,
    kind: e.kind,
  }));

  return {
    lanes,
    nodes,
    edges,
    width: Math.max(1, lanes.length) * LANE_WIDTH,
    height: Math.max(1, sorted.length) * ROW_HEIGHT,
  };
}
