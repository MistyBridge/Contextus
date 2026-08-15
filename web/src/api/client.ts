// REST + SSE 客户端（浏览器侧）。核心层类型仅 import type——禁止值导入进浏览器
import type { ApiError, CloseResult, EnterResult, ServerEvent, TreeSnapshot, ViewResult, WorkspaceDto } from "../../../src/web-api";

export class ApiClientError extends Error {
  constructor(
    message: string,
    public readonly kind: ApiError["kind"],
    public readonly detail?: string,
  ) {
    super(message);
  }
}

async function readError(res: Response): Promise<ApiError> {
  try {
    return (await res.json()) as ApiError;
  } catch {
    return { error: `HTTP ${res.status}`, kind: "internal" };
  }
}

async function post<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const e = await readError(res);
    throw new ApiClientError(e.error, e.kind, e.detail);
  }
  return (await res.json()) as T;
}

export async function fetchTree(): Promise<TreeSnapshot> {
  const res = await fetch("/api/tree");
  if (!res.ok) {
    const e = await readError(res);
    throw new ApiClientError(e.error, e.kind, e.detail);
  }
  return (await res.json()) as TreeSnapshot;
}

export async function fetchWorkspace(): Promise<WorkspaceDto> {
  const res = await fetch("/api/workspace");
  if (!res.ok) {
    const e = await readError(res);
    throw new ApiClientError(e.error, e.kind, e.detail);
  }
  return (await res.json()) as WorkspaceDto;
}

export function enterNode(nodeUuid: string, syncMode: boolean): Promise<EnterResult> {
  return post(`/api/nodes/${nodeUuid}/enter`, { syncMode });
}

export function viewNode(nodeUuid: string): Promise<ViewResult> {
  return post(`/api/nodes/${nodeUuid}/view`);
}

export function closeWindow(): Promise<CloseResult> {
  return post("/api/window/close");
}

/** SSE 订阅（EventSource 内建自动重连）；onStatus 上报连接状态（状态灯语义），返回退订函数 */
export function subscribeEvents(
  onEvent: (e: ServerEvent) => void,
  onStatus?: (connected: boolean) => void,
): () => void {
  const es = new EventSource("/api/events");
  es.onopen = () => onStatus?.(true);
  es.onerror = () => onStatus?.(false);
  es.onmessage = (ev) => {
    try {
      onEvent(JSON.parse(ev.data) as ServerEvent);
    } catch {
      /* 坏帧跳过 */
    }
  };
  return () => es.close();
}
