# Contextus Web 前端技术方案 v1.0（M1 树视图）

> 2026-08-14 · UI前端工程师 · 状态：**M1a/M1b 完成（全测通过）；M1c 真实窗口闭环验收中**
> 上游：MVP 技术方案 v3.2（M0~M4 已定稿）、UI 前端岗位 JD、技术栈定稿（commit 70e2174）

---

## 0. 范围

本文覆盖：**M1（树视图）详细设计** + M2~M4 的架构挂接点（只定接口形态，各自开工前再出详细方案）。

M1 交付内容（JD §三-1/2/7）：世界线树渲染（世界线分组/父子层级/tip 高亮/孤儿灰显/分叉点可视化）+ 节点操作（进入/查看/从这分叉）+ 实时刷新（提交事件推入 UI）。

核心原则（继承已有决策）：**前端只对接，核心层 `src/` 不修改业务逻辑**；git 数据模型是产品内核，展示必须与 git 语义一致。

---

## 1. 总体架构

```
contextus/ 仓库（现有）
├── src/             # 核心层（已有）：server 直接复用其函数与类型（listSessions/worldlines/
│   └── web-api.ts   #   tipSession/commitOf/materializeNode/watchSession/spawnTerminal…）
│                    #   ★新增：web-api.ts 纯类型 DTO 文件（业务逻辑零改动）
├── server/          # ★新增：Fastify 本地服务——绑定一个目标仓库 cwd
└── web/             # ★新增：Vite + React 18 SPA——dev 代理本地服务，产物由服务托管
```

数据流：

```
浏览器 (web SPA)  ⇄  server (Fastify)  ⇄  核心层 (src)  ⇄  git / JSONL / 终端窗口
        REST 快照 + SSE 事件          直接函数调用（同进程）
```

### 1.1 进程形态

- **一个 server 进程服务一个仓库**（本地单用户应用，MVP 不做多仓库切换 UI）
- 启动：`npm run web -- --cwd <仓库>`（缺省 `.`）；未启用 Twin 的仓库 → API 返回 409 + 引导文案
- dev：Vite dev server（5173）把 `/api`、`/events` 代理到 server（3999）
- prod：server 托管 `web/dist`（单端口，`@fastify/static`）

### 1.2 包管理

npm workspaces（root `package.json` 加 `"workspaces": ["server", "web"]`）——单仓标准做法，不引 monorepo 工具。依赖全部落在各子包：

| 包 | 运行依赖 | 开发依赖 |
|----|---------|---------|
| server | fastify | tsx, @types/node |
| web | react, react-dom, @xyflow/react, framer-motion | vite, @vitejs/plugin-react, tailwindcss, vitest, typescript |

遵守最小依赖原则：**不引** dagre/elkjs（树是严格单父，手写布局）、TanStack Query（M1 数据量小，手写轻量 hook）、shadcn/ui（模板感风险 + 代码膨胀，自建 <10 个基础组件）。

### 1.3 共享类型（D2）

`src/web-api.ts` 新增**纯类型** DTO 文件（无运行时逻辑，不触碰核心层任何既有文件）：

- server：`import { listSessions, … } from "../src/twin.js"`（值引用，同进程直调）
- web：`import type { TreeSnapshot } from "../../src/web-api"`（**仅 type-only import**——核心层是 Node 模块，绝不能有运行时依赖流入浏览器）

---

## 2. 关键决策

