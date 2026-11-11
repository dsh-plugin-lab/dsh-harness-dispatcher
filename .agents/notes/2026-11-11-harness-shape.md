# 2026-11-11 — Harness 的形状：判据从「声明」移到「观测」

状态：生效

**本条取代 `2026-11-11-harness-shape-open-discussion.md`（已删）。** 那份记录的是讨论中的状态、
以及一批后来被推翻的设想；推翻的理由与代价集中在 §4，**原样保留**——「当时怎么错的」是有用的证据，
但一条已定案的决策不该继续被追溯成「未拍板」。

标记约定同 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)：`在跑:` 读在跑宿主的 `lib/**/*.d.ts`
（契约）、`检出:` 读源码（用来理解为什么）、`实测:` 本机跑出来的、`待实测:` 有证据但没跑过，**别当结论**。

---

## 1. 形状（已定）

> **harness = 一份插件行列表。** 它写在哪由作者定；跑的时候**逐字复制进 run 目录**。
> 两次跑是不是同一份装配，不靠文件互相比较，靠**受试体自己日志里被观测到的装配**。

### 1.1 为什么实物是行列表

`PresetDefinition.plugins` 就是行列表，`agentPresets.register()` 会真的挂一棵 Loader 树，
每行的 `apply(ctx, config)` 往**那个 agent 的 scope** 上注册工具 / 提示段 / 服务 / 中间件
（`在跑:` `dsh-agent-preset-registry` `lib/types/mount.js:183-198` `mountPreset`）。
**能表达什么 = 插件能做什么**，枚举只是这份列表的一个子集。

### 1.2 输入：主路是文件，捷径是糖

```ts
harness_run({
  task_id, prompt, trials,
  harness: { file: 'minus-web' },                       // 主路：一个 harness 文件
  harness: { tools: ['fs'], persona: 'terse' },         // 捷径：几个标量
  harness: { file: 'minus-web', sealed: true },          // 同上，但工具集只由文件决定
  // 路由与深度是请求级，和 harness 并列，不在它里面
  provider?, model?, max_depth?, faults?
})
```

**`sealed` 是 2026-11-11 补上的，它改变了本笔记的默认心智模型。** 最初写的是「harness 是受试体的
装配」，实现出来才发现 preset 挂在宿主树里，**默认只是一个增量** —— 受试体还继承宿主自己的几十个
工具，以及（只要有 `skill` 通道）宿主的技能目录。于是「工具集」根本不是受控变量；最刺眼的是
**受试体能拿到本评测台自己的使用说明**，等于考生带着考试说明进考场。`sealed` 用一行把继承的工具
遮掉，实测极简 41→4、standard 69→32；技能只能靠不给通道来关，遮不住 —— §7.5 记了两次失败。
`disabled: true` 做不到这件事。

**两条形式二选一，但只有一条实现路径。** 捷径在 `openRun` 之前就被编译成一份行列表并序列化成
`harness.json`；此后两条输入完全无差别。记录里只保留 `stimulus.harness.source: 'file' | 'shortcut'`。

这条是 §7 那条命名教训的执行：**主词 `harness` 指它本来的东西（行列表），
简写形态另起名字（shortcut），不让它借用主词。** 抽象感来自命名，不来自机制。

> **落地后改过一次叫法**（2026-11-11，第二次整理）：最初叫 `quick` / `harness_file`，
> 收进 `harness` 对象后变成 `harness.file` 与 `harness.tools`。理由是**一个词管一件事**：
> `harness` 是参数名，`file` 与 `tools` 是它的两种形态，读的人不必先学两个并列参数才知道互斥。
> 代码里对应 `HarnessSelection`，源码中不再出现 `quick`（红线 B13 钉住）。

### 1.3 执行顺序是判据，不是风格

```
1. 取字节         file：读文件；shortcut：编译行列表并序列化
2. 算 digest      对**字节**算，不对路径算
3. openRun()      wx：创建即独占；立刻把捕获写进去
4. 挂载 + 审计 + 探针（零模型成本）
     挂 file 时挂**操作者的原文件**；挂 shortcut 时挂编译出的行
   on failure：删掉整个 run 目录，再抛
5. 跑 trial
6. finally 卸挂
```

