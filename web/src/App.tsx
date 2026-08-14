// Contextus Session Tree UI — M1 主界面（设计规范 §5.1 布局）
// 顶栏 / 树画布 / 详情面板 / 底部状态栏；状态完备：loading 骨架屏 / 空树引导 / 错误条
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiClientError, closeWindow, enterNode, viewNode } from "./api/client";
import { useTree } from "./hooks/useTree";
import { layoutTree } from "./layout/layoutTree";
import TopBar from "./components/TopBar";
import TreeCanvas from "./components/TreeCanvas";
import DetailPanel from "./components/DetailPanel";
import StatusBar from "./components/StatusBar";
import CopyBlock from "./components/ui/CopyBlock";

function CanvasSkeleton() {
  return (
    <div className="flex h-full items-start gap-16 p-10">
      {[0, 1, 2].map((i) => (
        <div key={i} className="w-[228px] space-y-6 opacity-60">
          <div className="h-3 w-24 animate-pulse rounded-full bg-border" />
          <div className="h-16 animate-pulse rounded-card border border-border bg-surface-2" />
          <div className="h-16 animate-pulse rounded-card border border-border bg-surface-2" />
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const { snap, error, online, toasts, dismissToast, refresh } = useTree();
  const [selected, setSelected] = useState<string | null>(null);
  const [syncMode, setSyncMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const layout = useMemo(() => (snap ? layoutTree(snap) : null), [snap]);
  const selectedNode = snap?.nodes.find((n) => n.nodeUuid === selected) ?? null;
  const windowActive = snap?.activeWindow != null;

  const handleEnter = useCallback(
    async (nodeUuid: string) => {
      setSelected(nodeUuid);
      setBusy(true);
      setActionError(null);
      try {
        await enterNode(nodeUuid, syncMode);
        await refresh();
      } catch (e) {
        const err = e instanceof ApiClientError ? e : new ApiClientError(String(e), "internal");
        setActionError(err.detail ? `${err.message}：${err.detail}` : err.message);
      } finally {
        setBusy(false);
      }
    },
    [syncMode, refresh],
  );

  const handleView = useCallback(
    async (nodeUuid: string) => {
      setSelected(nodeUuid);
      setBusy(true);
      setActionError(null);
      try {
        await viewNode(nodeUuid);
        await refresh();
      } catch (e) {
        const err = e instanceof ApiClientError ? e : new ApiClientError(String(e), "internal");
        setActionError(err.detail ? `${err.message}：${err.detail}` : err.message);
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const handleCloseWindow = useCallback(async () => {
    setBusy(true);
    try {
      await closeWindow();
      await refresh();
    } catch (e) {
      const err = e instanceof ApiClientError ? e : new ApiClientError(String(e), "internal");
      setActionError(err.message);
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  return (
    <div className="flex h-dvh flex-col bg-bg text-text">
      <TopBar
        snap={snap}
        online={online}
        windowActive={windowActive}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
      />

      <main className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          {layout && layout.nodes.length > 0 && (
            <TreeCanvas
              layout={layout}
              selected={selected}
              onSelect={setSelected}
              onEnter={(uuid) => void handleEnter(uuid)}
              onView={(uuid) => void handleView(uuid)}
            />
          )}

          {/* loading：未取回快照 */}
          {!snap && !error && <CanvasSkeleton />}

          {/* 空树引导（设计规范 §5.3） */}
          {snap && layout && layout.nodes.length === 0 && (
            <div className="flex h-full items-center justify-center">
              <div className="w-[360px] space-y-3 rounded-card border border-border bg-surface p-6 shadow-1">
                <h2 className="text-[15px] font-semibold text-text">空树 · 还没有会话</h2>
                <p className="text-[13px] leading-relaxed text-text-2">
                  在这个仓库启用 Twin 并完成首轮交互，世界线树就会长出来：
                </p>
                <CopyBlock text='sm twin-init' />
                <CopyBlock text='sm ask "第一问"' />
              </div>
            </div>
          )}
        </div>

        <DetailPanel
          node={selectedNode}
          windowActive={windowActive}
          syncMode={syncMode}
          onSyncMode={setSyncMode}
          onEnter={() => selectedNode && void handleEnter(selectedNode.nodeUuid)}
          onView={() => selectedNode && void handleView(selectedNode.nodeUuid)}
          busy={busy}
          actionError={actionError}
        />
      </main>

      <StatusBar
        online={online}
        window={snap?.activeWindow ?? null}
        toasts={toasts}
        onDismissToast={dismissToast}
        onCloseWindow={() => void handleCloseWindow()}
        errorKind={error?.kind ?? null}
        errorDetail={error?.detail ?? error?.message}
      />
    </div>
  );
}
