# Contextus MVP 技术方案 v3.1（Git Twin + 最简策略 Chunk + Session Tree UI）

> **v2（2026-08-13，用户决策）**：MVP 聚焦 **Git Twin**——代码世界与 Agent 会话世界在同一 git 仓库并存、独立演进、双向绑定。
> **v2.1（同日）**：增加**最简 Chunk**——单一全局策略 Chunk（项目约束 + 用户规则），跨分支共享、版本化。
> **v2.2（同日）**：**提交模型简化**——一轮（一问一答执行到停止输出）= 一个 commit，轮后 Contextus 自动提交；Session ↔ Commit 天然 1:1。
> **v2.3（同日）**：本地 git 完全隔离；运行日志；回放用当前规则（历史节点自动比对补全）；commit 名称 = 请求前若干字（≤20 字）。
> **v2.4（同日）**：① 节点 uid = 对话文件天然携带的 uuid / parentUuid（去掉自造编号）；② 新增「回溯 + 继承最新代码空间」——同步作为新对话的一个环节，不修改历史节点；③ 本地 git 对 Agent 开放**只读权限**（读命令可用，写命令全禁）；④ 核心价值叙事：**配置边界分支**（a b c d → 回到 a b 开新分支 → a b e f，无冗余上下文）。
> **v2.5（同日）**：存储不变量——管理一仓两层的 git **只增不修**：允许的操作集 = 增、删、查，禁止改（T9）。
> **v2.6（同日）**：**存储层带改**——操作集完备为增删改查（类比数据库）；改走维护通道（Contextus 显式操作 + 审计日志兜底），日志本身只增不改；常规路径仍按不可变哲学工作。
> **v2.7（同日）**：规则注入改为**增量注入**——只补 diff 而非全文（历史中已嵌旧规则，补全文会造成新旧并存矛盾）；修改/删减条目用 **【禁止】指令**中和历史旧文本；规则文档条目化，注入质量靠文档一致性比对（条目级 diff）控制。
> **v2.8（同日）**：**Chunks 文件夹模型**——规则由 `.contextus/Chunks/` 文件夹管理（工作区真相）；版本 = 该文件的 git 历史（移除 v 文件与 Registry）；同步 = 比对「历史节点 commit 中的 Chunks 快照」与「工作区 Chunks」（即比对 Chunks 与最近提交的 Chunks），差异注入增量。
> **v3.0（同日，架构审计整改）**：① code_after 字段移除（自引用字段物理上无法写入自身 commit，改由 uuid2commit 索引派生）② 失败轮一律提交（新增 T10，不变式全路径成立）③ 隔离升级四层（Bash deny + 文件工具 deny `.git/**`/`.contextus` 敏感路径 + sm.py deny + 审计兜底）④ checkout 改为**查看模式**（detached、不建线不提交，ask 时才建新世界线）⑤ rename 仅限 tip；中间节点重写不做 git rebase，由 Phase 2「重建分支」替代（压缩链上下文 → 新树 → 挂 skill/mcp 之下）⑥ P1/P2 全部落文（并发锁、同步材料规模控制、delta 提取规则、回放抽样、非 ASCII 路径回归等）⑦ Chunks 编辑权确认**放行**（人下命令、Agent 修改）⑧ 技术栈定为 **TypeScript**（Node 22 LTS）。
> **v3.1（同日，执行模型升级）**：**不使用无头模式作为用户主路径**——实现真实**树形会话 UI（TUI，ink）**：用户浏览会话树、选中节点 → 物化该节点上下文 → **开新终端窗口**运行交互式 `claude --resume`（真实 TTY：信任对话框/权限提示可正常应答，实验 §4.3 陷阱自然消解）。**提交时机 = 文件监控**：UI 后台监控会话 JSONL，每检测到一条新提问记录即提交上一轮（保持「一轮一 commit」不变式）；窗口关闭提交最后一轮。无头 `-p` 仅保留用于内部自动化与回归测试。
> 上游材料：立项书（ChatGPT 讨论）+ 《Contextus_架构与实验记录》（2026-08 实测）。
> 文档状态：v3.1，**已定稿**

---

## 1. 范围

### 1.1 MVP 做什么：自研四模块

**原则（用户定调）：尽可能复用 Claude Code 现有体系，只做必须做的最小内容。** 执行引擎、工具循环、权限、MCP、skills、system prompt 组装、会话文件格式、缓存机制全部原样复用（实验已验证的路线 B 边界）。**执行形态 = 交互式 CLI 窗口**（用户主路径，真实 TTY）；无头 `-p` 仅用于内部自动化与回归。Contextus 自研四个模块：

| 模块 | 范围 |
|------|------|
| **Git Twin** | 一仓两层 + 轮后自动提交 + 1:1 绑定 + 双世界恢复 + 运行日志（审计）+ 同步分支 |
| **策略 Chunk** | 单一 Chunk `project_policy`（`.contextus/Chunks/` 文件夹管理，版本 = git 历史）：项目约束与用户规则，跨分支共享，回放用当前规则（增量注入） |
| **Session Tree** | git 存储的会话树：分支 / 回溯 / 恢复（已验证的回合=commit 模型工程化） |
| **Session Tree UI（TUI）** | ink 树形界面：浏览世界线/节点、选中节点 → 物化上下文 → 开新终端窗口进入该节点 CLI 会话；后台文件监控自动提交 |

四模块协同构成最小闭环；Phase 2 及以上演进见 §7.3。

### 1.2 核心价值：配置边界分支（用户例子）

```
一个负责后端的 Agent：
  会话 a b c d
  ├─ a b = 项目规则 + skill/mcp 等配置设定上下文
  └─ c d = 具体任务带来的上下文

新任务 e f 与 c d 互相独立 → 无需冗余上下文，只需配置设定
  → 回到 b 节点开新分支 → 新世界线 = a b e f
```

这正是 Contextus 要的结果：**配置上下文与任务上下文分层，新任务回到配置边界开分支，零冗余继承**。MVP 中「项目规则」由策略 Chunk 承载（当前版本自动注入），「a b 配置讨论过程」由会话树保留、按节点选择性继承——回到哪个节点，用户说了算（MVP 手动指定，自动选择是 Phase 2 Resolver 的事）。

