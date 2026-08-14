# Contextus 多租户工作区设计方向 v0.2（已拍板）

> 2026-08-14 · UI前端工程师起草 · 状态：**D 三项已拍板，进入落地规划**
> 上游：用户需求原话——「contextus 应用于多租户项目开发：多 agent 选择一个工作区文件；git 管理 agent 历史会话组；暂时先只做单 agent + 代码仓库管理；路径放在工作区中，用 .claudes 文件夹管理」

## 0. 已拍板决策（2026-08-14）

| # | 决策 | 结论 |
|---|------|------|
| W1 | ✅ 工作区形态 | **单仓多 agent 共存**：一个 git 仓库内多个 agent 共享世界线，树视图按 agent 分组/过滤 |
| W2 | ✅ agent 标识 | **启动时指定 agent 名**（twin-init / server `--agent`，默认读 `.claudes/<agent>`）；新 session 自动打标签；历史 session 无标签 = 遗留数据 |
| W3 | ✅ 工作区文件 | **目录即工作区**：无显式清单文件，`.claudes/` 目录本身就是 agent 清单 |

## 1. 概念模型（单仓多 agent）

```
工作区（= 一个项目目录，内含一个 git 仓库）
├── .git/                      # 代码世界 + 全部 agent 会话世界的统一账本
├── .contextus/                # Twin 运行时状态（records/sessions/logs/index/Chunks）
├── .claudes/                  # ★ 租户维度：agent 工作目录集
│   ├── UI前端工程师/.claude/   # 岗位指令 + 权限
│   ├── <agent-B>/.claude/
│   └── ...
└── <代码>
```

- **租户 = agent 工作目录**（`.claudes/<agent>`）；agent 通过 `--agent` 参数选择自己的视角
- **会话组 = 一个 agent 的会话历史**：session.json 增补 `agent` 字段（W2），树视图按 agent 分组/过滤
- **世界线共享**：refs/context 是全仓库账本，多 agent 的世界线在同一个树中交错展示（默认全量视角，可按 agent 过滤）
- 会话文件物理位置仍在 `~/.claude/projects/<cwd编码>/`（Claude Code 原生决定，不可搬移）；「git 管理会话」靠 `.contextus` 每轮快照入库实现（现状已满足）

## 2. 现状映射（单 agent 已具备）

| 能力 | 现状 |
|------|------|
| 工作区 = git 仓库，`.claudes/<agent>` 随 add -A 入库 | ✅ 狗食中 |
| git 管理会话历史（每轮 = commit + session.json + 记录） | ✅ 核心层 M0~M4 |
| 单 agent 工作视角 | ✅ web UI 已跑通（`--cwd <工作区>`） |
| session 的 agent 标签 | ❌ 核心层改动（W2，Phase 2 启动时加字段） |
| 树视图 agent 分组/过滤 | ❌ 前端 Phase 2 |
| agent 选择器 | ❌ server `--agent` 参数 + 顶栏显示（Phase 2） |

## 3. 落地计划

### 3.1 近期（不破坏单 agent MVP）

1. **server 暴露工作区视角**：`GET /api/workspace` 返回 `.claudes/` 下 agent 列表（只读扫描）；`--agent <名>` 启动参数（默认 "default"）预留，本期不参与会话逻辑
2. **约定文档化**：`.claudes/<agent>/` 目录约定写入 CLAUDE.md

### 3.2 Phase 2（多租户能力）

1. 核心层：session.json 增补 `agent` 字段（W2）——commitDelta 调用侧传入；历史数据无标签兼容
2. web：树视图 agent 维度（分组/过滤/色标按 agent 而非按世界线）；顶栏 agent 选择器
3. 多 agent 并发写同一仓库：T2 并发锁的扩展 + `.claude/settings.json` deny 规则的 agent 隔离复查

## 4. 风险与边界（继承既有）

- R18 敏感信息跨世界线可见：多 agent 共存放大该风险（Phase 2 需按 agent 视角收窄）
- 会话组标签不溯及历史：W2 只打新 session；遗留数据按「未标记」处理，不做数据迁移