| # | 决策 | 结论 |
|---|------|------|
| D1 | ✅ 验收数据源（已拍板） | 开发/测试用 tests 合成仓库（零 API 约定）；dogfood 待 web UI 跑通后切换（见 §6） |
| D2 | 共享类型 | `src/web-api.ts` 纯类型 DTO（§1.3），零业务改动 |
| D3 | 树渲染 | React Flow 画布（缩放/平移/边动画）+ **手写 GitKraken 式行列布局**（§4.1） |
| D4 | 实时刷新 | server 轮询 `tipsFingerprint`（复用核心层会话内缓存失效机制，2s 间隔）→ SSE 推事件 → web 重拉快照 |
| D5 | 节点操作 | REST POST + server 层并发锁（`acquireLock` 包住 enter/view 的 git 写段） |
| D6 | ✅ 视觉方向（已拍板） | **C. GitKraken 式图形化**：浅色为主、世界线品牌色区分、明快图形语言、圆润卡片（§2.1） |
| D7 | 测试 | server 沿用 node:test + 合成仓库零 API；web 用 vitest（布局纯函数 + 组件） |
| D8 | ✅ 节点拖动（已拍板 2026-08-14） | **放开拖动**：节点可自由摆放（画布级，不改数据，会话内记忆）；「重置布局」按钮回到算法泳道；右键节点出上下文菜单（进入/分叉、查看、复制 sha/提问） |

### 2.1 ✅ 视觉方向（已拍板：C. GitKraken 式图形化）

用户拍板选 **C**：浅色为主、世界线用品牌色区分（蓝/紫/橙/绿）、明快图形语言、圆润卡片、亲和直观。

设计约束（落实 JD「禁止 AI 模板感」）：

- **浅色默认**，深色主题同 token 派生（CSS variables，两套完整主题）
- 世界线列色 = 稳定品牌色循环（main 蓝、衍生线按序紫/橙/绿…），孤儿列灰虚线
- 密度向 GitKraken 看齐：紧凑但不拥挤，卡片圆角、细描边、克制投影
- framer-motion 微动效统一走 M4 打磨；M1 先立 token 与基础质感
- 状态灯/终端窗口语义仍保留（B 方向的可取元素）

### 2.2 不引组件库的理由（记录备查）

shadcn/ui 会把按钮/卡片/弹窗等几十个组件源码复制进仓库（代码膨胀），且默认样式是 AI 模板感重灾区；本项目组件需求 <10 个，自建成本更低、视觉更可控。Tailwind 仅作 dev 工具产出 CSS，运行时零依赖。

---

## 3. API 契约（M1）

### 3.1 DTO（落 `src/web-api.ts`）

```ts
// 树快照（GET /api/tree 一次拉全）
export interface TreeSnapshot {
  cwd: string;
  isTwin: boolean;
  head: { branch: string; detached: boolean; sha: string } | null; // 工作区落位（查看模式显示）
  worldlines: WorldlineDto[];   // 现有世界线（refs/context/*）
  orphanBranches: string[];     // ref 已删但节点仍可索引的 branch_id（孤儿世界线，灰显）
  nodes: TreeNodeDto[];         // 全部 session（含孤儿）
  edges: TreeEdgeDto[];
}
export interface WorldlineDto { branch: string; tipNodeUuid: string | null; tipSha: string | null }
export interface TreeNodeDto {
  nodeUuid: string; parentUuid: string | null; branchId: string;
  decision: "initial" | "continue" | "fork" | "failed";
  userInput: string; createdAt: string; sha: string | null; // commitOf 派生
  isTip: boolean; hasFork: boolean; // 出边跨世界线 ≥1
}
export interface TreeEdgeDto { from: string; to: string; kind: "continue" | "fork" } // 同世界线=continue，跨世界线=fork

// 操作结果
export interface EnterResult { sid: string; branch: string; nodeUuid: string; isTip: boolean; launchCmd: string }
export interface ViewResult { commit: string; label: string; detached: boolean }
export interface ApiError { error: string; kind: "not-twin" | "dirty-workspace" | "locked" | "bad-request" | "internal" }

// SSE 事件
export type ServerEvent =
  | { type: "commit"; sha: string; records: number; node: string | null; branch: string }
  | { type: "tree-changed" }                                  // 指纹变化兜底（rename/drop/外部提交）
  | { type: "window-closed"; branch: string; committed: boolean }
  | { type: "error"; message: string };
```

### 3.2 端点

