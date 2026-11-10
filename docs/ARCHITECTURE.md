# ARCHITECTURE — 四条指导思想 → 宿主真实接缝

本文回答一个问题：**「把 Harness 当作受试变量」在这台宿主上具体用什么实现**，以及
**哪里跟最初设想不一样、为什么**。

出处标记：

- `在跑:` 读在跑宿主（`dsh --version`）的 `lib/**/*.d.ts` 得到 —— **这是契约**。
- `检出:` 读 `deepseek-harness` 源码得到 —— 用来理解**为什么**，不当契约。
- `实测:` 本机跑出来的。

两侧不一致时**以在跑侧为准**。本机两侧**不同线**（在跑 `0.2.2-rc.1`，检出 `dsh-v0.2.1-rc.3`），
实测差异 **11 处**，集中在 `dsh-session-projection`（7）与 `dsh-tools`（4）。

---

## 0. 结论先行

| 原设想 | 落地 | 关键改动 |
|---|---|---|
| ① SUT：Harness 是变量 | **成立**，用 `agentPreset` + `agentOptions` | 不用 `fork`（它继承父对话，污染控制变量） |
| ② 配置即代码：Harness 是个 JSON | **成立**，但**不是自由 JSON** | 改成**封闭词汇表**：工具取自固定目录、故障取自三种模式 |
| ③ Agentic 调度：封装成 Tool-Calling | **成立**，但角色反过来 | 主 Agent 只选**参数**，实验设计不交给模型现编 |
| ④ 旁路观测：Projection 当探针 | **方向对，机制换掉** | Projection **不适合**；真正的探针是 `session/event` 折叠 |

另外挖到两个**原方案里没有、但更好**的接缝：

- **故障注入不该装进 preset，该装在工具的 Scoped 管线上**（§2）—— 一条宿主级监听，按
  `exec.agent` 精确命中受试 session，不碰组合、不怕行序、连孙 agent 都能覆盖。
- **"读子 agent 的日志"这条路在在跑宿主里是被禁的**（§4.1）—— `snapshotEvents` / `eventAt` /
  `ownEvents` 三者都带 `@deprecated … new calls are prohibited`。这不是风格问题。

---

## 1. ① SUT：子 Agent 的装配本来就是启动参数

`ctx.subagents.startActivation(spec)`（`在跑:` `dsh-subagent` d.ts，两重重载与检出同形）。

`spec.request` 里三个字段就是受试变量：

| 字段 | 作用 | 改的是 Harness 的哪一块 |
|---|---|---|
| `agentPreset` | 用**另一份**组合启动子 session | 工具集 + system prompt + persona |
| `agentOptions` | `{provider, model, reasoningEffort, maxTokens}` | 模型路由 |
| `prompt` | 受试任务 | **不是变量，是输入** |

`spawn` provider 的能力位（`检出: packages/subagent/subagent-spawn-in-process/src/index.ts:39-44`）：
`agentOptions` / `agentPreset` / `outputSchema` / `depthLimit` 全 `true`，`inheritsParentContext = false`。
**所以 spawn 是唯一能同时改「工具/人设」和「模型」的后端。**

### 1.1 不能用 fork

`fork` 把父对话前缀种进子 session，且**不接受独立 preset**（`检出: docs/subsystems/subagent.md:130`）。
用它评测等于让「父对话内容」成为第二个自变量。

### 1.2 两个不是变量、但决定外部有效性的东西

1. **子 agent 的审批被钉成 `never`**（`检出: packages/subagent/subagent/src/child-agent.ts:229-234`，
   注释：delegated child 超出委托时固定的 sandbox 范围时，审批**确定性被拒**）。
   → 评测任务不能依赖交互式审批；反过来，「遇到需要审批的操作会怎样」**本身是一个受试特征**。
2. **本机 profile 把 `subagent.maxDepth` 设成 `0`**（实测读
   `~/.dsh/profiles/web/cordis.patch.yml` 的 `subagent` 行）。
   → 模型可见的 `subagent` 工具在本 profile **根本不能派活**。
   而 `startActivation` 是**服务直调**，`resolveMaxDepth` 只影响工具层；直调方自己给
   `request.maxDepth`（`检出: subagent/README.md:49`：直接服务调用方继续提供自己的深度）。
   本插件因此显式传 `maxDepth`，并要求 ≥ 1，**不继承**那个 `0`。
   **这是刻意的**：评测台不能被「生产环境的保守设置」关掉；但也因此必须自己守住上界。

