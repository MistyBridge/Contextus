# Contextus API 文档 v1

> 2026-08-14 · 覆盖当前项目（MVP M0~M4）的全部对外接口
> 受众：前端工程师（对接 server 层）、核心工程师（维护）
> 约定：`cwd` = twin 仓库根目录（绝对路径，Windows 反斜杠）；错误一律抛异常（CLI 侧打印后以非零码退出）

---

## 1. 接口总览

Contextus 当前有两类对外接口：

| 接口 | 形态 | 用途 |
|------|------|------|
| **CLI 命令** | `sm <command>`（tsx 开发 / 编译后 node dist） | 人工操作与脚本 |
| **核心库 API** | `src/*.ts` 的 export（TypeScript） | server 层与 UI 直接复用，**类型共享、契约零重复** |

未来 server 层（Fastify）将把核心库包装为 JSON API + SSE——前端**不要直接调 CLI 子进程**，通过核心库或 server 层访问。

---

## 2. CLI 命令参考

### 2.1 Twin 模式（在 twin 仓库内执行，操作当前 cwd）

| 命令 | 参数 | 语义 | 示例 |
|------|------|------|------|
| `sm twin-init` | — | 启用 Twin：建 `.contextus/` 结构、写入隔离四层权限（`.claude/settings.json` deny）、排除锁/索引、同步 CLAUDE.md、信任检测警告。幂等 | `sm twin-init` |
| `sm ask "<问题>"` | prompt | 无头执行一轮（自动化路径）：规则增量注入 → `claude -p --resume` → 轮后自动提交 | `sm ask "重构 foo"` |
| `sm ui` | — | 启动 TUI（ink）：树浏览、选中节点开交互窗口、监控自动提交 | `sm ui` |
| `sm find <commit>` | sha | 代码提交 → 产生它的会话；无尾注 = 「非会话提交」 | `sm find a797487` |
| `sm diff <节点A> <节点B>` | uuid×2 | 两个会话的代码世界 diff（排除 .contextus） | `sm diff 85457a02 6c593975` |
| `sm tree` | — | 会话树（世界线分组、孤儿标记、commit 缩写） | `sm tree` |
| `sm status` | — | HEAD 分支/世界线 tip/世界线列表/工作区状态 | `sm status` |
| `sm checkout <节点\|世界线名\|last>` | — | 查看模式：代码世界回退（.contextus 工作区保留）、detached、不建线不提交 | `sm checkout 85457a02` |
| `sm rename <新名称>` | ≤20 字 | 改当前世界线 tip 的 commit 名称（仅 tip；审计日志 + 索引更新） | `sm rename "修复登录"` |
| `sm drop <世界线>` | — | 废弃世界线（删 heads+context 双 ref；节点仍可索引；使用中拒绝） | `sm drop exp-a` |
| `sm policy set "<条目>"` | 一条规则 | 追加规则条目 + 同步 CLAUDE.md 区块（O(1)，随下轮提交入库） | `sm policy set "输出用英文"` |
| `sm policy show` | — | 输出当前规则（条目编号） | `sm policy show` |
| `sm policy log` | — | 规则文件的 git 版本历史 | `sm policy log` |

### 2.2 独立 store 模式（实验/回归用，`--store` 指定仓库）

| 命令 | 参数 | 语义 |
|------|------|------|
| `sm list` | — | 列出 `~/.claude/projects` 下全部会话文件 |
| `sm tree <sid>` | 会话文件 ID | 显示会话记录树 |
| `sm branch <sid> <节点> "<问题>" [--branch 名]` | 节点 = 数字/uuid/last | 从节点物化新会话并执行，回写 store |
| `sm exec <sid> "<问题>"` | — | 会话文件上继续并回写 |
| `sm import <sid\|路径> [--branch 名]` | — | 会话导入 store（幂等） |
| `sm check <sid> <节点>` | — | 物化一致性校验（store vs JSONL 祖先链逐 uuid） |

### 2.3 全局选项

| 选项 | 语义 |
|------|------|
| `--store <目录>` | 独立 store 仓库位置（默认 `./store`，可 `CONTEXTUS_STORE` 环境变量） |
| `--help` | 用法 |

---

## 3. 核心库 API（按模块）

### 3.1 `src/paths.ts` — 路径与环境

| 导出 | 签名 | 语义 |
|------|------|------|
| `CLAUDE_PROJECTS` | `string` | Claude 会话根目录 `~/.claude/projects` |
| `encodeCwd` | `(cwd: string) => string` | cwd → 项目目录名：**每个非字母数字字符 → 一个 `-`**（实测规则；错误则 `--resume` 找不到会话） |
| `resolveStoreDir` | `(flag?: string) => string` | store 定位：flag > 环境变量 > `./store` |

