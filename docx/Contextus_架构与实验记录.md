# Contextus — 架构设计与实验记录

> 树形会话信息管理系统。以 Claude Code 为执行后端，仅接管其上下文管理（存储 / 历史选取 / 分支）。
>
> 文档状态：实验阶段结论（Claude Code v2.1.197，2026-08 实测）
> 验证环境：Windows 11 / Git Bash / Python 3 / 无头 CLI (`claude -p --resume`)

---

## 1. 项目目标

以 Claude Code 为"示范与后端"，自研树形会话信息管理系统。核心诉求：

1. 会话历史呈树形，可从**任意节点 c** 分支继续提问（a→b→c→d，回到 c 再问 e）
2. 分支后的会话携带 c 处的完整上下文
3. 取代 Claude Code 的上下文管理，但**复用其执行引擎**（工具链 / 权限 / MCP / skills / 系统提示词组装）

---

## 2. 核心架构决策

### 2.1 Claude Code 上下文机制的五层拆解

| 层 | 环节 | 归属 | 说明 |
|----|------|------|------|
| 1 | 会话存储 | **Contextus（可替换）** | JSONL 只是载体；可换成 git / 数据库。本实验沿用 JSONL 格式 |
| 2 | 会话恢复 | Claude Code | `--resume` 读文件重建状态——但**读哪个文件、文件里有什么**由我们控制 |
| 3 | **历史选取（分叉）** | **Contextus ✅ 核心接管** | 原机制只能线性续聊 / 整段 fork；我们在任意会话的任意节点分支——原有入口不存在的能力 |
| 4 | 提示词组装 | Claude Code | system prompt、CLAUDE.md、tools、compaction、缓存断点——恢复时自动重建 |
| 5 | 执行引擎 | Claude Code | 工具循环、权限、MCP、skills 原封不动 |

**一句话总结**：我们接管了"模型看到哪些对话内容"的决定权；"内容如何变成 API 请求、如何执行"仍是 Claude Code 的。这是产品切入口——上下文管理是可独立替换的模块，执行引擎（最难复制）留在原地。

### 2.2 三条技术路线对比

| 路线 | 方式 | 分支点 | 结论 |
|------|------|--------|------|
| A：官方 flag | `claude -p --resume <id> --fork-session` | 仅会话**末尾** | 不可用：不支持任意节点 |
| B：伪造会话文件 | 提取祖先链 → 写新 JSONL（新 sessionId）→ `--resume` | **任意节点 ✅ 已实测** | **选定**：保留完整工具链 |
| C：直接调 API | 祖先链 → messages + `cache_control` | 任意节点（脚本已实现） | 备选：跨分支缓存可控，但工具链要自建 |

### 2.3 "完美无损替换"的边界

- **数据/历史层面**：可无损。git 内容寻址 + reflog；若把全部记录类型入库，物化时可字节级重放。
- **运行时行为层面**：做不到 100%，三处损耗均来自"分支应以当前环境执行"的语义本身：
  1. system prompt 按**分支时刻**的 CLAUDE.md / settings / skills 重建（预期行为）
  2. 运行态不迁移：compaction 摘要、prompt cache、活动 hook/daemon（harness 运行时，不在文件里）
  3. 会话文件格式是**行为实验结论**，非官方契约（升级需回归测试）

---

## 3. 会话数据格式（JSONL）

位置：`~/.claude/projects/<cwd编码>/<sessionId>.jsonl`，每行一条 JSON 记录。

### 3.1 记录类型（实测观察）

| type | 含义 | 处理 |
|------|------|------|
| `user` / `assistant` | 对话记录（含 tool_result / tool_use） | **保留** |
| `mode` / `permission-mode` | 会话与权限模式 | 物化时补在文件头 |
| `attachment` | 环境快照（技能列表 / 工具列表 / 任务提醒） | 过滤 |
| `system` | 每轮耗时等 | 过滤 |
| `file-history-snapshot` / `ai-title` / `last-prompt` / `summary` | 元数据 / 压缩摘要 | 过滤（summary 待实验，见 §9） |

### 3.2 树结构：uuid / parentUuid