**第 4 步必须在 trial 之前**。理由不是整洁：一次「看起来跑过了」的空实验比一次报错贵得多 ——
这正是本仓存在的理由。见 §4.1 那个真缺陷。

**失败要删目录**，因为「目录存在但一行记录都没有」和「跑了但受试体什么都没做」在数据上分不开。
用 `discard()` 删，不是绕过 —— 红线 B6 钉住这一条。

**挂原文件，不挂副本** —— 这一条是 2026-11-11 真机纠正的（原设计写的是「挂 run 目录那份副本」，见 §7.1）：
宿主把 `Include` 的 `baseUrl` 设成**harness 文件自己的目录**，而裸模块名（`@deepseek-ai/…`）
只在文件位于 profile 树内或 link 过的包内时才经宿主的拦截层解析。run 目录不在任何 profile 树内，
所以挂副本会让**每一行**都 `MODULE_NOT_FOUND`。

代价要如实说：原文件在「读」和「挂」之间被改，记录里的摘要就不再描述真正挂上去的东西。
这个窗口是两次相邻调用，且摘要来自同一份读到的文本。**换来的是「挂上去的东西能跑」**——
那比一个精确但跑不起来的摘要重要。

### 1.5 一次捕获，三处消费

```text
text ──┬─→ digest        声明层的身份，写进每条记录
       ├─→ run 目录副本   证据，与读到的字节同一
       └─→ 挂载           文件式交给宿主的 cordis:include；捷径直接用编译出的行
```

三者来自**同一次**读或编译，所以「副本 == 读到的东西」是构造性成立的。
**但「挂上去的 == 副本」只对捷径成立**：文件式挂的是原文件（理由见 §1.3），副本是证据而非执行体。

### 1.4 磁盘形状

```
<outputRoot>/<runId>/
  run.json          # runId, startedAt, recordSchema, stimulus, task, surface, note
  harness.<ext>     # 逐字副本（捷径形式是 harness.json）
  trials.jsonl      # 每 trial 一行
  README.txt        # 给读数据的人：该比 stimulus.fingerprint
```

`outputRoot` 默认 `~/.dsh/harness-dispatcher/runs`，所以这份副本本来就在 `.dsh` 里。

**文件名是 `harness.<ext>` 而不是固定的 `harness.yml`**（这一条是落地时改的，理由记在这里）：
扩展名不能固定，因为它决定宿主用哪个解析器回放这份副本；而捷径产出的确实是 JSON
（`JSON.stringify` 是唯一不需要自带方言就能保证正确的序列化）。所以固定**词干**、保留**真实扩展名**：
工具用 `harness.*` 找得到，回放时解析器选得对。文件名本身也记进 `run.json`。

---

## 2. 为什么 harness 文件「放哪都行」

### 2.1 旧问题问错了层级

旧未拍板项是「放仓里还是放输出目录」。两者各自付的代价：

| 位置 | 得到 | 付出 |
|---|---|---|
| 仓里 | 可版本化、可 diff、可复现 | 改一次要提交一次 |
| 输出目录 | 随手试 | 几周后不知道当时跑的是什么 |

**两个选项都错在同一个假设：文件的位置承担可复现性。** 一旦「跑的时候复制一份进 run 目录」，
证据就不再依赖位置，两个代价同时消失，位置退回它本该只回答的问题（作者的工作流）：
仓里 `harness/*.yml` / `%TEMP%` / 由 `dump` 生成，都可以。

### 2.2 白拿的三个性质

1. **run 目录自足。** 拿到目录就能读全这次实验：harness 原文、任务、每 trial 的结果。
2. **可重放，但要从解析基准里重放。** 把 `harness.<ext>` 复制到 profile 树内或本仓内
   （`harness.file` 指过去）即同一份 harness。**直接把 run 目录里的副本当路径交给
   `harness_run` 不行** —— 副本所在目录不在解析基准上，行名全部 `MODULE_NOT_FOUND`（§7.1）。
3. **记录只有一种形状。** 因为 run 目录永远有一份 harness 副本，捷径不再是第二条路，
   而是**生成文件的糖** —— 两条输入在 `openRun` 之前汇合。

### 2.3 一条新纪律：harness 文件不许带凭据

`harness.<ext>` 是**逐字**副本，而行 config 可以放任何东西（宿主不限制），**包括 API key**
（本机 `~/.dsh/profiles/web/cordis.patch.yml` 里就真有一个）。

