// 节点卡片（React Flow 自定义节点，设计规范 §6）
// 前 20 字 + decision 图标 + sha 徽章 + 时间；tip 统一绿色描边 + TIP 徽章（D9）；孤儿 60% 灰显
import type { CSSProperties } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { Circle, GitFork, X } from "@phosphor-icons/react";
import type { LayoutNode } from "../layout/layoutTree";

export type NodeCardData = LayoutNode & {
  selected: boolean;
  onSelect: (nodeUuid: string) => void;
};

function DecisionIcon({ decision }: { decision: LayoutNode["decision"] }) {
  switch (decision) {
    case "initial":
      return <Circle size={13} weight="fill" className="text-text-2" />;
    case "continue":
      return <Circle size={13} className="text-text-3" />;
    case "fork":
      return <GitFork size={14} weight="bold" className="text-text-2" />;
    case "failed":
      return <X size={14} weight="bold" className="text-danger" />;
  }
}

export default function NodeCard({ data }: NodeProps<Node<NodeCardData>>) {
  const { userInput, sha, createdAt, isTip, orphan, decision, selected, onSelect } = data;
  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        onSelect(data.id);
      }}
      className={[
        "relative flex h-16 w-[228px] cursor-pointer flex-col justify-center gap-1 rounded-card border bg-surface px-3 shadow-1",
        "transition-[border-color,box-shadow] hover:bg-surface-2",
        selected ? "border-accent shadow-2" : "border-border",
        isTip ? "ring-2 ring-inset" : "",
        orphan ? "opacity-60" : "",
      ].join(" ")}
      style={isTip ? ({ "--tw-ring-color": "var(--ok)" } as CSSProperties) : undefined}
    >
      {/* 边连接点：底部出 / 顶部入（透明，仅锚定边端点） */}
      <Handle type="target" position={Position.Top} style={{ opacity: 0, top: 0 }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0, bottom: 0 }} />

      <div className="flex items-center gap-1.5">
        <DecisionIcon decision={decision} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text" title={userInput}>
          {userInput}
        </span>
        {isTip && (
          <span className="rounded-full border border-ok/30 bg-ok/10 px-1.5 py-px font-mono text-[10px] font-medium uppercase tracking-wide text-ok">
            tip
          </span>
        )}
      </div>
      <div className="flex items-center justify-between">
        <span className="font-mono text-[11px] text-text-3">{sha ? sha.slice(0, 8) : "-"}</span>
        <span className="font-mono text-[11px] text-text-3">
          {createdAt.slice(11, 19)}
        </span>
      </div>
    </div>
  );
}
