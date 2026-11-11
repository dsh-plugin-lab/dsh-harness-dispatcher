# src/ — 模块手册

两层：`src/` 与 `src/tools/`。职责与导出按依赖方向自底向上排。
**改动约束见 [AGENTS.md](AGENTS.md)**，设计理由见 [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)。

## 底层：无状态工具

| 文件 | 导出 | 谁依赖 | 改后必跑 |
|---|---|---|---|
| [digest.ts](digest.ts) | `digestBytes` / `digestText` / `digestJson` | `harness`、`record`、`fold` | B4（记录里不许出现原文） |
| [text.ts](text.ts) | `contentBlocksOf` | `trial` | — |
| [attachments.ts](attachments.ts) | `resolvePrompt` / `planAttachment` / `imageDeliveryProblem` / `TaskAttachment` | `tools/harness-run`、`record` | **B27**（图片不可用必须拒；文件是路径句柄；记录只留身份）+ `attachments` 单测 |
| [config.ts](config.ts) | `Config` / `ResolvedConfig` / `resolveConfig` | `index` | B9 + 真机（`harnessDir` 默认值决定能否挂载） |

`resolveConfig` 收 `baseUrl`，把 `harnessDir` 默认到 **profile 目录内**。这不是风格：
harness 文件的裸模块名只在那里解析得到（见 [AGENTS.md](AGENTS.md) 硬约束 3）。

## 词汇与校验

| 文件 | 导出 | 谁依赖 | 改后必跑 |
|---|---|---|---|
| [catalog.ts](catalog.ts) | `TOOL_CATALOG` / `TOOL_KEYS` / `PERSONAS` / `DEFAULT_TOOLS` / `catalogLine` | `shortcut`、`tools/params` | **B1** + `catalog` 单测 |
| [fault.ts](fault.ts) | `FAULT_MODES` / `normalizeFaults` / `assertFaultsReachable` | `gate`、`tools/params` | B2 + `fault` 单测 |
| [gate.ts](gate.ts) | `FaultGate` | `tools/harness-inspect`、`tools/harness-run` | B2 + `fault` 单测 |

`catalog.ts` 同时是**捷径的词汇表**与**工具描述的生成源**（`catalogLine()`），所以加一个键要三处同批：
目录、红线 B1 的断言、工具描述。

## 受试对象

| 文件 | 导出 | 谁依赖 | 改后必跑 |
|---|---|---|---|
| [harness.ts](harness.ts) | `resolveHarness` / `harnessRows` / `sealedRows` / `mountPathFor` / `harnessLabel` / `HarnessSpecError` | 三个工具 | **B8 / B15 / B19** + `harness` 单测 |
| [sealed.ts](sealed.ts) | `apply` —— 一行 `tools.restrict`，遮掉继承来的工具 | `harness.ts` 的 `sealedRows` 生成它的行 | **B15 / B19**（只管工具；技能遮不住） |
| [tool.ts](tool.ts) | `apply` + `toolSpecOf` —— 从行 config 长出一个模型可见工具 | 只在 harness 文件里按名字使用 | **B20** |
| [shortcut.ts](shortcut.ts) | `normalizeShortcut` / `shortcutRows` / `shortcutLabel` | `harness` | `shortcut` 单测 |
| [subject.ts](subject.ts) | `mountSubject` / `surfaceOf` / `hostToolNames` / `presetList` / `presetSummaries` / `rowWarnings` / `presetIdFor` | 三个工具 | **B10 / B17**（`register` 后必须读回 `.broken`；`surface` 只报能到达的）+ **B21**（列表要标默认、坏的要连原因列出）+ **B25**（挂载了但不出力的行是**警告**，不是「不能跑」） |

`harness.ts` 是全仓最危险的文件：它同时拥有「取字节 / 算摘要 / 生成挂载行 / 决定挂哪个路径」。
`mountPathFor` 与 `harnessRows` 的分工是**真机纠正出来的**，别再合并回去。

## 执行与观测

