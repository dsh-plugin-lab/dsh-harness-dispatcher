# .agents/notes/ — 目录结构与去哪查

6 篇记录。这一层装「为什么这么定」，不装「现在是什么」
（那是 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)），也不装「怎么干活」
（那是 [AGENTS.md](../../AGENTS.md)）。写入约束见 [AGENTS.md](AGENTS.md)。

## 目录里有什么

| 记录 | 类 | 回答什么 |
|---|---|---|
| [受试对象是 Harness，不是模型](2026-11-10-harness-as-the-subject.md) | 决策 | 为什么受试对象是 harness 而不是模型；受试变量与控制变量的边界 |
| [在跑宿主的扩展面核查](2026-11-10-host-api-surface-0.2.2-rc.1.md) | 依据 | 宿主 API 的签名与出处，每条带 `文件:行` |
| [首次真机验证](2026-11-10-first-real-machine-run.md) | 依据 | 四个断言成立，以及加载期那次翻车 |
| [Harness 的形状：判据从「声明」移到「观测」](2026-11-11-harness-shape.md) | 决策 | **核心判据**：harness 的文件形状、三层判据、真机纠正的两个缺陷 |
| [`check` 全绿不代表 CI 会绿](2026-11-11-local-check-must-equal-ci.md) | 依据 | 为什么本地检查必须等于 CI 六步（红线 B9 的来源） |
| [受试体里能放什么：一行能引用到什么](2026-11-11-what-a-row-can-reference.md) | 依据 | 行能引用宿主包 / 本仓 / 任意本地 `.js` / 非工具零件；封印让探针说谎的那个缺陷 |

## 按问题找

不按文件找，按你想知道什么找。**引用指向标题锚点，所以标题改名不必改这里的文字。**

| 你想知道 | 去哪 |
|---|---|
| harness 文件该长什么样、放哪 | [形状（已定）](2026-11-11-harness-shape.md#1-形状已定) |
| 为什么「跑的是不是同一份装配」不能靠比文件 | [判据三层](2026-11-11-harness-shape.md#3-判据三层) |
| 哪些设计被现实推翻了、代价是什么 | [被推翻的判断](2026-11-11-harness-shape.md#4-被推翻的判断保留证据价值) |
| `cordis:include` 到底能不能用、怎么用 | [真机状态](2026-11-11-harness-shape.md#7-真机状态2026-11-11宿主-022-rc1) |
| 落地时哪些设计被改过 | [落地状态](2026-11-11-harness-shape.md#6-落地状态) |
| 一行能引用到什么（本仓自己的工具、任意 `.js`、非工具零件） | [一行能引用到什么](2026-11-11-what-a-row-can-reference.md#结论) |
| 为什么封印之后探针报的工具比实际多 | [探针说谎的那个缺陷](2026-11-11-what-a-row-can-reference.md#缺陷封印会让探针说谎) |
| 宿主 API 的签名与出处 | [扩展面核查](2026-11-10-host-api-surface-0.2.2-rc.1.md) |
| 为什么本机绿了推上去红 | [`check` 全绿不代表 CI 会绿](2026-11-11-local-check-must-equal-ci.md) |

## 命名约定

- **决策类**：`YYYY-MM-DD-<主题>`，必须有 `## 替代方案（强制）`。
- **依据类**：沿用原名即可，日期可省；有下游决策时写 `## 支撑的决策` 指针。
- 文件名小写 kebab-case，**不用中文**——中文在标题里，不在路径里。

## 状态

每篇第 3 行是状态行，四值见 [AGENTS.md](AGENTS.md)。**归档就地标记，不建 `archived/`。**

## 参考

- 写入规则 → [AGENTS.md](AGENTS.md)
- 根索引 → [../../AGENTS.md](../../AGENTS.md)
- 设计现状 → [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)
