<p align="center">
  <img src="icon.svg" alt="dsh-harness-dispatcher" width="80" height="80">
</p>

<h1 align="center">dsh-harness-dispatcher</h1>

<div align="center">
  <p><em>给 harness 打分，不给模型打分。<code>Model + Harness = Agent</code></em></p>

  <p>
    <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat&logo=deepseek&logoColor=white" alt="powered by dsh"></a>
  </p>

  <p>
    <a href="https://github.com/dsh-plugin-lab/dsh-harness-dispatcher/actions/workflows/ci.yml"><img src="https://github.com/dsh-plugin-lab/dsh-harness-dispatcher/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat" alt="MIT license"></a>
  </p>

  <p>
    <a href="README.md">English</a> · <strong><a href="README_zh.md">简体中文</a></strong>
  </p>
</div>

---

一个 agent 的行为，取决于它被**装配**成什么样 —— system prompt、工具集、模型路由 —— 这份影响
不比模型本身小。本插件把这份装配变成一个受控变量：一条固定任务、一次一份 harness、每个 trial 一行 JSONL。

它不算统计量。均值、区间与显著性属于仓外的 R 或 Python —— 分析口径会变，而记录必须能在另一个口径下重算。

## 它提供什么

- **一个零成本闭环，三个工具**：`harness_inspect` 挂载 + 审计 + 探针，**不起 agent、不花 token**；
  `harness_export` 把 preset 的行写成一份能跑的副本；`harness_run` 真跑，并留下一个自足的记录目录。
- **先发现，再动手**：`harness_inspect` 不带参数就列出宿主有哪些 preset **和**哪些 model route，两者都读
  本机注册表。再单独给 `provider` 才列出那一条路由的模型 —— 唯一要花一次适配器调用的读，也是「哪个模型
  声明了 `image` 输入」的唯一答案，带图之前先问它。
- **一个故障闸门**：对指定工具注入 `deny` / `fail` / `latency`，只作用于受试体，对其他 agent 零改动。
- **宿主自己的数字，原样导出**（`host`）：宿主注册了的那些投影 key，照抄回来不改。宿主新增一个投影，
  这里就加一个字符串。
- **本仓自己折叠的两个视图**：受试体**被给了什么**（`modelInput`，即「两次跑是不是同一份装配」的证据），
  以及没有任何投影提供的三个计数（`trace`）。
- **受试体的答案完整保存**（`output`），不做前缀截断：切掉的部分重算不回来，而它下面那层原始日志本来就
  大一个数量级。
- **受试体的原始事件日志**（`events.jsonl`，默认开）：所以一份记录能按本插件从未有过的口径重算。
- **一个随包注册的 skill**（`dsh-harness-dispatcher`，与包同名）：把这条回路和那些「漏了就废掉一次实验」
  的陷阱写在里面，agent 自己会找到。

## 安装

未发布，所以从检出装，而不是从 registry 装：

```shell
git clone https://github.com/dsh-plugin-lab/dsh-harness-dispatcher
dsh plugin --profile <profile> add ./dsh-harness-dispatcher
```

add 给的是 **link**，所以改检出就直接生效，不用重装。

## 兼容性

| | |
|---|---|
| `engines.dsh` | `^0.2.2-rc.1` —— 对着宿主 `0.2.2-rc.1` 验过 |
| Node | `>= 20` |

宿主的扩展面以**在跑版本**的 `lib/**/*.d.ts` 为准，不看源码检出：两条线不一样，差一个 patch 就够让
同一个 API 换个形状。实测记录（含「照检出写会静默坏掉」的那几条）在
[宿主扩展面核查](.agents/notes/2026-11-10-host-api-surface-0.2.2-rc.1.md)。

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `outputRoot` | `$DSH_HOME/harness-dispatcher/runs` | 每条 run 一个子目录的父目录 |
| `harnessDir` | `$DSH_HOME/profiles/<name>/harness` | 裸 harness 名解析的目录，`harness_export` 也写这里 |
| `defaultTools` | `fs`、`fs-search`、`pwsh` | 快捷方式未指定工具时挂的目录键 |
| `defaultMaxDepth` | `1` | 授予受试体的委派预算 |
| `maxTrials` | `10` | 单次调用允许的 trial 上限 |
| `trialTimeoutMs` | `0` | 单 trial 墙钟预算；`0` 关闭 |

`$DSH_HOME` 未设置时即 `~/.dsh`。这两个路径**故意落在不同的根**：记录是用户数据，而 harness 文件里的
裸模块名只在 profile 树内解析得到，导出到别处就是一份跑不了的文件。

## 记录

```text
<outputRoot>/<runId>/
  run.json          # run 身份、任务、stimulus 摘要、探到的 surface
  harness.<ext>     # harness 的逐字副本（捷径形式是 harness.json）
  trials.jsonl      # 每 trial 一行：stimulus、结果、宿主的数字、我们的两个视图
  events.jsonl      # 受试体的已提交会话事件，逐字
  README.txt        # 给读数据的人：该比哪个字段
```

**那份副本是证据，不是跑的那个东西** —— 真正挂载的是原文件。而 `events.jsonl` 里有受试体看到的
prompt 与模型输出，**分享前先脱敏**。

## 开发

```shell
pnpm install
pnpm run check     # typecheck + build + test + lint + format:check + check:release
```

`check` 就是 CI 跑的那六步，有一条红线钉住这个等价性：它曾经只跑前四项，于是本机全绿、推上去红了。

宿主层那条路 —— 真的挂载、真的拉起受试体、真的命中故障 —— **不在** `check` 覆盖范围内，
而装上插件不等于它跑过。这些步骤是人工的，写在
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#6-真机验证不属于-pnpm-run-check)；验到哪一步了在
[AGENTS.md](AGENTS.md)。

## 用之前值得知道的

只留会改变实验结论的建议，不留设计依据。后者 —— 记录为什么长这样、试过什么又否掉了什么 —— 在
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

- **跑之前先 `harness_inspect`。** 它不花钱，而且与 `harness_run` 走同一段解析：inspect 说行，
  run 跑的才是那个。
- **两件事免费问，一件事要花一次适配器调用。** 不带参数的 `harness_inspect` 只读本机；问某条路由有哪些
  模型则不是 —— 只有适配器知道回答它要不要去问远端。但带图之前还是该问，那是唯一说清「哪个模型收图」的地方。
- **默认是增量，除非你封起来。** 挂成 preset 之后它住在宿主里面，受试体默认还会继承宿主自己挂的全部工具。
  `sealed: true` 把这些遮掉。**工具集是变量时就用它**；要问「这份 harness 在这套部署里能不能跑」时别用。
- **技能不是「遮」出来的，是「不给通道」关掉的。** harness 自己挂 `tool-skill` 时那条行保留，
  继承的技能目录照样会到受试体手里，没有 API 拦得住。`harness_inspect` 报的是它真能加载的。
- **`deny` / `fail` / `latency` 是三个不同的实验**，不是同一个设置的三个档：缺席、恢复、耐心。
- **比 `stimulus.fingerprint`，不比文件名。** 它覆盖 harness 内容、路由与委派深度。

## 许可

[MIT](LICENSE)
