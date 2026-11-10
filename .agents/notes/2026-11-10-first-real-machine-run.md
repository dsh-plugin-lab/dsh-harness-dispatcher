# 2026-11-10 —— 首次真机验证：四个断言全部成立

## 这是什么的记录

MVP 落地后，把插件真的装进在跑 profile（`0.2.2-rc.1`）、真的拉起子 agent、真的注入故障。
记三件事：**装不上的那些**（判据漏在哪）、**跑出来的那两个记录**（行为对不对）、**还没验的**。

判据清单在 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md#6-真机验证不属于-pnpm-run-check)。

---

## 一、`pnpm run check` 全绿之后，装上仍然当场失败

**症状**：`install_bundle` 返回 `application: failed`，
`harness-dispatcher: defaultTools names an unknown catalog key "fs"`。

**原因**：我的加载期校验写成了

```ts
if (!(tool in TOOL_KEYS))   // TOOL_KEYS 是 Set
```

`in` 查的是**对象上的属性名**，不是 `Set` 的成员。`'fs' in new Set(['fs'])` **恒为 false**，
所以每一个默认工具键都被拒绝 —— 插件拒绝激活，而它自己的默认值恰好全是合法键。

**为什么类型检查和 36 个单测都没拦住**：`in` 与 `has` 都接受 `string`，类型上是合法的；
而单测覆盖的是 `normalize()`（它用 `TOOL_KEYS` 的**另一个**用法 `knownTools`，走的是 `Set.has`），
加载期的这条校验**从来没有测试**。

**修法与判据**：改成 `TOOL_KEYS.has(tool)`，并新增 [test/catalog.test.ts](../../test/catalog.test.ts)，
其中一条**专门钉住这个陷阱**：`expect(Object.hasOwn(TOOL_KEYS, 'fs')).toBe(false)`。
这样「`in` 与 `has` 答案不同」这件事被写成了断言，下一个人不会再写回去。

**教训（要带走的那一条）**：`pnpm run check` 全绿**只覆盖纯函数层**。
**加载期的每一行代码都不在它的覆盖里** —— 而加载期正是「插件根本起不来」的唯一入口。

---

## 二、两次真实跑动：装配确实是变量

同一任务（读 `package.json` 的 `name`）、同一模型、同一工具集，只改 Harness。
记录在 `<outputRoot>/<runId>/trials.jsonl`（下面两个 run 的 id 见提交时的说明）。

| | 干净基线 | 注入 `fail:read` |
|---|---|---|
| `harness.id` | `smoke-clean` | `smoke-fail-read` |
| `stopReason` | `completed` | `completed` |
| `wallMs` | **3 383** | **9 510** |
| `trace.toolCalls` | **1** | **3** |
| `trace.toolErrors` | **0** | **2** |
| `trace.byTool` | `read: {calls:1, errors:0}` | `read: {calls:2, errors:2}` + `pwsh: {calls:1, errors:0}` |
| `usage.inputTokens` | 21 396 | 41 926 |
| `finalText` | `dsh-harness-dispatcher` | `dsh-harness-dispatcher` |

**读法**（这是设计预测的行为，不是巧合）：

- 受试体先试 `read` → 被注入成失败 → **再试一次 `read`** → 再失败 → **绕道 `pwsh`** → 成功。
- 所以 `read` 的错误数 **恰好归因在 `read` 上**（而不是归到「某个 tool/result」），
  这是 `trace.ts` 用 `toolCallId → 发起该调用的工具名` 反查的结果，实测成立。
- **两个 `harness.id` 不同、行为不同** —— 「装配是自变量」这件事第一次有了实测证据。

**同时验证到的四件事**（一次跑动同时验）：
① preset 真的挂上了（fs + pwsh + persona 行）② persona 真的生效（记录里 `harness.persona` 是解析后的散文）
③ 故障闸门**只命中受试 session**、只命中被判定的那个工具 ④ 轨迹折叠与 token 记账正确。

---

## 三、一处已知的表达力缺口（不是 bug，是记录面）

注入的 `fail` 走的是 `tools/post-execute` 的 `block`，它把结果变成错误**但不带 `error` 字段**。
所以记录里 `lastToolErrorCode` / `lastToolErrorName` 是 `null`，而 `byTool.read.errors = 2` 是对的。

含义：**「工具真的抛错了」和「我们把它 block 成错误」在 `lastToolError*` 这两个字段上不可区分**。
计数层面可分（`deny`/`fail` 是记录里 `harness.faults` 明写的），所以要分开只能靠 join 装配。
**先不改**：加一个只为自己加的字段会把 `trace` 变成「一半是事实、一半是元数据」。
真要区分，应该在记录里加一个 `faultApplied: [{tool, mode, hits}]` —— 那是**下一步**，不是修 bug。

---

## 四、还没验的

- **`deny` / `latency` 两种模式**只做了单测（`normalize` 的分支），**没有真机跑过**。
- **`persona` 的四个变体**只验了 `terse`。
- **多 trial、并发、长跑（`ctx.jobs` 通道）**都没碰 —— 后台通道本来就还没实现。
- **`maxDepth > 1`**（让受试体自己再派活）没验。
- **`traceUnavailableReason`** 这条分支（collector 没布防 / session 不在 store）只在单测里存在。

**所以本仓现在的状态是：主路径真机通、边界全是单测。** 这个区别必须写清楚，
否则下一个人会把「单测绿了」当成「模式验过了」。