### 1.3 核心闭环

```
sm ui 启动树形界面（TUI）
  ↓
浏览世界线 / 会话树，选中任意节点
  ↓
物化：祖先链对话 + 规则比对注入 → 写会话文件 → 开新终端窗口 claude --resume（交互模式）
  ↓ 用户在窗口内一轮轮问答（信任/权限提示可正常应答）
UI 后台监控会话 JSONL：检测到新提问 → 提交上一轮（代码 + 记录 + 日志 → 一个 commit）
  ↓ 窗口关闭
提交最后一轮（T10 规则不变）→ refs/heads 与 refs/context 同步前进（工作区干净）
  ↓
树界面实时刷新；任意历史节点可再次进入（回溯即分叉，旧世界线不动）
```

### 1.4 能力清单（MVP 验收面）

| # | 能力 | CLI（示意） |
|---|------|------------|
| C1 | 一仓两层：`refs/heads/*` 与 `refs/context/*` 同步前进，共享对象库 | `sm.py twin-init` |
| C2 | 执行一轮交互，轮后自动提交（代码 + 记录 + 日志），工作区干净 | `sm.py ask "<问题>"` |
| C3 | 从任意历史节点（uuid）分支/回溯 | `sm.py branch <uuid> "<问题>"` / `checkout` |
| C4 | 会话 → 代码世界：恢复会话时同时得到当时代码状态 | `sm.py checkout <uuid>` |
| C5 | 代码 → 会话世界：给定 commit SHA，读出产生它的会话 | `sm.py find <commit>` |
| C6 | 两个会话的代码世界 diff | `sm.py diff <uuidA> <uuidB>` |
| C7 | 双世界树可视化与当前绑定状态 | `sm.py tree` / `sm.py status` |
| C8 | 纯对话轮同样入链（运行日志保证有提交内容） | （C2 自然情形） |
| C9 | 规则管理：Chunks 文件夹 + git 历史版本化，全局 O(1) | `sm.py policy set/edit/log` |
| C10 | 回放用当前规则：比对历史节点 Chunks 快照与工作区 Chunks，增量注入（含【禁止】中和） | （C2/C3/C4 内建） |
| C11 | 本地 git 读写分离：Agent 读命令可用、写命令全禁；gh/API 自由 | （twin-init 内建） |
| C12 | 同步分支：历史上下文 + 最新代码空间，同步是新对话的环节 | `sm.py branch <uuid> "<问题>" --sync-latest` |
| C13 | 维护操作：改名称 / 废弃世界线，每次改均产生审计记录 | `sm.py rename` / `drop` |
| C14 | 树形 UI：浏览世界线/节点，选中节点 → 物化 → 开交互窗口 → 自动提交 | `sm ui` |

---

## 2. 总体架构

```
┌───────────────────────────────────────────────┐
│            Contextus（状态层，自研）             │
│  Session Store(git) · 轮后自动提交 ·           │
│  双 ref 管理 · 双世界恢复 · 物化(路线B) ·       │
│  策略 Chunk（最简） · 运行日志 · 同步分支        │
└───────────────────┬───────────────────────────┘
                    │ ① 轮后提交：git add -A + commit + update-ref
                    │ ② 物化 Claude Code 会话文件（对话链 + 当前规则）
┌───────────────────▼───────────────────────────┐
│   目标代码仓库（一仓两层）+ Claude Code（执行层） │
│   refs/heads/*  = 工作分支（Contextus 提交推进）  │
│   refs/context/*= 世界线（同一 commit，同步前进） │
│   .contextus/   = 会话记录/Chunks 规则/日志       │
│   本地 git 对 Agent：只读（读命令可用，写命令全禁）│
│   Claude Code：工具循环/权限/MCP/skills 原样；    │
│   gh / GitHub API 自由                          │
└───────────────────────────────────────────────┘
```

与实验记录五层拆解的对应关系不变：Contextus 接管第 1 层（存储）与第 3 层（历史选取/分叉），第 2/4/5 层由 Claude Code 原样承担。

---

## 3. 关键设计决策（拍板）

### D1. 执行后端 = Claude Code CLI（路线 B），交互窗口为主【v3.1 重写】

已验证「伪造会话文件 + `--resume`」任意节点分支。执行形态分两路：

- **用户主路径（v3.1）**：TUI 选中节点 → 物化上下文 → **开新终端窗口**运行交互式 `claude --resume <sid>`——真实 TTY：信任对话框、权限提示、交互式追问全部可应答（实验 §4.3 的无头信任陷阱自然消解）。cwd = 仓库根（会话文件落在 `~/.claude/projects/<仓库路径编码>/`）。
- **自动化/回归路径**：无头 `claude -p --resume`（M0 已验证），仅用于测试与脚本，不做产品体验。

「一轮」定义不变：用户一问 → Agent 一答 → 执行到任务结束 → 停止输出。交互模式下同一窗口可多轮问答，提交时机由文件监控决定（T2）。

### D2. 存储 = git，核心定义是「Commit-like 状态」而非「Git SHA」

接口层隔离，未来可换 Object Store。已验证性能：uuid 索引 2μs、checkout 12ms、物化 0.23s。

### T1. 主模式 = 一仓两层（目标代码仓库内）；独立 store 为降级路径

- 同一个 `.git` 仓库：`refs/heads/*` + `refs/context/*` 指向同一串 commit（同一条 lineage，两层命名保留——未来若放开 Agent 自主提交，heads 可分化）。
- `.contextus/` 目录**纳入版本管理**（不 gitignore）：随每轮 commit 提交，用户可直接查看会话世界。例外：`index/`（uuid2commit 派生缓存，可全量重建 R23）与 `.lock`（运行时锁）经 `.git/info/exclude` 排除——保证提交后工作区干净且索引永远最新。
- 非仓库场景走独立 `store/` 仓库，同一套接口。

