# dsh-harness-dispatcher — 维护索引

本文件只服务「在这个仓里怎么干活」。它不回退到别处，也不引用仓外路径。

**为什么这个仓必须自带本文件**：宿主按目录链注入规则，`git init` 之后本目录就是 project root，
链到本文件为止 —— 父目录的规则一个字都读不到。

版本以 [package.json](package.json) 的 `version` 为准。**未发布到 npm**，但保持可发布形状
（没有 `private: true` —— `check:release` 会拒绝它）。发布前置见 [docs/PUBLISHING.md](docs/PUBLISHING.md)。

## 这个仓做什么

把**子 Agent 的装配**当受试对象（SUT）的评测台：`Model + Harness = Agent`，我们给 Harness 打分，
不给模型打分。

- **受试变量**是整份装配（提示段、工具、skills、中间件、模型路由）；**任务集是输入**，不动。
- **观测**是旁路折叠会话事件，只取确定性特征（计数、布尔、耗时），不碰执行。
- **边界**：本仓**不做统计** —— 只产出每 trial 一行的记录，均值与显著性一律外部算。

定义与取舍在 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 的「① SUT」与「旁路观测」，决策在
[.agents/notes/](.agents/notes/)。**本文件只写怎么干活。**

### 判据：harness 是什么

**一份插件行列表。** 写在哪由作者定；跑时逐字复制进 run 目录**当证据**，而**挂的是操作者那份原文件**
（副本所在目录不在模块解析基准上，挂副本会让每一行都 import 失败）。两次跑是不是同一份装配，靠
**受试体自己日志里被观测到的装配**判，不比文件。判据分「声明 / 生效 / 观测」三层 —— 理由、出处与
两次真机纠正见 [.agents/notes/2026-11-11-harness-shape.md](.agents/notes/2026-11-11-harness-shape.md)。

`harness.tools` / `harness.persona` 那几个标量是**糖**，编译成行列表后同样落盘；它们**不是**定义，
别再往上面加东西。

**默认是增量，`sealed: true` 才封闭。** preset 住在宿主里，不 sealed 时受试体还继承宿主自己挂的工具
（本机几十个）—— 工具集是不是变量决定要不要 sealed。它靠 preset 里的一行 `src/sealed.ts`
实现（`tools.restrict`），**那一行必须排在 harness 行之前**（红线 **B15**），反过来受试体一个工具
都看不见。

**技能只能靠「不给通道」来关。** 宿主没有技能遮罩 API，同名条目也盖不掉（`register()` 落全局层、
同层先到者赢，实测三次失败）。受试体能看见技能的唯一前提是它**有 `skill` 工具**——宿主没这个工具
就不发目录。所以 `sealed` 遮掉宿主工具时 `skill` 一并消失，技能目录就不会到受试体手里；
**但 harness 自己挂 `tool-skill` 时那条行豁免于 restrict，继承的技能目录照样会漏，且拦不住。**
详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 的「增量与封闭」。

## 动手前必查：宿主版本线

源码检出（读契约）与在跑宿主（实际执行）**不是同一条线**，差一个 patch 就可能同 API 不同形状。

- 在跑宿主：`dsh --version`；源码检出：`git -C <检出> log -1`
- **判据以在跑的那版为准**，检出只用来读「为什么这么设计」。两侧不一致时**不许照检出写代码**，
  先核在跑版的 `lib/**/*.d.ts`。
- 两侧差异的**实测记录**（含会静默改变行为的那几条）在
  [宿主扩展面核查](.agents/notes/2026-11-10-host-api-surface-0.2.2-rc.1.md)。

**硬规则**：`snapshotEvents` / `eventAt` / `ownEvents` 在两侧都标着「新调用禁止」——
**读会话事件一律走 `ctx.on('session/event')` 折叠。**

## 验证

```bash
pnpm run check     # typecheck + build + test + lint + format:check + check:release
```

**六步就是 CI 那六步**，红线 **B9** 钉住这条等价性 —— `check` 曾只跑前四项，于是本机全绿、推上去红了
（[经过](.agents/notes/2026-11-11-local-check-must-equal-ci.md)）。