| 方法 | 路径 | 说明 | 错误语义 |
|------|------|------|---------|
| GET | `/api/health` | `{ isTwin, cwd, worldlines: string[] }` | 200 恒（isTwin=false 时树端点 409） |
| GET | `/api/tree` | 完整快照（§3.1） | 409 not-twin |
| POST | `/api/nodes/:uuid/enter` | body `{ syncMode?: boolean }`。tip → 复用 live 会话 + 规则注入；历史节点 → **回溯即分叉**（autoBranchName 新世界线 + 物化 + 新会话文件）；两者均开真实终端 + 启动 watchSession | 409 not-twin；409 dirty-workspace（工作区脏，附文件清单）；423 locked（.contextus/.lock 被占）；404 节点无 commit |
| POST | `/api/nodes/:uuid/view` | checkoutView 查看模式（detached，不建线不提交） | 同 enter + 409 dirty-workspace |
| POST | `/api/window/close` | 停 watcher → 提交最后一轮（T10，半成品也提交） | 404 无活动窗口 |
| GET | `/api/events` | SSE 流（§3.1 ServerEvent） | — |

### 3.3 实时机制（D4）

核心层已有「tip 指纹缓存失效」：`listSessions` 等按 `refs/context` 的 for-each-ref 指纹缓存，**任何提交/分支/drop 都改变指纹**。server 每 2s 算一次指纹：

- 指纹变化 → 广播 `tree-changed` → web 重拉 `/api/tree`（快照式一致性，web 端永远全量正确）
- watcher 提交回调 → 广播 `commit`（附 sha/分支）→ web 显示 toast/状态灯 + 重拉
- 活动窗口状态（sid/branch）由 server 持有，`/api/tree` 附带 `activeWindow` 供 UI 显示「窗口进行中」面板

与 TUI 的 watchSession 同构：**提交边界不变（检测新提问 → 提交上一轮；窗口关闭 → 提交最后一轮）**。

---

## 4. 前端结构（M1）

### 4.1 世界线树布局算法（手写，GitKraken 式）

核心层保证：**严格单父树**（T6，无 merge）。布局目标：世界线 = 垂直泳道列，时间向下流动，分叉点一目了然。

```
输入：nodes（含 parentUuid/branchId/createdAt）、worldlines 顺序（refs 顺序）
1. 列：世界线按 refs 顺序占列 0..n-1；孤儿世界线按 branch_id 字典序排其后（灰显列头）
2. 行：全部节点按 createdAt 全局排序 → 行号 = 该节点在全局时间序中的序号（同列内时间单调 ⇒ 列内直线无交叉）
3. 节点位置：x = 列（泳道），y = 行（全局时间）
4. 边：parent→child 同列 = 竖直直线；跨列 = 三次贝塞尔弧线（fork 边，穿列过境）
5. 世界线列头：branch 名 + tip 徽章；列身 = 从该线首节点画到 tip 的竖直导线
6. tip 节点高亮描边；孤儿世界线整体 60% 透明度灰显 + 「orphan」角标
```

- 复杂度 O(N log N)（排序），纯函数可单测（vitest）
- React Flow 提供画布（缩放/平移/小地图/边路径动画），布局坐标自己算——**布局正确性不依赖第三方算法**
- 节点卡片：`user_input`（commit 名 ≤20 字）+ decision 图标（fork ⑂ / failed ✕红 / initial ● / continue ○）+ 短 sha 徽章（M2 起可点）+ 时间

### 4.2 页面结构

```
┌──────────────────────────────────────────────────────────────┐
│ 顶栏：Contextus 标 · 仓库路径 · 世界线状态灯 ● · 同步开关 · 主题切换 │
├───────────────────────────────────────────┬──────────────────┤
│  世界线树画布（React Flow）                  │ 节点详情面板        │
│  - 泳道列 + 全局时间行                       │ - user_input 全文  │
│  - tip 高亮 / 孤儿灰显 / 分叉弧线            │ - decision/branch │
│  - 点选节点 → 详情                          │ - sha/时间         │
│                                           │ - [进入节点]        │
│                                           │   [查看模式]        │
│                                           │   [sync 开关]       │
├───────────────────────────────────────────┴──────────────────┤
│ 底部事件流：commit toast / 状态灯 / 窗口进行中面板（可收起）          │
└──────────────────────────────────────────────────────────────┘
```

