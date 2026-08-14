// 底部栏（设计规范 §5.1）：状态灯 + commit toast + 窗口进行中面板 + 错误条
// 状态点只表真实语义（watching / 窗口进行中 / 已断开），零装饰点
import { AnimatePresence, motion } from "framer-motion";
import { X } from "@phosphor-icons/react";
import type { ActiveWindowDto } from "../../../src/web-api";
import type { CommitToast } from "../hooks/useTree";
import Button from "./ui/Button";
import CopyBlock from "./ui/CopyBlock";

interface Props {
  online: boolean;
  window: ActiveWindowDto | null;
  toasts: CommitToast[];
  onDismissToast: (id: number) => void;
  onCloseWindow: () => void;
  errorKind: string | null;
  errorDetail?: string;
}

function StatusLight({ tone }: { tone: "ok" | "warn" | "idle" }) {
  const color = tone === "ok" ? "bg-ok" : tone === "warn" ? "bg-warn" : "bg-border";
  const label = tone === "ok" ? "watching" : tone === "warn" ? "窗口进行中" : "已断开";
  return (
    <span className="flex items-center gap-1.5 font-mono text-[11px] text-text-2">
      <span className={`h-2 w-2 rounded-full ${color}`} />
      {label}
    </span>
  );
}

export default function StatusBar({ online, window, toasts, onDismissToast, onCloseWindow, errorKind, errorDetail }: Props) {
  const tone = window ? "warn" : online ? "ok" : "idle";
  return (
    <footer className="relative border-t border-border bg-surface">
      {/* toast 队列（右上角浮层，动效：滑入/淡出） */}
      <div className="pointer-events-none absolute bottom-full right-4 mb-2 flex w-[320px] flex-col gap-2">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="pointer-events-auto flex items-center justify-between gap-2 rounded-card border border-border bg-surface px-3 py-2 shadow-2"
            >
              <span className="min-w-0 truncate text-[12px] text-text-2">
                已提交 <span className="font-mono text-ok">{t.sha.slice(0, 8)}</span> →{" "}
                <span className="font-mono">{t.branch}</span> · {t.records} 条记录
              </span>
              <button type="button" className="shrink-0 text-text-3 hover:text-text" onClick={() => onDismissToast(t.id)} aria-label="关闭通知">
                <X size={12} weight="bold" />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* 错误条（409 not-twin → 引导命令；脏工作区 → 文件清单） */}
      {errorKind && (
        <div className="border-b border-danger/30 bg-danger/10 px-4 py-2">
          <div className="flex items-center gap-3">
            <span className="shrink-0 text-[12px] font-medium text-danger">
              {errorKind === "not-twin" ? "当前仓库未启用 Twin" : errorDetail ?? "操作失败"}
            </span>
            {errorKind === "not-twin" && <CopyBlock text="sm twin-init" />}
          </div>
        </div>
      )}

      <div className="flex h-9 items-center gap-4 px-4">
        <StatusLight tone={tone} />
        {window && (
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <span className="min-w-0 truncate text-[12px] text-text-2">
              窗口进行中 · 世界线 <span className="font-mono text-warn">{window.branch}</span>（{window.label}）
            </span>
            <Button variant="ghost" onClick={onCloseWindow} className="shrink-0">
              提交并关闭
            </Button>
          </div>
        )}
      </div>
    </footer>
  );
}