- 这与 [AGENTS.md](../../AGENTS.md) 硬性纪律 5 不是同一条：那条说「**记录**（`trials.jsonl`）不放凭据」；
  这条说「**输入快照**也不许带，因为它会被原样复制进证据」。
- **拒绝用启发式扫描密钥**——会漏也会误报。改用声明式纪律 + 让副本可见：
  你把 key 写进去了，key 就在证据里。

### 2.4 回答旧未拍板项 ①：`!!js` 允许

原来的推理是「`!!js` = 任意代码执行 → 禁止」。它站不住：**行列表本身就是任意代码执行**
（`name: './x.mjs'` 一样在宿主进程里跑），宿主 preset 文档也明说它不是沙箱。禁 `!!js`
买不到安全，只买到「不能按平台自适应」。

真正的代价是**可复现性**：同一份文件在不同宿主上求值不同，字节摘要不再证明「两次一样」。
这个代价现在由 §3 的第三层付——**不禁止语法，而是让差异可见**。加一条观测 > 加一条禁令。

---

## 3. 判据三层

| 层 | 来源 | 回答 | 成本 |
|---|---|---|---|
| **声明** | `harness.yml` 字节摘要 | 操作者改了文件没有 | 0 |
| **生效** | 挂载审计 + `acquireScope` + `compositionInventory` | 宿主真挂上了吗、受试体看得见什么 | **0（无模型）** |
| **观测** | 受试体日志的 `system/message` + `request/header` 折叠 | 受试体**实际**收到的 prompt / 工具表 / 路由 | 0（本就折叠） |

### 3.1 第二层：`acquireScope` 比 `auditRows` 强

`acquireScope(id)` 给一份 preset 的 **scope 租约，不启动 agent**
（`在跑:` `lib/types/index.d.ts:137-139`，返回 `{ key: ScopeKey } & AsyncDisposable`）。拿 `key` 后：

| 读 | 调用 | 回答 |
|---|---|---|
| 可见工具名 | `ctx.tools.definitions(key)` | 这份 harness 真的给了 `grep` 吗 |
| 可加载技能 | `ctx.tools.definitions(key)` 里有 `skill` **且** `ctx.skills.list({ scope: key })` 里有它 | 换预设之后那个 skill 指针还在吗 |
| 每行启用态 | `compositionInventory().rows[].enabled / fiberState` | 哪行其实没起来 |

两个条件都问，是因为 `list({ scope })` 会把**全局层**合并进来：只问它，报的是「注册表里有什么」，
不是「受试体够得到什么」（§7.5 就是这个错）。

`auditRows` 只报「行挂了」；`acquireScope` 报**受试体到底看得见什么**——这才是判据。

### 3.2 第二层的洞：被 profile 禁掉的行是隐形的

profile 兼容策略会把不认识的行挂成 **disabled**（`在跑:` `mount.js` 的 doc），
而 `auditRows` 里 `if (entry.disabled) continue`（`mount.js:116-117`）**直接跳过**。
于是：**一行可能因为 profile 策略静默没生效，而挂载审计说一切正常。**
`compositionInventory().rows[].enabled === false` 才看得见。

### 3.3 第三层：受试体自己的日志里就有答案

`system/message` 与 `request/header` 都在 `KNOWN_SESSION_EVENT_TYPES` 里，都走我们**已经在监听**的
`session/event`（`在跑:` `dsh-session` `lib/types/types.d.ts:309-327` / `:397-406`）。而 `EpochHeader` 是：

```ts
interface EpochHeader {
  config: LlmCallConfig   // provider, model, reasoningEffort, temperature, maxTokens, stop
  tools?: ToolSchema[]    // name, description, parameters —— 完全形态
}
```

也就是说**「这次到底给了模型什么」不需要推断，受试体自己的日志里就有**。
记录里存**摘要**（prompt 长度 + digest、工具名集合、schema digest、实际路由），不存正文——
不破坏「记录是证据不是转录」（红线 B4）。

**这一层把「同一份 harness」从承诺变成可查。** 也正因为有它，§2.4 才敢允许 `!!js`。

---

## 4. 被推翻的判断（保留证据价值）

