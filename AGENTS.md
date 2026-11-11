# dsh-harness-dispatcher — 维护索引

本文件只服务「在这个仓里怎么干活」。它不回退到别处，也不引用仓外路径。

**为什么这个仓必须自带本文件**：宿主按目录链注入规则，`git init` 之后本目录就是 project root，
链到本文件为止 —— 父目录的规则一个字都读不到。

- 版本以 [package.json](package.json) 的 `version` 为准。
- **未发布到 npm**，但**保持可发布形状**（没有 `private: true` —— `check:release` 会拒绝它）。
  发版流程见 [docs/PUBLISHING.md](docs/PUBLISHING.md)。

## 这个仓做什么

把**子 Agent 的装配**当成受试对象（SUT）的评测台：

```
Model + Harness = Agent        →       我们给「Harness」打分，不给模型打分
```

- **受试变量**：子 agent 的整份装配 —— 凡是「一个插件能做的事」都能按 agent 单独改
  （提示段、工具、skills、中间件、模型路由）。硬上界是 **Host 服务层**（agent loop、持久化、
  模型适配器、审批策略）：改它等于改整个进程，不是改一个 agent。
  故障注入是**时变**变量，装在**工具管线**上，不在装配里。
- **控制变量**：任务集是输入，固定不动。
- **观测**：旁路折叠会话事件流，提取**确定性**特征（计数、布尔、耗时），不碰执行。
- **边界**：本仓**不做统计**。不在这里算 P 值、不做语义评分 —— 全部导出成 JSONL，外部（R / Python）去做。

**设计取舍与依据在 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**，决策记录在 [.agents/notes/](.agents/notes/)。
本文件只写「怎么干活」。

> **Harness = 一份插件行列表。** 它写在哪由作者定；跑的时候**逐字复制进 run 目录当证据**，
> 而**挂载的是操作者那份原文件**（副本所在目录不在模块解析基准上，挂副本会让每一行都 import 失败）。
> 两次跑是不是同一份装配，靠**受试体自己日志里被观测到的装配**来判（不是比文件）。
> 判据分「声明 / 生效 / 观测」三层，理由、出处与真机纠正见
> [.agents/notes/2026-11-11-harness-shape.md](.agents/notes/2026-11-11-harness-shape.md)。
>
> `harness.tools` / `harness.persona` 那几个标量是**糖**，编译成行列表并同样落盘 —— 它们**不是** harness
> 的定义。别再往它们上面加东西；要加就加成行列表能表达的东西。

## 宿主版本线（**动手前先现查**）

本机有两条线，**它们不是同一条**：源码检出（写代码时看的契约）与在跑的宿主（实际执行的那个）。
两侧差一个 patch 时，**同一个 API 的签名可以不同**。

- 在跑宿主：`dsh --version`
- 源码检出：`git -C <检出> log -1 --format=%h%n%d`
- **判据以「在跑的那一版」为准**，检出只用来读「为什么这么设计」。
- 两侧不一致时**不许照检出写代码**，先核在跑版的 `lib/**/*.d.ts`。

**2026-11-10 实测：两侧不同线**（在跑 `0.2.2-rc.1` / 检出 `dsh-v0.2.1-rc.3`），
差异 **11 处**，集中在两个包，会静默改变行为的三个是：

1. `ctx.sessionProjections.register()` 两个重载都返回 `Promise<ProjectionHandle<S>>`；
   检出侧是 `() => void`。照检出写会「编译通过、运行期拿不到值」。
2. `SessionProjectionStateMap` **检出有、在跑版不存在**；在跑版改用第二个重载表达 host-only 单元。
3. `session-projection` 等包**自带嵌套 `node_modules/zod@4.4.3`**，宿主顶层是 **4.6.7** ——
   跨实例递 schema 是静默失败面。**本仓因此不用 Projection 单元**（理由见
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 的「为什么**不用** Projection 单元」）。

**且**：`Session.snapshotEvents()` / `eventAt()` / `ownEvents()` 在**两侧都**标着
`@deprecated … new calls are prohibited`。**读会话事件一律走 `ctx.on('session/event')` 折叠。**


## 验证

```
pnpm run check     # typecheck + build + test + lint + format:check + check:release
```

**六步，就是 CI 那六步**（外加发布态断言）。这不是讲究：`check` 曾经只跑前四项，
于是手改过的源码没过 prettier，**本机全绿、推上去红了** —— 见
[.agents/notes/2026-11-11-local-check-must-equal-ci.md](.agents/notes/2026-11-11-local-check-must-equal-ci.md)。
**红线 B9 现在钉住这条等价性**：往 CI 加一步而忘了往 `check` 加，测试就红。

- `pnpm run typecheck` —— `tsc -p tsconfig.json`，**0 error** 是硬要求。
- `pnpm run build` —— tsdown，产物进 `lib/`（git 忽略，由 `files` 发布）。
- `pnpm run test` —— 纯函数单测 + **红线 14 组 49 条**（[test/redlines.test.ts](test/redlines.test.ts)）。
  **不连宿主、不联网、不花额度**。全部 8 个文件 107 条，覆盖范围见 [test/README.md](test/README.md)。