### T2. 提交模型与权限边界：本地 git 只读开放，一轮一 commit【v2.4 更新】

**权限边界：隔离四层（用户定调 + 架构审计 v3.0）**：

1. **Bash 层**：本地 git 对 Agent 只读开放——读命令（status/log/diff/show/rev-parse/ls-files/rev-list）可用；写命令全禁（add/commit/checkout/switch/branch/merge/rebase/reset/stash/tag/cherry-pick/revert/push/pull/fetch/clean/rm/mv/apply/am/init）。permissions.deny 写入 `.claude/settings.json`（M1 验证规则格式）。
2. **文件工具层**：deny 编辑 `.git/**`（Agent 可不经 git 命令直接改 refs/HEAD/config）与 `.contextus/records|sessions|logs|index/**`；`.contextus/Chunks/**` **放行**（用户定调：**人下命令、Agent 修改**——Agent 按用户指令修改规则，随轮入库、下轮生效，演进全程可审计）。
3. **CLI 层**：deny `Bash(sm.py:*)` 等形态——sm.py 的 rename/drop 是写路径，不能经 Bash 绕过。
4. **审计兜底**：一切 Contextus 写操作入日志；Agent 越界尝试（被拒记录）可见。

subprocess 绕过（`python -c "subprocess…"`）接受为 MVP 边界：单用户、协作 Agent，四层防「意外」而非「恶意」（对抗性隔离属 Phase 4 多租户）。**GitHub 云 git 完全自由**：gh CLI / API / Web 不受限，与本地隔离互不冲突。

**轮后自动提交**：Agent 停止输出后，Contextus 立即提交一轮的完整结果（此时 Agent 已停止，无并发窗口）：

```
git add -A                          # 本轮全部代码改动（工作区 = 轮结果）
git add .contextus/**               # 会话记录 + session.json + chunk/registry + 日志
git commit --no-verify -m "<请求前20字>"
git update-ref refs/context/<branch> HEAD            # 双 ref 同步前进
```

**commit 命名（用户规则）**：commit 名称 = 用户请求的前若干字，**不超过 20 个字**。`git log --oneline` 直接可读每轮主题；完整元数据在 commit message 尾注与 session.json。

**运行日志（用户规则）**：项目运行时持续向 `.contextus/logs/runtime.log` 逐行追加事件（轮开始、claude 调用、轮结束、提交、规则比对结果、异常等）。效果：纯对话轮天然有提交内容（日志增量）；日志随 commit 入库，与 `git log` 互相印证，构成审计轨迹。

提交后工作区干净：下一轮从干净状态开始。

**交互模式提交时机（v3.1，用户定调）**：交互窗口内同一窗口可多轮问答。提交边界 = **文件监控**：UI 后台监控会话 JSONL，每检测到一条**新提问记录**即判定上一轮（一问一答）已完成 → 自动提交该轮（代码 + 记录 + 日志）；**窗口关闭时提交最后一轮**（完整或半成品，T10 失败轮规则不变）。「一轮一 commit」不变式在交互模式下依然成立。

**并发锁（P1-1）**：`.contextus/.lock` 锁文件（pid + 时间戳 + 过期判定；Windows msvcrt 锁），`ask`/`checkout`/维护操作一律先取锁、占用即拒绝——防双终端并发 ask 引发 git 索引竞争。

**轮记录 delta 提取（P1-4）**：每轮结束后，delta = live JSONL 中「uuid 不在已入库集合中的记录」（内存集合成员测试）。该规则对 Claude Code compaction 重写 live 文件免疫（旧记录已在库中，天然跳过），比按文件位置切分稳健。

私有索引 + plumbing 方案降级为备选（未来需要轮中提交或更强并发保护时启用）。边界：无头模式不支持交互式追问（工具问询/权限确认），MVP 内「一轮不问人」。

### T3. 节点标识：uid = 对话文件天然携带的 uuid / parentUuid【v2.4 更新】

- **节点 uid 不发明新编号**：直接复用 Claude Code 会话 JSONL 中每条记录天然携带的 `uuid`；树边 = `parentUuid` 链（实验 §3.2 已验证：uuid 是行级 ID，parentUuid 构成会话树，分支 = 新记录 parentUuid 指向节点 c）。
- **节点锚定**：一轮交互以「该轮提问记录」为节点，节点 uid = 该提问记录的 uuid；树边 = 该记录的 parentUuid（沿链回溯即祖先链，实验 `ancestor_path` 已验证）。同一提问被编辑重试按 promptId 去重（实验 §3.2）。
- **commit SHA 只是内部账本**：对外标识一律用 uuid；`uuid2commit` 索引（已验证 2μs）为 O(1) 主索引，commit message 尾注 `Node: <uuid>` 作 `--grep` 兜底。

```json
// .contextus/sessions/<node_uuid>.json（随 commit 提交）
{
  "node_uuid": "4892f958-…",             // 节点 ID = 该轮提问记录的 uuid（对外标识）
  "parent_uuid": "3c81e2a1-…",           // 树边 = 该记录的 parentUuid（天然携带）
  "root_uuid": "0f2a7b3c-…",             // 根节点（沿 parentUuid 回溯）
  "branch_id": "main",                   // 世界线 = refs/context/main
  "decision": "continue",                // initial|continue|fork|sync
  "anchor_node_uuid": null,              // fork/sync 时的锚点
  "claude_session_id": "4892f958-…",     // 执行层 JSONL 文件 ID（同文件多轮时同值）
  "chunks_hash": "sha256:9c31…",          // 生效规则快照 = 物化时工作区 Chunks 内容哈希（见 T7）
  "code_before": "9f2a…",                // 父 commit（Agent 看到的代码世界；提交前已知，可写入）
  // 注意：不存 code_after——自引用字段物理上无法写入自身 commit
  // （SHA 含 tree、tree 含本文件）；code_after 一律由 uuid2commit 索引派生
  "user_input": "把 API 改成异步",
  "created_at": "2026-08-13T10:30:00"
}
```

