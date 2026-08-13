# Contextus Agent 会话状态运行时立项书

> 来源：与 ChatGPT 的讨论（chatgpt.com/share/6a7d1d5e-c224-83ec-922d-ff3f304cc3ba），2026-08 由用户粘贴转入本仓库。
> 性质：产品定义与 MVP 范围讨论。落地结论见《Contextus_MVP技术方案.md》。

---

## 一、项目概述

### 1.1 项目名称

**Contextus**

项目定位：

> 面向长期运行 Agent 的语义化会话状态运行时（Semantic Context Runtime）。

Contextus 不以替代 Conversation、Summary、RAG、Memory、KV Cache 等已有能力为目标，而是在这些能力之上建立统一的**会话状态组织、版本、分支、继承、回溯、懒更新与上下文装配机制**。

其核心思想是：

```text
Conversation / Summary / RAG / Tool / Skill / MCP
                     ↓
              Semantic Chunks
                     ↓
             Context Composition
                     ↓
                  Session
                     ↓
              Session Tree
                     ↓
          Effective Context Runtime
                     ↓
                 Agent / LLM
```

每一个 Session 都是一个真实、可寻址、可回溯的上下文状态；整个 Session Tree 保存 Agent 的状态演进历史。

---

## 二、立项背景与问题

当前 Agent 的上下文体系普遍由多个相互独立的组件组合而成：Conversation History、Summary、RAG、Vector Memory、Prompt、Session ID、KV Cache、Git。这些组件各自解决一个局部问题，但缺乏统一的 **Context State Model**。

长期 Agent 因此会出现几个典型问题：

### 2.1 上下文线性增长

Conversation → Summary → RAG → Tool Results → 新 Conversation，最终 Context 越来越大。

### 2.2 历史状态不可精确恢复

系统只能回答"以前聊过什么"，却很难回答"当时 Agent 处于什么状态？当时使用的是哪个规则版本？当时仓库是什么版本？"

### 2.3 规则修改导致上下文污染

Policy v1 → v2 → v3。传统系统通常通过 Prompt 覆盖、Summary 或额外提示解决，历史 Context 与当前 Context 的边界并不清晰。

### 2.4 多分支任务难以管理

用户可能从一个任务产生多个方案（方案 A / B / C），普通 Session 往往只能线性追加。

### 2.5 Agent 与代码版本脱节

Coding Agent 最大问题之一：历史 Conversation = 旧世界，Git HEAD = 新世界。很难精确回答"为什么当时这个 Agent 做出了这个决定？"

---

## 三、项目目标

> **建立一个面向 Agent 的、语义驱动、版本化、可分支、可回溯、可懒更新、可复现的 Session Context Runtime。**

### 3.1 建立 Semantic Chunk 模型

把上下文拆成语义原子：Policy、Task、Goal、Constraint、Preference、Experience、Knowledge、Decision、State、Result、Entity、Skill、MCP、Evidence、Summary、Conversation。

Chunk 本身不可修改。同一语义模块通过不同版本实现演进：`behavior_policy@v1 → v2 → v3`。

### 3.2 建立 Session State 模型

```text
Session
├── session_id
├── parent_session_id
├── root_session_id
├── branch_id
├── context_generation
├── effective_chunks
├── conversation references
├── summary references
├── RAG evidence references
├── skill versions
├── MCP versions
├── code/git state
└── execution metadata
```

Session 不可被历史性地修改。新的状态通过新 Session 表达。

### 3.3 建立 Session Tree

```text
Root
├── S001
│   ├── S002
│   │   ├── S004
│   │   └── S005
│   └── S003
└── S006
```

任何节点均可：查看、恢复、继续执行、分支、比较、重放。

### 3.4 建立 Context Resolution

用户输入首先被解析成 Chunk Set。例如"把 monkiy 下面的科创板小票再减 5%，按照之前的方法"解析为 `{monkiy, 科创板, 小票, reduce, 5%, historical_strategy}`。

系统随后根据语义关联度、Chunk 关系、Scope、Session Lineage、Skill/MCP compatibility、Policy compatibility、Context inheritance cost、Future reuse value、Conflict、State continuity 选择最佳 Context Anchor。

注意：**最大覆盖只是一个决策因素，而不是唯一目标。**

---

## 四、核心设计原则

