// Web API DTO（纯类型，无任何运行时依赖）——server 组装、web 消费。
// 约定：web 侧只允许 `import type` 本文件（核心层是 Node 模块，禁止值流入浏览器）。
// 本文件不 import 任何核心层模块，保证 web 侧 typecheck 无需 node 类型环境。
export type Decision = "initial" | "continue" | "fork" | "failed";

export interface WorldlineDto {
  branch: string;
  tipNodeUuid: string | null; // 世界线 tip 节点（refs/context/<branch> 尾注 Node）
  tipSha: string | null; // tip commit sha（索引派生）
}

export interface TreeNodeDto {
  nodeUuid: string; // 节点 ID = 该轮提问记录的 uuid
  parentUuid: string | null; // 树边 = 该记录的 parentUuid
  branchId: string; // 世界线 = refs/context/<branch>
  decision: Decision;
  userInput: string;
  createdAt: string;
  sha: string | null; // commitOf 派生（code_after）
  isTip: boolean; // 世界线 tip 高亮
  hasFork: boolean; // 存在跨世界线出边（分叉点可视化）
}

export interface TreeEdgeDto {
  from: string; // parent nodeUuid
  to: string; // child nodeUuid
  kind: "continue" | "fork"; // 同世界线 = continue；跨世界线 = fork
}

export interface ActiveWindowDto {
  sid: string;
  branch: string;
  label: string; // 进入节点的 user_input 前 30 字
  startedAt: string;
}

export interface TreeSnapshot {
  cwd: string;
  isTwin: boolean;
  head: { branch: string; detached: boolean; sha: string } | null; // 工作区落位（查看模式 detached）
  worldlines: WorldlineDto[]; // 现有世界线（refs 顺序）
  orphanBranches: string[]; // ref 已删但节点仍可索引的 branch_id（孤儿灰显）
  nodes: TreeNodeDto[];
  edges: TreeEdgeDto[];
  activeWindow: ActiveWindowDto | null;
}

export interface EnterResult {
  sid: string;
  branch: string;
  nodeUuid: string;
  isTip: boolean;
  launchCmd: string;
}

export interface ViewResult {
  commit: string;
  label: string;
  detached: boolean;
}

export interface CloseResult {
  branch: string;
  committed: boolean;
  commit: { sha: string; records: number; node: string | null } | null;
}

export type ApiErrorKind =
  | "not-twin" // 409 仓库未启用 Twin
  | "dirty-workspace" // 409 工作区有未提交改动（detail = 前 3 项）
  | "locked" // 423 .contextus/.lock 被占
  | "conflict" // 409 已有活动窗口等状态冲突
  | "bad-request" // 400 节点不存在 / 参数错误
  | "internal"; // 500

export interface ApiError {
  error: string;
  kind: ApiErrorKind;
  detail?: string;
}

export type ServerEvent =
  | { type: "connected" }
  | { type: "commit"; sha: string; records: number; node: string | null; branch: string }
  | { type: "tree-changed" } // tip 指纹变化兜底（外部提交/rename/drop）
  | { type: "window-closed"; branch: string; committed: boolean }
  | { type: "error"; message: string };
