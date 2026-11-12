# test/ — 覆盖范围与运行

一览：**不连宿主、不联网、不花额度**。约束见 [AGENTS.md](AGENTS.md)，条数与覆盖随时会变，
以文件本身为准。

## 怎么跑

```bash
pnpm run test                                   # 全部
pnpm exec vitest run test/redlines.test.ts       # 只跑红线
pnpm exec vitest run -t 'B8'                     # 按红线编号
```

## 每个文件覆盖什么

| 文件 | 覆盖 | 对应源码 |
|---|---|---|
| [redlines.test.ts](redlines.test.ts) | **红线**（编号见下表）：本仓的宪法 | 横切全仓 |
| [harness.test.ts](harness.test.ts) | 路径候选、扩展名、捕获、挂载行、`file:` URL | [src/harness.ts](../src/harness.ts) |
| [fold.test.ts](fold.test.ts) | 事件折叠成确定性特征、缺数据 ≠ 0 | [src/fold.ts](../src/fold.ts) |
| [shortcut.test.ts](shortcut.test.ts) | 捷径编译、工具排序、persona 变体 | [src/shortcut.ts](../src/shortcut.ts) |
| [fault.test.ts](fault.test.ts) | 三种故障模式、可达性校验 | [src/fault.ts](../src/fault.ts) |
| [abort.test.ts](abort.test.ts) | 预算到点时挂/摘监听的两个边界：已 abort、已 detach | [src/abort.ts](../src/abort.ts) |
| [attachments.test.ts](attachments.test.ts) | 种类判定（扩展名）、图片路由的三条拒绝、文本在前/附件按序、记录只留身份、两条读上限 | [src/attachments.ts](../src/attachments.ts) |
| [jobs.test.ts](jobs.test.ts) | 三种 job 结局的映射：完成 / 被杀 / 失败（含"没抛异常的喊停也算被杀"），以及状态行只放一行 | [src/jobs.ts](../src/jobs.ts) |
| [record.test.ts](record.test.ts) | run 目录形状、`wx` 独占、`discard` | [src/record.ts](../src/record.ts) |
| [catalog.test.ts](catalog.test.ts) | 目录键、默认集、描述生成 | [src/catalog.ts](../src/catalog.ts) |
| [smoke.test.ts](smoke.test.ts) | 模块能 import、注册面存在 | [src/index.ts](../src/index.ts) |

`text.ts` 的三个导出（`contentBlocksOf` / `errorMessage` / `firstLine`）由各自调用方的测试覆盖
（`fold`、`attachments`、`jobs`、`record`），并有一条红线（**B31**）保证它们没有被抄第二份。

## 红线各管什么

