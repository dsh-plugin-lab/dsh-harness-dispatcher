# dsh-harness-dispatcher

给**装配**打分，不给模型打分。

```text
Model + Harness = Agent
```

一个 agent 的行为，至少同样取决于它的**装配** —— system prompt、工具集、模型路由 —— 而不是只取决于模型。
本插件把装配变成受控变量：用固定任务反复跑同一个装配变体，把每次跑动的已提交事件折叠成确定性事实，
每个 trial 写一行 JSONL。

**它不算统计量。** 均值、区间、显著性属于仓外的 R / Python —— 因为分析口径会变，而记录必须能被
**另一个口径**重算。

## 拿到什么

- **三个工具，一条零成本的迭代回路**：
  - `harness_export` —— 把宿主已有的 preset 导成一份**能跑的** harness 文件（从能跑的东西上做减法）；
  - `harness_inspect` —— 挂载 + 审计 + 探针，报出受试体**到底能调用什么**。**不起 agent、不花 token**。
    也可以 `{ preset: "standard" }` 直接看宿主已有的 preset，**连文件都不用生成**；
  - `harness_run` —— 任务 + harness + trial 数 → 一个 run 句柄与逐 trial 结果。**记录文件才是交付物**。
- **一个故障闸门**：对指定工具注入 `deny` / `fail` / `latency`，只作用于受试体，对其他 agent 零改动。
- **两条折叠**：受试体**做了什么**（`trace`：turn/step/工具调用数、按工具名的错误、token 记账、最终文本），
  以及受试体**被给了什么**（`modelInput`：system prompt 摘要、工具名与 schema 摘要、实际路由）。
  全是事实，没有判断。
- **一个随包注册的 skill**（`dsh-harness-dispatcher`，与包同名）：把这条回路和两个命名空间陷阱写在里面，
  agent 自己会找到。

一次 run 一个目录，**自足**：harness 的逐字副本就在里面，不用回头找原文件。**两个根，分开是有意的**：

| | 默认 | 为什么在那 |
|---|---|---|
| **记录**（`outputRoot`） | `$DSH_HOME/harness-dispatcher/runs/<runId>/` | 用户数据；一次 run 一个自足目录 |
| **harness 文件**（`harnessDir`） | `<profile>/harness/` | harness 文件里的裸模块名只在 profile 树内解析得到，导出到别处就是**跑不了的文件** |

`$DSH_HOME` 没设时分别是 `~/.dsh/harness-dispatcher/runs/` 与 `~/.dsh/profiles/<profile>/harness/`。
**不存在 `<DSH_HOME>/harness-dispatcher/harness/`** —— 那只是「上下文里根本没有 profile 文件」时的兜底。

```text
<outputRoot>/<runId>/
  run.json          # run 身份、任务、stimulus 摘要、探到的 surface
  harness.<ext>     # harness 的逐字副本（捷径形式是 harness.json）
  trials.jsonl      # 每 trial 一行：stimulus、结果、两条折叠视图
  README.txt        # 给读数据的人：该比哪个字段
```

## 用之前值得知道的几条

- **harness 是一份插件行列表**，写在哪都行；跑的时候**复制一份进 run 目录**。
  于是「同一份 harness」不靠文件位置保证，靠 run 目录里的副本 + 记录里的 `stimulus.fingerprint`。
- **跑之前先 `harness_inspect`。** 它不花钱，而且它与 `harness_run` 走同一段解析 ——
  inspect 说行，run 跑的才是那个。
- **默认是增量，除非你封起来。** 挂成 preset 之后它住在宿主里面，所以受试体默认还会继承宿主自己挂的
  全部工具 —— 你比来比去的每个变体都共享那几十个你从没选过的工具。`sealed: true` 把这些遮掉，
  只剩 harness 自己声明的东西。**工具集是变量时就用它**；要问"这份 harness 在这套部署里能不能跑"时别用。
- **技能不是「遮」出来的，是「不给通道」关掉的。** 宿主没有技能遮罩 API，同名条目也盖不掉继承来的
  那条（实测两次：注册落在宿主那一层，先到者赢）。目录只发给**能调 `skill`** 的受试体，所以封起来
  —— 连带去掉宿主的 `skill` 工具 —— 就够了。**但 harness 自己挂 `tool-skill` 时那条行保留，
  继承的技能目录仍会到受试体手里，没有 API 拦得住。** `harness_inspect` 报的是它真能加载的。
- **捷径是糖，不是定义。**`harness.tools` 取自固定目录键、`harness.persona` 是枚举 ——
  它编译成同样的行列表并同样落盘。要表达糖装不下的东西（分组、`isolate`、skills、`!!js` 条件），写文件。
- **文件由宿主自己解析**（`cordis:include`），本插件不实现第二套方言。
- **`deny` / `fail` / `latency` 是三个不同的实验**，不是同一个设置的三个档。
  `deny` 拿走工具（测绕路），`fail` 返回错误（测恢复），`latency` 押后结果（测耐心）。
- **同步读已结束的会话日志在宿主里已废弃**（`snapshotEvents` / `eventAt` / `ownEvents` 都写着
  *new calls are prohibited*）。本插件改为折叠 `session/event`。

完整依据（含 `file:line` 出处，以及**被推翻的判断**）见
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 与
[.agents/notes/2026-11-11-harness-shape.md](.agents/notes/2026-11-11-harness-shape.md)。

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `outputRoot` | `$DSH_HOME/harness-dispatcher/runs`（未设置时即 `~/.dsh/…`） | 每条 run 一个子目录的父目录 |
| `harnessDir` | `<profile>/harness` | 裸 harness 名解析的目录，`harness_export` 也写这里。**故意落在 profile 内**：放到别处的 harness 文件 import 不了自己的行 |
| `defaultTools` | `fs`、`fs-search`、`pwsh` | 快捷方式未指定工具时用的目录键 |
| `defaultMaxDepth` | `1` | 授予受试体的委派预算 |
| `maxTrials` | `10` | 单次调用允许的 trial 上限 |
| `trialTimeoutMs` | `0` | 单 trial 墙钟预算；`0` 关闭 |

## 状态

未发布（`private: true`）。单测覆盖纯函数层（捕获、归一化、折叠、记录写入、行编译）。
宿主层那条路 —— 真的挂载、真的拉起受试体、真的命中故障、真的读到折叠 —— 是人工验证的，
步骤写在 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#6-真机验证不属于-pnpm-run-check)，
因为**装上插件不等于它跑过**。

## 许可

MIT