| 文件 | 导出 | 谁依赖 | 改后必跑 |
|---|---|---|---|
| [run.ts](run.ts) | `runBench` / `summaryLine` / `RunRequest` / `RunSummary` | `tools/harness-run`（两条等待都调它） | **B6 / B8 / B10 / B15**（执行体搬家后仍在这里）+ **B26**（唯一执行体）+ **B28**（一次停止停一切；`stopped` 只在后台读得到） |
| [trial.ts](trial.ts) | `runTrial` / `stoppedByBudget` / `TrialPlan` / `TrialOutcome` | `run` | **B23 / B28**（融合信号里始终有调用方的信号）+ `fold` 单测 |
| [abort.ts](abort.ts) | `onceAborted` | `trial` | `abort` 单测 |
| [jobs.ts](jobs.ts) | `jobOutcomeOf` + `JobRegistry` 等结构类型 | `tools/harness-run` | **B26 / B28**（`killed` / `failed` 分清；没抛的喊停也是 `killed`；`detail` 只放一行） |
| [collector.ts](collector.ts) | `FoldCollector` | `run` | `fold` 单测 |
| [fold.ts](fold.ts) | `foldEvent` / `finishFold` / `summarize` / `TrialObservations` | `collector`、`record` | **B4 / B7** + `fold` 单测 |
| [record.ts](record.ts) | `openRun` / `stimulusRecord` / `TrialRecord` | 三个工具 | **B5 / B6** + `record` 单测 |

`fold.ts` 是全仓最大的文件，也是最该保持纯函数的一个：它收事件、返确定性特征，
不碰 `ctx`。**想在里面加「判断好坏」就是越界**（根 AGENTS 硬性纪律 1）。

## 装配

| 文件 | 导出 | 说明 |
|---|---|---|
| [index.ts](index.ts) | `name` / `inject` / `apply` | 唯一装配点：三个工具 + skill + 提示段 |
| [skill.ts](skill.ts) | `SKILL_NAME` / `readSkill` / `splitFrontmatter` / `registerSkill` | 代码注册的 skill；正文 + 元信息是 [../skills/dsh-harness-dispatcher/SKILL.md](../skills/dsh-harness-dispatcher/SKILL.md)，`skills` 服务**可选**，注册挂 `ctx.effect`（**B18**），注册对象带 `source`（**B24**） |

`skill.ts` 用代码注册而不是文件目录：文件式 skill 在没把 `customSkillDirs` 指过去的 preset 里
**不可见且不报错**，是个死指针。但**正文是文件**，而且是一个**合法的 skill 文件**（带 YAML
frontmatter 的 `name` / `description` / `author` / `metadata.source`），apply 时读盘并剥掉 frontmatter：

- 元信息只有一个 home：文件。改描述不用碰代码，也不会两边不一致。
- 文件因此能被 `dsh-skill-filesystem` 直接读 —— 若哪天有人把 `skills/` 挂给文件系统 provider，它仍然成立。
  只放正文的片段看起来一样，但会被那个 provider 丢掉，是个「像伪劣品的成品」。

代价是三条必须自己守的纪律，都有断言：文件随包发布（`check:release`）、正文与 frontmatter 坏掉要
**响亮失败**（宿主只校验 `name`/`description`/`invocation`，空的会在目录里出现、加载时渲染成空）、
路径按**产物位置**推算（`src/` 与 `lib/` 都在包根下一级，所以 `../skills` 两种布局同一个式子）。
注册必须挂在 fiber 上：宿主把 disposer 记在**它自己**的 ctx 上，丢掉返回值就会在卸载后残留 ——
热重载之后改了正文仍然是旧的那一份，而且不报错。

## tools/：唯一知道宿主 API 形状的地方

| 文件 | 注册的工具 | 谁依赖 | 改后必跑 |
|---|---|---|---|
| [tools/params.ts](tools/params.ts) | 三个工具共享的参数片段 | 三个工具 | B11 + 工具 schema 相关的全部单测 |
| [tools/harness-inspect.ts](tools/harness-inspect.ts) | `harness_inspect` | — | **B11**（含 `{ preset }` 分支与路由校验） |
| [tools/harness-export.ts](tools/harness-export.ts) | `harness_export` | — | B14（文档里的工具名） |
| [tools/harness-run.ts](tools/harness-run.ts) | `harness_run` | — | **B5 / B6 / B8 / B23 / B26** |

`params.ts` 里 `FAULTS_PARAMETER` **必须包成 `{ faults: {…} }` 再展开**：
直接展开一个值规格会把 `defineTool<const S, const O>` 的推断塌成宽 JSON 类型，`args.*` 全部失去类型。