- 每条记录有 `uuid` 与 `parentUuid`，构成会话树；分支 = 追加新记录、新节点 `parentUuid` 指向 c。
- **`uuid` 是行级 ID，`message.id` 才是消息级 ID**：一条 assistant 回复拆成多行（thinking → text → tool_use），共享同一 `message.id`，归组必须按 `message.id` 而非行。
- **同一提问被编辑重试会记录多次**（实测同一 promptId 出现 4 行，各自新 uuid）；识别"同一轮提问"按 `promptId` 去重，必要时加文本相似度兜底。
- `tool_use` 的 `id` 与后续 `tool_result` 的 `tool_use_id` 一一配对；祖先链截断时若分支点落在回合中间，必须保证配对完整。

### 3.3 关键事实

- **system prompt 不在 JSONL 里**——harness 运行时组装，`--resume` 时自动重建。这既是特性（工具链白嫖）也是边界（不可定制缓存前缀）。
- 每条 assistant 消息含完整 `usage`（input / cache_read / cache_creation / output tokens）——**无头运行同样写入**，这是缓存实验的数据来源。

---

## 4. 已验证方案：会话文件伪造 + `--resume`（路线 B）

### 4.1 原理

```
分支 = 提取节点 c 的祖先链（沿 parentUuid 回溯到根）
     → 只保留对话记录 + mode/permission-mode 头
     → 写新文件: ~/.claude/projects/<cwd编码>/<新uuid>.jsonl
     → claude -p --resume <新uuid> "新问题"
```

d/e 等"兄弟"消息不在祖先链上，天然被排除；`--resume` 恢复时 Claude Code 自己重建系统提示词与工具链。

### 4.2 实验记录（全部通过）

| 实验 | 结果 |
|------|------|
| 手工伪造会话 `4892f958-...` + `--resume` 提问"对话里第一个问题是什么" | ✅ 正确复述出分支点之前的上下文 |
| `sm.py branch <会话> 3 "总结分支前对话主题"` | ✅ 准确说出"打招呼 + 记忆文件位置"两个主题；返回码 0；新对话自动追加回分支文件 |
| 分支会话**二次恢复**（同文件继续对话） | ✅ 正常（上下文 + 增量追加） |

### 4.3 Windows 环境陷阱清单（全部实测踩中）

| 陷阱 | 现象 | 解法 |
|------|------|------|
| **会话查找是 cwd 作用域** | 在错误 cwd 下 `--resume` 报 `No conversation found` | 文件必须放在 `~/.claude/projects/<当前cwd编码>/`，且在该 cwd 下运行 claude |
| **cwd 编码规则** | 冒号也要编码成 `-`：`C:\Users\admin` → `C--Users-admin`（**双**横线） | `encode_cwd = cwd.replace(":", "-").replace("\\", "-")` |
| 会话文件前几行无 `cwd` 字段 | 读到的 cwd 为空 → 文件落错目录 | mode/permission-mode 行没有 cwd，扫描到第一个非空 cwd |
| subprocess 裸名解析失败 | `FileNotFoundError: [WinError 2]` | `shutil.which("claude")` 得全路径（`...\npm\claude.CMD` 可直跑） |
| **`--debug` 破坏恢复** | 报 `No deferred tool marker found` | 排查 `--resume` 问题时勿用 `--debug`；普通恢复正常 |
| 无头权限被忽略 | `Ignoring 143 permissions.allow entries...` | 该目录须先交互式接受信任（或改 `.claude.json` 的 `hasTrustDialogAccepted`） |

---

## 5. 已验证方案：git 作为存储层（第 1 层替换）

### 5.1 映射关系

| 会话树概念 | git 概念 | 说明 |
|-----------|---------|------|
| 节点 c | commit | 粒度 = **回合**（一次提问 + 完整回复循环 = 一个 commit） |
| parentUuid 链 | commit 父链 | 天然一致 |
| 从 c 分支 | `git checkout -b <新sessionId> <sha>` | **零复制**，内容寻址自动去重 |
| 分支关系 | `git log --graph` | 树可视化白送 |
| 多方案对比 | `git diff` | 两分支上下文差异直接 diff |
| 误操作恢复 | reflog | 天生审计 |
| 回写闭环 | diff 物化文件新增记录 → 新 commit | 执行后同步回库 |
| manifest 记录 | git 历史本身 | 不再需要 |

**两套 ID 分层**：commit SHA（git 内部账本，amend/rebase 会变，不对外暴露）↔ uuid（Claude Code 记录 ID，稳定，对外标识；uuid→commit 索引提供 O(1) 查询，commit message 里也带 uuid 便于 `--grep` 兜底）。