- **4.1 Chunk Immutable**：Chunk 永不 UPDATE；v2 不修改 v1。
- **4.2 Session Immutable**：历史 Session 永远保留；不能把 S100 改成 S101。
- **4.3 Logical History 与 Physical Context 分离**：逻辑历史永远保存；物理 Context 可以重新 materialize、compaction、建立新 Generation、针对 KV Cache 优化。
- **4.4 Lazy Reconciliation**：规则更新不遍历整棵树。policy@v7 → v8 只更新全局 Module Registry；当某个 Session 再次命中 policy 时才发现 local=v7 / latest=v8，随后生成补丁并创建新的 Session。
- **4.5 Context Compaction = New Tree**：Summary/Compaction 不直接修改旧树，而是 Tree T0 → Compaction → Tree T1。T0 永远保留，T1 是重新 materialize 后的新最优 Context Tree。
- **4.6 Context Provider 正交**：Conversation、Summary、RAG、Tool、Skill、MCP 等都作为 Context Provider。Contextus 不替代这些能力，它负责获取 → 语义化 → 组织 → 版本 → 继承 → 分支 → 状态化。

---

## 五、系统总体架构

```text
                         ┌─────────────────┐
                         │   Agent / LLM   │
                         └────────┬────────┘
                                  │
                         ┌────────▼────────┐
                         │ Context Runtime  │
                         └────────┬────────┘
                                  │
              ┌───────────────────┼───────────────────┐
              │                   │                   │
       Context Resolver     Session Manager     Context Compiler
              │                   │                   │
              └───────────────────┼───────────────────┘
                                  │
                         ┌────────▼────────┐
                         │ Context State   │
                         └────────┬────────┘
                                  │
                 ┌────────────────┼────────────────┐
                 │                │                │
           Chunk Store       Session Tree      Version Registry
                 │                │                │
                 └────────────────┼────────────────┘
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        │                         │                         │
 Conversation Provider      Summary Provider          RAG Provider
        │                         │                         │
        ├───────────────┬─────────┴─────────────┬───────────┤
        │               │                       │
      Tool            Skill                    MCP
        │               │                       │
        └───────────────┴──────────────┬────────┘
                                       │
                                  Artifact Store

                          Code / Git Twin Layer
                                       │
                                Git Commit / Tree
```

---

## 六~二十三、核心模块（摘要）

| 模块 | 职责 |
|------|------|
| Chunk Engine | 语义 Chunk 的创建、分类、版本与关系（Schema/Type/Version/Name/Scope/Lifecycle/Confidence/Relation/Supersedes/Conflicts/Depends On/Derived From） |
| Context Resolution Engine | **最核心**。输入 Query/Current Session/Candidates/Chunk Index/Registry → 输出 Context Anchor/Selected Session/Required Chunks/Inheritance Plan。含语义解析、候选生成、Context Scoring（10 项因素）、Decision（Continue/Patch/Fork/New Branch/New Context Lineage） |
| Session Manager | Create/Continue/Fork/Switch/Restore/Compare/Snapshot。每个 session_id 唯一、可寻址、可回溯、可继续工作 |
| Session Tree Engine | 遍历、祖先/后代查找、分支创建、Generation、历史导航、树比较、compaction 映射；任何节点可重新成为 active_session |
| Version Registry | 统一管理语义模块版本（behavior_policy→v8、risk_policy→v12…）；Session 查询先命中模块名再决定版本，版本不作为第一层语义搜索键 |
| Lazy Reconciliation Engine | Policy Update = O(1)；真正使用相关模块时才产生 O(accessed sessions) 的更新成本 |
| Context Materializer | Chunk Set/Relations/Session State/Version/Provider Artifacts → Effective Context/Token Stream/Prefix Hash |
| Context Compiler | Token 层最终装配（System→Policy→Skill→MCP→Project→Task→Experience→State→Conversation→Evidence→Query），按模型与 KV Cache 策略做 Prefix Layout。目标：让逻辑 Context 与物理 Token Layout 解耦 |
| Context Compaction Engine | 输入 Context Tree T0 → 输出 T1（合并有效版本、移除 Patch Chain、压缩 Conversation/Summary、重建拓扑）。T0=Historical Truth，T1=Optimized Execution Tree |
| Context Generation | 每次 Compaction 产生 Generation（T0/T1/T2），每个 Generation 可独立工作，建立 old→new lineage mapping |
| Conversation Adapter | Message ingestion、Message→Chunk、引用/分段/摘要、Session linkage。Conversation 保存原始事实，Chunk 是语义投影 |
| Summary Adapter | Summary 可作为 Chunk、Context Artifact、Compaction 输入、历史压缩表示 |
| RAG Adapter | Retrieval request、Evidence ingestion、Evidence Chunk、Citation tracking、时间戳、Source version、Session linkage。重点：让历史 Session 恢复"当时实际看到的 Evidence" |
| Skill/MCP Registry | 统一管理 Skill/MCP/Tool/Capability/Version/Compatibility；任务不属于已有业务 Context 但需要 Skill A+MCP X+Policy P 时，可 Base Skill/MCP Context → New Branch |
| Git Twin Engine | 每个重要 Session 绑定 session_id/context_generation/git_commit/repository/branch/working_tree_hash，形成 Context Tree ↕ Git Tree；恢复 Session 时同时恢复 Context World 与 Code World |
| KV Cache Layer | Prefix Hash、Context Layout、Prefix Reuse、Cache Reference、Warm/Cold、Branch Prefix Sharing——最大化共享前缀 |
| Replay/Audit Engine | Session/Context/Git/Tool/RAG Evidence/Decision Replay，回答"在 Session S1234 中 Agent 当时拥有的上下文是什么" |

