// 树状态：快照 + SSE 事件驱动重拉（D4 实时机制，技术方案 §3.3）
// commit 与 tree-changed 可能 2s 内先后到达 → 防抖合并重拉，避免双请求
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClientError, fetchTree, fetchWorkspace, subscribeEvents } from "../api/client";
import type { ServerEvent, TreeSnapshot, WorkspaceDto } from "../../../src/web-api";

export interface CommitToast {
  id: number;
  sha: string;
  branch: string;
  records: number;
}

export function useTree() {
  const [snap, setSnap] = useState<TreeSnapshot | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceDto | null>(null);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [online, setOnline] = useState(false); // SSE 连接状态（状态灯语义）
  const [toasts, setToasts] = useState<CommitToast[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastSeq = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const [tree, ws] = await Promise.all([fetchTree(), fetchWorkspace()]);
      setSnap(tree);
      setWorkspace(ws);
      setError(null);
    } catch (e) {
      if (e instanceof ApiClientError) {
        setError(e);
      } else if (e instanceof TypeError) {
        // fetch 网络层失败（服务未启动/已停止）——避免把 "Failed to fetch" 甩给用户
        setError(new ApiClientError("本地服务未连接（请确认 web server 已启动）", "internal"));
      } else {
        setError(new ApiClientError(String(e), "internal"));
      }
    }
  }, []);

  /** 合并窗口内的多次失效通知（commit + tree-changed 同源变化） */
  const refreshSoon = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void refresh(), 400);
  }, [refresh]);

  const dismissToast = useCallback((id: number) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    void refresh();
    const off = subscribeEvents(
      (ev: ServerEvent) => {
        if (ev.type === "connected") {
          refreshSoon(); // 重连后兜底重拉（断线期间可能错过事件）
        } else if (ev.type === "commit") {
          toastSeq.current += 1;
          const id = toastSeq.current;
          setToasts((ts) => [...ts.slice(-4), { id, sha: ev.sha, branch: ev.branch, records: ev.records }]);
          setTimeout(() => dismissToast(id), 6000);
          refreshSoon();
        } else if (ev.type === "tree-changed" || ev.type === "window-closed") {
          refreshSoon();
        }
      },
      (connected) => setOnline(connected),
    );
    return () => {
      off();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [refresh, refreshSoon, dismissToast]);

  return { snap, workspace, error, online, toasts, dismissToast, refresh };
}