### 3.2 `src/records.ts` — 会话记录

| 导出 | 签名 | 语义 |
|------|------|------|
| `Record` | interface | Claude JSONL 行（type/uuid/parentUuid/sessionId/cwd/promptId/message…，全可选） |
| `loadRecords` | `(text: string) => Record[]` | 逐行解析 JSONL（忽略空行） |
| `readSessionFile` | `(file: string) => Record[]` | 读会话文件 |
| `isQuestion` | `(rec: Record) => boolean` | 是否用户提问（`<` 前缀 = 本地命令伪消息 → false；tool_result → false） |
| `questions` | `(records: Record[]) => Record[]` | 按 promptId 去重的提问列表（编辑重试只取首次） |
| `preview` | `(rec: Record, limit=60) => string` | 记录摘要（展示/命名用） |
| `ancestorPath` | `(byUuid, targetUuid) => Record[]` | 沿 parentUuid 回溯，返回时间序链（含目标） |
| `splitRounds` | `(records: Record[]) => Record[][]` | 按提问切分回合（非 user/assistant 记录被跳过） |

### 3.3 `src/git.ts` — git 封装

| 导出 | 签名 | 语义 |
|------|------|------|
| `git` | `(args, cwd, {allowFail?}) => string` | 子进程执行 git；失败抛异常（allowFail 时返回空） |
| `catFileBatch` | `(cwd, refs: string[]) => string[]` | **批量读对象**（`<sha>:<path>` 行输入，一次进程；字节级解析）——性能关键路径 |

### 3.4 `src/claude.ts` — Claude Code 执行对接

| 导出 | 签名 | 语义 |
|------|------|------|
| `resolveClaude` | `() => Launcher` | 定位启动方式：优先原生二进制 `@anthropic-ai/claude-code/bin/claude.exe`，兜底 cli.js/.cmd |
| `runClaude` | `(sid, prompt, cwd) => number` | 无头一轮 `claude -p --resume`（stdio 继承；返回退出码） |
| `runClaudeFresh` | `(prompt, cwd, capture?) => {rc, stdout, stderr}` | 新会话直跑（capture=true 捕获输出） |
| `spawnTerminal` | `(cwd, sid, onError?) => string` | **开真实终端窗口**交互式 `claude --resume`（临时 bat：chcp 65001 + cd + claude；wt 优先/cmd start 兜底）；返回启动命令描述 |

### 3.5 `src/log.ts` — 运行日志（审计轨迹，只增不改）

| 导出 | 签名 | 语义 |
|------|------|------|
| `LogEvent` | interface | `{ts, event, ...fields}` |
| `logFile` | `(cwd) => string` | 日志路径 `.contextus/logs/runtime.log` |
| `ensureLog` | `(cwd) => void` | 确保日志文件存在 |
| `logEvent` | `(cwd, event, fields?) => void` | 追加一条事件（事件类型见 §6） |

### 3.6 `src/sessions.ts` — 会话状态模型

| 导出 | 签名 | 语义 |
|------|------|------|
| `Session` | interface | 见 §4 |
| `sessionFile` | `(cwd, nodeUuid) => string` | session 文件路径 |
| `writeSession` / `readSession` | — | 写/读 session.json（读失败返回 null） |

### 3.7 `src/policy.ts` — 策略 Chunk（规则）

| 导出 | 签名 | 语义 |
|------|------|------|
| `POLICY_NAME` | `"project_policy.md"` | 规则文件名 |
| `policyPath` | `(cwd) => string` | 规则文件路径 |
| `readPolicyWorktree` | `(cwd) => string[]` | 工作区规则条目（无文件 = 空） |
| `readPolicyAt` | `(cwd, sha) => string[]` | 某 commit 的规则快照 |
| `policyHash` | `(entries) => string` | 条目集哈希（session.chunks_hash 用） |
| `entryDiff` | `(base, target) => RuleDelta` | 条目级 diff：相似度序列对齐（LCS），相似行配对为「修改」 |
| `buildRuleInjection` | `(cwd, baseSha) => string \| null` | **纠错注入文本**：修改=【规则更新】新文+【禁止】旧文；删除=【规则禁止】旧文；纯新增/无差异 → null（v3.2 双通道） |
| `policyAppend` | `(cwd, entry) => void` | 追加规则 + 同步 CLAUDE.md |
| `syncRulesToClaudeMd` | `(cwd) => void` | **生效通道**：规则全文同步进 CLAUDE.md 标记区块（system prompt，不可见但生效） |