---

## 2. ② 故障注入：装在 Scoped 工具管线上，不装进 preset

### 2.1 先说为什么原方案（往 preset 里塞一行）不好

三条，都是从源码读出来的硬约束：

1. **行序即语义，写反了是整份组合挂不上去**。`tools.restrict()` 会校验名字是不是已知 global tool，
   不认识就抛（`检出: packages/core/tools/src/index.ts:1122-1126`）。所以限制行必须排在工具行**之后**。
2. **组合里提供 root 服务的行会被判泄漏**：`mountPreset` 对 subtree 泄漏到 root realm 的服务抛
   `Preset services require isolate realms`（`检出: packages/preset/agent-preset-registry/src/mount.ts:213`）。
3. **组合只能改「开始时有」什么**，改不了「跑起来之后」的行为。延迟、间歇性失败这类
   **时变故障**，静态行表达不了。

### 2.2 正确的接缝：三个 Scoped waterfall 都带 `exec.agent`

`在跑:` `dsh-tools` d.ts / `检出: packages/core/tools/src/index.ts:143-199`，四个工具事件全部
`Scoped<ToolRuntime>` 且参数里有 `exec.agent`：

| 事件 | 模式 | 用它做什么故障 |
|---|---|---|
| `tools/pre-execute` | waterfall，返回 `allow`/`deny`/`cancel`/`ask` | **`deny`**：工具不存在 |
| `tools/execute` | around-dispatch，可换 `signal` | **`latency`**：结果晚到（`signal` 仍被 registry 重新融合，撤不掉的取消权） |
| `tools/post-execute` | waterfall，返回 `accept`/`block` | **`fail`**：工具"跑了但失败"，`block` 把纠正性反馈变成错误结果 |
| `tools/result` | emit，只读 | 不在本仓用（它是 `@deepseek-ai/dsh-scope` 的 scope 派发，用来按 session 归属做观测也可以） |

`@deepseek-ai/dsh-scope` 的语义：**未打标签的监听器是全局的**，打在某个 scope 上的只收那个 scope 的
（`检出: packages/core/scope/README.md`「Route scoped events」）。
→ 插件在根 ctx 注册一条全局监听，内部按 `exec.agent.id` 查「这个 session 是不是受试体」，
命中才注入。**闲置时成本是一次 Map 查找**，对任何其他 agent 的行为**零改动**。

### 2.3 三种故障是三个**不同的实验**，不是同一个设置的三个档

这一条必须写进任何使用本文的人脑子里：

| 模式 | 受试体看到 | 测的是什么 |
|---|---|---|
| `deny` | 工具**不存在**（schema 里没有） | 能力缺失下的**绕路能力** |
| `fail` | 工具存在、调用返回错误 | **错误处理与恢复** |
| `latency` | 工具存在、结果晚到 | **耐心、重试、超时意识** |

把 `deny` 当成「工具坏了」是最常见的误用：它测的是完全不同的东西。

### 2.4 一条纪律：不改写真实失败

`fail` 的实现**先看原结果**：已经是错误就原样放行（`gate.ts`）。
理由：注入的刺激不能**掩盖**真实缺陷 —— 否则「工具自己坏了」会被记成「我们注入的坏」，
而前者才是要上报的东西。

---

## 3. Harness 是「封闭词汇表」，不是自由 JSON

### 3.1 原设想哪儿不对

「主 Agent 听懂人类意图 → 组装 Harness JSON → 调工具」把**实验设计的正确性**押在
模型每次都能正确生成嵌套 JSON 上。而且它的失败是**静默**的：

```
{"deny": ["wite"]}       ← 不报错，只是让故障注入什么都不做
```

于是你得到一组**看起来跑过了**的干净数据。**最坏的一类实验结果是"看起来有效的空结果"。**

### 3.2 改成什么

`harness` 参数全部是枚举或受校验的列表，取值来自本仓的注册表（[src/catalog.ts](../src/catalog.ts)）：

```text
tools:    ['fs', 'fs-search', 'pwsh', 'bash', 'todo', 'web', 'present']   ← 目录键，未知键直接报错
persona:  native | terse | verbose | pair-programmer | custom
faults:   [{ tool, mode: deny|fail|latency, message?, latency_ms? }]
provider/model:  成对出现或都不出现
max_depth:       ≥ 1
```

`normalize()` 会拒绝：未知工具键、空工具集（要消融必须显式传空之外的写法）、
同一工具的**矛盾故障**、`latency_ms` 用在非 latency 模式、provider/model 只给一半、`max_depth < 1`。