| # | 原判断 | 为什么错 | 现在 |
|---|---|---|---|
| 1 | harness 是一个参数对象 | `PresetDefinition.plugins` 是行列表，`mountPreset` 真挂一棵 Loader 树 | harness = 行列表（§1.1） |
| 2 | 收窄词汇能防错 | 只防住拼写；行列表写错**是响的**（`mountPreset` 逐行审计） | 不靠收窄，靠挂载审计 |
| 2b | （2 的加强）「写错会响」就够了 | **不够：`register()` 不抛**（下 §4.1），没人听就还是静默 | 必须把 `resolve().broken` 读回来 |
| 3 | 必须禁止 `!!js` | 行列表本身就是任意代码执行，禁它买不到安全 | 允许；代价由第三层观测付（§2.4） |
| 4 | `readDocument` 不可往返，所以不能克隆出厂 preset | 见 §4.2，实测可往返 | `dump` 是「从能跑的东西上做减法」的入口 |
| 5 | task 的四个部件都能做成变量 | 宿主的 `AgentOptions` 只有 `provider/model/reasoningEffort/maxTokens`（`在跑:` `dsh-agent` `runtime-types.d.ts:27-36`），`agent-loop` 的 Config 也没有轮次上限 | 三能一不能，见 §5 |
| 6 | harness 文件要决定放仓里还是输出目录 | 把「出处」和「证据」压进一个决定（§2.1） | 位置自由，证据靠副本 |

### 4.1 `register()` 不抛 —— 现在代码的真缺陷

`在跑:` `dsh-agent-preset-registry` `lib/types/index.js:106-151`：

```js
async register(definition) {
  record.ready = this.activate(record)
  await record.ready
  return unregister            // ← 挂载失败也正常返回
}
async activate(record) {
  try { await mountPreset(...) }
  catch (error) { record.broken = error.message; ... }   // ← 只记进 record，打 warn
}
```

失败要等 `retain()`（`:251-268`）才抛 `agent-preset/invalid`，而 `retain` 是子 agent 装配时
`presets.mount(...)` 调的（`在跑:` `dsh-subagent` `lib/index.js:374-384`）。所以当前顺序是：

```
normalize → openRun（建目录、建 trials.jsonl） → register（坏 Harness 静默通过）
→ startActivation → 这里才抛 agent-preset/invalid
```

**留下一个空的 `trials.jsonl`。** 修法不需要新机制，只要 `register` 之后读一次 `resolve(id).broken`
（公开方法，`d.ts:80-85`）。

### 4.2 `readDocument` 可往返（`实测:`）

旧判断依据的是宿主 README 的「nothing accepts YAML back」。那句话说的是**整份 document**
（display 元数据 + content），不是 `plugins` 数组。而 `readDocument` 只 dump `plugins`
（`index.js:239-250`），用的是 `entryListSchema`，其中 `JsExpr = { __jsExpr: string }`
并被原样写回（`cordis-plugin-include/src/index.ts:16-25`）。本机实测：

```
parsed:  [{"id":"b","name":"@x/y","disabled":{"__jsExpr":"process.platform === 'win32'"}}]
dump →   disabled: !!js process.platform === 'win32'
roundtrip equal: true
```

「求值后形态不保留」恰恰是**要的**：重新挂载就该重新求值。
`entryListProblem` / `auditRows` / `leakedServices` 也都从 registry 主入口导出（已验证）。

---

## 5. task 的四个部件：三能一不能

| 部件 | 宿主给不给 | 结论 |
|---|---|---|
| 首条输入 | `request.prompt: ContentBlock[]` | **能做，且现在被浪费**——现在只收字符串，图/文件本来就支持 |
| 初始环境 | `request.cwd?: string` | **能做，且现在是漏的**——现在根本没传 `cwd` |
| 终止条件 | ❌ `AgentOptions` 无轮次上限，`agent-loop` 也无 | **做不到，别造字段**。能做的是 `timeout_ms`（abort → `stopReason: 'aborted'`），它属于 task 不属于 harness |
| 判定信号 | `outputSchema` + `result.structured` | **能做，最大的一笔**，见 §5.1 |

### 5.1 判定信号：不在进程里判对错

> **要求受试体交一个 schema 合规的结构化答案；记录里同时留 `output` 正文与 `structured`。
> 判定发生在仓外，但判定信号是确定性的。**