- 纯对话轮：commit 正常产生，代码树与父 commit 相同，但运行日志有增量（审计轨迹仍在）。
- 不再需要：bindings 索引（code→session 直接读 commit message 尾注）、dirty 快照（轮后全量提交）。

### T4. 双向查询

- **会话 → 代码**：`uuid2commit` 索引 O(1)（code_after = 本节点 commit，索引派生；session.json 仅存 code_before 作展示与校验）。**读路径一律以索引为准**（v3.0）——T9 改后索引重建，字段永不漂移。
- **代码 → 会话**：commit message 尾注 `Node: <uuid>`；无尾注 = 非 Contextus 提交，`find` 明确报告「非会话提交」。
- `git log --grep "Node:"` 可批量检索会话历史。

### T5. 恢复语义：checkout 查看模式，ask 时才建世界线【v3.0 重写】

**读历史不建提交（用户定调，v3.0）**：checkout 是纯查看动作，不创建任何 ref、不产生任何 commit；新世界线在用户真正提问（ask）时才建立。

```
sm.py checkout <node_uuid|世界线名|last>    # last = 回到当前世界线 tip
  1. 守卫：工作区有未提交改动 → 拒绝（防覆盖；轮间用户自己的改动）
  2. git checkout --detach <该节点 commit>   # 查看模式：落位（工作区 = 节点代码世界）
  3. 物化上下文备用；status 显示「查看模式 @ 节点 X」
  4. 纯查看到此为止——无世界线、无 commit

随后 ask "<问题>" 时（仍在查看模式）：
  1. 建新世界线：分支名 --branch 指定，缺省自动 <原世界线名>-2
  2. git checkout -b <heads新支> <节点commit>
     git update-ref refs/context/<新支> <节点commit>   # 双 ref 镜像不变式
  3. 常规 T2 流程（物化→执行→提交→双 ref 前进；parent = 节点 commit）
```

- **回溯即分叉**：新 commit 的 parent = 该节点 commit；旧世界线 ref 不动，历史永不丢。
- `--at-start` 取 code_before 视角（查看「当时所见」）。
- 查看模式下用户自行 git 操作：允许（用户不受禁）；Contextus 下次命令时检测状态并对齐。
- 默认不带同步 = 纯历史代码空间；带同步见 T8。

### T6. 分支模型：严格单父，无 Merge【立项书约定】

Fork = 新世界线 ref 指向锚点 commit 后在其上继续提交。世界线间互不可见对方后续；`refs/context/<branch>` 即各世界线最新会话指针。

### T7. 最简 Chunk：Chunks 文件夹 + git 历史版本化，回放用当前规则【v2.8 重写】

- **定位**：MVP 中 Chunk 的唯一职责 = **跨分支规则定义**。全树所有世界线共享同一套项目约束与用户规则。
- **存储模型（用户定调）**：使用 Contextus 管理的项目有一个 **`.contextus/Chunks/` 文件夹**管理 Chunk 内容。MVP 只放一个文件：

```
.contextus/Chunks/
└── project_policy.md        # 条目化（每行一条规则），例如：
                             #   1. 调仓幅度上限 5%
                             #   2. 所有输出使用中文
```

  - **编辑入口 = 该文件本身**：`sm.py policy set "<条目>"` 追加一条 / `policy edit` 打开编辑器 / 直接改文件均可；改动随下一轮 commit 入库。
  - **版本 = git 历史**：每个 commit 中的 Chunks 快照即一个版本，天然不可变——不再需要 v 文件与 Registry（「最近提交的 Chunks」就是最新版本）；`policy log` = `git log` 该文件。
  - Agent 对 Chunks 文件的修改同样随轮提交入库（规则演进全程可审计），下一轮交互起生效。

- **回放用当前规则 + 增量注入（用户定调）**：历史会话回放/继续时，生效的**始终是当前规则**。新会话物化时做**文档一致性比对**：

```
base   = 该节点 commit 中的 Chunks 快照（会话链最后看到的规则）
target = 工作区 Chunks（当前规则）
         若工作区与最近提交的 Chunks 不一致 = 有未入库改动：
         以工作区为准注入，本轮 commit 将其入库，比对基线随之复位
  base == target → 不注入
  base != target → 条目级 diff(base → target)，只注入增量：
       新增条目 → 【规则新增】<内容>
       修改条目 → 【规则更新】<新内容>　【禁止】<原内容表述>
       删除条目 → 【规则禁止】<原内容表述>（已废止，禁止执行）
  新 Session 记录 chunks_hash = target 内容哈希（旧 Session 不变）
```

  **为什么是增量而非全文（用户指出）**：历史上下文中已嵌有旧规则文本，补全文会使新旧规则并存且可能矛盾，模型无所适从。增量注入只补差异；对修改/删减条目用 **【禁止】指令显式中和**历史中的旧文本。**注入质量靠文档一致性比对（条目级 diff）控制**。

- **发送顺序**：历史上下文 → 规则增量 → 用户请求——请求永远拼接在最后（Claude Code `-p` 参数即请求，天然位于文件内容之后）。
- 纯回溯查看（只 checkout 不提问）不产生任何新 Session。
- **API 形状对齐**：Phase 2 完整 Chunk 体系 = Chunks 文件夹放多个文件（多模块）+ 类型/关系元数据；比对机制复用（文件级 → 条目级 diff），Twin 模型不变。

### T8. 同步分支：回溯 + 继承最新代码空间【v2.4 新增】

**场景（用户定调）**：回到历史节点开新分支，但想带着**最新会话的代码空间**（而非历史节点的旧代码）出发。

```
sm.py branch <历史节点> "<问题>" --sync-latest

1. checkout 历史节点（工作区 = 历史代码；上下文 = 历史对话）
2. 新会话开头注入同步指令：
   "先比较历史节点 <hist-sha> 与最新会话 <latest-sha> 的代码状态
    （可用只读 git diff/log），将工作区同步到最新代码状态，
    并在回复中说明同步了什么，然后处理：<问题>"
3. Agent 用只读 git 直接比较（读权限 T2），编辑文件完成同步，
   同步动作与说明全部记录在新会话中（可审计）
4. 处理用户请求
5. 轮后提交：新 commit 的 parent = 历史节点 commit
   → 新世界线 = 历史上下文 + 最新代码空间
```