**判据**：枚举错不了，自由 JSON 会错；而且枚举让「同一份 Harness」能被两个独立 trial 复现 ——
这正是「控制变量」的前提。

### 3.3 一个被否掉的更省事做法：克隆基线 preset

想过「读 `agentPresets.readDocument(base)` 拿 YAML → 改几行 → 挂回去」。
**不通**：那个 read 是给**展示**用的，`!!js` 条件以文本形态出现、求值后形态不保留，
而且官方明确「nothing accepts YAML back」（`在跑:` `dsh-agent-preset-registry` README）。
拿它当输入会**静默改变组合**。

所以 Harness **自己声明行**（[src/preset-rows.ts](../src/preset-rows.ts)）：
persona 行（当变体要求时）在前，工具行按目录键展开在后。**行序由这一处拥有**，调用方无从写错。

### 3.4 挂载的五条硬约束（都抛错，不警告）

`检出: agent-preset-registry/src/definition.ts:18-39`、`mount.ts:204-216`、`index.ts:84`：

| 约束 | 踩中的样子 |
|---|---|
| 每行必须有非空字符串 `name` | `row 3 names no plugin` |
| group 行必须 `group: true` + `config: [...]` | `group X must hold a list of plugin rows` |
| 任一 enabled 行 import/activate 失败 → **整份 mount 抛** | 一行写错，整份 Harness 不可用（这**正好**对：坏 Harness 不该被当成低分 Harness） |
| 子树向 root 泄漏服务 → 抛 | `Preset services require isolate realms` |
| preset `id` 全局唯一 | `Duplicate agent preset` |

`id` 那条决定了 **preset id 必须按 run 命名**（`bench-<runId>`），否则并发的第二次 run 直接失败。

### 3.5 返回值是句柄，不是散文

工具返回 `{ runId, harnessId, recordPath, trials, completed, outcomes[] }`（`output.schema`）。
不返回「跑完了，平均 3.2 次工具调用」——散文返回值无法被脚本消费，
而且**顺手算均值会把统计口径藏进插件里**，而口径是可变的（见 §5）。

---

## 4. ④ 旁路观测：真正的事件探针，不是 Projection

### 4.1 先撞墙：读日志的那三个 API 在在跑宿主里是**禁用的**

`在跑:` `dsh-session` d.ts，`Session` 上：

```
eventAt()        @deprecated … new calls are prohibited
snapshotEvents() @deprecated … new calls are prohibited
ownEvents()      @deprecated … new calls are prohibited
```

同一段注释指向官方 Agent Note：`2026-09-09-deprecate-synchronous-session-event-reads.md`。

**这不只是"旧了"**：三个一起被禁，说明宿主认的读法是**折叠已提交事件**，不是事后翻日志。
最初我写的 `summarize(session.snapshotEvents())` 因此整个推翻。

### 4.2 为什么**不用** Projection 单元

原设想是「用原生 Projection 单元当探针」。逐条核完之后，它在这里是**错的工具**：

1. **它要 zod schema，而 zod 有两个实例**。`ProjectionDefinition.stateSchema: ZodType`，
   而 `dsh-session-projection` **自带嵌套 `node_modules/zod@4.4.3`**，宿主顶层是 **4.6.7**
   （`实测:` 目录核对）。递一个外来 schema 实例进去是**静默失败面**，而失败的样子是「没有记录」。
2. **host-only 单元收不到事件级推送**。`onEventChanged` 的注释写明它只报
   **client-visible** 单元的视图变化（`在跑:` d.ts）。所以「host-only 更干净」是错的 ——
   干净到自己也收不到。
3. **它是给客户端看的整值读模型，不是给探针用的钩子**。Projection 的语义是
   「每个已提交事件驱动每个单元、返回同一引用表示无关」，产出是**可发布的会话状态**；
   而本仓需要的是「跑到结束读一次、读完就扔」的一次性折叠，出自同一个进程。

**所以**：本仓用 `ctx.on('session/event')` 自己折叠（[src/observe.ts](../src/observe.ts)），
按 session id 布防/撤防。等哪天要**给 UI 做实时评测面板**，那才是同时注册一个 projection 的时机 ——
记录本身不依赖它。

> 这条值得单独记：**「原生的」不等于「合适的」**。Projection 是原生接缝、写起来也漂亮，
> 但它的三条硬性质（zod 实例、client-visible 门槛、发布语义）每一条都跟探针的用法冲突。

