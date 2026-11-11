# src/ — 模块手册

19 个文件，两层：`src/` 与 `src/tools/`。职责与导出按依赖方向自底向上排。
**改动约束见 [AGENTS.md](AGENTS.md)**，设计理由见 [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)。

## 底层：无状态工具

| 文件 | 导出 | 谁依赖 | 改后必跑 |
|---|---|---|---|
| [digest.ts](digest.ts) | `digestBytes` / `digestText` / `digestJson` | `harness`、`record`、`fold` | B4（记录里不许出现原文） |
| [text.ts](text.ts) | `contentBlocksOf` | `trial` | — |
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
| [harness.ts](harness.ts) | `resolveHarness` / `harnessRows` / `mountPathFor` / `harnessLabel` / `HarnessSpecError` | 三个工具 | **B8** + `harness` 单测 |
| [shortcut.ts](shortcut.ts) | `normalizeShortcut` / `shortcutRows` / `shortcutLabel` | `harness` | `shortcut` 单测 |
| [subject.ts](subject.ts) | `mountSubject` / `surfaceOf` / `rowProblems` / `presetIdFor` | 三个工具 | **B10**（`register` 后必须读回 `.broken`） |

`harness.ts` 是全仓最危险的文件：它同时拥有「取字节 / 算摘要 / 生成挂载行 / 决定挂哪个路径」。
`mountPathFor` 与 `harnessRows` 的分工是**真机纠正出来的**，别再合并回去。

## 执行与观测

| 文件 | 导出 | 谁依赖 | 改后必跑 |
|---|---|---|---|
| [trial.ts](trial.ts) | `runTrial` / `TrialPlan` / `TrialOutcome` | `tools/harness-run` | `fold` 单测 |
| [collector.ts](collector.ts) | `FoldCollector` | `tools/harness-run` | `fold` 单测 |
| [fold.ts](fold.ts) | `foldEvent` / `finishFold` / `summarize` / `TrialObservations` | `collector`、`record` | **B4 / B7** + `fold` 单测 |
| [record.ts](record.ts) | `openRun` / `stimulusRecord` / `TrialRecord` | 三个工具 | **B5 / B6** + `record` 单测 |

`fold.ts` 是最大的文件（约 400 行），也是最该保持纯函数的一个：它收事件、返确定性特征，
不碰 `ctx`。**想在里面加「判断好坏」就是越界**（根 AGENTS 硬性纪律 1）。

## 装配

| 文件 | 导出 | 说明 |
|---|---|---|
| [index.ts](index.ts) | `name` / `inject` / `apply` | 唯一装配点：三个工具 + skill + 提示段 |
| [skill.ts](skill.ts) | `SKILL_NAME` / `registerSkill` | 代码注册的 skill；`skills` 服务**可选** |

`skill.ts` 用代码注册而不是文件目录：文件式 skill 在没把 `customSkillDirs` 指过去的 preset 里
**不可见且不报错**，是个死指针。内容本身受红线 **B12** 约束（必须写清三个陷阱）。

## tools/：唯一知道宿主 API 形状的地方

| 文件 | 注册的工具 | 谁依赖 | 改后必跑 |
|---|---|---|---|
| [tools/params.ts](tools/params.ts) | 三个工具共享的参数片段 | 三个工具 | B11 + 工具 schema 相关的全部单测 |
| [tools/harness-inspect.ts](tools/harness-inspect.ts) | `harness_inspect` | — | **B11**（含 `{ preset }` 分支与路由校验） |
| [tools/harness-export.ts](tools/harness-export.ts) | `harness_export` | — | B14（文档里的工具名） |
| [tools/harness-run.ts](tools/harness-run.ts) | `harness_run` | — | **B5 / B6 / B8** |

`params.ts` 里 `FAULTS_PARAMETER` **必须包成 `{ faults: {…} }` 再展开**：
直接展开一个值规格会把 `defineTool<const S, const O>` 的推断塌成宽 JSON 类型，`args.*` 全部失去类型。

## 变更影响路由

| 你在改的东西 | 同批必须改 |
|---|---|
| 工具的名字 / 数量 / 参数 schema | 本文件 → [能力面](../docs/ARCHITECTURE.md#5-能力面) → 红线 B11/B14 |
| harness 的形状（行列表 / 捷径标量 / 判据三层） | [Harness 的形状](../.agents/notes/2026-11-11-harness-shape.md) 是**判据** → `harness.ts`（捕获）→ `shortcut.ts`（糖）→ `record.ts` 的 `StimulusRecord` |
| 挂载 / 审计 / 探针的顺序 | `subject.ts` → 红线 **B10** |
| run 目录的形状（新增落盘文件） | `record.ts` 的 `openRun` → [数据出口只有两个函数](../docs/ARCHITECTURE.md#44-数据出口只有两个函数) → 两个 README 的目录树 |
| 工具目录新增一个键 | `catalog.ts` → 红线 **B1** → `catalogLine()` |
| 给某个东西改名 | 红线 **B13/B14** 兜住源码与文档两侧 |
| 导出记录的字段 | `record.ts` 的 `TrialRecord` → [数据出口只有两个函数](../docs/ARCHITECTURE.md#44-数据出口只有两个函数) |
| 观测折叠的语义 | `fold.ts` → `fold` 单测 → [折叠的边界是硬的](../docs/ARCHITECTURE.md#43-折叠的边界是硬的) → 红线 B4/B7 |
| 故障模式 | `fault.ts` + `gate.ts` 三条管线 → [三种故障是三个不同的实验](../docs/ARCHITECTURE.md#23-三种故障是三个不同的实验不是同一个设置的三个档) |
| 依赖范围 | `engines.dsh` / `peerDependencies` / devDependencies **三处同批**，且逐字相同 |

## 参考

- 规则层 → [AGENTS.md](AGENTS.md)
- 根索引 → [../AGENTS.md](../AGENTS.md)
- 设计理由 → [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)
- 测试对应关系 → [../test/README.md](../test/README.md)