### 5.2 实测性能（demo_git_tree.py，14 回合会话）

| 操作 | git 方案 | JSONL 方案 |
|------|---------|-----------|
| uuid → 节点定位 | **2 微秒**（索引 O(1)） | ~2.5 秒（每次全量解析） |
| 从节点 c 回溯分支 | **~12 毫秒**（checkout） | 需复制祖先链到新文件 |
| 祖先链物化 | **0.23 秒**（只读所需对象） | 2.54 秒 |
| 物化一致性 | ✅ 11 条 vs 祖先链 11 条，逐 uuid 完全一致 | — |

### 5.3 关键陷阱：commit tree 是累积的

`git add -A` 使每个 commit 包含此前所有文件；物化时若遍历每个 commit 的全部文件，祖先记录会被**重复输出**（实测 24 条 vs 正确 11 条）。**物化必须按文件名去重，每个文件只读一次。**

---

## 6. 缓存机制实测

> 数据来源：无头运行写入会话文件的 `usage` 字段。本环境为第三方网关（`cache_creation_input_tokens` 恒报 0，TTL 表现与官方文档不完全一致），结论按实测记录。

### 6.1 会话内命中率：97.9% ~ 100%（真实数据）

本会话第 57~81 次 API 调用实测：

```
调用63: input= 342   cache_read=270720   命中率 99.9%
调用66: input=  63   cache_read=275072   命中率 100.0%
调用80: input= 146   cache_read=315648   命中率 100.0%
调用81: input=5964   cache_read=316032   命中率 98.1%
```

- `cache_read` 随对话单调增长（26.3 万 → 31.6 万），每次调用只付几百 token 的增量（tool_result、新回合）。
- 机制：agentic 循环每轮调用的前缀 = 上一轮 + 增量；harness 在末尾放断点，**同会话内命中天然接近 100%**。

### 6.2 跨分支首轮：miss（实测）

| 实验 | 间隔 | cache_read | 结论 |
|------|------|-----------|------|
| 19:32 分支（读交互会话缓存） | 交互会话活跃几分钟内 | ✅ **命中 16640** | 搭便车：交互会话在自己对话中恰好写下了共享前缀条目；交互一停，TTL 到期即失效 |
| B（A 分支后跑） | ~2 分钟 | ❌ 0 | 当时共享条目已过期 |
| D / E 背靠背（同节点分支） | **~2 秒** | ❌ 0 / 0 | 间隔时间不是变量；无头分支请求**不在共享边界放断点**，没人写共享条目 |

**结论**：跨分支命中**可能**但**不可控、不可依赖**——取决于网关侧条目存活状态（TTL/容量驱逐均为黑盒）。机制推断：缓存条目绑定"会话完整前缀"，分支在 c 之后分道扬镳，就没有条目落在共享边界上可查。

### 6.3 成本模型

```
分支首轮（唯一 miss 点）: 一次性 ~15k tokens 全价 ≈ $0.07（Opus 4.8）/ $0.15（Fable 5）
分支内后续任何长任务:     每轮调用 99.9% 缓存命中，增量价
长任务主要开销:           输出 token（如 30 次调用/回合 ≈ 60k 输出 ≈ $1.5~3）
```

- 策略含义：**少开分支、开了就聊深**（分支开销一次性 ~$0.1）；"每问一句开一个分支"则成本线性累加。
- **想要跨分支确定性命中，唯一路径是路线 C**：断点由我们在共享边界 c 处放置，前缀字节由我们保证一致，内容寻址必然命中。代价是自建工具链。

### 6.4 缓存机制要点（官方文档，自研路线 C 时必守）

- **前缀精确匹配**：前缀任一字节变化，其后所有缓存失效。渲染顺序 `tools → system → messages`。
- 断点 `cache_control: {"type": "ephemeral", "ttl": "5m"|"1h"}`；最多 4 个/请求；Opus 4.8 系最小可缓存前缀 4096 tokens（不足静默不缓存）。
- 定价：写入 5m=1.25× / 1h=2×，读取 0.1×。5m TTL 两次请求回本，1h 需三次。
- **20-block lookback**：断点最多回溯 20 个 content block 找旧条目；长回合须每 ~15 块放中间断点。
- **并行首轮全价**：同一前缀并行发出的请求全部全价（第一个响应开始流式前条目不可读）。工具循环串行无碍，但**并发开多个分支**会互相抢全价。
- 静默失效器清单：system 里插时间戳 / UUID、JSON 序列化顺序不定、工具列表变动、中途换模型。

