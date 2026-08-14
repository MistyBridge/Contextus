// 世界线树画布（React Flow，技术方案 §4.1 / 设计规范 §5.1）
// 节点/边坐标默认来自 layoutTree 纯函数；节点可自由拖动（画布级摆位，不改数据），
// 拖动位置在会话内记忆，「重置布局」回到算法泳道。右键节点出上下文菜单。
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyNodeChanges,
  Background,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ArrowCounterClockwise, ArrowSquareOut, Copy, Eye, GitFork } from "@phosphor-icons/react";
import {
  CARD_H,
  CARD_SLOT_PAD,
  HEADER_H,
  LANE_WIDTH,
  ROW_HEIGHT,
  type LayoutNode,
  type TreeLayout,
} from "../layout/layoutTree";
import NodeCard, { type NodeCardData } from "./NodeCard";

// ---------- 车道列头（不可交互、不可拖；D9：中性灰，孤儿加角标） ----------

type LaneHeaderData = {
  branch: string;
  orphan: boolean;
};

function LaneHeader({ data }: NodeProps<Node<LaneHeaderData>>) {
  const { branch, orphan } = data;
  return (
    <div className="pointer-events-none flex h-10 w-[244px] items-center gap-2 border-b px-2">
      <span className={`min-w-0 truncate font-mono text-[12px] font-medium ${orphan ? "text-text-3" : "text-text-2"}`}>
        {branch}
      </span>
      {orphan && (
        <span className="rounded-full border border-orphan/30 px-1.5 py-px font-mono text-[10px] uppercase tracking-wide text-orphan">
          orphan
        </span>
      )}
    </div>
  );
}

// ---------- 车道导线（不可交互、不可拖；中性灰，孤儿虚线） ----------

type LaneWireData = {
  orphan: boolean;
  height: number;
};

function LaneWire({ data }: NodeProps<Node<LaneWireData>>) {
  const { orphan, height } = data;
  return (
    <div
      className="pointer-events-none"
      style={{
        width: 2,
        height: Math.max(height, 2),
        background: orphan
          ? `repeating-linear-gradient(to bottom, var(--orphan) 0 6px, transparent 6px 12px)`
          : "var(--text-3)",
        opacity: orphan ? 0.8 : 0.5,
      }}
    />
  );
}

// ---------- 元素派生（布局 + 用户拖动覆盖 → RF 元素） ----------

function deriveNodes(
  layout: TreeLayout,
  selected: string | null,
  overrides: Map<string, { x: number; y: number }>,
  onSelect: (nodeUuid: string) => void,
  hoverPath: Set<string>,
  hovered: string | null,
): Node[] {
  const nodes: Node[] = [];

  for (const lane of layout.lanes) {
    nodes.push({
      id: `lane-header-${lane.branch}`,
      type: "laneHeader",
      position: { x: lane.x + 8, y: 4 },
      data: { branch: lane.branch, orphan: lane.orphan } satisfies LaneHeaderData,
      selectable: false,
      draggable: false,
      zIndex: 0,
    });

    // 车道导线：从该列首节点中心到末节点中心（跟随算法布局，不随拖动）
    const laneNodes = layout.nodes.filter((n) => n.lane === lane.index);
    if (laneNodes.length > 0) {
      const firstRow = Math.min(...laneNodes.map((n) => n.row));
      const lastRow = Math.max(...laneNodes.map((n) => n.row));
      nodes.push({
        id: `lane-wire-${lane.branch}`,
        type: "laneWire",
        position: {
          x: lane.x + LANE_WIDTH / 2 - 1,
          y: HEADER_H + firstRow * ROW_HEIGHT + CARD_SLOT_PAD + CARD_H / 2,
        },
        data: {
          orphan: lane.orphan,
          height: (lastRow - firstRow) * ROW_HEIGHT,
        } satisfies LaneWireData,
        selectable: false,
        draggable: false,
        zIndex: 0,
      });
    }
  }

  for (const n of layout.nodes) {
    const base = { x: n.x + 16, y: HEADER_H + n.row * ROW_HEIGHT + CARD_SLOT_PAD };
    const pos = overrides.get(n.id) ?? base;
    nodes.push({
      id: n.id,
      type: "ctx",
      position: pos,
      data: {
        ...n,
        selected: selected === n.id,
        hover: hovered === n.id ? "self" : hoverPath.has(n.id) ? "path" : null,
        onSelect,
      } satisfies NodeCardData,
      zIndex: 10,
    });
  }
  return nodes;
}

function deriveEdges(layout: TreeLayout): Edge[] {
  // D9：边线中性灰（fork 弧线靠形状区分），孤儿边更浅
  return layout.edges.map((e) => {
    const target = layout.nodes.find((n) => n.id === e.target);
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      type: e.kind === "continue" ? "straight" : "default",
      style: { stroke: target?.orphan ? "var(--orphan)" : "var(--text-3)", strokeWidth: 1.5, opacity: 0.6 },
      interactionWidth: 12,
      zIndex: 5,
    };
  });
}

// ---------- 右键菜单项 ----------

function MenuItem({ icon, label, disabled, onClick }: { icon: ReactNode; label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-btn px-2 py-1.5 text-left text-[12px] text-text-2 hover:bg-surface-2 hover:text-text disabled:opacity-40"
    >
      <span className="shrink-0">{icon}</span>
      {label}
    </button>
  );
}

// ---------- 画布 ----------

const NODE_TYPES = { ctx: NodeCard, laneHeader: LaneHeader, laneWire: LaneWire };