这把「答案对不对」从语义评分问题变成 schema 校验问题，而校验器在外面——不违反「进程里不做统计/不做语义判断」。
`spawn` 的 `outputSchema` 能力位是 `true`、`inheritsParentContext` 是 `false`
（`在跑:` `dsh-subagent-spawn-in-process` `lib/index.js:21-27`），`SubagentResult.structured` 也在
（`dsh-subagent` `lib/types/types.d.ts:244-253`）。零新机制。

### 5.2 `llm-replay` 维持原判：另一类实验

它改变的是「模型是不是变量」这个前提。放进同一个 run 等于同时改两个东西，不能和「换装配」混。

---

## 6. 落地状态

**七项全部落地**（2026-11-11，`pnpm run check` 绿，86 个测试 / 红线 10 组 32 条）：

| # | 项 | 落在哪 |
|---|---|---|
| 1 | 修 §4.1 的顺序缺陷 | [src/subject.ts](../../src/subject.ts) + 红线 **B10**（`register` 之后必须读回 `.broken`） |
| 2 | run 目录加 harness 副本 | [src/record.ts](../../src/record.ts) 的 `openRun` + 红线 **B8** |
| 3 | 捷径编译成文件（两条输入汇合） | [src/harness.ts](../../src/harness.ts)（捕获）→ [src/shortcut.ts](../../src/shortcut.ts)（糖） |
| 4 | `harness_inspect`（`acquireScope` 探针） | [src/tools/harness-inspect.ts](../../src/tools/harness-inspect.ts) |
| 5 | 观测层加 prompt / tools / route 摘要 | [src/fold.ts](../../src/fold.ts) 的 `ObservedModelInput` |
| 6 | task 加 `cwd` / `output_schema` / `timeout_ms` | [src/trial.ts](../../src/trial.ts)（`AbortSignal.any` 融合超时与取消） |
| 7 | `harness_export` | [src/tools/harness-export.ts](../../src/tools/harness-export.ts) |
| 8 | 使用说明 skill（§4 那条，落地时补回） | [src/skill.ts](../../src/skill.ts) + 红线 **B12** |

**第 6 项少了一半，如实记下**：`prompt` 仍是纯文本，没做成 `ContentBlock[]`（图 / 文件）。
宿主支持它（`request.prompt: ContentBlock[]`），但工具参数里的联合类型要动工具 schema 方言，
而收益比 `cwd` / `output_schema` 低得多。**这是已知缺口，不是已完成。**

**红线做了反向控制**：故意把挂载改为指向原文件、把 `.broken` 读回去掉，B8/B10 各自变红后再复原。

### 6.1 落地时被迫改的设计（都是被现实纠正的）

| 原打算 | 现实 | 改成 |
|---|---|---|
| 自己解析 YAML（`js-yaml` + `entryListSchema`） | 本机无网，装不了依赖 | **不解析**：文件交给宿主的 `cordis:include`。反而更好 —— 本仓不再拥有第二套方言定义，且零新依赖 |
| 副本叫 `harness.yml` | 捷径产出 JSON，扩展名不能假 | 固定词干 + 真实扩展名（§1.4） |
| `provider`/`model`/`maxDepth` 留在简写形态里 | 它们是**请求级**，写不进行列表 | 挪到 `harness` 对象旁边。于是同一份文件能跑在两条路由下 |
| 故障对着静态目录校验 | 文件式 harness 挂了什么工具**未知** | 校验挪到**探针之后**，对着 `tools.definitions(scope)` 的真实结果。更准，且文件式也能用故障 |
| `quick` + `harness_file` 两个并列参数 | 两个参数读的人得先学才知道互斥 | 收进一个 `harness` 对象：`file` 或 `tools`/`persona`。**一个词管一件事** |

### 6.2 一条工具链教训（这条该被记住）

整理命名时我用 PowerShell 的 `Get-Content`/`Set-Content` 往返改文件，**把字符改坏了**：
`*` 变成 `D`、`D` 变成 `i`、`harnessDir` 变成 `harnessiir`。类型检查和单测都没报 ——
因为它只弄脏注释和一个属性名，而**属性名改坏会静默改变行为**（那次恰好被 tsc 抓到）。

两条结论：
1. **改文件只用编辑工具，不要经过 shell 往返。** 已写进 [AGENTS.md](../../AGENTS.md) 的验证节。
2. **红线 B13/B14 是这次的对策**：它把「源码里的旧词」「文档里的旧工具名与已删文件」
   变成机器可判的，于是下次改名漏掉哪一处，`pnpm run test` 会指出来，而不是靠人扫一遍。