基础数据模型实体：Chunk、ChunkVersion、ChunkRelation、ContextVector、ContextSnapshot、ContextGeneration、Session、SessionBranch、SessionTree、ModuleRegistry、VersionRegistry、ProviderArtifact、ContextCommit、GitBinding、KVPrefix、ReplayRecord。

---

## 二十四~二十七、阶段规划

| 阶段 | 内容 |
|------|------|
| MVP | Chunk、Chunk Version、Session、Session Tree、Semantic Resolver、Lazy Reconciliation、Context Materializer、Conversation Adapter。完整闭环：用户输入 → Semantic Chunk → 找到历史 Session → Continue/Fork/New Branch → 新 Session → Effective Context → Agent |
| 第二阶段 | Summary/Compaction、Context Generation、RAG Evidence、Skill/MCP Registry、Session Compare、Replay（T0→T1→T2 的 Tree Generation 能力） |
| 第三阶段 | KV Prefix Optimization、Git Twin、Code/Context Replay、Hot/Warm/Cold Session、Cache Warming |
| 第四阶段 | Multi-Agent、Multi-Tenant、Permissions、Audit、Persistence、Distributed Index、GC、Observability |

---

## 二十八、核心 API（初稿）

```text
POST /sessions                 POST /sessions/{id}/continue
POST /sessions/{id}/fork       POST /sessions/{id}/activate
GET  /sessions/{id}            GET  /sessions/{id}/tree
GET  /sessions/{id}/context    POST /context/resolve
POST /context/reconcile        POST /context/compact
GET  /context/generations      GET  /chunks/{name}/versions
POST /chunks/{name}/versions   GET  /sessions/{id}/replay
GET  /sessions/{id}/git
```

---

## 二十九、非功能目标

- **正确性**（最重要）：历史 Session 不被破坏、Chunk Version 不被覆盖、Effective Context 可确定、Replay 可复现
- **性能**：Context Resolution < 100ms、Session Lookup < 10ms、Chunk Lookup < 10ms、Lazy Reconcile < 100ms（以 Benchmark 后调整为准）
- **可扩展性**：百万级 Session、百万级 Chunk、十万级活跃 Branch；避免 Rule Update → 全树遍历

---

## 三十、核心 Benchmark

数据集：100,000+ Sessions、1,000,000+ Chunks、100,000+ Queries。对比 Baseline（Conversation+Summary+RAG+Conventional Session）与 Contextus（同样 Provider + Context Runtime）。

- Context：Correct Context Anchor、Wrong Context Rate、Retrieval Accuracy、State Consistency
- 成本：Input/Output/Repeated Tokens、KV Cache Hit Ratio、TTFT、Total Latency、Tool Calls、Retry Count
- 工程：Replay Success Rate、Version Consistency、Branch Isolation、Reconciliation Cost、Compaction Cost

---

## 三十一、成功标准（第一阶段）

1. Session Tree 能稳定表达长期 Agent 状态
2. 不引入显著错误上下文
3. Rule/Skill/MCP 更新无需全树同步
4. 历史 Session 始终可回溯
5. 新 Branch 能选择干净的 Context Anchor
6. Summary/RAG/Conversation 能自然接入
7. Compaction 后可以建立新的最优 Tree
8. Coding Agent 能通过 Session ↔ Git 回到历史工作状态
9. KV Prefix 在连续 Branch 中可以产生明显复用
10. 相同 Agent 任务下 Contextus 的总推理成本下降