interface Props {
  layout: TreeLayout;
  selected: string | null;
  onSelect: (nodeUuid: string | null) => void;
  onEnter: (nodeUuid: string) => void;
  onView: (nodeUuid: string) => void;
}

export default function TreeCanvas({ layout, selected, onSelect, onEnter, onView }: Props) {
  const userPos = useRef(new Map<string, { x: number; y: number }>());
  const [hasOverrides, setHasOverrides] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; node: LayoutNode } | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const instance = useRef<ReactFlowInstance | null>(null);
  const fitted = useRef(false);

  const [rfNodes, setRfNodes] = useNodesState<Node>([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setRfNodes((nds) => applyNodeChanges(changes, nds));
    },
    [setRfNodes],
  );

  // hover 祖先链（自含 + 沿 parentUuid 回溯的祖先），供卡片链路高亮
  const hoverPath = useMemo(() => {
    if (!hovered) return new Set<string>();
    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    const s = new Set<string>();
    let cur: string | undefined = hovered;
    while (cur) {
      s.add(cur);
      cur = byId.get(cur)?.parentUuid ?? undefined;
    }
    return s;
  }, [layout, hovered]);

  // 布局/选中/悬停变化 → 重派生（拖动覆盖优先；选中态更新卡片样式）
  useEffect(() => {
    setRfNodes(deriveNodes(layout, selected, userPos.current, onSelect, hoverPath, hovered));
    setRfEdges(deriveEdges(layout));
  }, [layout, selected, onSelect, hoverPath, hovered, setRfNodes, setRfEdges]);

  // 一次性 fitView：首次有节点时适配视口；此后布局/树刷新不再拽回用户视角
  useEffect(() => {
    if (!instance.current) return;
    if (!fitted.current && rfNodes.some((n) => n.type === "ctx")) {
      fitted.current = true;
      requestAnimationFrame(() => instance.current?.fitView({ padding: 0.2 }));
    }
  }, [rfNodes]);

  const handleDragStop = useCallback((_e: MouseEvent | TouchEvent, node: Node) => {
    if (node.type !== "ctx") return;
    userPos.current.set(node.id, { x: node.position.x, y: node.position.y });
    setHasOverrides(true);
  }, []);

  const resetLayout = useCallback(() => {
    userPos.current.clear();
    setHasOverrides(false);
    fitted.current = false; // 重置后重新适配视口（回到算法泳道视角）
    setRfNodes(deriveNodes(layout, selected, userPos.current, onSelect, hoverPath, hovered));
  }, [layout, selected, onSelect, hoverPath, hovered, setRfNodes]);

  const handleContextMenu = useCallback(
    (e: ReactMouseEvent, node: Node) => {
      e.preventDefault();
      if (node.type !== "ctx") return;
      const ln = layout.nodes.find((n) => n.id === node.id);
      if (!ln) return;
      setMenu({ x: e.clientX, y: e.clientY, node: ln });
    },
    [layout],
  );

  // 关闭右键菜单：点击外部 / Esc
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  return (
    <div className="relative h-full">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={NODE_TYPES}
        onInit={(inst) => {
          instance.current = inst;
        }}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={handleDragStop}
        onNodeContextMenu={handleContextMenu}
        onNodeMouseEnter={(_e, node) => {
          if (node.type === "ctx") setHovered(node.id);
        }}
        onNodeMouseLeave={() => setHovered(null)}
        minZoom={0.3}
        maxZoom={1.5}
        nodesConnectable={false}
        elementsSelectable
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_e, node) => {
          if (node.type === "ctx") onSelect(node.id);
        }}
        onPaneClick={() => onSelect(null)}
      >
        <Background gap={24} color="var(--border)" />
      </ReactFlow>

      {/* 重置布局（有拖动覆盖时出现） */}
      {hasOverrides && (
        <button
          type="button"
          onClick={resetLayout}
          className="absolute right-3 top-3 z-10 flex items-center gap-1.5 rounded-btn border border-border bg-surface px-2.5 py-1.5 text-[12px] text-text-2 shadow-1 transition-colors hover:bg-surface-2 hover:text-text"
        >
          <ArrowCounterClockwise size={13} />
          重置布局
        </button>
      )}

      {/* 节点右键菜单（fixed 定位，避开视口边缘） */}
      {menu && (
        <div
          className="fixed z-50 w-[184px] rounded-card border border-border bg-surface p-1 shadow-2"
          style={{
            left: Math.min(menu.x, window.innerWidth - 200),
            top: Math.min(menu.y, window.innerHeight - 240),
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <MenuItem
            icon={menu.node.isTip ? <ArrowSquareOut size={13} weight="bold" /> : <GitFork size={13} weight="bold" />}
            label={menu.node.isTip ? "进入节点" : "从这分叉"}
            onClick={() => {
              setMenu(null);
              onEnter(menu.node.id);
            }}
          />
          <MenuItem
            icon={<Eye size={13} weight="bold" />}
            label="查看模式"
            onClick={() => {
              setMenu(null);
              onView(menu.node.id);
            }}
          />
          <div className="my-1 h-px bg-border" />
          <MenuItem
            icon={<Copy size={13} />}
            label={menu.node.sha ? `复制 sha ${menu.node.sha.slice(0, 8)}` : "复制 sha（无）"}
            disabled={!menu.node.sha}
            onClick={() => {
              setMenu(null);
              void navigator.clipboard.writeText(menu.node.sha ?? "");
            }}
          />
          <MenuItem
            icon={<Copy size={13} />}
            label="复制提问"
            onClick={() => {
              setMenu(null);
              void navigator.clipboard.writeText(menu.node.userInput);
            }}
          />
        </div>
      )}
    </div>
  );
}