### 6.5 本环境的黑盒行为（记录备查）

- `cache_creation_input_tokens` 恒报 0（写入量不可观测）。
- TTL 边界不一致：约 15 分钟前的条目可读、17 分钟前不可读。
- 实验教训：**跨 TTL 边界做的缓存对比实验会被污染**——"背靠背 2 分钟 miss"与"19:32 命中"的差异最初被误判为间隔问题，实为条目存活状态问题。

---

## 7. 路线图

| 序 | 事项 | 状态 | 说明 |
|----|------|------|------|
| 0 | 路线 B 核心 + sm.py（JSONL 版） | ✅ 已完成并实测 | list / tree / branch / exec |
| 1 | git 存储并入 sm.py | 待做 | 复用 demo_git_tree.py 已验证逻辑（回合切分 / uuid 索引 / 物化去重 / checkout 分支）；`git worktree` 实现并发分支执行 |
| 2 | `stats` 成本树 | 待做 | 聚合各分支 token 花费与缓存命中率（usage 已在 transcript 中） |
| 3 | `graft` 结论嫁接 | 待做 | 把源分支末轮回复注入目标会话（git cherry-pick 语义） |
| 4 | **`merge` 会话合并** | 待做（旗舰功能） | `[根→b] + 分支1全文 + 分支2全文 + 综合指令` → 新会话。Claude Code 只能分叉不能汇聚，此为其原生做不到的能力；1M 上下文使全文合并可行 |
| 5 | squash 压缩 | 待做（需先补实验） | 旧回合替换为摘要 commit；需验证 `--resume` 接受 summary 记录开头的会话文件 |

---

## 8. 代码资产

| 文件 | 位置 | 功能 | 状态 |
|------|------|------|------|
| `sm.py` | `C:\Users\admin\session-manager\` | 会话管理器：list / tree / branch / exec + manifest | ✅ 可用（JSONL 版） |
| `demo_git_tree.py` | 同上 | git 存储原型：回合切分 / uuid 索引 / 物化 / checkout 分支 | ✅ 已验证 |
| `extract_context.py` | `C:\Users\admin\session_tree_demo\` | 祖先链提取 → Messages API payload（路线 C 原型） | ✅ 可用 |
| `build_session.py` | 同上 | 最早的伪造会话文件实验 | 原型 |
| `manifest.json` | session-manager 下 | 分支关系（parent_id / parent_node_uuid / cwd / 时间） | 随 sm.py 维护 |

测试遗留物（可清理）：`~/.claude/projects/C--Users-admin/` 下的实验会话 `4892f958-...`、`4a11a39e-...`、`91f830dc-...`、`ccbd84b8-...`、`be5fce68-...`、`69bfe32c-...`、`d55374dd-...`（会出现在 `/resume` 列表中）。

---

## 9. 风险与未验证项

1. **格式非契约**：JSONL 记录格式、`--resume` 容忍度、cwd 编码均为行为实验结论。**每次 Claude Code 升级须回归**（建议把 §4.2 实验做成自动化回归脚本）。
2. **summary / compaction 未处理**：超长会话被压缩后出现 summary 记录，祖先链提取在压缩点之前的行为未验证（路线图第 5 项）。
3. **工具配对完整性**：分支点落在回合中间（tool_result 节点）时，物化截断必须保证 tool_use↔tool_result 配对完整，否则恢复失败或上下文错乱。
4. **跨分支缓存 miss**：按"分支首轮可能全价"设计（~$0.1/次）；确定性优化需路线 C。
5. **网关差异**：本环境 usage 报告与官方文档不一致（写入恒 0）；迁移到官方 API 环境后缓存数据需重测。

---

## 附录：一句话结论速查

- 分支任意节点 c：伪造会话文件 + `claude -p --resume`，已验证 ✅
- 存储层换成 git：uuid 索引 2μs、回溯 12ms、物化一致性逐条验证 ✅
- 会话内缓存命中率 99.9%（实测）；跨分支首轮 miss（一次性 ~$0.1）
- 无损边界：数据/历史可无损（git）；运行时语义受"分支以当前环境执行"约束
- 旗舰差异化：merge（会话合并）——Claude Code 原生做不到，git 模型免费解锁
