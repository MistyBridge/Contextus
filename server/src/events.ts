// SSE 事件中枢 + tip 指纹轮询（D4 实时机制）
// 提交事件由 watchSession 回调直推；指纹轮询兜底外部变化（CLI 提交/rename/drop）
import type { FastifyReply } from "fastify";
import type { ServerEvent } from "../../src/web-api.js";
import { tipsFingerprint } from "./gitutil.js";

export class EventHub {
  private clients = new Set<FastifyReply>();

  subscribe(reply: FastifyReply): void {
    this.clients.add(reply);
  }

  unsubscribe(reply: FastifyReply): void {
    this.clients.delete(reply);
  }

  broadcast(event: ServerEvent): void {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const c of this.clients) {
      try {
        c.raw.write(payload);
      } catch {
        this.clients.delete(c); // 连接已断，清理
      }
    }
  }

  count(): number {
    return this.clients.size;
  }

  /** 服务关停时强制断开全部 SSE 客户端（否则 keep-alive 连接让 server.close 永远等待） */
  closeAll(): void {
    for (const c of this.clients) {
      try {
        c.raw.end();
      } catch {
        /* 忽略 */
      }
    }
    this.clients.clear();
  }
}

/**
 * 指纹轮询：间隔比对 refs/context 指纹，变化即广播 tree-changed。
 * 仓库被重建/删除的瞬间 git 会失败——跳过该拍（不广播不崩溃），下一拍恢复后自动补广播。
 * 返回 stop 函数（server onClose 时调用，防事件循环挂起）。
 */
function tipsFingerprintSafe(cwd: string): string | null {
  try {
    return tipsFingerprint(cwd);
  } catch {
    return null;
  }
}

export function startTreePoller(cwd: string, hub: EventHub, intervalMs = 2000): () => void {
  let fp = tipsFingerprintSafe(cwd);
  const timer = setInterval(() => {
    const next = tipsFingerprintSafe(cwd);
    if (next === null) return;
    if (next !== fp) {
      fp = next;
      hub.broadcast({ type: "tree-changed" });
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
