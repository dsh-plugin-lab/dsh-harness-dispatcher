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
| ② 配置即代码：Harness 是个 JSON | **成立，但形状已改** | 不是自由 JSON，也不是当初的封闭枚举 —— **是一份插件行列表文件**，见 [形状（已定）](../.agents/notes/2026-11-11-harness-shape.md#1-形状已定) |
| ③ Agentic 调度：封装成 Tool-Calling | **成立**，但角色反过来 | 主 Agent 只选**参数**，实验设计不交给模型现编 |
| ④ 旁路观测：Projection 当探针 | **方向对，机制换掉** | Projection **不适合**；真正的探针是 `session/event` 折叠 |

另外挖到两个**原方案里没有、但更好**的接缝：

- **故障注入不该装进 preset，该装在工具的 Scoped 管线上**（见下文「故障注入」）—— 一条宿主级监听，按
  `exec.agent` 精确命中受试 session，不碰组合、不怕行序、连孙 agent 都能覆盖。
- **"读子 agent 的日志"这条路在在跑宿主里是被禁的**（见下文「先撞墙」）—— `snapshotEvents` / `eventAt` /
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

## 3. Harness 的形状（**本节前半已被取代**）

> **⚠ 状态：这一节描述的是「封闭词汇表」，它已被
> [.agents/notes/2026-11-11-harness-shape.md](../.agents/notes/2026-11-11-harness-shape.md) 取代。**
> 现在的形状是**一份插件行列表文件**，跑的时候逐字复制进 run 目录；代码里那个 6 字段枚举
> 降级成捷径（`harness.tools` / `harness.persona` 那几个标量）。
>
> **原文保留不删**，因为它记录了**为什么当初选枚举**（「原设想哪儿不对」那节的静默失败推理），
> 而那个推理后来被证明不成立（判据本身错了，见
> [被推翻的判断](../.agents/notes/2026-11-11-harness-shape.md#4-被推翻的判断保留证据价值) 第 2 行）。
> 保留它是为了**别再犯同一个错**，不是因为它还有效。
>
> 下面「一个被否掉的更省事做法」里的 `readDocument` 断言是**事实错误**，已就地更正。

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

**当时的判据**：枚举错不了，自由 JSON 会错；而且枚举让「同一份 Harness」能被两个独立 trial 复现 ——
这正是「控制变量」的前提。

> **这条判据后来被证明是错的，错在哪值得记住**：枚举防住的只有**拼写**。真正的静默失败是另一类 ——
> 「看起来有效的空结果」（往不存在的工具注入故障、跑了一组其实没施加任何条件的 trial），
> 而它**不是词汇表宽度造成的**。收窄词汇的代价是「你真正想测的东西根本进不来」。
> 治它的是**指纹 + 可观测装配**，不是收窄。见
> [判据三层](../.agents/notes/2026-11-11-harness-shape.md#3-判据三层)。

### 3.3 一个被否掉的更省事做法：克隆基线 preset —— **这条已被推翻**

想过「读 `agentPresets.readDocument(base)` 拿 YAML → 改几行 → 挂回去」，
当时的结论是**不通**：那个 read 是给**展示**用的，`!!js` 条件以文本形态出现、求值后形态不保留，
而且官方明确「nothing accepts YAML back」（`在跑:` `dsh-agent-preset-registry` README）。

**这个结论错了，错法很具体**：把「整份 document 不能回挂」读成了「`plugins` 不能回挂」。
`readDocument` 只 dump `plugins` 数组（`lib/types/index.js:239-250`），用的是 `entryListSchema`，
其中 `JsExpr` 就是 `{ __jsExpr: string }`，并被**原样写回** `!!js`（`cordis-plugin-include/src/index.ts:16-25`）。
`实测:` 往返成立：

```
parsed:  [{"id":"b","name":"@x/y","disabled":{"__jsExpr":"process.platform === 'win32'"}}]
dump →   disabled: !!js process.platform === 'win32'
roundtrip equal: true
```

「求值后形态不保留」恰恰是**要的**：重新挂载就该重新求值。
所以 `dump → 改 → 挂回去` 这条路是通的，它现在就是 `harness_export` 的依据（见
[落地状态](../.agents/notes/2026-11-11-harness-shape.md#6-落地状态) 第 7 项）。

**代码现状**：捷径从 [src/catalog.ts](../src/catalog.ts) 经 [src/shortcut.ts](../src/shortcut.ts)
编译成行列表：persona 行（当变体要求时）在前，工具行按目录键展开在后，
**行序由那一处拥有**，调用方无从写错。文件式 harness 则**一行都不生成** —— 它只产生一条
`cordis:include` 行，把解析交给宿主（[src/harness.ts](../src/harness.ts)）。
刻意不继承操作者自己那份 preset —— 那才是两个变体可比、
且受试体不会捡到评测台没选的工具的原因。

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
而且**顺手算均值会把统计口径藏进插件里**，而口径是可变的（见下文「能力面」）。

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

**所以**：本仓用 `ctx.on('session/event')` 自己折叠（[src/fold.ts](../src/fold.ts) 的 reducer +
[src/collector.ts](../src/collector.ts) 的布防），按 session id 布防/撤防。等哪天要
**给 UI 做实时评测面板**，那才是同时注册一个 projection 的时机 ——
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
  run.json          # { runId, startedAt, recordSchema, stimulus, task, surface, note }
  harness.<ext>     # harness 的逐字副本（捷径形式是 harness.json）
  trials.jsonl      # 每 trial 一行：stimulus、结果、两条折叠视图（trace / modelInput）
  README.txt        # 给读数据的人：该比 stimulus.fingerprint
```

**副本是证据，不是执行体。** 挂载用的是**操作者那份原文件**：宿主把 include 的解析基准设成
harness 文件所在目录，而 run 目录不在任何解析基准上，挂副本会让文件里每一行都 import 失败
（真机实测，见 [真机状态](../.agents/notes/2026-11-11-harness-shape.md#7-真机状态2026-11-11宿主-022-rc1)）。
代价是「读」与「挂」之间有个极小的窗口；换来的是「挂上去的东西能跑」。
所以「harness 文件放哪」仍然不影响可复现性 —— 摘要来自读到的那份文本，副本可逐字比对。
设计推演见 [为什么 harness 文件「放哪都行」](../.agents/notes/2026-11-11-harness-shape.md#2-为什么-harness-文件放哪都行)。

`openRun` 用 `flag: 'wx'` 建 `trials.jsonl`：**同目录第二次 run 直接失败**。
理由：静默追加会把两个实验混进一个「还能正常解析」的文件里。
`run.discard()` 是它的反面：一次没跑到第一个 trial 的 run 会被整目录删掉 ——
「目录存在但一行记录都没有」和「跑了但受试体什么都没做」在数据上分不开，所以前者不能留下。

---

## 5. 能力面

| 面 | 形态 | 阶段 |
|---|---|---|
| `harness_run` | 工具：任务 + 受试 harness + trial 数 → 结构化句柄 | **已实现** |
| `harness_inspect` | 挂载 + 审计 + 探针（`acquireScope`），**零模型成本**；也接受 `preset` | **已实现** |
| `harness_export` | `readDocument()` → 一份能跑的 harness 文件 | **已实现** |
| 使用说明 skill | [src/skill.ts](../src/skill.ts)，代码注册、`skills` 服务可选 | **已实现** |
| `session/event` 折叠 | [src/fold.ts](../src/fold.ts)：受试体做了什么 + 被给了什么 | **已实现** |
| 工具管线故障注入 | [src/gate.ts](../src/gate.ts)，三种模式 | **已实现** |
| JSONL 导出 | [src/record.ts](../src/record.ts) | **已实现** |
| 后台任务版（`ctx.jobs.start`） | 长跑用，取消权转给任务自己 | 后续 |
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