---

## 7. 真机状态（2026-11-11，宿主 `0.2.2-rc.1`）

### 7.1 验过的

一次隔离实例实验（独立 `DSH_HOME` + `--from-default-profile web`，端口 3181）之后，
又用 `--patch` 在一份一次性 profile 上复核。**`cordis:include` 这条地基成立**：

- 挂载链真正走过：宿主栈里出现
  `#probe-persona` → `#include-probe-good` → `#include`，说明 include 读到了我们写的 harness 文件、
  把里面的行逐条挂上并执行到该行的 `apply()`。
- 触发报错的是**行本身与宿主层重复注册**（`tool:read` / `deployment:persona-prefix`，
  因为 `dsh-base` 已在宿主层挂过同一个包），**不是 include 机制**。

同时纠了两处原设计的错，都是**只有真机能抓到**的（`pnpm run check` 从不真的挂载任何东西）：

| # | 原设计 | 实测 | 现在 |
|---|---|---|---|
| 1 | include 的 `config.path` 传绝对路径 | `new URL('C:/x.yml', baseUrl)` 把盘符当 scheme，`fileURLToPath` 抛 `ERR_INVALID_URL_SCHEME`，**行永远不挂**（`dsh-app-boot/lib/index.js:739`） | 一律 `pathToFileURL()`。**Windows 上绝对路径必定失败** |
| 2 | 挂 run 目录里那份副本 | `Include` 把 `baseUrl` 设成文件所在目录；裸模块名只在 profile 树内 / link 过的包内才经拦截层解析，run 目录两者都不是 → **每一行 `MODULE_NOT_FOUND`** | 挂操作者的原文件，副本只作证据 |
| 3 | `harnessDir` 默认 `~/.dsh/harness-dispatcher/harness` | 同上：落在解析基准之外，导出的文件不可用 | 默认从 `ctx.baseUrl` 派生到 **profile 目录内** |
| 4 | 技能注册在宿主层，受试体自然看不到 | **看得到**：`standard` 那次受试体收到了完整的技能目录，其中一条是本插件自己的使用说明（见 §7.5） | 只靠「不给 `skill` 工具」；遮不住，也如实写在文档里 |

前三条都进了红线 **B8**，并做了反向控制（把修复改回，测试变红）；第四条进 **B17 / B19**。

### 7.2 还没验的

- **`harness_inspect` / `harness_run` 的端到端行为**：这两个要一次模型回合才被调用到，
  而实验用的 profile 模型路由是 `deepseek-official`、凭据里没有 `DEEPSEEK_API_KEY`。
  所以只能验到「插件行激活、apply 不抛、Config 过 schema」这一层。
- `tools.definitions(key)` 在租约 scope 上的返回、`acquireScope` 探针、`!!js` 求值、
  `output_schema` → `result.structured`、`modelInput` 能否从 `system/message` + `request/header` 折叠出来、
  `skills.register()` 是否真的出现在技能目录里 —— **全部未验**。

### 7.3 一条方法论教训（比上面两条 bug 更值钱）

我第一次的结论是**「preset 挂载成功」**，依据是「启动输出里没有警告」。然后做了反向控制：
把 include 的路径**故意改坏**，输出**一模一样**。

于是那个「没有警告」什么都不证明，结论已撤回。

**一个不可能失败的检查不是检查。** 这也是为什么本仓把「反向控制」写成硬纪律，而不是可选项。

### 7.4 同一个错误犯了第二次：`disabled: true` 减不掉宿主工具

发现工具会从宿主漏进来之后，我先试的是「在 preset 里把宿主那些工具行逐个 `disabled: true`」。
写了一份 86 行的文件，**工具数一个没少（41 → 41）**。

真机制：preset 里同 id 的 `disabled` 只取消 **preset 自己的那一行**；宿主那一行不在这棵树里，
取消不了。我先看到的 41 → 37 其实是「没有加」而不是「减掉了」—— 又一次把相关性当成因果。

真正能减的是 `tools.restrict`，而它只作用于**调用它的作用域**。所以遮罩必须是 preset 里的**一行**，
且排在 harness 行之前（§1.2）。这条顺序不是风格：反过来的话受试体一个工具都看不见，
而「看得见的空结果」比报错危险得多。红线 **B15** 钉住它。