### 4.3 折叠的边界是硬的

| 特征 | 在进程里算吗 | 依据 |
|---|---|---|
| turn/step 数、工具调用数、按工具名的错误数、未应答调用 | **算** | 事件里直接有 |
| token（`assistant/message.data.usage` 累加） | **算，但缺失要记成缺失** | `usage` 可选；把「适配器没说」记成 0 会让省略 usage 的路由看起来无限便宜 |
| 「报了错还不如自己说成功」 | **只记两个原始事实** | 记 `lastToolErrorCode` 与 `finalText`，判定留给外部 |
| 「答案对不对」 | **不算** | 需要标准答案 / 评分器 |

最后两行是**硬边界**：进程里一旦开始做语义判断，同一份日志换个人重算就得到不同数，
「确定性特征提取」这个前提就没了。

### 4.4 数据出口只有两个函数

`openRun(root, meta)` / `append(record)`（[src/record.ts](../src/record.ts)）。
没有查询、没有聚合、没有统计。**导出面一旦有 API，就会有人往里加 `mean()`。**
把聚合挡在仓外是纪律，不是偷懒。

一次 run 的磁盘形状：

```
<outputRoot>/<runId>/
  run.json        # { runId, startedAt, taskId, note, recordSchema: 1 }
  trials.jsonl    # 每 trial 一行
```

`openRun` 用 `flag: 'wx'` 建 `trials.jsonl`：**同目录第二次 run 直接失败**。
理由：静默追加会把两个实验混进一个「还能正常解析」的文件里。

---

## 5. 能力面

| 面 | 形态 | 阶段 |
|---|---|---|
| `run_benchmark` | 工具：任务 + 受控 Harness + trial 数 → 结构化句柄 | **MVP** |
| `session/event` 折叠 | [src/observe.ts](../src/observe.ts)，按 session 布防 | **MVP** |
| 工具管线故障注入 | [src/gate.ts](../src/gate.ts)，三种模式 | **MVP** |
| JSONL 导出 | [src/record.ts](../src/record.ts) | **MVP** |
| 后台任务版（`ctx.jobs.start`） | 长跑用，取消权转给任务自己 | 后续 |
| 自由 `EntryOptions[]` 逃生口 | 给人和脚本用，默认不对模型暴露 | 后续 |
| 评测面板（Projection + 客户端槽） | 只做展示，不影响记录 | 后续 |

### 5.1 后台通道为什么是第二步

一个 trial 是一次完整子 agent 跑动，可能几分钟；N 个 trial 串起来会撞工具执行上限。
原生解法是 `ctx.jobs.start`（`检出: docs/cookbook/adding-a-tool.md:53-55`），但它多一层生命周期：
**一旦 `jobs.start()` 发布 id，取消权就从 `exec.signal` 转给任务自己**（`job_kill` / owner dispose）。
先把「参数 → 子 agent → 记录」跑对，再加通道。

### 5.2 并发

`isConcurrencySafe: () => false`。gate 与 collector 都按 session 键控，并发**逻辑上**是对的，
但一次 run 会挂载一份 preset、写一个文件；让一次调用独占 bench 更容易推理。

---

## 6. 真机验证（**不属于** `pnpm run check`）

`pnpm run check`（typecheck + build + 32 个单测）全绿**只证明**：类型对、模块能打、纯函数对。
它**不证明**这个插件在宿主里真的能拉起一个子 agent —— 那是下面这几步，必须人工跑。

1. 装进 profile（`plugin_manager install_bundle`，包目录绝对路径）。
2. **真的拉起一个子 agent**：最小任务跑 1 个 trial，确认
   ① 子 session 真的起来了（`list_agents` 或会话列表里出现）② 记录文件里有一行
   ③ 该行的 `trace` **不是 null**、且 `toolCalls` 不是 0（全 0 = 折叠没接上，最常见的假绿）。
3. 换一个 Harness 再跑一次：同任务下两次的 `harness.id` 必须**不同**、特征有差异。
   **若两次一模一样，说明 Harness 参数没被用上**（假绿 No.2）。
4. 装一个故障：`faults: [{tool:'write', mode:'fail'}]`，确认记录里 `byTool.write.errors > 0`。
   **若为 0，说明 gate 没命中**（假绿 No.3）。
5. 跑完确认没有残留：`agentPresets.list()` 里不该多出 `bench-*`。

**第 2③、3、4 步是假绿探测器** —— 它们比「命令退出码 0」有用得多。