### 3.8 `src/twin.ts` — Twin 核心（最大模块）

| 导出 | 签名 | 语义 |
|------|------|------|
| `twinInit` | `(cwd) => void` | 启用 Twin（幂等） |
| `hasTrust` | `(cwd) => boolean` | `~/.claude.json` 中该目录是否已接受信任 |
| `isTwin` | `(cwd) => boolean` | 是否已启用 |
| `acquireLock` | `(cwd) => () => void` | 取并发锁（返回释放函数；占用/过期逻辑内置） |
| `loadIndex` | `(cwd) => Map<string,string>` | uuid2commit 索引（派生缓存，工作区文件，可重建） |
| `rebuildIndex` | `(cwd) => Map<string,string>` | 从 git 历史全量重建索引 |
| `tipSession` | `(cwd, branch) => Session \| null` | 世界线 tip 的会话（git 视角读取） |
| `writeJsonl` | `(sid, chain, cwd) => string` | 物化：祖先链 → 新会话文件（路线 B 格式），返回文件路径 |
| `deltaRecords` | `(cwd, sid, idx) => Record[]` | 会话文件中的未入库记录（免疫 compaction） |
| `commitDelta` | `(cwd, {sid, branch, prompt, records, idx, decision, anchorNodeUuid?, rc?}) => CommitResult \| null` | **提交原语**：写 records/session → commit（名称≤20字+尾注）→ 双 ref 前进 → 索引更新；无提问的增量不创建节点；空记录返回 null |
| `askTurn` | `(cwd, prompt) => number` | 无头一轮（规则注入 → claude → 提交） |
| `materializeNode` | `(cwd, node: Session, tip: boolean) => Record[]` | 物化节点完整上下文（git 历史全量 + live 文件合并；tip 用 live 文件尾确定轮末） |
| `listSessions` | `(cwd) => Session[]` | **全部会话节点**（唯一不变索引 = git 历史；孤儿节点在内；会话内 tip 指纹缓存） |
| `worldlines` | `(cwd) => string[]` | 世界线名（refs/context） |
| `autoBranchName` | `(cwd, parent) => string` | 新世界线命名 `<parent>-2/3…` |
| `commitOf` | `(cwd, nodeUuid) => string \| null` | 节点 → commit（= code_after 索引派生） |
| `sessionOfCommit` | `(cwd, sha) => Session \| null` | commit → 会话（尾注 Node；无 = 非会话提交） |
| `diffSessions` | `(cwd, nodeA, nodeB) => string` | 双会话代码 diff（排除 .contextus） |
| `checkoutView` | `(cwd, target) => {commit, label}` | 查看模式（代码回退 + detached；target = uuid/世界线名/last） |
| `renameTip` | `(cwd, newSubject) => {before, after, nodes}` | tip 改名（amend + 索引局部更新 + 审计） |
| `dropWorldline` | `(cwd, branch) => {tip}` | 废弃世界线（双 ref 删除 + 审计；使用中拒绝） |
| `syncInstruction` | `(histSha, latestSha) => string` | T8 同步指令文本（注入载体由调用方构造） |
| `ruleInjectionRecord` | `(cwd, baseSha, sid, parentUuid) => Record \| null` | 规则纠错注入记录（assistant 类型） |
| `lastRecordUuid` | `(cwd, sid) => string \| null` | live 文件最后记录 uuid |
| `appendToSession` | `(cwd, sid, rec) => void` | 记录追加到 live 文件 |
| `watchSession` | `(cwd, state: WatchState, onCommit) => {stop}` | **提交监控**：2s 轮询，检测第二条新提问 → 提交上一轮；stop()（窗口关闭）→ 提交最后一轮 |

### 3.9 `src/store.ts` — 独立 store 模式（M0）

| 导出 | 签名 | 语义 |
|------|------|------|
| `findSessionFile` | `(sid) => {file, cwd} \| null` | 全局搜索会话文件并读其 cwd |
| `ManifestEntry` | interface | 会话清单条目 |
| `Store` | class | `exists/init/open/uuidCommit/manifestOf/importClaudeFile/materialize` |

### 3.10 `src/ui.tsx`

| 导出 | 签名 | 语义 |
|------|------|------|
| `runUi` | `(cwd) => void` | 启动 TUI（需先 twin-init） |

---

## 4. 数据模型

### 4.1 Session（`.contextus/sessions/<node_uuid>.json`）