- `test` 是纯函数单测 + **红线**，**不连宿主、不联网、不花额度**。
  覆盖与红线清单见 [test/README.md](test/README.md)。
- **手改过源码就跑** `lint` / `format:check`。**改文件只用编辑工具**：PowerShell 的
  `Get-Content`/`Set-Content` 往返会改坏字符（实测把 `harnessDir` 毁成 `harnessiir`）。
- `check:release` 断言发布态不变量（[scripts/check-release.mjs](scripts/check-release.mjs)）。

**`pnpm run check` 不覆盖加载期**（`apply()` 里每一行），而加载期是「插件根本起不来」的唯一入口 ——
栽过：`'fs' in TOOL_KEYS`（`Set` 用 `in`，恒 false）拒绝激活而 check 全绿。
需要真宿主的验证（装进 profile、拉起子 agent）是**人工步骤**，见
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#6-真机验证不属于-pnpm-run-check)。
**不许把「装上了」当成「验过了」。**

**红线做过反向控制**：「现在这条绿」和「这条判据有牙齿」是两件事，后者要单独证。

## 当前验证状态（**会漂，别复述成永久保证**）

- **主路径真机通过**（2026-11-10）：装进 profile → 拉起子 agent → 注入 `fail` → 记录落地。
  干净基线 1 次调用 / 0 错误 / 3.4s；注入后 3 次 / 2 错误 / 9.5s。**装配确实是变量。**