---

## 三十二~三十三、长期产品形态与愿景

三层能力：**Context Store**（Chunk/Version/Artifact/Evidence/Experience）、**Context Runtime**（Session/Branch/Resolution/Reconciliation/Compaction/Materialization）、**Context Observability**（Replay/Audit/Diff/Timeline/Git Twin/Cache/Metrics）。

Contextus 最终不是 Chat Session Manager，而是 **Agent Context State Operating Layer**。它解决的问题不是"如何让 Agent 记住更多"，而是"如何让 Agent 在一个不断演化、可以分支、可以回溯、可以压缩、可以与代码世界同步的上下文世界中长期工作"。

一个 `session_id` 代表：一个确定的 Context State + 一个确定的历史位置 + 一组确定的语义版本 + 一个确定的 Agent 世界 + 可选的 Git Code State。

完整生命周期：Observe → Resolve → Inherit → Branch → Execute → Version → Reconcile → Compact → Replay。

---

## 三十四、项目建议

按 **Context Engine → Session Runtime → Compaction → Git Twin → KV Optimization** 顺序推进。第一阶段最重要的交付物不是 UI，而是：

> **一个可以让 Agent 在同一棵 Session Tree 中准确 Continue、Fork、New Branch，并在 Chunk Version 更新后进行 Lazy Reconciliation 的可运行 Runtime。**

---

## MVP 讨论结论（ChatGPT 建议原文要点）

MVP 不做"缩小版完整 Contextus"，只证明最核心闭环：

> Query → Semantic Chunks → 找到最佳 Session Anchor → Continue/Fork/New Branch → Lazy Version Reconcile → Materialize Context → Agent 执行

**MVP 必做模块**（P0）：Chunk Store、Semantic Resolver、Session Store、Session Tree、Context Matching、Branch Decision、Lazy Reconcile、Context Materializer、基础 Benchmark；Conversation Adapter 为 P1。

**MVP 数据模型**（6 对象）：Chunk、ChunkVersion、Session、SessionRelation、ModuleRegistry、ContextSnapshot。Session 只保存引用和必要物化信息，不复制完整 Chunk 内容。

**5 个验证场景**：① 连续任务（正确继承）② 语义分叉（脱离错误历史）③ 完全独立任务（不是最大覆盖就一定最好）④ 规则更新（O(1) 全局更新 + 按访问懒更新）⑤ 回溯（session_id 成为可回溯状态指针）。

**MVP 明确砍掉**：完整 Git Twin（只留 git_commit/repository 字段）、自研 Summary Engine、复杂 RAG、分布式（PostgreSQL+可选 Redis+一个 Index 足够）、复杂 Merge（只做 Continue/Fork/New Branch）。

**最值得重投入的模块：Context Resolver**。输入 Query/Current Session/Candidates/Chunk Registry → 输出 anchor_session/matched_chunks/inherit_chunks/stale_chunks/decision/confidence。

评分第一版用可解释公式：

```text
Score = semantic_match + entity_overlap + task_overlap + scope_match
      + skill_match + mcp_match + recency + continuity
      - inheritance_cost - conflict
```

输出 CONTINUE / FORK / NEW_BRANCH，不要一开始搞复杂图算法。

**4 个硬验收指标**：
1. Context 正确性：人工标注 Query 集，Context Anchor 正确率 ≥ 90%
2. Token：长会话场景有效 Prompt Token 比完整 History 明显下降（先证明趋势稳定）
3. Lazy Update：100,000 Sessions + 1 个 Policy 更新 = 只更新 Registry（O(1)）
4. Replay：随机抽 1000 个历史 Session 全部能 restore → materialize → continue，历史不被破坏

MVP 体量估算：5~8 个核心服务模块、一个存储层、一个 Resolver、一个简单可视化 Session Tree UI。

---

## Git 模型映射讨论（ChatGPT 建议原文要点）

> 不需要重新发明"状态版本控制协议"，直接借用 Git 已经成熟的 commit/parent/ref/branch/checkout/diff 语义，只是把 Git 管理的对象从"代码状态"扩展成"Agent 交互状态"。
>
> Git Commit Graph 是天然 DAG，而 Session Lineage 强约束为"每个节点只有一个 Session Parent"——在 Git 对象模型之上定义更严格的 Session Tree 语义。