### 4.3 组件划分

```
web/src/
├── api/           # fetch 封装 + SSE client（EventSource + 自动重连）+ DTO 类型引用
├── hooks/         # useTree（快照状态 + 事件驱动重拉）、useServerEvents、useTheme
├── layout/        # layoutTree.ts 纯函数（§4.1）+ React Flow 坐标转换
├── components/
│   ├── TreeCanvas.tsx      # React Flow 画布：自定义节点/边/列头/导线
│   ├── NodeCard.tsx        # 节点卡片（decision 图标/sha 徽章/tip 描边）
│   ├── DetailPanel.tsx     # 详情面板 + 操作按钮
│   ├── StatusBar.tsx       # 状态灯 + toast 队列 + 窗口面板
│   └── ui/                 # 自建基础件：Button/Toast/Badge/Toggle（<10 个）
└── App.tsx
```

M1 不做的（挂接点预告）：diff 视图（M2：@git-diff-view 或 Monaco，倾向 @git-diff-view——更轻）、规则编辑器（M3）、审计时间线（M4）、xterm.js（Phase 2 可选，M1 终端走真实窗口唤起）。

---

## 5. M1 任务拆解

| 任务 | 内容 | 状态 |
|------|------|------|
| **M1a server** | Fastify 骨架 + 五个端点 + SSE + 指纹轮询 + 锁守卫 | ✅ 9/9 集成测试通过 |
| **M1b web 树** | Vite 骨架 + layoutTree 纯函数 + React Flow 画布 + 详情面板 + 双主题 token | ✅ 5/5 单测 + 构建 + 冒烟通过；拖动/重置/右键菜单（D8）、tip 统一绿（D9）已拍板落地 |
| **M1c 闭环** | enter/view 端到端 + SSE 实时刷新 + toast/状态灯 + 窗口面板 | 🔄 守卫语义已修正（tip 放行脏工作区，b47dcf1）；真实窗口闭环验收进行中（狗食仓库） |

测试约定（对齐现有 tests/）：合成仓库独立命名空间（`.tmp-m1-*`）、`mkRec` 合成记录、零 API；web 侧 vitest 只测纯函数与组件，不跑真 git。

### M1 验收标准（↔ JD）

1. ✅ 树正确展示**全部**节点/世界线/tip/孤儿（合成仓库：多世界线 + fork + drop 孤儿，全量断言）
2. ✅ 点击节点可操作：进入（tip 继续 / 历史分叉）、查看（detached）
3. ✅ 可实时刷新：模拟新 commit → SSE 推送 → UI 状态灯 + 树更新（无手动刷新）
4. ✅ 错误路径：脏工作区守卫、锁冲突、未启用 Twin——全部有明确 UI 反馈
5. ✅ 视觉：深色默认 + 浅色主题切换，无 AI 模板感（先出设计快照再精细实现）

---

## 6. 已拍板记录

1. **D1 验收数据源（✅ 2026-08-14）**：合成仓库起步，M1 开发/验收用 tests 合成仓库（零 API 约定）；web UI 跑通后再对 Contextus 自身 twin-init 狗食。注意：狗食后本仓库 agent 的 git 写命令被四层权限禁掉，提交由 Contextus 监控代管。
2. **D6 视觉方向（✅ 2026-08-14）**：C. GitKraken 式图形化（浅色为主、世界线品牌色、明快图形语言）。下一步按 taste-skill 流程出设计快照再动工。
3. 端口约定：server 3999 / web dev 5173。
4. **D9 配色简化（✅ 2026-08-14，用户拍板）**：废除按世界线名循环配色（main 蓝 / main-2 紫）；全部 tip 节点统一 `--ok` 绿，非 tip 与车道导线/边线中性灰；孤儿仍灰显。设计规范 §1.2 已同步。