- **历史节点不动**：同步发生在工作区，作为**新对话的一个环节**执行；历史 commit 与旧世界线毫发无损。
- **「记忆」= 会话记录**：Agent 在回复中说明同步内容，即进入新世界线的上下文，后续轮自然可见。
- **同步材料规模控制（P1-2）**：不注入全量 diff——只注入 `git diff --stat` 变更清单 + 前 30 个文件的 diff；其余由 Agent 按需用只读 git 自行查看（读权限 T2），同步指令要求分批同步并报告进度。
- 最新代码源：默认 = 当前世界线最新会话；`--from <节点>` 可指定任意源。
- 无 `--sync-latest` 的普通分支 = 纯历史代码空间（T5 语义）。

### T9. 存储模型：增删改查完备，改走审计通道【v2.6 重写】

Contextus 管理的 git 是**完备的存储层**（类比数据库：增删改查齐全），但两条路径分离：

**常规路径（应用语义，不可变哲学不变）**：

- 新 commit（轮提交/规则版本）、新世界线 ref、新记录/chunk 文件——常规操作只做「增」，Chunk/Session 不可变原则（立项书 §4.1/4.2）照旧。
- 提交错误仍默认**向前修复**（新 commit）。

**维护路径（改/删，审计兜底）**：

- 改/删必须经 Contextus 显式操作执行（不提供任意 git 改写），MVP 操作集：

| 操作 | CLI | 语义 |
|------|-----|------|
| 改 commit 名称（**仅 tip**） | `sm.py rename <新名称>` | 只允许改世界线 tip：amend message（树不变）——修正命名歧义/后悔；中间 commit 重写**不做 git rebase**（全链 SHA 级联重写），由 Phase 2「重建分支」替代 |
| 废弃世界线 | `sm.py drop <世界线>` | 删 ref 指针（可配合 GC 真正清理）——「放弃实验分支」 |
| 历史清理 scrub | Phase 2（机制预留） | 抹除历史中的敏感文件/内容（filter-repo 类，审计记录全程） |

- **每次改/删强制产生审计日志**：`.contextus/logs/runtime.log` 追加一条（操作类型、对象、before SHA、after SHA、原因、时间）——**日志本身只增不改**，审计信任锚定在日志上，而非「历史不可改」。
- 改后维护：uuid2commit 索引自动重建（派生数据）；读路径一律以索引为准（T4），code_before 字段仅展示与校验；对话记录以 uuid 为标识、不依赖 SHA，已物化的会话文件不受影响。
- Agent 权限不变（T2：仍只读）——「改」是 Contextus 与用户的维护能力，不向 Agent 开放。

**取舍（用户定调）**：无改换来了回放确定性但付出了「错误与噪音永久驻留」的代价（R19~R22）；带改让存储层像数据库一样完备，纠错灵活，审计代价由只增不改的日志承担。

### T10. 失败轮处理：提交而非回滚【v3.0 新增】

`claude -p` 的失败模式统一处理为**提交**，保证「工作区始终干净」不变式在所有路径成立：

| 模式 | 处理 |
|------|------|
| 退出码非 0 | 照常提交，`decision: "failed"`，日志记录退出码与 stderr 摘要 |
| 超时（Contextus 侧 subprocess 超时，默认 30 分钟可配） | kill 进程 → 提交半成品状态（failed） |
| 用户中断（Ctrl+C） | 同上，标记 interrupted |
| 提交本身失败（磁盘满/锁冲突） | 重试 3 次退避；仍失败 → 高声告警，不动工作区 |

理由：审计完整性（失败轮也是历史事实）；回滚会丢失 Agent 半成品工作（对调试是损失）；修复走 T9 维护通道（rename 改名、drop 废弃世界线）。

### D5'. 交付形态与技术栈 = TypeScript + CLI【v3.0 定稿：用户定调 TS】

**Node.js 22 LTS + TypeScript**：开发期 `tsx` 直跑，发布编译为 JS；核心库 `contextus/`；CLI `sm`。选型理由：

1. **格式密集代码的类型收益**：JSONL 会话格式是无契约行为结论（R 系列风险大半是格式漂移），session/chunk/索引全结构化——静态类型是本项目收益最大的语言特性；
2. **路线图一语言贯穿**：Phase 4 REST API（Fastify 类）+ 立项书的 Session Tree 可视化 UI + Claude 生态（MCP/skills 为 TS 原生）；
3. **迁移成本低**：旧 Python 代码 ~500 行逻辑，且已验证结论全部在 docx（格式事实/陷阱/性能数据），代码迁移是机械工作。

依赖保持最小：条目级 diff 用 `diff`（jsdiff，对应 Python difflib）；子进程/路径用 `node:child_process` + `node:path`；不引框架。

---

## 4. 数据模型（MVP：2 核心对象 + 策略 Chunk + 运行日志）

| 对象 | 内容 | 存储 |
|------|------|------|
| Session | §3-T3 的 session.json（node_uuid 为键，含 chunks_hash、code_before；code_after 由索引派生，不落存储） | `.contextus/sessions/<node_uuid>.json` |
| 回合记录 | Claude Code JSONL 行（user/assistant/tool 等，格式 = 实验 §3；uuid/parentUuid 天然树结构） | `.contextus/records/<seq>-<uuid>.json` |
| 策略 Chunk | §3-T7 的 Chunks 文件夹（条目化文件；版本 = git 历史快照） | `.contextus/Chunks/project_policy.md` |
| 运行日志 | 运行时逐行追加（轮开始/调用/结束/提交/规则比对/异常） | `.contextus/logs/runtime.log` |

挂接点（Phase 2 用，MVP 只留字段/目录）：session.json 保留 `chunks: []` 字段；`.contextus/` 预留 `snapshots/` 等目录；`SemanticResolver` 接口在包内留名。

---

## 5. 项目结构