| 编号 | 判据 |
|---|---|
| B1 | 捷径的键必须存在于工具目录 |
| B2 | 只有 `deny` / `fail` / `latency` 三种故障，且是三种不同实验 |
| B3 | 进程内不算统计（没有 `mean` / `stdev` / `pValue`） |
| B4 | 记录里不出现原文：凭据、prompt 正文（只存摘要）；而 `output` 是**整段**保存，不截断 |
| B5 | 受试体空闲时不得开始 trial（零成本闸） |
| B6 | 不留残留：没跑到 trial 1 的 run 必须删目录 |
| B7 | 缺数据记成 `null`，不是 `0` |
| B8 | 捕获即证据：include 用 `file:` URL、挂原文件不挂副本、默认目录在 profile 内 |
| B9 | `pnpm run check` 必须等于 CI 的步骤集合 |
| B10 | `register()` 之后必须读回 `.broken` 才算挂载成功 |
| B11 | `harness_inspect` 能查已有 preset，且对不可用路由报警 |
| B12 | skill 由代码注册，且内容写清一次实验能踩空的那些陷阱 |
| B13 | 一个词管一件事（源码无 `quick` / `assembly` / `effect` 等旧词） |
| B14 | 文档不指向已删文件、不提已退休的工具名、不描述记录里已经撤掉的字段（`interrupted` 这类） |
| B15 | 封起来的 harness 是完整工具集：遮罩行排在 harness 行之前 |
| B16 | 源码 import 的包必须在清单里声明；peer 与 dev 范围相同；有运行时导入的包必须 external |
| B17 | `surface` 报「受试体能到达的」，不是「注册表里有的」：无注册表 / 无可达 / 有名单三态可分；而且封印点过名的工具**连自造的也到不了**，探针要减掉 |
| B18 | 插件给宿主的注册由自己的 fiber 拥有（`ctx.effect`），失败不连累工具半边 |
| B19 | `sealed` 只承诺实测过的：遮工具，不遮技能，且限制写在会被读到的地方 |
| B20 | 造工具的行拒掉保留名、坏名字、空描述/空结果、坏参数；失败与延迟留给 `faults` |
| B21 | 零知识也能查：不带参数列出 preset 与 model route，默认排第一，坏的要连原因一起列出；列某条路由的模型是**另一个入口**（它要等适配器，不能拖累免费那一格） |
| B22 | skill 是一页纸：不超宿主裁剪阈值，每条「漏了就废掉一次实验」的事实都在；而且**只载读者能据此改变动作的事实** —— 特性与 schema 里已有的内容不进正文 |
| B23 | 预算到点就真的停住受试体（`dispose()`），且只有结果 `aborted` 才算 `timedOut`；已记录与已完成分开报数 |
| B24 | 注册出去的 skill 要**能加载**：带 `source` 与正文，不只是能列进目录 |
| B25 | 判定词只说实测到的：挂载了不出力的行是**警告**；文件摘要与指纹不共用「digest」一个词 |
| B26 | 后台 run 与前台 run 是同一个执行体；后台用 job 自己的取消信号；进度不带 `log` 通道（那个通道不进模型） |
| B27 | 附件不许静默降级：图片在开跑前查受试体路由（不支持就拒）、文件只是路径句柄、记录里只有身份没有字节 |
| B28 | 一次停止停一切：在飞的 trial 取消、后面的不再启动；前台被停后调用方看不到返回值（管线覆盖），别承诺部分摘要 |
| B29 | 没有东西绑死在一台机器上：宿主家走 `dshHomePath()`，仓里不出现任何人的用户目录；两个 README 互相可切换 |
| B30 | 宿主算过的就抄、不重算：`trace` 只剩投影给不出的三个计数；原始事件默认落盘，记录才可被另一口径重算 |
| B31 | 一个 helper 只有一个 home：源码里不许有两个同名函数定义（`apply` 是宿主契约，按名字豁免） |
| B33 | 零工具的受试体是可表达的（`tools: []` 合法，声明为空是消融是警告）；而「声明了行但一行都没被放行」仍是阻塞问题 |
| B34 | `never started` 必须带下一步：挂载失败只有这三个字时，补一句「裸模块名在哪解析」；已经说清成因的诊断不加话 |
| B35 | 生成控制属于刺激：`reasoning_effort` / `max_tokens` 进指纹、进记录、进 `agentOptions`，`null` 表示继承 |

## 已知盲区（**不是遗漏，是边界**）

单测**只跑纯函数**，所以下面这些永远在这里抓不到：

- **加载期**：`apply()` 里的每一行。`'fs' in TOOL_KEYS` 那次就栽在这里。
- **真机解析基准**：harness 文件的裸模块名能否 import —— 取决于文件位置，不是逻辑。
- **工具被模型调用的实际行为**：需要一次模型回合。

**发现一次真机缺陷，就在红线里补一条**——B8 的三条断言、B17–B19、B23、B24 都是这么来的。
2026-11-11 晚又补了三条：B26（`job.append` 的 `log` 通道不进模型）、B27（图片会被宿主静默换成占位
文本；附件参数 schema 要用宿主自己的编译器验）、B28（被喊停的 run 抛异常会把记录包成"失败"）。
B30 也是真机来的，但是另一类：**不是坏了，是两个数都对却叫同一个名字** —— 本仓的 `turns` 数与
`sessionStats.turns` 定义不同，同一条记录和同一个会话由此可以互相矛盾。

**B31 与 B14 的字段那条不是真机来的，是"扫一遍源码"来的**，它们挡的是另一类腐蚀：不是行为错了，
是同一件事被抄了四份、同一条旧事实留在了文档里，而**没有任何一处会自己报错**。这类断言的反向控制
尤其重要——第一版 B31 只统计**非导出**声明，于是 `text.ts` 里那个导出反而不会被当成一条定义，
重复永远配不上对；是反向控制把那个洞逼出来的。
真机步骤见 [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) 的「真机验证」节。
