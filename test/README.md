# test/ — 覆盖范围与运行

8 个文件 113 条。**不连宿主、不联网、不花额度**。约束见 [AGENTS.md](AGENTS.md)。

## 怎么跑

```bash
pnpm run test                                   # 全部
pnpm exec vitest run test/redlines.test.ts       # 只跑红线
pnpm exec vitest run -t 'B8'                     # 按红线编号
```

## 每个文件覆盖什么

| 文件 | 条数 | 覆盖 | 对应源码 |
|---|---|---|---|
| [redlines.test.ts](redlines.test.ts) | 55 | **红线 B1–B16**：本仓的宪法 | 横切全仓 |
| [harness.test.ts](harness.test.ts) | 17 | 路径候选、扩展名、捕获、挂载行、`file:` URL | [src/harness.ts](../src/harness.ts) |
| [fold.test.ts](fold.test.ts) | 12 | 事件折叠成确定性特征、缺数据 ≠ 0 | [src/fold.ts](../src/fold.ts) |
| [shortcut.test.ts](shortcut.test.ts) | 9 | 捷径编译、工具排序、persona 变体 | [src/shortcut.ts](../src/shortcut.ts) |
| [fault.test.ts](fault.test.ts) | 7 | 三种故障模式、可达性校验 | [src/fault.ts](../src/fault.ts) |
| [record.test.ts](record.test.ts) | 6 | run 目录形状、`wx` 独占、`discard` | [src/record.ts](../src/record.ts) |
| [catalog.test.ts](catalog.test.ts) | 4 | 目录键、默认集、描述生成 | [src/catalog.ts](../src/catalog.ts) |
| [smoke.test.ts](smoke.test.ts) | 3 | 模块能 import、注册面存在 | [src/index.ts](../src/index.ts) |

## 红线 B1–B16 各管什么

| 编号 | 判据 |
|---|---|
| B1 | 捷径的键必须存在于工具目录 |
| B2 | 只有 `deny` / `fail` / `latency` 三种故障，且是三种不同实验 |
| B3 | 进程内不算统计（没有 `mean` / `stdev` / `pValue`） |
| B4 | 记录里不出现原文：凭据、prompt 正文、事件 JSON |
| B5 | 受试体空闲时不得开始 trial（零成本闸） |
| B6 | 不留残留：没跑到 trial 1 的 run 必须删目录 |
| B7 | 缺数据记成 `null`，不是 `0` |
| B8 | 捕获即证据：include 用 `file:` URL、挂原文件不挂副本、默认目录在 profile 内 |
| B9 | `pnpm run check` 必须等于 CI 的步骤集合 |
| B10 | `register()` 之后必须读回 `.broken` 才算挂载成功 |
| B11 | `harness_inspect` 能查已有 preset，且对不可用路由报警 |
| B12 | skill 由代码注册，且内容写清三个陷阱 |
| B13 | 一个词管一件事（源码无 `quick` / `assembly` / `effect` 等旧词） |
| B14 | 文档不指向已删文件、不提已退休的工具名 |
| B15 | 封起来的 harness 是完整工具集：遮罩行排在 harness 行之前 |
| B16 | 源码 import 的包必须在清单里声明；peer 与 dev 范围相同；有运行时导入的包必须 external |

## 已知盲区（**不是遗漏，是边界**）

单测**只跑纯函数**，所以下面这些永远在这里抓不到：

- **加载期**：`apply()` 里的每一行。`'fs' in TOOL_KEYS` 那次就栽在这里。
- **真机解析基准**：harness 文件的裸模块名能否 import —— 取决于文件位置，不是逻辑。
- **工具被模型调用的实际行为**：需要一次模型回合。

**发现一次真机缺陷，就在红线里补一条**——B8 的三条断言都是这么来的。
真机步骤见 [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) 的「真机验证」节。