```
D:\开发\Contextus\
├── docx/                        # 文档
├── src/                         # TypeScript 源码
│   ├── index.ts                 # CLI 入口（sm）
│   ├── gitstore.ts              # git 操作封装：轮后提交 / 双 ref 管理 / 物化去重 /
│   │                            #   uuid2commit 索引（T2/T3/T4）
│   ├── policy.ts                # 策略 Chunk：Chunks 文件夹读写 + 条目级 diff + 文档一致性比对（T7）
│   ├── sessions.ts              # Session 模型 + 树遍历（uuid/parentUuid 链）
│   ├── twin.ts                  # Twin 核心：一轮生命周期（物化→执行→日志→轮后提交→ref 前进）+ 提交监控
│   ├── materialize.ts           # 物化：祖先链 + 规则增量注入 + 同步指令注入（T7/T8，路线 B 格式）
│   ├── log.ts                   # 运行日志写入（逐行追加，审计轨迹）
│   ├── ui.ts                    # Session Tree UI（TUI，ink）：树浏览 + 节点进入（开交互窗口）
│   └── runner.ts                # claude 执行对接（交互窗口 spawn + 无头 -p，Windows 陷阱处理）
├── package.json / tsconfig.json # Node 22 LTS + TypeScript；依赖最小（jsdiff）
├── tests/                       # 单元测试 + 升级回归（实验 §4.2 三用例自动化）
└── benchmark/                   # Twin 验收场景 + 回放测试（1000 会话）
```

