# 2026-11-13 —— 子 agent activation 的 spec 在 rc.2 平铺

状态：生效

**这是一份依据档，不是规则。** 每条结论带出处；规则落在红线 **B36** 与根 [AGENTS.md](../../AGENTS.md)。

## 背景

真机（宿主 `0.2.2-rc.1` → `0.2.2-rc.2` 之后）调本仓 `harness_run`，整条起子代理的路直接报：

```
Error: Cannot read properties of undefined (reading id)
```

**不是** `SubagentError`，也**不是**一个 `stopReason` —— 是裸 `TypeError`，所以连「受试环境失败记成数据」
这条纪律都轮不到（纪律 4 说的是子 agent 跑挂，这里坏的是本插件自己的调用）。

同时 `pnpm check` 全绿：**本机绿与真机崩的差，全部落在一个 patch 版本上。**

## 结论

### 1. spec 从「嵌套」变成「平铺」

`[检出 dsh-v0.2.2-rc.2]` `packages/subagent/subagent/src/types.ts:29`：

```ts
export interface SubagentActivationSpec extends Omit<SubagentStartRequest, 'label' | 'signal'> {
  readonly provider: string
  readonly label: string
  readonly name?: string
  readonly childId?: SessionId
  readonly signal: AbortSignal
  readonly delivery: 'parent' | 'caller'
}
```

rc.1 是「外层 provider / label / childId / **request** / signal / delivery」，任务字段全在 `request` 里；
rc.2 把它们**提到顶层**，`prompt` / `parent` / `agentPreset` / `maxDepth` / `cwd` / `agentOptions` /
`outputSchema` 都直接挂在 `spec` 上。

### 2. 实现第一句就读 `spec.parent.id`

`[安装树]` `dsh-subagent/lib/index.js`（`async startActivation` 函数体第一段）：

```js
if (this.ctx.get("agents")?.get(spec.parent.id) !== spec.parent) throw new SubagentError(…, "UNAUTHORIZED")
```

传嵌套形状时 `spec.parent` 是 `undefined`，于是 `undefined.id` —— 这就是那个裸 `TypeError` 的出处。
**安装树与检出在这一点上同形**，所以不是「产物过期」。

### 3. 迁移指南只在 rc.2 的树里

`[检出 dsh-v0.2.2-rc.2]` `docs/upgrade-guide/v0.2.1-rc.2/subagent-activation-options/guide.zh.md`：
把 `request` 里的字段移到外层；有现成任务对象时 `request: task` → `...task`；`label` / `signal` 放在展开之后。
本地检出停在旧 tag 时**根本读不到这篇**，这也是它被漏掉的一半原因。

### 4. 服务方法删了一批，但本仓一处没用到

rc.2 删了 `drainChildren` / `listChildren` / `list` / `waitForChildren` / `interruptByParent`，
新增 `rootOf` / `namesOf` / `resolveName` / `waitForTreeWork` / `interruptByUser`。
全仓 grep 结果：本仓只用 `startActivation` 与 `activation.dispose()`，**没有一处碰到被删的方法**。
所以形状变化只体现在「实参怎么摆」这一处。

### 5. 版本面判不出来，这才是它活过 `pnpm check` 的原因

- `engines.dsh` 当时是 `^0.2.2-rc.1`，而**这个区间包含 rc.2** —— 满足声明的宿主换掉了形状。
- `devDependencies` 当时是 `0.2.2-rc.1`，那一版的 `SubagentActivationSpec` **还有** `request`，
  所以 `tsc` 对嵌套形状点了头。**typecheck 看的是装进来的那条 dev 线，而 dev 线比宿主慢了一个 patch。**

两侧证据（2026-11-13 实测，逐字比字节）：

| 文件 | SHA256 前 16 位 | 字节 |
|---|---|---|
| `node_modules/@deepseek-ai/dsh-subagent/lib/types/types.d.ts`（rc.2 dev 依赖） | `6CA5691A52FA26A4` | 16508 |
| 安装树同名文件（在跑宿主 rc.2） | `6CA5691A52FA26A4` | 16508 |

→ 抬高 dev 之后，**typecheck 读的那份 .d.ts 与在跑宿主逐字节相同**。这是「本机绿 ≈ 真机绿」在这一条上
唯一能给出的证据形态：不是「版本号相等」，是「判据用的那份声明相等」。

## 影响

- 调用点平铺（[src/trial.ts](../../src/trial.ts)），条件展开保持原样：`plan.cwd === null` 不传 `cwd`，
  没给 `agentOptions` / `outputSchema` 就不传这三个键 —— **别把 `undefined` 显式传进去**。
- 新增红线 **B36**：`src/trial.ts` 里 `startActivation` 的实参不许出现 `request:` 键。
  **理由是版本面判不出**，而 typecheck 会不会红取决于装的是哪条 dev 线 —— 它曾经就是这么绿的。
- 依赖三处同批抬到 `^0.2.2-rc.2`（`engines.dsh` / `peerDependencies` / `devDependencies`）。
- 反向控制（2026-11-13 实测）：把 `request:` 塞回去 —— 红线红；`tsc` **也**红（`request` 不在
  `SubagentActivationSpec` 里）。两者都会红，但只有红线**不随 dev 依赖的升降而变绿**，所以判据写成红线。
- 信号语义**没变**：`startActivation` 的 `signal` 仍只覆盖受理之前，停住子 agent 仍只有 `dispose()`
  （红线 B23 / B28 不动，[src/trial.ts](../../src/trial.ts) 里那两句注释仍然成立）。

## 支撑的决策

- 红线 **B36**（`test/redlines.test.ts`）：判据挂在调用形状上，而不是挂在类型检查上。
- 根 [AGENTS.md](../../AGENTS.md)「动手前必查：宿主版本线」：先核在跑版 `lib/**/*.d.ts`，
  **不要照检出写代码** —— 这一轮是「检出旧 tag 读不到迁移指南」的另一种形态。