| 字段 | 类型 | 语义 |
|------|------|------|
| `node_uuid` | string | 节点 ID = 该轮提问记录的 uuid（对外标识，树键） |
| `parent_uuid` | string \| null | 树边 = 提问记录的 parentUuid |
| `root_uuid` | string | 世界线根节点（tip 传递，O(1)） |
| `branch_id` | string | 世界线 = refs/context/<branch_id> |
| `decision` | `"initial"\|"continue"\|"fork"\|"failed"` | 轮类型 |
| `anchor_node_uuid` | string \| null | fork 锚点 |
| `claude_session_id` | string | 执行层 JSONL 文件 ID（同文件多轮同值） |
| `chunks_hash` | string \| null | 生效规则哈希（提交时工作区快照） |
| `code_before` | string | 父 commit（提交前已知）；**code_after 由索引派生，不存储**（自引用无法写入） |
| `user_input` | string | 该轮提问原文 |
| `created_at` | string(ISO) | 创建时间 |

### 4.2 其他类型

- `Record`：Claude JSONL 行（`type/uuid/parentUuid/sessionId/cwd/promptId/message{role,content}`，全可选）
- `CommitResult`：`{sha, records, node}`
- `WatchState`：`{sid, branch, firstDecision, anchorNodeUuid}`
- `RuleDelta`：`{adds, updates[{old,next}], removes}`
- `LogEvent`：`{ts, event, ...fields}`

---

## 5. 文件系统布局

```
<repo>/.contextus/
├── records/<seq>-<uuid>.json    # 每轮记录（git 历史 = 唯一不变索引）
├── sessions/<node_uuid>.json    # 会话状态（随轮 commit）
├── logs/runtime.log             # 审计日志（随轮 commit，只增不改）
├── index/uuid2commit.json       # 派生索引（不入库，可全量重建）
├── Chunks/project_policy.md     # 规则（条目化，git 历史 = 版本）
└── .lock                        # 并发锁（不入库，过期自愈）

<repo>/CLAUDE.md                 # 规则生效通道（标记区块，system prompt 注入）
<repo>/.claude/settings.json     # 隔离四层 deny（twin-init 写入）
<repo>/.git/refs/heads/*         # 代码世界分支（Contextus 提交推进）
<repo>/.git/refs/context/*       # 世界线（同一 commit 同步前进）

~/.claude/projects/<cwd编码>/<sid>.jsonl   # Claude Code 执行层会话文件
<project>/store/                 # 独立 store 模式仓库（M0 实验/回归）
```

---

## 6. 审计事件（runtime.log）

| event | fields | 触发 |
|-------|--------|------|
| `twin_init` | — | twin-init |
| `turn_start` | branch, code_before, prompt | 每轮开始 |
| `turn_end` | rc | 每轮结束 |
| `commit` | decision, node, records | 每次提交（先写后提交，sha 由 Node 尾注/索引派生） |
| `rename` | branch, before, after, subject, nodes | tip 改名 |
| `drop` | branch, tip | 世界线废弃 |
| `policy_set` | entry | 规则追加 |
| `window_spawn` | sid, branch, cmd | 交互窗口打开 |
| `error` | msg | 异常 |

---

## 7. 前端功能 → 建议接口映射（server 层设计参考）

| UI 功能 | 核心库入口 | 备注 |
|---------|-----------|------|
| 世界线树 | `listSessions` + `worldlines` + `tipSession` + `commitOf` | 数据已含 tip/孤儿/父子结构；会话内缓存，直接轮询也便宜 |
| 节点详情 | `listSessions` 对应项 + `commitOf` | code_after = commitOf 派生 |
| 进入节点 | `materializeNode` + `writeJsonl` + `spawnTerminal` + `watchSession` | 非 tip 需先建世界线（branch + update-ref + 路径回退 + symbolic-ref，见 twin.ts 逻辑） |
| 代码 diff | `diffSessions` | 输出 raw diff 文本，前端用 diff 渲染库 |
| 双向追溯 | `sessionOfCommit` / `commitOf` | — |
| 规则管理 | `readPolicyWorktree` / `readPolicyAt` / `policyAppend` / git log 该文件 | 版本历史 = git log |
| rename/drop | `renameTip` / `dropWorldline` | 均带审计日志 |
| 实时提交状态 | `watchSession` 的 onCommit 回调 → SSE | — |
| 审计时间线 | 读 runtime.log + git log | — |
| token 统计 | 会话文件 usage 字段（records 中） | 前端或 server 聚合 |

---

## 附录：变更记录

- v1（2026-08-14）：初版，覆盖 MVP M0~M4 全部接口。