## 变更影响路由

| 你在改的东西 | 同批必须改 |
|---|---|
| 工具的名字 / 数量 / 参数 schema | 本文件 → [能力面](../docs/ARCHITECTURE.md#5-能力面) → 红线 B11/B14 |
| 任务的附件（图 / 文件） | `attachments.ts` → [任务是输入，可以带附件](../docs/ARCHITECTURE.md#343-任务是输入可以带附件) → 红线 **B27** → `record.ts` 的 `TaskRecord.attachments` |
| harness 的形状（行列表 / 捷径标量 / 判据三层） | [Harness 的形状](../.agents/notes/2026-11-11-harness-shape.md) 是**判据** → `harness.ts`（捕获）→ `shortcut.ts`（糖）→ `record.ts` 的 `StimulusRecord` |
| 挂载 / 审计 / 探针的顺序 | `subject.ts` → 红线 **B10** |
| `sealed`（工具集封闭） | `sealed.ts` + `harness.ts` 的 `sealedRows` + `subject.ts` 的 `inheritedBy` → 红线 **B15**（遮罩行必须在前）/ **B19**（不承诺遮技能） |
| `surface` 报什么（能到达 vs 存在） | `subject.ts` 的 `loadableSkills` → 红线 **B17** → `tools/harness-inspect` 的那行文案 |
| `harness_inspect` 的三种用法（列 preset / 查 preset / 查 harness） | `subject.ts` 的 `presetList`/`presetSummaries` → 红线 **B21** → `tools/harness-inspect` 的输出 schema 与三个渲染分支 |
| skill 正文 | [../skills/dsh-harness-dispatcher/SKILL.md](../skills/dsh-harness-dispatcher/SKILL.md) → 红线 **B22**（上限 + 事实清单 + 缺文件/空正文要响亮）→ `check:release` 断言它随包发布 → 改完真机确认它仍在技能目录里 |
| 造工具 / 改工具的语义 | `tool.ts` 的 `toolSpecOf` → 红线 **B20** → [造工具与改工具](../docs/ARCHITECTURE.md#342-造工具与改工具dsh-harness-dispatchertool) → `package.json` 的 `exports` 与 `tsdown.config.ts` 的 `entry` |
| run 目录的形状（新增落盘文件） | `record.ts` 的 `openRun` → [数据出口只有两个函数](../docs/ARCHITECTURE.md#44-数据出口只有两个函数) → 两个 README 的目录树 |
| 工具目录新增一个键 | `catalog.ts` → 红线 **B1** → `catalogLine()` |
| 给某个东西改名 | 红线 **B13/B14** 兜住源码与文档两侧 |
| 导出记录的字段 | `record.ts` 的 `TrialRecord` → [数据出口只有两个函数](../docs/ARCHITECTURE.md#44-数据出口只有两个函数) |
| 观测折叠的语义 | `fold.ts` → `fold` 单测 → [折叠的边界是硬的](../docs/ARCHITECTURE.md#43-折叠的边界是硬的) → 红线 B4/B7 |
| 故障模式 | `fault.ts` + `gate.ts` 三条管线 → [三种故障是三个不同的实验](../docs/ARCHITECTURE.md#23-三种故障是三个不同的实验不是同一个设置的三个档) |
| 超时 / 取消（停住一个正在跑的受试体） | `trial.ts` 的 `onceAborted` 监听 → [停止一个正在跑的受试体](../docs/ARCHITECTURE.md#53-停止一个正在跑的受试体) → 红线 **B23 / B28** |
| 后台 / 长跑（`ctx.jobs`） | `jobs.ts` 的结构类型 + `run.ts` 的执行体 → [后台通道](../docs/ARCHITECTURE.md#51-后台通道同一个工具的一个开关) → 红线 **B26** |
| 依赖范围 | `engines.dsh` / `peerDependencies` / devDependencies **三处同批**，且逐字相同 |

## 参考

- 规则层 → [AGENTS.md](AGENTS.md)
- 根索引 → [../AGENTS.md](../AGENTS.md)
- 设计理由 → [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)
- 测试对应关系 → [../test/README.md](../test/README.md)