- `pnpm run lint` / `pnpm run format:check` —— eslint / prettier。**手改过源码就一定要跑**。
  两个实测过的坑：用字符串替换改文件很容易带上不合格式的换行，而它不会在任何地方报错；
  **PowerShell 的 `Get-Content`/`Set-Content` 往返会破坏字符**（2026-11-11 实测把 `*` 写成 `D`、
  `D` 写成 `i`，把 `harnessDir` 毁成 `harnessiir`），所以**改文件只用编辑工具，不要经过 shell 往返**。
- `pnpm run check:release` —— 发布态不变量（[scripts/check-release.mjs](scripts/check-release.mjs)）。
  **它拒绝 `private: true`**，所以本仓必须保持可发布形状。

**`pnpm run check` 不覆盖加载期**（`apply()` 里的每一行）—— 而加载期是「插件根本起不来」的唯一入口。
实测栽过：`'fs' in TOOL_KEYS`（`Set` 用 `in`，恒 false）让插件拒绝激活，而 check 全绿。
见 [首次真机验证](.agents/notes/2026-11-10-first-real-machine-run.md#一pnpm-run-check-全绿之后装上仍然当场失败)。

**红线做了反向控制**：把 `DEFAULT_TOOLS` 改成不存在的键、往源码注入一个 `mean()`，
对应断言各自变红后再复原。**「现在这条绿」和「这条判据有牙齿」是两件事**，后者要单独证。

需要真宿主的那类验证（装进 profile、拉起子 agent）**不属于** `pnpm run check`，
它是人工步骤，见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 的「真机验证」节。
**不许把「装上了」当成「验过了」** —— 装上只证明模块能 import。

### 跨仓：组织的判据会自动核到本仓

组织仓 `dsh-plugin-lab/.github` 的 `scripts/check-criteria.mjs` 按 **`dsh-` 前缀 + 清单有 `dsh` 字段**
**自动发现**插件仓，每周独立核一次。**新建或改名都不需要登记**，但**必须满足它**。

2026-11-10 首次核出 6 条（缺 `release.yml` 四条规则 / 缺 `release-drafter.yml` / 缺红线文件），
已全部补齐，现在 `14 checks, 0 new findings`。

- **核它要 `GITHUB_TOKEN`**：`GITHUB_TOKEN=$(gh auth token) node scripts/check-criteria.mjs`
  （不带 token 会匿名超时，**超时不是通过**）。
- **`release.yml` 不属于模板生成物**（取来之后**必须读一遍它断言了什么** ——
  它包含发布顺序、OIDC、tag 形状这些不可撤销的动作）。
  **2026-11-11 实测它带了别人的包名**：守卫写的是 `npm view "dsh-dsml-rescue@$VERSION"`，
  于是永远查到「已存在」→ 永远跳过发布 → **报成功但什么都没发**。已修。照抄兄弟仓的代价就是这个。

#### 怎么对齐（用组织仓自己的工具，不要凭记忆）

```bash
# 生成一份权威的 host-only 参考仓，然后逐字节比
node <组织仓>/scripts/scaffold.mjs <临时目录> --host-only --name dsh-harness-dispatcher
node <组织仓>/scripts/scaffold.mjs check <本仓路径>     # 期望 all byte-identical
```

`scaffold check` 只比**三个**身份件（`.node-version` / `release-drafter.yml` / `.prettierignore`）；
**其余文件要自己比**。2026-11-11 那次靠人工逐项比，抓出四处偏差，其中两处会伤到人：

| 文件 | 当时的偏差 | 后果 |
|---|---|---|
| `.gitignore` | **丢了 `*.local.yml`** | 凭据文件可能被提交 |
| `scripts/check-release.mjs` | 是**兄弟仓的旧版** | 发布断言落后于模板 |

#### 有意保留的偏离（**每条都要有理由，否则就是"这个仓特殊"**）

| 偏离 | 理由 |
|---|---|
| `test/smoke.test.ts` 不含模板的 `apply({})` 断言 | 本仓 `apply` 读四个服务，空 ctx 必抛；保留它会逼出永不发生的防御分支 |
| `check` 是六步（模板四步） | 修 CI 红根因，红线 B9 钉住 |
| `files` 含 [`README_zh.md`](README_zh.md) | 双语文档是实际惯例 |
| devDependencies 比模板多六个 `@deepseek-ai/*` | 本仓真的 import 它们；模板那份起始集它自己说**未经校验** |
| 没有 `docs/.gitkeep` / `.agents/notes/.gitkeep` | 两个目录都已非空，占位文件是噪音 |
| `vitest.config.ts` 不含 `contract-live-*` 排除 | 本仓没有 contract 测试 |



### 当前验证状态（**这个会漂，别复述成永久保证**）

- **主路径真机通过**（2026-11-10，宿主 `0.2.2-rc.1`）：装进 profile → 拉起子 agent →
  注入 `fail` → 记录落地。干净基线 1 次工具调用 / 0 错误 / 3.4s；
  注入后 3 次调用 / 2 错误 / 9.5s 且绕道 `pwsh`。**装配确实是变量。**
- **边界只在单测里**：`deny` / `latency` 两模式、persona 其余三档、多 trial、并发、
  `maxDepth > 1`、后台通道 —— **都没有真机跑过**。清单见
  [首次真机验证的「还没验的」](.agents/notes/2026-11-10-first-real-machine-run.md#四还没验的)。
- **加载期与 `cordis:include` 已真机确认**（2026-11-11）：插件行能激活、include 能解析并挂载
  文件里的行；同时纠正两个 Windows 缺陷（`file:` URL、不挂副本）。**工具被模型调用的端到端仍缺**
  （实验 profile 没有可用的模型路由）。见
  [Harness 的形状的「真机状态」](.agents/notes/2026-11-11-harness-shape.md#7-真机状态2026-11-11宿主-022-rc1)。

## 待办

- [ ] **给实验 profile 一条可用模型路由**，跑通 `harness_inspect` / `harness_run` 的端到端
      （工具要被调用到，必须有模型回合；当前卡在这里）。
- [ ] 真机验 `deny` / `latency` 两模式、persona 其余三档、多 trial、并发、`maxDepth > 1`、后台通道。
- [ ] `prompt` 仍是纯文本，没做成 `ContentBlock[]`（图 / 文件）。**已知缺口，不是已完成。**
- [ ] 本仓从未真机跑过 `{ preset: "standard" }` 那一支的 `harness_inspect`。

## 活跃坑

| 坑 | 后果 | 防线 |
|---|---|---|
| Windows 上传绝对路径给 `cordis:include` | `new URL` 把盘符当 scheme，行**永远挂不上** | 一律 `pathToFileURL()`，红线 **B8** |
| harness 文件放在 profile 树 / link 仓之外 | 每一行的裸模块名 `MODULE_NOT_FOUND` | `harnessDir` 默认在 profile 内，红线 **B8** |
| PowerShell `Get-Content`/`Set-Content` 往返 | **改坏字符**（`*`→`D`、`D`→`i`），类型检查只抓到一部分 | 只用编辑工具改文件 |
| `pnpm run check` 全绿 ≠ 插件能起来 | 加载期（`apply()`）不被任何单测覆盖 | 真机跑一次；见[首次真机验证](.agents/notes/2026-11-10-first-real-machine-run.md#一pnpm-run-check-全绿之后装上仍然当场失败) |
| 一次「看起来跑过了」的空实验 | 比一次报错贵得多 | 挂载 + 审计 + 探针在 trial 之前；红线 B5/B6 |

## 改动影响路由

**逐文件的影响面在 [src/README.md](src/README.md) 的「变更影响路由」。** 这里只留跨层的三条，
因为它们同时牵动文档与测试，不属于任何单个源码目录：

| 你在改的东西 | 同批必须改 |
|---|---|
| 工具的名字 / 数量 / 参数 schema | [src/tools/](src/tools/) 的注册处 → [能力面](docs/ARCHITECTURE.md#5-能力面) → [test/README.md](test/README.md) 的红线 B11/B14 |
| 给某个东西改名 | 红线 **B13/B14**：源码旧词与文档旧工具名两侧都兜住 |
| 依赖范围 | `engines.dsh` / `peerDependencies` / devDependencies **三处同批**，且逐字相同 |
| 任何文档 | 跑链接校验（见下），错误数保持 0 |

## 硬性纪律

1. **不在进程里算统计。** 本仓只产出「每个 trial 一行的确定性记录」。均值、置信区间、显著性一律外部算。
   理由：统计口径会随研究设计变，而本仓的产物必须能被**另一个口径**重算。
2. **不改宿主的行为。** 只用公开服务（`ctx.subagents` / `ctx.agentPresets` / 工具注册 / 事件）。
   需要改宿主才能测的东西，**说明它不是受试变量，而是要上报的缺陷**。
3. **不留全局副作用。** 每次评测临时挂载的 preset 必须在 `finally` 里 dispose；
   工具结束时不得残留限制、监听或临时目录。
4. **受试环境的失败要记成数据，不是异常。** 子 agent 跑挂了是**一个观测结果**（`stopReason`），
   不是本插件的 bug —— 只有「本插件自己坏了」才抛。
5. **凭据、会话内容不进导出记录。** 记录只放结构化的计数与短标签；prompt 原文另存且由调用方显式开启。
6. **输入快照同等对待凭据。** run 目录里的 `harness.<ext>` 是**逐字**副本，行 config 能装任何东西
   （包括 API key —— 本机 profile 的 patch 里就真有一个）。所以规矩要从「记录不带凭据」扩到
   **「harness 文件不许带凭据，因为它会被原样复制进证据」**。
   **不写启发式扫密钥**（会漏也会误报）；靠声明式纪律 + 让副本可见。

## 发布前

**未发布过。** 第一次发之前必须做的事，写在 [docs/PUBLISHING.md](docs/PUBLISHING.md) ——
那里不抄别的仓的版本号与判例，只写**本仓自己的前置条件**。
