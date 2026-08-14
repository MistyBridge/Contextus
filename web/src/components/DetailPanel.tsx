// 节点详情面板（设计规范 §5.1 右栏）：完整字段 + 操作（进入/查看/同步开关）
import { useState } from "react";
import { ArrowSquareOut, Eye, GitFork } from "@phosphor-icons/react";
import type { TreeNodeDto } from "../../../src/web-api";
import Button from "./ui/Button";
import Toggle from "./ui/Toggle";

interface Props {
  node: TreeNodeDto | null;
  windowActive: boolean;
  syncMode: boolean;
  onSyncMode: (v: boolean) => void;
  onEnter: (syncMode: boolean) => void;
  onView: () => void;
  busy: boolean;
  actionError: string | null;
}

const DECISION_LABEL: Record<TreeNodeDto["decision"], string> = {
  initial: "initial",
  continue: "continue",
  fork: "fork",
  failed: "failed",
};

const DECISION_BADGE: Record<TreeNodeDto["decision"], string> = {
  initial: "bg-surface-2 text-text-2",
  continue: "bg-surface-2 text-text-2",
  fork: "bg-accent/10 text-accent",
  failed: "bg-danger/10 text-danger",
};

function MetaRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="shrink-0 text-[12px] text-text-3">{label}</span>
      <span className={`min-w-0 truncate text-right text-[12px] text-text-2 ${mono ? "font-mono" : ""}`} title={value}>
        {value}
      </span>
    </div>
  );
}

export default function DetailPanel({ node, windowActive, syncMode, onSyncMode, onEnter, onView, busy, actionError }: Props) {
  if (!node) {
    return (
      <aside className="flex w-[320px] shrink-0 flex-col border-l border-border bg-surface">
        <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
          <GitFork size={28} className="text-text-3" />
          <p className="text-[13px] text-text-3">
            选择节点查看详情
            <br />
            点击卡片，从右侧操作进入或查看
          </p>
        </div>
      </aside>
    );
  }

  return (
    <aside className="flex w-[320px] shrink-0 flex-col border-l border-border bg-surface">
      <div className="border-b border-border p-4">
        <h2 className="text-[14px] font-semibold leading-snug text-text">{node.userInput}</h2>
        <span
          className={`mt-2 inline-block rounded-full px-2 py-px font-mono text-[11px] ${DECISION_BADGE[node.decision]}`}
        >
          {DECISION_LABEL[node.decision]}
        </span>
      </div>

      <div className="flex-1 space-y-0.5 px-4 py-3">
        <MetaRow label="世界线" value={node.branchId} mono />
        <MetaRow label="sha" value={node.sha ?? "-"} mono />
        <MetaRow label="created" value={node.createdAt} mono />
        <MetaRow label="节点" value={node.nodeUuid.slice(0, 8)} mono />
        {node.hasFork && <MetaRow label="分叉" value="有下游世界线" />}
      </div>

      <div className="space-y-3 border-t border-border p-4">
        {actionError && (
          <p className="rounded-btn border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">{actionError}</p>
        )}
        {windowActive && (
          <p className="rounded-btn border border-warn/30 bg-warn/10 px-3 py-2 text-[12px] text-warn">
            已有活动窗口，先关闭再操作
          </p>
        )}
        {!node.isTip && <Toggle checked={syncMode} onChange={onSyncMode} label="同步最新代码（回溯时）" />}
        <div className="flex gap-2">
          <Button
            disabled={windowActive}
            loading={busy}
            onClick={() => onEnter(syncMode)}
            className="flex-1 justify-center"
          >
            {node.isTip ? <ArrowSquareOut size={14} weight="bold" /> : <GitFork size={14} weight="bold" />}
            {node.isTip ? "进入节点" : "从这分叉"}
          </Button>
          <Button variant="ghost" disabled={windowActive || busy} onClick={onView}>
            <Eye size={14} weight="bold" />
            查看
          </Button>
        </div>
      </div>
    </aside>
  );
}
