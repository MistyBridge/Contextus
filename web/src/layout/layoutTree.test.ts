// layoutTree 纯函数测试（零 API，合成快照）
import { describe, it, expect } from "vitest";
import { layoutTree, LANE_WIDTH, ROW_HEIGHT } from "./layoutTree";
import type { TreeSnapshot, TreeNodeDto } from "../../../src/web-api";

function snap(opts: {
  nodes: TreeNodeDto[];
  edges?: TreeSnapshot["edges"];
  worldlines?: string[];
  orphanBranches?: string[];
}): TreeSnapshot {
  return {
    cwd: "D:\\test",
    isTwin: true,
    head: null,
    worldlines: (opts.worldlines ?? ["main"]).map((b) => ({ branch: b, tipNodeUuid: null, tipSha: null })),
    orphanBranches: opts.orphanBranches ?? [],
    nodes: opts.nodes,
    edges: opts.edges ?? [],
    activeWindow: null,
  };
}

let seq = 0;
function node(p: Partial<TreeNodeDto>): TreeNodeDto {
  seq += 1;
  return {
    nodeUuid: `uuid-${String(seq).padStart(3, "0")}`,
    parentUuid: null,
    branchId: "main",
    decision: "initial",
    userInput: "提问",
    createdAt: `2026-08-14T10:00:0${seq}.000Z`,
    sha: "abc123",
    isTip: false,
    hasFork: false,
    ...p,
  };
}

describe("layoutTree", () => {
  it("单世界线：按 createdAt 排成单列，行号 = 全局时间序", () => {
    const n2 = node({ createdAt: "2026-08-14T12:00:00.000Z", userInput: "后一题" });
    const n1 = node({ createdAt: "2026-08-14T10:00:00.000Z", userInput: "前一题" });
    const n3 = node({ createdAt: "2026-08-14T14:00:00.000Z", userInput: "最后一题" });
    const edges: TreeSnapshot["edges"] = [
      { from: n1.nodeUuid, to: n2.nodeUuid, kind: "continue" },
      { from: n2.nodeUuid, to: n3.nodeUuid, kind: "continue" },
    ];
    const layout = layoutTree(snap({ nodes: [n3, n1, n2], edges }));

    expect(layout.lanes).toHaveLength(1);
    expect(layout.lanes[0].branch).toBe("main");
    expect(layout.lanes[0].orphan).toBe(false);
    expect(layout.nodes.map((n) => n.id)).toEqual([n1.nodeUuid, n2.nodeUuid, n3.nodeUuid]);
    expect(layout.nodes.map((n) => n.row)).toEqual([0, 1, 2]);
    expect(layout.nodes.every((n) => n.x === 0)).toBe(true);
    expect(layout.nodes.every((n) => n.y === n.row * ROW_HEIGHT)).toBe(true);
    expect(layout.edges.map((e) => [e.source, e.target])).toEqual([
      [n1.nodeUuid, n2.nodeUuid],
      [n2.nodeUuid, n3.nodeUuid],
    ]);
    expect(layout.width).toBe(LANE_WIDTH);
    expect(layout.height).toBe(3 * ROW_HEIGHT);
  });

  it("多世界线：泳道分列，fork 边跨列且标记分叉点", () => {
    const n1 = node({ createdAt: "2026-08-14T10:00:00.000Z", branchId: "main" });
    const n2 = node({ createdAt: "2026-08-14T12:00:00.000Z", branchId: "main-2", decision: "fork" });
    const layout = layoutTree(
      snap({
        nodes: [n1, n2],
        edges: [{ from: n1.nodeUuid, to: n2.nodeUuid, kind: "fork" }],
        worldlines: ["main", "main-2"],
      }),
    );

    expect(layout.lanes.map((l) => l.branch)).toEqual(["main", "main-2"]);
    expect(layout.nodes.find((n) => n.id === n1.nodeUuid)!.lane).toBe(0);
    expect(layout.nodes.find((n) => n.id === n2.nodeUuid)!.lane).toBe(1);
    expect(layout.nodes.find((n) => n.id === n2.nodeUuid)!.x).toBe(LANE_WIDTH);
    expect(layout.edges[0].kind).toBe("fork");
  });

  it("孤儿世界线：排在活世界线之后，orphan 标记（灰显语义，D9）", () => {
    const n1 = node({ createdAt: "2026-08-14T10:00:00.000Z", branchId: "main" });
    const n2 = node({ createdAt: "2026-08-14T11:00:00.000Z", branchId: "exp" });
    const layout = layoutTree(
      snap({
        nodes: [n1, n2],
        worldlines: ["main"],
        orphanBranches: ["exp"],
      }),
    );

    expect(layout.lanes.map((l) => l.branch)).toEqual(["main", "exp"]);
    const exp = layout.lanes.find((l) => l.branch === "exp")!;
    expect(exp.orphan).toBe(true);
    expect(exp.x).toBe(LANE_WIDTH);
    expect(layout.nodes.find((n) => n.id === n2.nodeUuid)!.orphan).toBe(true);
    expect(layout.width).toBe(2 * LANE_WIDTH);
  });

  it("空树：零节点不崩，画布保底 1×1", () => {
    const layout = layoutTree(snap({ nodes: [] }));
    expect(layout.nodes).toHaveLength(0);
    expect(layout.edges).toHaveLength(0);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });

  it("时间并列：稳定排序确定性（tie-break branch → uuid）", () => {
    const a = node({ createdAt: "2026-08-14T10:00:00.000Z", branchId: "main", nodeUuid: "aaa" });
    const b = node({ createdAt: "2026-08-14T10:00:00.000Z", branchId: "main", nodeUuid: "bbb" });
    const l1 = layoutTree(snap({ nodes: [b, a] }));
    const l2 = layoutTree(snap({ nodes: [a, b] }));
    expect(l1.nodes.map((n) => n.id)).toEqual(["aaa", "bbb"]);
    expect(l2.nodes.map((n) => n.id)).toEqual(["aaa", "bbb"]);
  });
});
