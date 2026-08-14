// 等宽命令块 + 复制按钮（空树引导 / 错误提示用，设计规范 §5.3）
import { useState } from "react";
import { Check, Copy } from "@phosphor-icons/react";

interface Props {
  text: string;
}

export default function CopyBlock({ text }: Props) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center justify-between gap-2 rounded-btn border border-border bg-surface-2 px-3 py-2">
      <code className="font-mono text-[12px] text-text-2">{text}</code>
      <button
        type="button"
        className="text-text-3 hover:text-accent transition-colors"
        aria-label="复制命令"
        onClick={() => {
          void navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check size={14} weight="bold" className="text-ok" /> : <Copy size={14} />}
      </button>
    </div>
  );
}