| Contextus | Git |
|-----------|-----|
| Session | Commit |
| Parent Session | Parent Commit |
| Session Tree | Commit Graph 的受限子图 |
| Active Session | Ref / HEAD |
| Session Branch | Branch Ref |
| Session Generation | Tag / Ref |
| Chunk Version | Immutable object |
| Context Snapshot | Tree / commit metadata |
| Fork | New branch |
| Checkout | checkout / switch |
| Replay | checkout + replay |
| Diff | git diff |
| Compaction Generation | 新 root / 新 ref |
| Git Code State | Git Tree / Code Commit |

**"每一次用户对 AI 的交互都是一次提交"**。回到 A 再做一次不同尝试 → A 分出 B 和 C，非常自然。

分支直接复用 Git Ref 思想：`refs/context/main`、`refs/context/task-a`、`refs/context/task-b`、`refs/context/experiment-1`，不必额外发明 Branch Object。

**关键工程问题：交互提交与代码提交不要混成一个 Commit。** 一次交互可能不改代码、修改多文件暂不提交、只调工具、执行测试、产生 RAG 证据、改 Policy、切 Skill——这些不一定对应代码 Commit。因此建议：

### "一仓两层，双向绑定"

同一个 `.git` 仓库里 Code History + Context History 并存，但两个 commit lineage 独立：

```text
代码:   main: A ── B ── C ── D
Context: context/main: S1 ── S2 ── S3
                              \
                               S4
映射:   Context S3 ↕ Code Commit C
        Context S4 ↕ Code Commit B
```

Session Commit 定义"Agent 的认知世界"，Code Commit 定义"工程世界"。两个世界同步向前，但不要求一一相等（如纯推理交互 S100→S101 时代码仍为 C50；下一轮"实现这个方案"才产生 C51）。

每次交互 commit 记录：parent_session、user_input_hash、assistant_output_hash、active_chunks、effective_policy、tool_events、git_commit、timestamp。由此直接获得 Replay（checkout S101 + replay interaction #002）、Diff（diff S101 S102）、Fork。

**不可变对象 + 可变引用**：Session Commit / Chunk Version / Context Snapshot 不可变；refs/context/main、HEAD 可变。Policy v7 永远存在，更新产生 v8 新对象，ref 指向新 Session——几乎不需要重新发明状态管理原则。

**与 Git 的区别**：Git 允许 Merge Commit 多 parent；Contextus Session lineage 严格单父。规定"Session lineage 使用 Git-compatible object model，但禁止普通 Session Merge"；未来需要 Context Merge 时单独设计，不破坏 Session 基本语义。

**不要把大内容硬塞 Git Tree**：百万 RAG chunk、十亿 token conversation、KV cache、embedding、大型 tool output 不适合做 Git blob。正确做法：Git-compatible identity + Object Store + External Artifact Store。Git 负责 identity/version/parent/branch/ref/snapshot；Contextus Store 负责 large payload/index/embedding/runtime cache。Session Commit 里只放 chunk 的 sha256 引用与 code_commit 引用。

**关键调整建议**：不要把"Git 是底层实现"当成 Contextus 的核心定义。应该是"Contextus 采用 Git 的 immutable commit/ref/branch/checkout 哲学，并与 Git Repository 双向绑定"。真正不可替代的是 `Session = Commit-like State`，而不是 `Session = 某个 Git commit SHA`。两个概念一定要分开——未来换 Rust Object Store 不影响模型。

---

## Claude 能力边界讨论（ChatGPT 建议原文要点）

Claude 已经支持 fork，官方 Cookbook 支持从指定 message 分叉：`fork_session(..., up_to_message_id=...)`（创建新 session ID，原 session 不变）。所以不能再说"Claude 无法从历史点回溯并继续"——Claude 提供了 history-point fork，但这是 Claude 自己的 Session 机制，不是跨 Agent/跨供应商的统一 Session Graph。（2026-03 的 SDK issue 显示 Python 侧当时尚缺统一参数，能力正在不同 SDK/API 面逐渐补齐。）

因此 Contextus 的价值不在于发明"Session 可以 Fork"（Claude 已有），而在于：

> **把这种能力提升为通用的、跨 Agent 的 Session Graph 基础设施，并把 Chunk、版本、Context、代码状态、Branch、Generation 等统一纳入这个状态模型。**

Claude 的 fork 是一个**功能**；Contextus 是一个 **Session State Model**。这是非常重要的区别。
