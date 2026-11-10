# dsh-harness-dispatcher — 维护索引

本文件只服务「在这个仓里怎么干活」。它不回退到别处，也不引用仓外路径。

**为什么这个仓必须自带本文件**：宿主按目录链注入规则，`git init` 之后本目录就是 project root，
链到本文件为止 —— 父目录的规则一个字都读不到。

- 版本以 [package.json](package.json) 的 `version` 为准。
- 未发布（`private: true`）。要发版时先补 `docs/PUBLISHING.md`（尚未创建），不要照别的仓抄。

## 这个仓做什么

把**子 Agent 的装配**当成受试对象（SUT）的评测台：

```
Model + Harness = Agent        →       我们给「Harness」打分，不给模型打分
```

- **受试变量**：System prompt（persona）、工具集（含故障注入）、模型路由。
- **控制变量**：任务集是输入，固定不动。
- **观测**：旁路折叠会话事件流，提取**确定性**特征（计数、布尔、耗时），不碰执行。
- **边界**：本仓**不做统计**。不在这里算 P 值、不做语义评分 —— 全部导出成 JSONL，外部（R / Python）去做。

**设计取舍与依据在 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**，决策记录在 [.agents/notes/](.agents/notes/)。
本文件只写「怎么干活」。

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
   跨实例递 schema 是静默失败面。**本仓因此不用 Projection 单元**（见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §4.2）。

**且**：`Session.snapshotEvents()` / `eventAt()` / `ownEvents()` 在**两侧都**标着
`@deprecated … new calls are prohibited`。**读会话事件一律走 `ctx.on('session/event')` 折叠。**


## 验证

```
pnpm run check     # typecheck + build + test
```

- `pnpm run typecheck` —— `tsc -p tsconfig.json`，**0 error** 是硬要求。
- `pnpm run test` —— 纯函数单测（fold / 归一化 / 特征提取）。**不连宿主、不联网、不花额度**。
- 需要真宿主的那类验证（装进 profile、拉起子 agent）**不属于** `pnpm run check`，
  它是人工步骤，见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 的「真机验证」节。
  **不许把「装上了」当成「验过了」** —— 装上只证明模块能 import。

## 改动影响路由

| 你改了 | 同批必须改 |
|---|---|
| 工具的名字 / 数量 / 参数 schema | [src/tools/](src/tools/) 的注册处 → [ARCHITECTURE 的「能力面」](docs/ARCHITECTURE.md#5-能力面) |
| Harness 配置的形状（字段增删改） | [src/harness.ts](src/harness.ts) → [ARCHITECTURE 的「Harness 是封闭词汇表」](docs/ARCHITECTURE.md#3-harness-是封闭词汇表不是自由-json) → [src/record.ts](src/record.ts) 里 `TrialRecord.harness` 的字段 |
| 工具目录新增一个键 | [src/catalog.ts](src/catalog.ts) → 单测的 `KNOWN` 集 → [ARCHITECTURE 的「Harness 是封闭词汇表」](docs/ARCHITECTURE.md#3-harness-是封闭词汇表不是自由-json) |
| 导出记录的字段 | [src/record.ts](src/record.ts) 的 `TrialRecord` → [ARCHITECTURE 的「数据出口只有两个函数」](docs/ARCHITECTURE.md#44-数据出口只有两个函数) |
| 观测折叠的语义（算什么特征） | [src/trace.ts](src/trace.ts) → 单测 → [ARCHITECTURE 的「折叠的边界是硬的」](docs/ARCHITECTURE.md#43-折叠的边界是硬的) |
| 故障模式（deny / fail / latency） | [src/gate.ts](src/gate.ts) 三条管线 → [ARCHITECTURE 的「三种故障是三个不同的实验」](docs/ARCHITECTURE.md#23-三种故障是三个不同的实验不是同一个设置的三个档) |
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

## 发布前

未定。`private: true` 时不要发。
