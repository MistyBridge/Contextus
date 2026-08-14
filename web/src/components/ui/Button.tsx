// 基础按钮：primary（accent 蓝，全站唯一强调色）/ ghost（描边次级）
// 对比度：accent 蓝底白字 4.5:1（WCAG AA）；按压反馈 scale-[0.98]（设计规范 §4）
import type { ReactNode } from "react";

interface Props {
  variant?: "primary" | "ghost";
  disabled?: boolean;
  loading?: boolean;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
}

export default function Button({ variant = "primary", disabled, loading, onClick, children, className = "" }: Props) {
  const base =
    "inline-flex items-center gap-1.5 rounded-btn px-3 py-1.5 text-[13px] font-medium " +
    "transition-transform active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none select-none";
  const styles =
    variant === "primary"
      ? "bg-accent text-white hover:bg-accent/90"
      : "border border-border bg-surface text-text-2 hover:bg-surface-2 hover:text-text";
  return (
    <button type="button" className={`${base} ${styles} ${className}`} disabled={disabled || loading} onClick={onClick}>
      {loading && <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      {children}
    </button>
  );
}
