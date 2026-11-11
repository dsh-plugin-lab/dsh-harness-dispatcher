# 2026-11-10 — 受试对象是 Harness，不是模型

状态：生效

## 背景

要研究的问题：**同一批任务，换一套「装配」（system prompt / 工具集 / 模型路由），
成功率与行为特征怎么变。**

这不是「给模型打分」，是「给 Harness 配置打分」。所以本仓的一切设计都服从一条：
**任务集是输入（控制变量），Harness 是变量。**

起点是四条指导思想：SUT、配置即代码、Agentic 调度、旁路观测。
下面记的是**把四条落在真实宿主上之后，哪条变了、为什么**。

## 结论

### 保留的三条

1. **SUT** —— `agentPreset` + `agentOptions` 本来就是 `startActivation` 的启动参数，
   不需要改宿主。
2. **配置即代码** —— `ctx.agentPresets.register(definition)` 能在**运行时**挂一棵真 Loader 树。
   这比预想的好：不必碰 profile 的 `cordis.patch.yml`（那是用户资产）。
3. **旁路观测** —— Projection 单元做确定性折叠，只记原始事实，不做语义判断。

### 改掉的一条：不让模型现编 Harness JSON

原设想是「主 Agent 当测试总监，听懂意图 → 组装 Harness 参数 → 调工具」。

**它会把实验设计的正确性押在模型每次都能正确生成嵌套 JSON 上**，而且失败了是**静默**的：
`{"deny":["wite"]}` 不报错，只是让故障注入什么都不做 —— 于是得到一组
「看起来跑过了」的干净数据。**最坏的一类错误是产生看起来有效的空结果。**

改法：`harness` 参数是一个**扁平枚举**（persona 档位 / 工具名列表 / 故障项），
取值由本仓的注册表预先定义好，模型只能在**已知合法**的组合里选。
自由 `EntryOptions[]` 保留为**逃生口**，默认不对模型暴露。

**判据**：枚举错不了，自由 JSON 会错；而且枚举让「同一份 Harness」能被两个独立 trial 复现 ——
这是「控制变量」的前提。

### 还没定的一条：后台任务

一个 trial 是一次完整子 agent 跑动，可能几分钟。同步版先做，`ctx.jobs.start` 通道第二步。
理由：后台任务多一层生命周期（取消权从 `exec.signal` 转给任务自己），
先把「参数 → 子 agent → 记录」这条链跑对，再加通道。

## 依据（都是读出来的，不是推断的）

- `spawn` provider 的能力位：`packages/subagent/subagent-spawn-in-process/src/index.ts:39-44`
  （`agentOptions` / `agentPreset` / `outputSchema` / `depthLimit` 全 true，`inheritsParentContext` false）。
- `fork` **不接受**独立 preset：`docs/subsystems/subagent.md:130`。
  → 评测里不能用 fork，它把父对话种进子 session，污染控制变量。
- 子 agent 审批被钉成 `never`：`packages/subagent/subagent/src/child-agent.ts:229-234`。
- preset 运行时注册与挂载：`packages/preset/agent-preset-registry/src/index.ts:81-122`、`mount.ts:204-216`。
- 挂载的五条硬约束（都抛错不警告）：`definition.ts:18-39`、`mount.ts:212-213`、`index.ts:84`。
- `tools.restrict()` 会校验工具名存在与否：`packages/core/tools/src/index.ts:1122-1126`。
  → 限制行必须排在工具行**之后**，否则整个 mount 失败。
- Projection 单元契约（同步、同引用、纯 JSON）：`packages/session/session-projection/src/index.ts:48-93`。

## 被推翻的两个「想当然」

1. **「host-only 投影更干净，就用它」** —— 错。`onEventChanged` 只对 **client-visible**
   单元触发，host-only 单元什么都不推。要么带 `wire`，要么退回监听 `session/event`。
   取法：`wire` + `summary: false`。
2. **「Projection 是挂在事件流上的探针」** —— 不是。它是**每会话整值**折叠：
   每个事件驱动每个单元，返回同一个引用表示「与我无关」。它能给出探针要的**结果**，
   但不是探针本身，也不该拿它当「随便挂点什么都行」的钩子。

## 硬边界

**进程里不做统计。** 不做均值、不做置信区间、不做语义评分。
记录只放「每个 trial 一行的确定性事实」；口径留给外部（R / Python）。
理由：统计口径会随研究设计变，而产物必须能被**另一个口径**重算。
