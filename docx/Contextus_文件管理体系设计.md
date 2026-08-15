# Contextus 文件管理体系设计 v1.1（草稿，待拍板）

> 2026-08-15 · UI前端工程师起草 · 上游：多租户工作区设计方向 v0.2（W1 单仓多 agent / W2 启动时指定 agent / W3 目录即工作区）
> **v1.1 定位修正（用户拍板）**：Contextus 是 **Claude Code 插件**——agent 相关内容放在 Claude Code 原生认得的 `.claude/` 目录下管理；`.contextus/` 是 Contextus 自己的命名空间，只管世界状态。
> 问题：项目应用 Contextus 时 `.contextus/` 管什么？agent 相关内容在 `.claude/` 下怎么组织？

## 0. 分界原则（一句话）

> **`.contextus/` = 世界状态**（Contextus 命名空间：跨 agent 共享、随轮提交、git 是唯一账本）；
> **`.claude/` = agent 相关内容**（Claude Code 插件原生目录：settings/skills/agents/commands，Claude Code 原生加载生效）。

| 维度 | .contextus（世界状态层） | .claude（agent 插件层） |
|------|---------------------|--------------------------------------|
| 回答的问题 | 这个世界发生了什么 | 有哪些 agent、各自是谁、怎么工作 |
| 命名空间 | Contextus 自有 | Claude Code 原生约定（插件直接生效） |
| 共享性 | 全仓库所有 agent 共享 | 项目级共享（Claude Code 原生语义） |
| git 归属 | 每轮随 commit 入库 | 随项目入库（现状已如此） |
| 审计 | runtime.log 是审计信任锚点 | 自身变化入 runtime.log（带 agent 字段） |

## 1. 项目层 `.contextus/`（世界状态）

### 1.1 现状（核心层已实现）

```
.contextus/
├── records/<seq>-<uuid>.json   # 会话记录快照：每轮 = 若干条 JSONL 记录，随 commit 入库
├── sessions/<node_uuid>.json   # 会话元数据：节点/父边/世界线/decision/usage…（树的数据源）
├── logs/runtime.log            # 审计日志：只增不改，随轮入库（T9 信任锚点）
├── Chunks/project_policy.md    # 版本化规则：条目化文件，版本 = git 历史（T7）
├── index/uuid2commit.json      # 派生索引：uuid→sha，可全量重建，不入 git
└── .lock                       # 并发锁：pid+时间戳+过期判定，不入 git
```

职责划分已成熟：**事实（records/sessions/logs/Chunks）入库，派生（index）与运行时（.lock）排除**。

### 1.2 提案新增（按优先级）

| # | 新增 | 职责 | 时机 |
|---|------|------|------|
| P1 | `twin.json` | Twin 元数据：`{schema_version, twin_version, created_at}`——升级迁移的锚点 | **建议现在加**（一行写入 twin-init） |
| P2 | `worldlines/<branch>.json` | 世界线注解：`{description, created_at, anchor_node_uuid}`——UI 列头悬停显示「为什么开这条线」；refs/context 仍是权威，本文件只是人读注解 | Phase 2 |
| P3 | `Chunks/` 多文件 + 类型元数据 | 完整 Chunk 体系（技术方案 §7.3 已定） | Phase 2 |
| P4 | `snapshots/`、scrub/GC 标记 | 技术方案挂接点 | Phase 2 |

**不放进 .contextus 的**：agent 私有配置（归 agent 层）、世界线本身状态（= refs/context，git 原生）、token 统计（session 记录里已有 usage，派生即可）。

## 2. agent 插件层 `.claude/`（Claude Code 原生目录，v1.1 修正）

### 2.1 现状

```
<仓库>/.claude/
├── settings.json         # 项目级权限（twin-init 四层 deny 已写在这）——Claude Code 原生加载
└── settings.local.json   # 本地覆盖（不入库）
```

（历史遗留：本仓库的 `.claudes/UI前端工程师/.claude/` 是早期多 agent 工作区形态，将按新约定迁移）

### 2.2 提案布局（对齐 Claude Code 插件原生约定）

```
<仓库>/.claude/
├── settings.json              # 项目级权限：twin-init 四层 deny（现状）
├── settings.local.json        # 本地覆盖（不入库）
├── agents/
│   └── <agent-name>.md        # agent 定义（Claude Code 原生 subagent 格式：frontmatter name/description + 指令正文）
│                              #   = 现在的岗位 CLAUDE.md 内容；Contextus 扩展字段（capabilities 等）也放 frontmatter
├── skills/                    # 项目技能（Claude Code 原生 skills 目录，SKILL.md 格式）
├── commands/                  # 斜杠命令（如 /ctxus-tree 打开树视图的入口命令）
└── (memory/ 待定)             # agent 持久笔记——Claude Code 原生记忆在 ~/.claude，入库方案 Phase 2 再定
```

| # | 内容 | 职责 | 时机 |
|---|------|------|------|
| A1 | `agents/<name>.md` | agent 身份卡 + 指令（Claude Code 原生加载）；`/api/workspace` 列 agents 目录即得 agent 清单，W2 的 `--agent` 默认值同源 | **建议现在落地约定**（服务端只读文件名 + frontmatter） |
| A2 | 权限分层 | 项目级四层 deny 已在 settings.json；agent 差异权限（Phase 2）沿用 deny 规则格式（**已拍板**），落到 agents 定义或独立权限节 | Phase 2 |
| A3 | `commands/` | Contextus 入口命令（打开树视图等） | Phase 2 |

**不放进 `.claude/` 的**：会话文件（Claude Code 原生位置不可搬移）、会话历史（git 账本，按 W2 agent 字段分组）、世界状态（.contextus）。

### 2.3 权限形态（Phase 2，写法已拍板：沿用 deny 格式）

```
用户级  ~/.claude/settings.json          # 用户全局
项目级  <仓库>/.claude/settings.json      # twin-init 全局四层 deny（现状）
agent级 随 agents 定义（deny 格式）       # 岗位级差异权限
```

## 3. git 边界总表

| 路径 | 入库 | 理由 |
|------|------|------|
| `.contextus/records,sessions,logs,Chunks` | ✅ | 世界状态事实 + 审计 |
| `.contextus/index,.lock` | ❌ | 派生可重建 / 运行时 |
| `.contextus/twin.json`（提案） | ✅ | 轻量元数据，迁移锚点 |
| `.claude/settings.json`（项目级 deny） | ✅ | 已随狗食首轮入库 |
| `.claude/settings.local.json` | ❌ | 本地覆盖（按 Claude Code 约定） |
| `.claude/agents,skills,commands` | ✅ | 插件内容随项目入库 |
| `.claudes/**`（历史遗留） | 迁移后废弃 | 见 §4 |

## 4. 落地顺序

1. **现在（server 侧，小改动）**：`/api/workspace` 读 `.claude/agents/` 列 agent（文件名即 agent 名）；`agents/<name>.md` 约定文档化
2. **Phase 2**：`.claudes/` → `.claude/agents/` 迁移、世界线注解（**已拍板进近期规划**：`worldlines/<branch>.json` 的 description 供 UI 列头显示）、agent 字段打标（W2）、agent 级权限（deny 格式）
3. `twin.json`：等 PM 指令碰核心层时随 twin-init 一并写入

## 5. 已拍板记录

1. ✅（2026-08-15）agent 相关内容放 `.claude/`（Claude Code 插件原生目录），`.contextus/` 只管世界状态
2. ✅（2026-08-15）世界线注解 description 进近期规划（M2~M3 之间）
3. ✅（2026-08-15）agent 级权限沿用 deny 规则格式（Phase 2 才做）
