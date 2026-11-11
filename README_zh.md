<p align="center">
  <img src="icon.svg" alt="dsh-harness-dispatcher" width="80" height="80">
</p>

<h1 align="center">dsh-harness-dispatcher</h1>

<div align="center">
  <p><em>装配是变量，记录是产物。</em></p>

  <p>Model + Harness = Agent</p>

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

一个 agent 的表现，取决于它被**装配**成什么样 —— 提示段、工具、技能、中间件、模型路由 —— 这份影响
不比模型本身小。平时这些选择只能靠感觉，因为改一处再看差别，全凭印象。

本插件把这份装配变成**一个文件**：写下来，同一条任务跑两个变体，把每个变体实际做了什么留在记录里。

## 能查出什么

- **这段文案值不值它的 token。** harness 里一行复用宿主某个工具的名字，就**替换**掉那个工具 —— 只对
  这个受试体生效，描述与参数一起换。「这段描述有用吗」于是从争论变成一次编辑、两次跑。
- **工具集到底重不重要。** `sealed: true` 让 harness 成为整个工具集；不加则受试体还继承宿主自己挂的
  全部工具 —— 那是另一个问题。剥到只剩一个工具的 harness，同一条任务要花掉的调用次数很不一样。
- **你自己写的代码会怎样。** 任何一行都能指向包、子路径，或一个路径 —— harness 文件旁边的 `./mine.js`，
  或 `file:///` URL。所以你自己写的提示段、中间件、整套工具，与宿主自带的同样是变量。
- **什么会坏。** 对指定工具注入 `deny` / `fail` / `latency`，只作用于受试体：缺席、恢复、耐心，三次
  独立的实验。
- **差别是不是真的。** 每个变体跑 N 个 trial，外加一个指纹说明这两个变体确实不是同一个东西。

## 怎么跑的

| 步骤 | 工具 | 成本 |
|---|---|---|
| 列出本机有哪些 preset 与 model route；查哪个模型收图 | `harness_inspect` —— 不带参数，或只给 `provider` | 免费 · 一次适配器调用 |
| 挂载、审计、报告受试体真能调到什么 | `harness_inspect` 带 `preset` 或 `harness` | 免费 |
| 把一份能跑的行列表导出来改 | `harness_export` | 免费 |
| 拿它跑一条任务，一个或多个 trial | `harness_run`，可以放后台 | **每 trial 一次模型调用** |

三个免费步骤与 `harness_run` 走**同一段解析**，所以 inspect 的判定就是 run 的判定。这就是为什么
「写错 → 知道错在哪 → 改」便宜到可以放在最前面。

## 记录里有什么

一次 run 就是一个自足的目录：

```text
<outputRoot>/<runId>/
  run.json          # run 身份、任务、stimulus 指纹、探到的能力面
  harness.<ext>     # harness 的逐字副本（捷径形式是 harness.json）
  trials.jsonl      # 每 trial 一行
  events.jsonl      # 受试体的已提交会话事件，逐字
  README.txt        # 给读数据的人：该比哪个字段
```

一行 trial 里分三层，分开就是重点：

- **`host`** —— 宿主已经算过的（耗时、token 分桶、上下文压力、策略、委派行为），照抄回来不改。
  自己再算一套合计就是第二套定义。
- **`modelInput` + `trace`** —— 受试体**被给了什么**，以及没有任何投影提供的三个计数。
  这是「两次跑是不是同一份装配」的证据。
- **`events.jsonl`** —— 受试体已提交的事件，逐字，默认开。有了它，一份记录才能按本插件从未设想过的
  口径重算 —— 这也正是本插件不算统计量的原因：均值、区间与显著性属于仓外的 R 或 Python。

**那份副本是证据，不是跑的那个东西** —— 真正挂载的是原文件，因为行里的裸模块名只在 profile 树内
解析得到。而 `events.jsonl` 里有受试体看到的 prompt 与模型输出，**分享前先脱敏**。

## 到哪里为止

- **指纹覆盖的是声明，不是行为。** 它哈希行列表、路由、委派深度，以及 harness 是否 `sealed`
  （封起来就是 4 个工具，不封是 41 个 —— 这是两个实验，必须两个指纹）。改了某行指向的文件，或者让一个
  `!!js` 行条件当天解析成别的结果，两次跑仍然同指纹。`modelInput` 才是受试体真正收到的东西 ——
  两者不一致时，信它。
- **技能遮不住，只能不给通道。** 技能只通过 `skill` 工具到受试体手里，而封印会把宿主的那个工具拿掉，
  通道就断了。但 harness 自己挂 `tool-skill` 时那一行保留，继承的技能目录照样会跟过去。
  `harness_inspect` 报的是它真能加载的。
- **被点名的工具就是按名字遮。** 封印之下，一行复用宿主工具的名字，会连它一起被隐藏。探针报的是活下来
  的那些名字 —— 读它，别假设你的替换品还在。

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

## 开发

```shell
pnpm install
pnpm run check     # typecheck + build + test + lint + format:check + check:release
```

`check` 就是 CI 跑的那六步，有一条红线钉住这个等价性：它曾经只跑前四项，于是本机全绿、推上去红了。

提交时还会自动修格式与 lint，配置在 [.pre-commit-config.yaml](.pre-commit-config.yaml)，用的是
`node_modules` 里已有的 `prettier` / `eslint`。每个克隆 `pre-commit install` 装一次
（`pre-commit` 本体另装，如 `uv tool install pre-commit`）。

宿主层那条路 —— 真的挂载、真的拉起受试体、真的命中故障 —— **不在** `check` 覆盖范围内，
而装上插件不等于它跑过。这些步骤是人工的，写在
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#6-真机验证不属于-pnpm-run-check)；验到哪一步了在
[AGENTS.md](AGENTS.md)。

## 用之前值得知道的

只留会改变实验的建议。依据 —— 记录为什么长这样、试过什么又否掉了什么 —— 在
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

- **跑之前先 `harness_inspect`。** 它不花钱，而且与 `harness_run` 走同一段解析：inspect 说行，
  run 跑的才是那个。
- **两件事免费问，一件事要花一次适配器调用。** 不带参数的 `harness_inspect` 只读本机；问某条路由有哪些
  模型则不是 —— 只有适配器知道回答它要不要去问远端。但带图之前还是该问，那是唯一说清「哪个模型收图」的地方。
- **`deny` / `fail` / `latency` 是三个不同的实验**，不是同一个设置的三个档：缺席、恢复、耐心。
- **一次只动一个变量。** 装配、路由、故障、附件、委派深度。任务不动 —— 这就是全部的意义。

## 许可

[MIT](LICENSE)
