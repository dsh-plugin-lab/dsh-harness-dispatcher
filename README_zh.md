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

- **一个工具 `run_benchmark`**：任务 + 装配变体 + trial 数 → 一个 run 句柄与逐 trial 结果。
  **记录文件才是交付物。**
- **一个故障闸门**：对指定工具注入 `deny` / `fail` / `latency`，只作用于受试体，对其他 agent 零改动。
- **一条轨迹折叠**：turn 数、step 数、工具调用数、按工具名的错误数、未恢复的失败、token 记账、
  最终回复文本。全是事实，没有判断。

一次 run 一个目录：

```text
<outputRoot>/<runId>/
  run.json        # run 身份、任务 id、记录 schema 版本
  trials.jsonl    # 每 trial 一行：装配、结果、折叠出的轨迹
```

## 用之前值得知道的几条

- **装配是封闭词汇表，不是自由 JSON。**`tools` 取自固定目录键，`persona` 是枚举，故障是三种模式之一。
  让模型自由写一棵插件树，它可能产出一个**什么都不做**的故障注入 —— 而空的实验看起来就像结果。
- **`deny` / `fail` / `latency` 是三个不同的实验**，不是同一个设置的三个档。
  `deny` 拿走工具（测绕路），`fail` 返回错误（测恢复），`latency` 押后结果（测耐心）。
- **评测台自己声明组合**，不克隆出厂 preset：preset 的展示用 YAML 不可回挂，回挂会**静默改变受试刺激**。
- **同步读已结束的会话日志在宿主里已废弃**（`snapshotEvents` / `eventAt` / `ownEvents` 都写着
  *new calls are prohibited*）。本插件改为折叠 `session/event`。

完整依据（含 `file:line` 出处，以及**被推翻的四条设想**）见
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `outputRoot` | `~/.dsh/harness-dispatcher/runs` | 每条 run 一个子目录的父目录 |
| `defaultTools` | `fs`、`fs-search`、`pwsh` | 装配未指定工具时用的目录键 |
| `defaultMaxDepth` | `1` | 授予受试体的委派预算 |
| `maxTrials` | `10` | 单次调用允许的 trial 上限 |

## 状态

未发布（`private: true`）。单测覆盖纯函数层（归一化、折叠、行构建、记录写入）。
宿主层那条路 —— 真的拉起受试体、真的命中故障、真的读到折叠 —— 是人工验证的，
步骤写在 [docs/ARCHITECTURE.md §6](docs/ARCHITECTURE.md#6-真机验证不属于-pnpm-run-check)，
因为**装上插件不等于它跑过**。

## 许可

MIT
