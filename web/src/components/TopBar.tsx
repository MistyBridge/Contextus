// 顶栏（设计规范 §5.1）：品牌 + 仓库路径 + 状态灯 + 主题切换（56px，单行）
import { GitFork, Moon, Sun } from "@phosphor-icons/react";
import type { TreeSnapshot } from "../../../src/web-api";

interface Props {
  snap: TreeSnapshot | null;
  online: boolean;
  windowActive: boolean;
  theme: "light" | "dark";
  onToggleTheme: () => void;
}

export default function TopBar({ snap, online, windowActive, theme, onToggleTheme }: Props) {
  const tone = windowActive ? "bg-warn" : online ? "bg-ok" : "bg-border";
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-4">
      <span className="flex items-center gap-2 text-[15px] font-semibold text-text">
        <GitFork size={18} weight="bold" className="text-accent" />
        Contextus
      </span>
      <span className="font-mono text-[12px] text-text-3">{snap?.cwd ?? "…"}</span>
      <span className="flex-1" />
      {snap?.head?.detached && (
        <span className="rounded-full border border-warn/30 bg-warn/10 px-2 py-px font-mono text-[11px] text-warn">
          detached · 查看模式
        </span>
      )}
      <span className="flex items-center gap-1.5 font-mono text-[11px] text-text-2">
        <span className={`h-2 w-2 rounded-full ${tone}`} />
        {windowActive ? "窗口进行中" : online ? "watching" : "已断开"}
      </span>
      <button
        type="button"
        className="rounded-btn p-1.5 text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
        onClick={onToggleTheme}
        aria-label="切换主题"
      >
        {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
      </button>
    </header>
  );
}