### 7.5 第三个：受试体拿到了本评测台的使用说明

`sealed` 补上之后，`harness_inspect` 报封起来的极简 harness 有 **4 个工具、6 条技能**。
「6 条技能」立刻不对：那个受试体连 `skill` 工具都没有。

三条消息各自成立、合起来错，解压子会话的 `session.v4.jsonl.zstd` 才看清（122 个 zstd 帧）：

| run | harness | 工具 | 收到的技能目录 | 系统提示里的 bench 段 |
|---|---|---|---|---|
| `04-09-16` | minimal 未封 | 41 | 无（没有 `skill` 工具） | **有** |
| `04-09-52` | standard | 69 | **41 条，含本插件自己的说明** | **有** |
| `04-22-46` | minimal `sealed` | 4 | 无 | 无 |

于是有四个独立事实，之前被当成一个：

1. **系统提示段**由 `harness_run` 是否可见控制 —— 未封的 harness 继承宿主工具，段就漏了；
2. **技能目录**由 `skill` 工具是否可见控制（`dsh-tool-skill` 在 `agent/pre-step` 里先问这一点）；
3. **`sealed` 只关了前两个**，因为它只有工具那一半；
4. **`surface.skills` 报的是注册表在作用域里的条目**，`list({ scope })` 会合并全局层，所以它
   把「受试体够不到」的东西算成了它的能力面。

修法是三处，各一条红线：**B17**（探针只报能到达的）、**B18**（注册挂 fiber，否则热重载后旧正文继续赢）、
**B19**（`sealed` 只承诺实测过的）。第 2 条之前一直是潜伏的：`skills.register()` 返回的 disposer
被丢掉了，而宿主把它记在**注册表自己**的 ctx 上。

**技能遮不住 —— 试过两次，两次都失败，记在这里免得下次重跑。** 想的是「注册表最近一层赢同名」，
于是在 preset 层里注册一份同名、`modelInvocable: false` 的条目盖掉继承来的那条：目录按该标记过滤、
`skill` 工具也拒载，看起来正好。实测（自动路径 + 手写一行做二分）**继承来的 6 条原样保留**。
真原因：`ctx.skills.register()` 按 `scopeOf(this.ctx)` 归属，而 `this.ctx` 是**注册表服务自己的
ctx（宿主）**，不是调用方 —— 条目落进全局层，与被遮对象同层，同层同名**先到者赢**。

所以技能只有一个开关：**给不给受试体 `skill` 工具**。宿主没有这个工具就不发目录
（`dsh-tool-skill` 在 `agent/pre-step` 里先问这一点）。`sealed` 遮宿主工具时 `skill` 一起消失，
于是封起来的 harness 天然没有技能通道 —— 实测 `no-skill-channel.yml` 报
`0 skill(s): no \`skill\` tool here, so none is loadable`。反过来，**harness 自己挂 `tool-skill` 时
那条行属于 preset、豁免于 restrict，继承的目录照样会漏，且没有 API 能拦** —— 这是宿主的能力缺口。

**第二次尝试为什么也没成，值得单独记：** 想拿到 scope 绑定的注册表，就得把 `skills` 写进那一行的
`inject`（`ctx.get('skills')` 拿到的是宿主那份实例）。加上之后**那一行在 preset 里变成 PENDING**。
判据是探针：在 `apply` 首行无条件 `throw`，结果**挂载照样成功、工具一个不少** —— 说明 `apply` 压根
没执行。而 PENDING 既不在 `broken` 里也不在 `rowProblems` 里，所以「没生效」看起来和「生效了但没用」
一模一样。这类失败只能靠「故意让它抛」抓。

---

## 8. 与 docs/ARCHITECTURE.md 的关系

- **§3「Harness 是封闭词汇表」已被本节取代。** 那节保留原文，因为它记录了**为什么当初选枚举**
  （怕模型自由生成嵌套 JSON 且错得静默），而那个理由被 §4 第 2 行推翻了 —— 保留原文是为了别再犯同一个错。
- §3.3 的 `readDocument` 断言是**事实错误**，已在原处更正（见 §4.2）。
- §5 能力面要在第 1–7 项落地后同批更新。