- **加载期、`cordis:include`、`sealed` 已真机确认**（2026-11-11），并纠正两个 Windows 缺陷
  （`file:` URL、不挂副本）。封起来的极简 harness 只有 4 个工具，同一任务用 `read` 单打独斗
  134 次调用才得到答案 —— 见 [真机状态](.agents/notes/2026-11-11-harness-shape.md#7-真机状态2026-11-11宿主-022-rc1)。
- **边界也逐个真机跑过**（2026-11-11 第二批）：`deny` / `latency`（含「延迟加在没被调用的工具上
  会回到基线」的反向控制）、persona 四个变体、多 trial、两次重叠调用被串行化、`maxDepth: 2` 真的
  出现孙会话、故障点名不可达工具被拒、未达 trial 的 run 目录被删掉、超时真的停住了受试体。
  同一批里抓到并修掉四个缺陷：超时只标记不停止（红线 **B23**）、注册的技能能列出却**加载不了**
  （缺 `source`，红线 **B24**）、能跑的 harness 被判「不能跑」、文件摘要与指纹共用一个词（后两条 **B25**）。
- **后台通道已实现并真机验过**（2026-11-11 晚）：`run_in_background: true` 注册即返回、`job_output`
  读得到逐 trial 进度、完成通知自动到达、`job_kill` 之后记录保留且 preset 无残留。实现中发现
  `job.append` 的 `log` 通道**不进模型**（红线 **B26**）。
- **任务可以带附件**（2026-11-11 晚，**真机验过**）：`attachments` 兄弟参数，扩展名决定是图还是文件。
  图片要求**受试体自己的路由**声明 `image` 输入，否则**拒绝开跑**（宿主在这里会静默换成占位文本）；
  文件一律由宿主投影成一行"路径句柄"，永远不发内容。记录里只留身份（红线 **B27**）。
  真机证据：一个图 + 一个 CSV 的 trial，答案是「Blue; the codes sum to 10 (3 + 7)」—— 图片真的进了上下文，
  文件句柄真的被 `read` 跟着读了；把文件工具全部拿掉的 harness 仍然答对颜色（`echo` 是唯一工具、
  `toolCalls: 0`），证明图走的是**原生图片**而不是"靠工具补救"；路由不存在时在开跑前就被拒，且没留目录。
- **停止停一切**（2026-11-11 晚，**真机验过**）：
  主会话的停止与 `job_kill` 都会**取消在飞的那个 trial** 并记成 `aborted`，后面的一个都不再启动。
  只丢一个 trial 是**另一种意图**，宿主从那个子会话的页面直接给了（真机：连按两次中断，三条记录，
  run 照跑完）。前台被停时调用方**看不到**返回值 —— 宿主的工具管线会用 `Error: tool call aborted`
  覆盖它，所以磁盘记录是唯一的账（红线 **B28**）。
  真机证据（同一条命令跑了两次，两次结论相反，这就是设计改动的对照）：改之前按停止 —— 4 个 trial 的
  前台 run，trial 2 被**放过**、跑满 30.0s 记 `completed`，之后才停；改之后按停止 —— trial 1 正常
  `completed` 32.8s，trial 2 在 **10.6s** 处断掉记 `aborted`（`interrupted=true`、`timedOut=false`），
  请求 4 个只落 2 行，preset 无残留。
- **没验的**：无。

## 待办

- [ ] 附件的第二条边界：在一个**不声明 `image` 输入的**路由上带图，确认拒绝文案（本机只有一条
      声明了图的可用路由，这半边只能等换路由时补）。

## 活跃坑

| 坑 | 后果 | 防线 |
|---|---|---|
| Windows 传绝对路径给 `cordis:include` | 盘符被当 URL scheme，行**永远挂不上** | 一律 `pathToFileURL()`，红线 **B8** |
| harness 文件放在 profile 树 / link 仓之外 | 每一行的裸模块名 `MODULE_NOT_FOUND` | `harnessDir` 默认在 profile 内，红线 **B8** |
| preset 里写 `disabled: true` 想减宿主行 | **减不掉**：那只取消 preset 自己的行 | 要封闭就用 `sealed`，红线 **B15** |
| 技能注册在宿主层，受试体也看得见 | 考生拿到**本评测台的使用说明**，实验被污染 | 只给它没有 `skill` 工具的环境；遮不住，见上 |
| 插件注册的东西不用 `ctx.effect` 收 | 卸载后残留：热重载改了技能正文却仍是旧的 | 注册一律挂 fiber，红线 **B18** |
| 拿「注册表里有什么」当「受试体能调什么」 | 探针**回答的不是它名字承诺的问题**，读记录的人反着推断 | 探针只报能到达的，红线 **B17** |
| 以为同名条目能盖掉继承来的技能 | 实测三次都**盖不掉**（落全局层、先到者赢）；再这么写就是假封闭 | `sealed` 不承诺遮技能，红线 **B19** |
| 想靠 `inject: ['skills']` 拿 scope 绑定的注册表 | 那一行在 preset 里变 **PENDING**，`apply` 不执行也不报错 | 别注入它；`sealed` 只用 `tools` |
| 以为 `startActivation` 的 `signal` 能停住子 agent | 它只管**受理之前**；超时只写标记、受试体照跑（实测 700ms 预算 → 15.5s、`completed`） | 要停就 `dispose()`，且只在结果 `aborted` 时写 `timedOut`，红线 **B23** |
| 以为 `max_depth` 参数能让受试体再派活 | 上限来自**工具行自己的 `maxDepth`**；本机宿主默认 `0`，不写行配置就一个孙会话都起不来 | 在 harness 行里写 `maxDepth`，见[真机状态](.agents/notes/2026-11-11-harness-shape.md#7-真机状态2026-11-11宿主-022-rc1) |
| 以为 persona 行是**追加**人设 | 它用同一个 section 名注册，**替换**部署人设：系统提示只涨几十字符，容易误判成没生效 | 比 `modelInput.systemPrompt.digest`，别拿长度判 |
| 以为 `skills.register()` 过了就等于技能能用 | 注册只做**宽松**校验，加载正文时才要求 `source` 是字符串：目录里有它，`skill` 工具一调就报错（真机实测） | 注册对象带上 `source`，红线 **B24**（它真的调一次加载路径） |
| 把「有警告」写成「不能用」 | 判定词比检查更狠：一份**跑通了**的 harness 被判 `NOT runnable`，操作者会放弃它 | 阻塞问题与建议分开两级，红线 **B25** |
| 一个词指两个量（`digest`） | 文件摘要与刺激指纹都是 8 位十六进制，读者会以为文件被改过 | 各自命名：`file digest` / `fingerprint`，红线 **B25** |
| 以为 `job.append` 的内容模型能看到 | 宿主的 `log` 通道**只给观察者**：逐 trial 行写进去，`job_output` 一个字都读不到 | 要模型读就别带通道标签，红线 **B26** |
| 后台 run 用工具调用的 `signal` 收尾 | 调用已经返回，信号作废，`job_kill` 停不下来 | job 里用自己的 `AbortController`，红线 **B26** |
| 以为子 agent 会被父 agent 的停止带走，或者反过来以为它一定不会被带走 | 它有自己的 Session 与 turn，**什么都不会自动传下去**：既不自动被停，也不自动被放过 —— 两种行为都得**我们**做 | 一次停止就 `dispose()` 在飞的那个；只想丢一个 trial 请用子会话的中断，红线 **B28** |
| 以为被停的工具调用能返回自己的结果 | 宿主管线在取消后用 `Error: tool call aborted` **覆盖**工具结果，所以前台被停之后**只有磁盘记录**，别在文档里承诺"返回部分摘要" | 摘要只对后台 job 成立，红线 **B28** |
| 以为图片附件一定会进上下文 | 模型不声明 `image` 输入时，宿主把它**换成一行占位文本且不报错** —— 一次没看到图的 trial，记录看起来正常 | 开跑前查受试体自己的路由，不支持就拒，红线 **B27** |
| 以为文件附件会把内容发过去 | 宿主**永远不发文件字节**，只发一行"有个文件、多大、只读副本在 X"；受试体没有文件工具就白给 | 参数描述里写明这是"路径句柄"，红线 **B27** |
| PowerShell 往返改文件 | 改坏字符，类型检查只抓到一部分 | 只用编辑工具 |
| `check` 全绿 ≠ 插件能起来 | 加载期不被单测覆盖 | 真机跑一次 |
| 一次「看起来跑过了」的空实验 | 比一次报错贵得多 | 挂载 + 审计 + 探针在 trial 之前；红线 B5/B6 |

## 改动影响路由

**逐文件的影响面在 [src/README.md](src/README.md) 的「变更影响路由」。** 这里只留跨层的三条：

| 你在改的东西 | 同批必须改 |
|---|---|
| 工具的名字 / 数量 / 参数 schema | [src/tools/](src/tools/) 的注册处 → [能力面](docs/ARCHITECTURE.md#5-能力面) → 红线 B11/B14 |
| 新手能不能上手 | `harness_inspect` 不带参数的列表分支 → 红线 **B21** → [skills/dsh-harness-bench/SKILL.md](skills/dsh-harness-bench/SKILL.md) → 红线 **B22** |
| skill 正文 | [skills/](skills/AGENTS.md)：它是**运行时载荷**，不是文档；`check:release` 断言它随包发布 |
| 给某个东西改名 | 红线 **B13/B14** 兜住源码旧词与文档旧工具名 |
| 依赖范围 | `engines.dsh` / `peerDependencies` / devDependencies **三处同批**，逐字相同 |
| 任何文档 | 跑链接校验，错误数保持 0：`python <maintenance-flow>/check-markdown-links.py . --fragments --refs` |

## 硬性纪律

1. **不在进程里算统计。** 只产出每 trial 一行的确定性记录；统计口径会变，产物必须能被另一个口径重算。
2. **不改宿主的行为。** 只用公开服务（`ctx.tools` / `ctx.agentPresets` / `ctx.subagents` / 事件）。
   需要改宿主才能测的东西，**说明它不是受试变量，是要上报的缺陷**。
3. **不留全局副作用。** 临时 preset、故障门、探针租约都在 `finally` 里 dispose。
4. **受试环境的失败记成数据，不是异常。** 子 agent 跑挂了是观测结果（`stopReason`）；只有本插件自己坏了才抛。
5. **凭据、会话内容不进导出记录。** 只放结构化计数与短标签；prompt 原文另存且由调用方显式开启。
6. **输入快照同等对待凭据。** run 目录里的 `harness.<ext>` 是逐字副本，行 config 能装 API key ——
   所以**harness 文件不许带凭据**。不写启发式扫密钥（会漏也会误报），靠声明 + 让副本可见。

## 发布前

**未发布过。** 第一次发之前必须现查的事、以及与组织判据对齐的方法，都在
[docs/PUBLISHING.md](docs/PUBLISHING.md)。