迁移：旧 Python 代码（`C:\Users\admin\session-manager\` 的 `sm.py`、`demo_git_tree.py`）作为**参考实现**迁移为 TS——已验证结论在 docx（格式事实/陷阱清单/性能数据），代码迁移是机械工作。路线 C 原型（`extract_context.py` 等）归档不迁。

**模块归属**：`gitstore.ts` + `sessions.ts` = **Session Tree**；`twin.ts` + `log.ts` = **Git Twin**；`policy.ts` = **策略 Chunk**；`materialize.ts` + `runner.ts` = 与 Claude Code 的对接边界（物化会话文件 + 执行调用，复用层，无自研逻辑）。

**首个 dogfood 目标**：`D:\开发\Contextus` 本身 `git init` 并启用 twin——Contextus 开发过程即第一份真实测试数据（代码世界 = Contextus 代码；会话世界 = 本项目开发对话；project_policy = 本项目开发约定）。

---

## 6. 开发里程碑

| 里程碑 | 内容 | 验收 |
|--------|------|------|
| **M0 地基** | 项目 `git init` + 包骨架；sm.py/demo_git_tree.py 迁入；独立 store 模式全能力回归（list/tree/branch/exec，git 存储版） | 实验 §4.2 三用例 + 物化一致性测试全过；**cwd 编码在非 ASCII 路径（`D:\开发\Contextus`）下回归**（P2-1） |
| **M1 Twin 写入** | `twin-init`（.contextus/ + settings.json 隔离四层权限 + 日志初始化 + 并发锁）；轮后自动提交（T2）；session.json + commit 命名与尾注（T3）；失败轮提交（T10）；无头 ask 闭环（自动化路径） | 测试仓库：连续 3 轮 → 3 个 commit、双 ref 同步、工作区干净、Agent 写命令被拒而读命令/gh 可用、并发 ask 被锁拒绝 |
| **M1.5 Session Tree UI** | `sm ui`（ink TUI）：世界线/节点树浏览；选中节点 → 物化 → 开新终端窗口交互式 `claude --resume`；后台文件监控：检测新提问 → 提交上一轮；窗口关闭 → 提交最后一轮 | 测试仓库：树显示正确；进入节点窗口上下文正确；监控提交逐轮产生 commit；窗口关闭后树刷新 |
| **M2 Twin 恢复与查询** | `checkout`（双世界恢复 + 脏工作区守卫 + 新世界线）、`find`、`diff`、`tree`、`status`、`--sync-latest` 同步分支（T8）、维护操作 `rename`/`drop`（T9） | 场景 T1~T5、T7~T9 人工跑通 |
| **M3 策略 Chunk** | `policy set/edit/log`（T7，Chunks 文件夹 + git 历史）；物化时文档一致性比对 + 增量注入（含【禁止】） | 场景 T6 跑通 |
| **M4 验收** | 场景自动化 + 1000 会话回放（50 真执行）+ 升级回归脚本 + `cat-file --batch` 长链物化性能项 | §7 全部通过 |

---

## 7. 验证与验收

### 7.1 九场景（T1~T5、T7~T9 为 Twin，T6 为策略 Chunk）

| # | 场景 | 通过标准 |
|---|------|---------|
| T1 | 连续编码任务：3 轮（每轮 Agent 改代码） | 每轮恰一个 commit；commit 名称 = 请求前若干字（≤20 字）；节点 uid = 提问记录 uuid；S_n 的 code_after == S_{n+1} 的 code_before；双 ref 始终同步；轮间工作区干净 |
| T2 | 纯对话轮（不改代码） | commit 正常产生；代码树与父 commit 相同，但运行日志有增量（审计轨迹完整） |
| T3 | 本地 git 读写分离：轮中 Agent 尝试写命令 / 读命令 | 写命令（commit/checkout/…）被 permissions 拒绝；读命令（log/diff/…）正常可用；gh / GitHub API 正常；轮后提交不受影响 |
| T4 | 分支世界线：从节点 c fork 两条线各自继续 | 两个 refs/context/* 独立演进、互不可见对方后续；旧世界线 ref 不动；任意时刻 checkout 任一会话，代码世界正确 |
| T5 | 代码 → 会话回溯：给定某轮 commit SHA | `find` 返回产生它的 node_uuid；checkout 该节点恢复当时完整上下文（对话 + 代码） |
| T6 | 规则更新：policy v1 → v2（Chunks 比对 + 增量注入） | ① 更新 = 改 Chunks 文件（随下轮提交入库），全树零改动（O(1)）② 任一分支持续交互 → 比对「节点 commit 的 Chunks 快照 vs 工作区 Chunks」发现 base≠target → 注入增量（新增原文 / 修改 = 新文 + 【禁止】旧文 / 删除 = 【禁止】），新 Session 生效 v2，旧 Session 不变 ③ checkout 旧 Session 回放 → 历史上下文 + 增量注入 → 生效当前规则，历史中的旧文本被【禁止】中和 ④ 分支 A/B 均自动继承当前规则（跨分支规则统一）⑤ base==target 时不注入；工作区未入库改动同样被注入并在本轮提交入库 |
| T7 | **配置边界分支（用户例子）**：a b = 配置上下文，c d = 任务上下文；新任务 e f | 回到 b 节点开新分支 → 新世界线 = a b e f；物化上下文不含 c d（token 断言）；当前规则正常注入 |
| T8 | **同步分支**：从历史节点 `--sync-latest` 开新分支 | ① 历史节点 commit 未被修改（SHA 不变）② 同步动作与说明记录在新会话中（可审计）③ 轮后工作区代码 == 最新会话代码（`git diff` 为空）④ 新世界线 = 历史上下文 + 最新代码 |
| T9 | **维护操作**：rename 改 commit 名称；drop 废弃世界线 | ① 每次改/删均有审计日志（before/after SHA、原因）② rename 后树内容不变、`find`/`checkout` 仍正确（索引重建）③ drop 后该世界线 ref 消失、其余世界线不受影响 ④ 审计日志本身只增不改 |

### 7.2 硬验收指标

1. **1:1 绑定正确性**：N 轮后每轮恰一个 commit；node_uuid ↔ commit 双向可查且一致；code_before 字段与 commit 链吻合、code_after 索引派生一致；每轮 commit 均有日志增量
2. **回放**：随机 1000 个历史会话做零成本校验（restore + materialize + 物化记录与 commit 树逐 uuid 比对）；其中 50 个抽样真 continue 执行；历史状态不被破坏（继承立项书指标 ④；真执行抽样控制 API 成本）
3. **零干扰 + 干净**：轮后工作区 clean；refs/heads 与 refs/context 始终一致；Agent 写命令全部被拒、读命令与 gh/API 不受影响
4. **规则更新 O(1)**：N 个会话 + 1 次规则更新 = 改 1 个 Chunks 文件 + 0 个会话改动（零全树遍历；立项书指标 ③ 最简版）
5. **回归**：实验 §4.2 三用例 + git 物化一致性测试，每次 Claude Code 升级必跑（格式非契约，唯一护栏）
6. **性能继承**：uuid 查询 2μs、checkout 12ms 量级不退化
7. **改必审计**：每一次改/删操作 100% 产生审计日志（操作、对象、before/after SHA、原因、时间）；审计日志本身只增不改；常规路径（轮提交/规则更新/分支）保持不可变语义——无审计的改 = 事故

### 7.3 Phase 2 演进（不在 MVP 验收内）

完整 Chunk 体系（类型化/关系/自动提取）、Context Resolver（自动选择配置边界节点——T7 场景的自动化）、完整 Lazy Reconcile、Compaction-Generation、Context Merge、Summary/RAG Adapter、Agent 自主提交放开（混合模型，heads 与 context 分化）、**重建分支**（用户定义：将某节点回溯到 root 的链所继承的上下文压缩，成立一棵新树，挂在 skill/mcp 基础上下文之下——对应立项书「Compaction = New Tree」与「Base Skill/MCP Context → New Branch」；**取代中间节点的 git 重写**，历史重写类需求统一走此机制）、scrub 历史清理（敏感内容清除，R19）——全部在 Twin 模型之上叠加：`chunks_hash` 升级为 `chunks` 引用数组即挂接点，Twin 模型无需变更。

---

## 8. 风险与边界

继承实验 §9 全部风险（格式非契约、summary/compaction 未处理、工具配对、跨分支缓存 miss、网关差异），新增：

| # | 风险 | 缓解 |
|---|------|------|
| R8 | 用户仓库 hooks（pre-commit 等）干扰 Contextus 提交 | `--no-verify`（hooks 属代码世界政策，turn 提交是状态快照）；文档说明 |
| R9 | checkout 覆盖用户工作区 | 脏工作区守卫（T5 拒绝 + 提示） |
| R10 | 每轮 commit 含全量代码树，对象库膨胀 | blob 去重天然生效（未变文件共享对象）；GC 策略 Phase 2 |
| R11 | `.contextus/` 被 Agent 误操作（文件层面改/删） | 预防：文件工具 deny 编辑 `.git/**` 与 `.contextus/records|sessions|logs|index/**`（T2 隔离四层）；兜底：已入库 + 对象不可变 + reflog 可恢复 |
| R13 | 规则注入占 token（每分支首轮） | 增量注入（只补 diff 不补全文）进一步压缩；版本一致时不注入；缓存成本模型已明（实验 §6.3） |
| R25 | 增量 diff 噪声：规则文档为自由文本时，条目 diff 产生碎片指令 | 规则文档条目化约定（每行一条，`policy set` 校验）；注入内容 CLI 输出预览，用户可复核 |
| R26 | 【禁止】中和是启发式的：旧规则在历史中被多次引用/改写时无法彻底抹除 | 注入位置在历史之后、请求之前（recency 优先）；彻底解法 = Phase 2 重建分支/Compaction（新树不含旧规则） |
| R27 | 窗口唤起平台差异：Windows Terminal（wt）缺失或版本差异 | wt 优先 + `cmd /c start` 兜底；唤起失败时输出手动命令提示（claude --resume <sid>） |
| R28 | 监控提交滞后：新提问检测依赖文件写入时机；极端情况轮边界误判 | 轮询间隔 2s；窗口关闭时兜底提交最后一轮（不完整也提交，T10）；误判可由 rename/drop 维护通道修正 |
| R29 | 多窗口并行：同一仓库多个交互窗口同时问答 → 提交串行化 | 并发锁（T2）：每次提交取锁；MVP 建议单窗口；多窗口完整支持属 Phase 2 |
| R14 | **本地 git 写命令禁用后，任务需要写 git 时受限** | 边界明确：GitHub 托管走 gh/API（自由）；本地写 git 由用户或 Contextus 代执行；Phase 2 可选放开 + 混合提交模型 |
| R15 | permissions 规则格式随 Claude Code 版本变化；读命令被误伤 | twin-init 写入 + M1 验证读写分离规则格式；升级回归覆盖 |
| R16 | 运行日志无限增长 | 日志按轮分段、随 commit 入库后可截断（保留 tail）；压缩策略 Phase 2 |
| R17 | **同步分支依赖 Agent 正确执行同步**（读 diff 有偏差、漏改、误改） | 同步指令为会话第一步、要求 Agent 先报告同步内容；轮后 `git diff <最新会话>` 校验可检测遗漏（T8 场景③）；校验不通过可再开一轮修正 |
| R18 | Agent 只读 git 可看到全部世界线历史（含其他分支敏感信息） | MVP 边界接受（单用户仓库）；多租户/权限细化属 Phase 4 |
| R19 | **敏感信息入史**：某轮把密钥/机密写进文件，Agent 只读可见 | 改通道可抹除（scrub，Phase 2 机制预留）；MVP 期间仍建议提交前 secret 扫描拦截（挡在历史之外成本最低） |
| R20 | **仓库膨胀**：被修改过的文件每轮产生新 blob；误入大文件驻留 | blob 去重天然生效；提交前大小/类型检查；改/删通道可整理（drop + GC、scrub）；长期靠 Phase 2 Compaction-Generation 换树 |
| R21 | **错误与噪音入史**：后悔决策、粒度错误、命名歧义 | rename 可修命名；常规路径仍向前修复；一切整理走审计通道（T9） |
| R22 | **世界线废弃**：放弃的实验分支占着历史 | drop ref + GC 可真正清理（T9 维护路径） |
| R23 | **改后派生数据失效**：uuid2commit 索引、session.json 冗余字段、外部引用的旧 SHA 过时 | 改后索引自动重建；冗余字段标注「以 commit 链为准」；对话记录以 uuid 标识、不依赖 SHA |
| R24 | **改操作本身出错/被滥用**：rebase 冲突、误删、无审计的改 | 审计日志只增不改 + git reflog 可回滚；改仅限 Contextus 显式维护操作，不向 Agent 开放 |

---

## 附录 A：决策速查（v3.1）

- 自研边界：**Git Twin / 策略 Chunk / Session Tree / Session Tree UI（TUI）** 四模块；其余全部复用 Claude Code 现有体系
- 执行形态：**交互窗口为主**——`sm ui` 树界面选中节点 → 物化 → 开真实终端窗口 `claude --resume`（信任/权限可应答）；无头 `-p` 仅自动化/回归
- 交互提交时机：文件监控——检测到新提问 → 提交上一轮；窗口关闭 → 提交最后一轮；「一轮一 commit」不变
- 存储模型：**增删改查完备**（类比数据库）——常规路径不可变（新 commit/版本/会话）；改/删走维护通道（Contextus 显式操作：rename **仅限 tip** / drop，中间重写由 Phase 2「重建分支」替代，scrub 为 Phase 2）；每次改强制审计日志（before/after SHA + 原因），**日志本身只增不改**
- 存储：git 一仓两层（主模式 = 目标代码仓库；独立 store 降级）
- 权限：**隔离四层**——① Bash 写 git deny（读命令开放）② 文件工具 deny 编辑 `.git/**` 与 `.contextus` 敏感路径（Chunks 默认放行）③ Bash deny `sm.py` ④ 审计兜底；GitHub 云 git 自由（gh/API/Web），两者互不冲突；subprocess 绕过接受为 MVP 边界
- 提交：轮后自动提交（add -A + commit --no-verify + 双 ref 前进）；一轮一 commit；commit 名称 = 用户请求前若干字（≤20 字），尾注 `Node: <uuid>`；并发锁 `.contextus/.lock`；失败轮一律提交（decision=failed + 日志）
- 日志：运行时持续追加 `.contextus/logs/runtime.log`；纯对话轮也有提交内容；审计轨迹
- 标识：**节点 uid = 对话文件天然 uuid，树边 = parentUuid**；commit SHA 仅内部账本；uuid2commit 索引 2μs
- 绑定：Session ↔ Commit 1:1；code_before 存 session.json（父 SHA）；**code_after 由索引派生**（自引用字段无法写入自身 commit）；读路径一律以索引为准
- 查询：会话→代码 O(1)（索引）；代码→会话读 commit 尾注 Node
- 恢复：checkout = **查看模式**（detached，不建线不提交）；ask 时才建新世界线（回溯即分叉，旧 ref 不动）
- 同步分支：`--sync-latest` = 历史上下文 + 最新代码空间；同步是新对话环节（Agent 只读 git 比较 + 编辑文件），历史节点不动
- 规则：单一 `project_policy`，存于 **`.contextus/Chunks/` 文件夹**（条目化文件）；**版本 = git 历史快照**（无 v 文件/Registry）；更新 = 改文件，O(1)；回放用当前规则——比对「节点 commit 的 Chunks 快照 vs 工作区 Chunks」（含未入库改动），不一致则**注入增量**（新增 = 原文；修改 = 新文 + 【禁止】旧文；删除 = 【禁止】）；发送顺序 = 历史 → 规则增量 → 用户请求
- 分支：严格单父；fork = 新 refs/context 支指向锚点 commit
- 交付：TypeScript（Node 22 LTS + tsx 开发）+ CLI + TUI（ink）；REST 后包
- 环境基线：Windows 11 / Git Bash / Python 3 / Claude Code v2.1.197（升级须回归）

## 附录 B：已实测结论速查（自实验记录继承）

- 分支任意节点 c：伪造会话文件 + `claude -p --resume` ✅
- git 存储：uuid 索引 2μs、checkout 回溯 12ms、物化 0.23s、逐条一致性 ✅
- 会话内缓存命中 99.9%；跨分支首轮 miss（一次性 ~$0.1）
- 无损边界：数据/历史可无损（git）；运行时语义受「分支以当前环境执行」约束
