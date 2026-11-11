# 2026-11-10 —— 在跑宿主 0.2.2-rc.1 的扩展面核查

状态：生效

**这是一份证据档，不是规则。** 每条结论带 `文件:行` 出处。

**它为什么在这里**：本仓写代码时，源码检出（`dsh-v0.2.1-rc.3`）与在跑宿主（`0.2.2-rc.1`）**不是同一条线**，
两侧 API 实测差 **11 处**。照检出写会「编译通过、运行期静默坏」。这份核查就是那次对照的原始记录，
**再核一遍的成本很高，而它会漂 —— 换宿主版本时整份作废、必须重做**。

**什么时候该重读 / 重做**：`dsh --version` 变了，或任何一条结论与实测不符。

**已知的过期风险**：本档的出处行号只对 `0.2.2-rc.1` 成立。

---
# 宿主 API 面事实清单 —— 安装版 0.2.2-rc.1

**核查对象**：本机**正在运行**的宿主 `@deepseek-ai/dsh@0.2.2-rc.1`（`dsh --version` = `0.2.2-rc.1`）。
**唯一证据来源**：安装树的 `lib/**/*.d.ts`、各包 `package.json`、各包自带的说明文件。
**对照物**（仅用于 §9 差异对照，**不是**契约）：宿主源码检出，
`HEAD = 1f81c047fc`，`tag: dsh-v0.2.1-rc.3`（`git describe --tags` = `dsh-v0.2.1-rc.3`）。

**路径约定**：下文 `文件:行` 中的文件路径**相对于安装根**

```
<ROOT> = <`npm root -g`>\@deepseek-ai\dsh\node_modules\@deepseek-ai\
```

例如 `<ROOT>@deepseek-ai\dsh-session-projection\lib\types\index.d.ts:204` 简写为
`dsh-session-projection/lib/types/index.d.ts:204`。

**证据类型标注**（每条结论都带其一）：
`[d.ts]` = 逐字读自类型声明；`[README]` = 读自包 README（**推断**，非类型契约）；
`[检出侧]` = 读自 `deepseek-harness` 检出源码（**不得当 0.2.2-rc.1 契约用**）。

---

## 0 · 先说一件事故（必须交代）

核查过程中我误用 `write` 工具而非 `read`，把安装树里一个**真实文件**覆盖成了单字符 `x`：

```
<ROOT>dsh-agent-preset-registry\lib\types\index.d.ts   （原 6915 字节 → 被写成 1 字节）
```

**已完全复原，并已自证**：

1. 从 npm 本地缓存 `_cacache` 定位到 `dsh-agent-preset-registry@0.2.2-rc.1` 的**官方 tarball**
   （integrity `sha512-ODRb9BSGJ1OPsZvYSjsVwQkIV/Cr4GxbwJmAAMagtigVgWrF7rhpbRwHKoFNXb8qTOVVMToVQGP+6UTeINonMg==`，
   size 44131），解包取回原始 `index.d.ts`。
2. 复原后 `SHA256` 与 tarball 内原件**逐字节相同**：`0C23D399…47DF`，size 6915。
3. 对**整个包目录**做了全量比对（tarball 内每个文件 vs 安装树）：**mismatch count: 0**。

**未触碰任何被 git 跟踪的文件**；安装树其余部分未改动。此事记录在此以备你判断是否需要重装该包。

---

## 1 · `@deepseek-ai/dsh-session-projection`

包目录名 = 包名：`dsh-session-projection`。

### 1.1 校准样本：`register()` —— 两个重载**都**返回 `Promise<ProjectionHandle<S>>`

`[d.ts]` `dsh-session-projection/lib/types/index.d.ts:202-204`（client-visible 单元，`wire` 必填）：

```ts
    register<K extends keyof SessionProjectionMap, S>(definition: Omit<ProjectionDefinition<K, S>, 'wire'> & {
        wire: NonNullable<ProjectionDefinition<K, S>['wire']>;
    }): Promise<ProjectionHandle<S>>;
```

`[d.ts]` `dsh-session-projection/lib/types/index.d.ts:212-214`（host-only 单元，`wire` 禁填）：

```ts
    register<K extends string, S>(definition: ProjectionDefinition<K, S> & {
        key: Exclude<K, keyof SessionProjectionMap>;
    }): Promise<ProjectionHandle<S>>;
```

**deprecated 的到底是什么** —— `[d.ts]` `index.d.ts:200` 与 `:210` 的 JSDoc（两个重载各一句）：

```
     * @returns an awaitable yielding a ready handle; the callable runtime value is deprecated.
```

即：**`register` 方法本身未被标 `@deprecated`**；被废弃的是它**运行时返回值的"可调用"用法**。
`[README]` `dsh-session-projection/README.md`「Deprecated plugin compatibility」节说得更明白：
返回值的 `typeof` 是 `"function"`、`instanceof Promise` 为 **false**（可调用 thenable），
`await` 得到 handle，**调用**它则释放注册（旧用法，已废弃）。需要原生 Promise 时用 `Promise.resolve(registration)`。

> **给写代码的判据**：必须 `await` 后再用 handle；**不要把返回值当函数调用**，
> 也不要直接把它交给 `ctx.effect(...)`（README 明确 `Invalid effect` 的几种踩法）。

### 1.2 `ProjectionHandle<S>`（`index.d.ts:31-53`）

```ts
export interface ProjectionHandle<S> {
    stateOf(session: Session): S;
    readerFor(session: Session): () => S;
    dispose(): Promise<void>;
}
```

逐行：`stateOf` `:40`；`readerFor` `:47`；`dispose` `:52`。
`[d.ts]` `dispose` 返回 `Promise<void>`（`:52`）——**不是** `() => void`。
`[d.ts]` `readerFor` 注释（`:41-47`）：不读 state、不 prepare Session、不产生 I/O；reader **无 disposal 责任**；
解除注册后仍能按原 unit 继续折。`[README]` 同节与此一致（推断，非契约）。

### 1.3 注册表（`class SessionProjectionRegistry extends Service`，`index.d.ts:181`）

| 成员 | 完整签名原文 | 出处 |
|---|---|---|
| `onChanged` | `onChanged(listener: ProjectionChangeListener): () => void;` | `index.d.ts:234` |
| `onEventChanged` | `onEventChanged(listener: ProjectionEventChangeListener): () => void;` | `index.d.ts:245` |
| `snapshot` | `snapshot(session: Session, keys?: ProjectionKeySelection): ProjectionSnapshot;` | `index.d.ts:257` |
| `summaryKeys` | `summaryKeys(): ReadonlySet<Extract<keyof SessionProjectionMap, string>>;` | `index.d.ts:278` |
| `checkpoint` | `checkpoint(session: Session): ProjectionCheckpoint;` | `index.d.ts:300` |
| `restoreFloor` | `restoreFloor(checkpoint: ProjectionCheckpoint): SessionLogOffset \| undefined;` | `index.d.ts:317` |
| `viewCheckpoint` | `viewCheckpoint(checkpoint: ProjectionCheckpoint, keys?: ProjectionKeySelection): Partial<SessionProjectionMap>;` | `index.d.ts:329` |
| `restore` | `restore(checkpoint: ProjectionCheckpoint, events: readonly SessionEvent[], baseSeq: SessionLogOffset, header: SessionHeader, inheritedEventCount: SessionLogOffset): { snapshot: ProjectionSnapshot; checkpoint: ProjectionCheckpoint; };` | `index.d.ts:356-359` |
| `hydrate` | `hydrate(session: Session, checkpoint: ProjectionCheckpoint, events: readonly SessionEvent[], baseSeq: SessionLogOffset): ProjectionSnapshot;` | `index.d.ts:370` |
| `stateOf`（**注册表级，已废弃**） | `stateOf(session: Session, key: string): unknown;` —— `@deprecated`（`:225`） | `index.d.ts:227` |
| `cachedSnapshot`（**已废弃**） | `cachedSnapshot(session: Session, keys?: ProjectionKeySelection): ProjectionSnapshot \| undefined;` —— `@deprecated`（`:265`） | `index.d.ts:268` |

`[d.ts]` `onChanged` / `onEventChanged` 均返回 `() => void`（**同步** disposer），与 `dispose()` 的 `Promise<void>` **不同形** —— 别混。

监听器类型（`[d.ts]`）：
- `ProjectionChangeListener` `index.d.ts:118`：
  `(session: Session, key: Extract<keyof SessionProjectionMap, string>, value: unknown, seq: SessionSeq) => void`
- `ProjectionEventChangeListener` `index.d.ts:126-129`：
  `(session: Session, changes: readonly { readonly key: Extract<keyof SessionProjectionMap, string>; readonly val: unknown; }[], seq: SessionSeq) => void`
- `ProjectionSnapshot` `:141-146`：`{ asOfSeq: SessionSeqCursor; values: Partial<SessionProjectionMap>; }`
  （`asOfSeq` 空日志为 `-1`，`:142`）
- `ProjectionKeySelection` `:135`：`readonly string[] | ReadonlySet<string>`（元素为 `SessionProjectionMap` 的键）

**`ctx.sessionProjections` 的挂载点** —— `[d.ts]` `index.d.ts:23-27`：

```ts
declare module '@deepseek-ai/cordis' {
    interface Context {
        sessionProjections: SessionProjectionRegistry;
    }
}
```

### 1.4 `ProjectionDefinition` 完整字段（`index.d.ts:62-112`）

| 字段 | 完整签名原文 | 行 |
|---|---|---|
| `key` | `key: K;` | `:64` |
| `stateSchema` | `stateSchema: ZodType<S>;` | `:66` |
| `init` | `init(header: SessionHeader, inheritedEventCount: SessionLogOffset): NoInfer<S>;` | `:73` |
| `apply` | `apply(state: NoInfer<S>, event: SessionEvent): NoInfer<S>;` | `:82` |
| `wire?` | `wire?: K extends keyof SessionProjectionMap ? { viewSchema; view; summary? } : never;` | `:84-104` |
| `stateVersion` | `stateVersion: number;` | `:111` |

`wire` 块内部逐字（`index.d.ts:84-104`）：

```ts
    wire?: K extends keyof SessionProjectionMap ? {
        viewSchema: ZodType<SessionProjectionViewValue<SessionProjectionMap[K]>>;
        view(state: NoInfer<S>): SessionProjectionViewValue<SessionProjectionMap[K]>;
        summary?: boolean;
    } : never;
```

**`wire.summary` 在不在？→ 在。** `index.d.ts:103`，类型 `summary?: boolean`，JSDoc `@default true`（`:101`）。
语义（`[d.ts]` `:96-102`）：`wire.summary` 决定**运行时 key 集合**；而**类型层**由
`SessionProjectionSummaryExcluded` 标记决定。两者需人工保持一致（类型系统**不**强制配对，`:98-100` 明说）。
`[README]` 同结论（「The mark decides the client view type; `wire.summary` decides the runtime key set」）。

**`stateSchema` 用的是 `zod` 还是 schemastery 的 `z`？→ `zod`。**
`[d.ts]` `index.d.ts:20`：`import type { ZodType } from 'zod';`
该 d.ts **全篇没有** `import z from '@deepseek-ai/schemastery'`（对比：`dsh-tools/index.d.ts:3`、
`dsh-agent-preset-registry/index.d.ts:2`、`dsh-subagent/index.d.ts:32` 都有这行 —— 那些包的 **`Config`** 用 schemastery）。
`[d.ts]` `dsh-session-projection/lib/types/types.d.ts:10` 无 schemastery 引用；`storage-domain/lib/types/spec.d.ts:5-8`
的模块注释把这条分工写明了：「Record schemas are zod …; plugin `Config` stays schemastery.」

### 1.5 这个包的 `zod` 是**自己 node_modules 里的一份**，不是 peer

`[d.ts/package.json]` 三条证据：

1. `dsh-session-projection/package.json:37`：`"zod": "4.4.3"` —— 在 **`dependencies`** 段，
   **不在** `peerDependencies`（peer 段只有 `@deepseek-ai/dsh-session` 与 `@deepseek-ai/cordis`）。
2. 物理存在嵌套副本：`dsh-session-projection/node_modules/zod/package.json` → `version` = **`4.4.3`**。
3. 宿主安装树的**顶层** hoisted zod 是 **`4.6.7`**（`<ROOT>..\..\node_modules\zod\package.json`）。
   Node 解析优先命中包内嵌套副本 → 该包拿到的是 **4.4.3**，与你插件若装 4.6.x 拿到的**不是同一个 zod 实例**。

> **同族情况**（都自带嵌套 `node_modules/zod` = `4.4.3`）：`dsh-agent-preset-registry`、`dsh-subagent`、
> `dsh-agent`、`dsh-storage-domain`。**没有**嵌套副本的：`dsh-tools`、`dsh-session`（都不依赖 zod）。
> `[d.ts]` `dsh-tools/lib/types/schema.d.ts` 全篇无 `zod` 导入，其 schema 是**自制 JSON-Schema 方言**（`ParameterSchemaSpec` / `ValueSchemaSpec`）。

**风险（推断，非契约）**：你插件里写 `z.object(...)` 交给 `register()`，若你的 zod 版本 ≠ 4.4.3，
`instanceof` / 内部类标识可能对不上，而 `zod` 校验走 duck-typing（只调 `.parse`）时又能过 —— 属于「静默不一致」。
建议：`stateSchema` 用**类型标注**（`ZodType<S>`）而非跨版本实例断言，或显式对齐 4.4.3。

### 1.6 类型表与 module augmentation 目标

`[d.ts]` `dsh-session-projection/lib/types/types.d.ts`：

| 符号 | 定义 | 行 |
|---|---|---|
| `SessionProjectionMap` | `export interface SessionProjectionMap {}`（空，merge 目标） | `:39-40` |
| `SessionProjectionViewValue<T>` | `T extends SessionProjectionSummaryExcluded<infer Value> ? Value : T` | `:46` |
| `SessionProjectionViewValues` | 映射表 | `:48-50` |
| `SessionProjectionSummaryExcluded<T>` | `T & { readonly [sessionProjectionSummaryExcluded]: true }` | `:29-31` |
| `SessionProjectionSummaryExcludedKey` | 键集合 | `:56-58` |
| `SessionProjectionSummaryValues` | `Omit<SessionProjectionViewValues, SessionProjectionSummaryExcludedKey>` | `:64` |
| `sessionProjectionSummaryExcluded` | `declare const …: unique symbol`（**仅类型**存在，运行时不存在，`:12-19`） | `:20` |

**`SessionProjectionStateMap` 在安装版里不存在。** 我对**整个安装树**的所有 `*.d.ts` 做了全文检索：
`SessionProjectionStateMap` → **0 命中**。见 §9。

**augmentation 目标模块名 = `@deepseek-ai/dsh-session-projection/types`** ✅（就是你猜的那个）
`[d.ts]` 三处实证：
- 该包自己的模块头：`types.d.ts:8` —— `@module @deepseek-ai/dsh-session-projection/types`，且 `:4-6` 写明
  「Domain packages may declare-merge through either the package root or this outlet — re-export preserves symbol identity」。
- 别人的实际写法：`dsh-agent-preset-registry/lib/types/types.d.ts:53-58`
  ```ts
  declare module '@deepseek-ai/dsh-session-projection/types' {
      interface SessionProjectionMap {
          agentPreset: string | null;
      }
  }
  ```
- 再一处：`dsh-agent/lib/types/types.d.ts:48-53`（`inbox: InboxWireState`）。
- 与该 outlet 对应的 `exports` 子路径：`package.json:21-24`（`"./types"` → `./lib/types/types.d.ts`）。

---

## 2 · `@deepseek-ai/dsh-agent-preset-registry`

包目录名 = 包名：`dsh-agent-preset-registry`。
`[d.ts]` 类声明：`index.d.ts:22` —— `export declare class AgentPresetRegistry extends TypertRemoteService {`
（**不是** `extends Service`；远程服务基类来自 `@deepseek-ai/dsh-typert-protocol`，`:3`）

### 2.1 `register(definition)` —— 完整签名

`[d.ts]` `dsh-agent-preset-registry/lib/types/index.d.ts:48-52`：

```ts
    /** Register and eagerly load a definition; activation failure remains visible in the roster.
     * @param definition Parsed configuration supplied by the declaring plugin.
     * @returns Definition disposer after activation or its diagnostic settles; the declaring plugin owns it.
     */
    register(definition: PresetDefinition): Promise<() => Promise<void>>;
```

注意返回是 **`Promise<() => Promise<void>>`** —— 内层 disposer 是 **async**，不是 `() => void`。
（与 `sessionProjections.register()` 的 `Promise<ProjectionHandle<S>>` 是**两种不同形状**，别套用同一套释放写法。）

### 2.2 `PresetDefinition` 全部字段

`[d.ts]` `dsh-agent-preset-registry/lib/types/definition.d.ts:4-13`（**共 5 个字段，逐字**）：

```ts
export interface PresetDefinition {
    readonly id: string;
    readonly name?: string;
    readonly description?: string;
    readonly order?: number;
    readonly plugins: readonly (Omit<EntryOptions, 'id' | 'disabled'> & {
        id?: string;
        disabled?: EntryOptions['disabled'] | JsExpr;
    })[];
}
```

**关键结论**：`PresetDefinition` 里**没有** `systemPrompt` / `tools` / `model` / `persona` 这类字段。
预设的"装配"全部表达为 `plugins`（一份 **Cordis entry list**，即 loader YAML 的条目数组，类型来自
`@deepseek-ai/cordis-plugin-loader`，`definition.d.ts:2`）。也就是说：**改 system prompt / 工具集 / 模型路由 =
往这份 entry list 里插/改插件行**，不是设某个字段。

配套导出 `[d.ts]` `definition.d.ts:19`：`export declare function entryListProblem(rows: unknown, at?: string): string | undefined;`
（校验 entry 列表，含嵌套 group）

### 2.3 其余要核的方法

`[d.ts]` 全部出自 `dsh-agent-preset-registry/lib/types/index.d.ts`：

| 方法 | 完整签名原文 | 行 |
|---|---|---|
| `mount` | `mount(ctx: Context, id?: string): Promise<AgentPreset>;` | `:99` |
| `acquireScope` | `acquireScope(id?: string): Promise<{ key: ScopeKey; } & AsyncDisposable>;` | `:137-139` |
| `resolve` | `resolve(id?: string): Promise<AgentPreset>;` | `:85` |
| `readDocument` | `readDocument(agentPreset: string): Promise<AgentPresetDocument>;` | `:90` |
| `list` | `list(): Promise<AgentPreset[]>;` | `:76` |
| `defaultId`（getter） | `get defaultId(): string;` | `:41` |
| `presetForSession` | `presetForSession(session: Session): string \| null;` | `:47` |
| `inspectCompositions` | `inspectCompositions(ctx?: Context): AgentPresetInspection[];` | `:72` |
| `remoteExportList` | `remoteExportList(): Promise<AgentPresetRoster>;` | `:80` |
| `composeFrom` | `composeFrom(ctx: Context, parent: Context): string \| undefined;` | `:105` |
| `composedPreset` | `composedPreset(ctx: Context): string \| undefined;` | `:110` |
| `serviceFor` | `serviceFor<K extends string & keyof Context>(agent: { ctx: Context; }, name: K): Context[K] \| undefined;` | `:116-118` |
| `recompose` | `recompose(ctx: Context, id: string): Promise<AgentPreset>;` | `:124` |
| `select` | `select(agent: Agent, agentPreset: string): Promise<string>;` | `:132` |
| `compositionInventory` | `compositionInventory(): Promise<AgentPresetComposition[]>;` | `:143` |

`acquireScope` 返回 **`{ key: ScopeKey } & AsyncDisposable`** —— 释放走 `await using` / 手动 `[Symbol.asyncDispose]()`，
不是返回值当函数调。`[d.ts]` JSDoc `:133-136`：「dispose it after the scoped read completes」。

**挂载点** `[d.ts]` `index.d.ts:16-20`：`declare module '@deepseek-ai/cordis' { interface Context { agentPresets: AgentPresetRegistry; } }`

相关数据类型（`[d.ts]`）：
- `AgentPreset` `lib/types/preset.d.ts:4-10`：`id` / `name?` / `description?` / `order?` / `broken?`
- `Config` `lib/types/preset.d.ts:12-17`：`default: string;` + `selectedDefault: Volatile<string | undefined>;`
- `AgentPresetDocument` `lib/types/types.d.ts:24-33`：`agentPreset: string; content: string; name?: string; description?: string;`
  （`content` = entry-list **YAML 文本**，`:27`）
- `PresetMount` `lib/types/mount.d.ts:7-16`：`presetId` / `fiber: Fiber` / `tree: EntryTree` / `key: ScopeKey | undefined`
- `mountPreset(...)` `lib/types/mount.d.ts:76`：
  `export declare function mountPreset(ctx: Context, id: string, plugins: PresetDefinition['plugins']): Promise<PresetMount>;`
  —— 这是个**可直接调的导出函数**，做"临时挂一个 preset 做评测"可能比 `register()` 更轻。

---

## 3 · `@deepseek-ai/dsh-subagent`

包目录名 = 包名：`dsh-subagent`。
`[d.ts]` `index.d.ts:105`：`export declare class SubagentRuntime extends TypertRemoteService {`
挂载点 `[d.ts]` `index.d.ts:60-62`：`subagents: SubagentRuntime;`

### 3.1 `startActivation` 的两个重载

`[d.ts]` `dsh-subagent/lib/types/index.d.ts:136-140`（local 子 agent，带保留 id）：

```ts
    startActivation(spec: SubagentActivationSpec & {
        readonly childId: SessionId;
    }): Promise<SubagentActivation & {
        readonly messageId: MessageId;
    }>;
```

`[d.ts]` `dsh-subagent/lib/types/index.d.ts:146`（local 或 external）：

```ts
    startActivation(spec: SubagentActivationSpec): Promise<SubagentActivation>;
```

差异只在：**传 `childId` ⇒ 返回值多一个非可选 `messageId`**。不传 ⇒ `SubagentActivation.messageId` 是可选。

### 3.2 `SubagentActivationSpec`（`lib/types/types.d.ts:25-38`，6 字段逐字）

```ts
export interface SubagentActivationSpec {
    readonly provider: string;
    readonly label: string;
    readonly childId?: SessionId;
    readonly request: Omit<SubagentStartRequest, 'label' | 'signal'>;
    readonly signal: AbortSignal;
    readonly delivery: 'parent' | 'caller';
}
```

注意 `request` 是 **`Omit<SubagentStartRequest, 'label' | 'signal'>`** —— `label` 与 `signal` 提到外层了，
`request` 里**不能**再给这两个（给了是类型错）。

### 3.3 `SubagentStartRequest`（`lib/types/types.d.ts:127-174`，9 字段）

| 字段 | 原文 | 行 |
|---|---|---|
| `cwd?` | `readonly cwd?: string;` | `:129` |
| `agentPreset?` | `readonly agentPreset?: string;` | `:135` |
| `label?` | `readonly label?: string;` | `:137` |
| `prompt` | `readonly prompt: ContentBlock[];` | `:139` |
| `parent` | `readonly parent: Agent;` | `:144` |
| `signal` | `readonly signal: AbortSignal;` | `:152` |
| `agentOptions?` | `readonly agentOptions?: AgentOptions;` | `:160` |
| `outputSchema?` | `readonly outputSchema?: ObjectJsonSchema;` | `:166` |
| `maxDepth?` | `readonly maxDepth?: number;` | `:173` |

### 3.4 `SubagentActivation`（`lib/types/types.d.ts:40-52`）

```ts
export interface SubagentActivation {
    readonly childId: SessionId;
    readonly messageId?: MessageId;
    readonly result: Promise<SubagentResult>;
    dispose(): Promise<void>;
}
```
逐行：`childId` `:42`；`messageId?` `:44`；`result` `:49`；`dispose()` `:51`。
`[d.ts]` 语义（`:45-48`）：`result` **不会**因 child 级失败而 reject（那是 `stopReason` 的事），
只有 "infrastructure fault the seam cannot represent as a stop reason" 才 reject。

### 3.5 `SubagentResult`（`lib/types/types.d.ts:237-263`）

```ts
export interface SubagentResult {
    readonly output: readonly ContentBlock[];
    readonly structured?: unknown;
    readonly diagnostic?: string;
    readonly stopReason: SubagentStopReason;
}
```
逐行：`output` `:244`；`structured?` `:253`；`diagnostic?` `:260`；`stopReason` `:262`。
`[d.ts]` `diagnostic` 有**硬上限 4096 UTF-8 字节**（`:256-258`）—— 记录到导出数据时要留意截断。

### 3.6 `SubagentStopReason`（merge-extensible）

`[d.ts]` `lib/types/types.d.ts:220-231`：

```ts
export interface SubagentStopReasonMap {
    completed: 'completed';
    aborted: 'aborted';
    error: 'error';
    'max-tokens': 'max-tokens';
    refusal: 'refusal';
}
```
`[d.ts]` `:233`：`export type SubagentStopReason = SubagentStopReasonMap[keyof SubagentStopReasonMap];`
**5 个已知取值**：`'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'`。
`[d.ts]` `:215-218` 明确它是 merge-extensible：后端可合并新变体 → **消费方要 `default` 兜底**，
不能写 `switch` 穷尽（这正是你们"受试环境失败要记成数据"要的字段）。

### 3.7 `Capabilities` —— 真实类型名是 `SubagentCapabilities`

⚠️ **安装树里没有叫 `Capabilities` 的导出类型**。真实名字：

`[d.ts]` `lib/types/types.d.ts:115-121`（逐字，**4 个布尔**）：

```ts
export interface SubagentCapabilities {
    readonly agentOptions: boolean;
    /** Supports selecting a preset independently of the parent's composition. */
    readonly agentPreset: boolean;
    readonly outputSchema: boolean;
    readonly depthLimit: boolean;
}
```

**字段名**：provider 上叫 **`capabilities`**。
`[d.ts]` `lib/types/types.d.ts:296-300`：

```ts
export interface SubagentProvider {
    readonly name: string;
    /** The start-time features this provider supports (see {@link SubagentCapabilities}). */
    readonly capabilities: SubagentCapabilities;
```

另外 provider 上还有两个**必读**字段（评测台要用）：
- `[d.ts]` `:306`：`readonly inheritsParentContext: boolean;` —— 子 agent 是否看得到父的已完成轮次前缀
  （`:301-305` 强调它是 descriptive、**不是** service 校验过的 start capability）。
- `[d.ts]` `:313-316`：`readonly agentRouteDefaults?: Readonly<{ provider: string; model: string; }>;`
- `[d.ts]` `:326`：`start?(request: ResolvedSubagentStartRequest): Promise<SubagentRun>;`（**optional**）
- `[d.ts]` `:341`：`prepareContinuable?(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec>;`
  —— 方法存在即选 local activation 执行路径（`:330-332`）。

`[d.ts]` 运行期能力校验：`lib/types/index.js:441-451`（`assertCapabilities`）—— `agentPreset` 被
`!capabilities.agentPreset || inheritsParentContext` 拦；其余按 flag 逐个查。
（这一条来自 `.js` 不是 `.d.ts`，标注为**实现旁证**。）

---

## 4 · `@deepseek-ai/dsh-tools`

包目录名 = 包名：`dsh-tools`。

### 4.1 `defineTool` 签名

`[d.ts]` `dsh-tools/lib/types/schema.d.ts:248`：

```ts
export declare function defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(options: DefineToolOptions<S, O>): ToolDefinition;
```

`DefineToolOptions` `[d.ts]` `schema.d.ts:178-240`，关键字段逐字：

| 字段 | 原文 | 行 |
|---|---|---|
| `name` | `readonly name: string;` | `:180` |
| `description` | `readonly description: string;` | `:182` |
| `parameters` | `readonly parameters: S;` | `:184` |
| `output` | `readonly output: { readonly schema: O; render(args: InferArgs<S>, value: InferValue<NoInfer<O>>): ContentBlock[]; presentationMeta?(args: InferArgs<S>, value: InferValue<NoInfer<O>>): JsonValue; };` | `:186-193` |
| `deferLoading?` | `readonly deferLoading?: true;` | `:195` |
| `timeoutMs?` | `readonly timeoutMs?: number;` | `:197` |
| `isConcurrencySafe?` | `isConcurrencySafe?(args: InferArgs<S>): boolean;` | `:203` |
| `execute` | `execute(args: InferArgs<S>, exec: ToolRunContext): Promise<InferValue<NoInfer<O>>>;` | `:210` |
| `projectContent?` | `projectContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] \| undefined;` | `:217` |
| `finalizeContent?` | `finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] \| undefined;` | `:226` |
| `presentCall?` | `presentCall?(args: InferArgs<S>): ToolCallView \| undefined;` | `:232` |
| `presentResult?` | `presentResult?(args: InferArgs<S>, result: ToolResult): ToolResultView \| undefined;` | `:239` |

写工具时 `output.schema` 用的是**作者方言** `ValueSchemaSpec`（`O`），`render` 由你提供。

### 4.2 `ToolDefinition` 关键字段（`lib/types/contracts.d.ts:23-99`）

```ts
export interface ToolDefinition extends ToolSchema {
    readonly output: ToolOutputDefinition;
    execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
    projectContent?(...): ContentBlock[] | undefined;
    finalizeContent?(...): ContentBlock[] | undefined;
    timeoutMs?: number;
    isConcurrencySafe?(args: unknown): boolean;
    presentCall?(args: unknown): ToolCallView | undefined;
    presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined;
}
```

`ToolOutputDefinition` `[d.ts]` `contracts.d.ts:14-21`（**注意这里是 raw JSON Schema，不是作者方言**）：

```ts
export interface ToolOutputDefinition {
    readonly schema: JsonSchemaNode;
    render(args: unknown, value: JsonValue): ContentBlock[];
    presentationMeta?(args: unknown, value: JsonValue): JsonValue;
}
```

逐行：`output` `:25`；`execute` `:36`；`projectContent?` `:46`；`finalizeContent?` `:58`；
`timeoutMs?` `:66`；`isConcurrencySafe?` `:80`；`presentCall?` `:90`；`presentResult?` `:98`。
`presentationMeta?` 在 `ToolOutputDefinition:20`。

**`timeoutMs` 的两条硬约束**（`[d.ts]` `contracts.d.ts:59-66`）：
① 由 `@deepseek-ai/dsh-tool-call-timeout-policy` 的 `tools/execute` wrapper 执行；**永远不发给模型**
（`schemas()` 只白名单 name/description/parameters）；
② 声明它 = 断言本工具把 `exec.signal` 转发给一个能随 abort 达到静默的协作式实现。
`isConcurrencySafe` `[d.ts]` `:67-80`：只有返回**严格 `true`** 才并入并行组；省略/异常/非 `true` 一律独占。
`projectContent` vs `finalizeContent` 的分界（`[d.ts]` `:37-46` / `:47-58`）：前者在 post-execute **之前**装内容、
策略替换仍权威；后者是**最后一步**、涵盖 pipeline 失败，必须 total 且不得 throw。

### 4.3 `ToolRuntime` 的真正身份

`[d.ts]` `dsh-tools/lib/types/index.d.ts:29`：`export declare class ToolsService extends Service {`
`[d.ts]` `dsh-tools/lib/types/index.d.ts:150`：`export { ToolsService as ToolRuntime };`

→ **`ToolRuntime` 是 `ToolsService` 的导出别名**，两者都能 `import`。安装版**同时**有这两个名字。

### 4.4 `ToolRuntime` 的四个方法

`[d.ts]` `dsh-tools/lib/types/index.d.ts`：

| 方法 | 完整签名原文 | 行 |
|---|---|---|
| `register` | `register(definition: ToolDefinition, options?: ToolRegistrationOptions): () => void;` | `:50` |
| `restrict` | `restrict(filter: ToolRestriction): () => void;` | `:58` |
| `guard` | `guard(guard: ToolGuard): () => void;` | `:136` |
| `schemas` | `schemas(scope?: ScopeKey, toolSet?: ResolvedToolSet): ToolSchema[];` | `:110` |
| （附）`definitions` | `definitions(scope?: ScopeKey, toolSet?: ResolvedToolSet): readonly ToolDefinition[];` | `:102` |
| （附）`checkGuards` | `checkGuards(exec: ToolExecution): string \| undefined;` | `:142` |
| （附）`setExecutor` | `setExecutor(executor: ToolExecutor): () => void;` | `:117` |
| （附）`resolve` | `resolve(context: ToolActivationContext): Promise<ResolvedToolSet>;` | `:95` |
| （附）`execute` | `execute(input: ToolBatchInput): Promise<ToolBatchResult>;` | `:130` |

⚠️ **`register` 第二个参数 `options?: ToolRegistrationOptions` 是 0.2.2-rc.1 的**（检出侧只有 1 个参数，见 §9）。
`ToolRegistrationOptions` `[d.ts]` `contracts.d.ts:110`（「Lifecycle-owned conditions for a registered tool」，
可做**按步激活条件** —— 评测台做"工具集受试变量"时这是关键接缝）。

### 4.5 `ToolRestriction`

`[d.ts]` `dsh-tools/lib/types/contracts.d.ts:360-365`（逐字）：

```ts
export interface ToolRestriction {
    readonly allow?: readonly string[];
    readonly deny?: readonly string[];
}
```

语义（`[d.ts]` `:356-359` + `index.d.ts:51-58`）：**每个 scope 一层、多层求交**；**不影响** scoped 注册
与保留的 PTC 传输名；空 filter / 未知名字 / scope-local 名字 / 保留名 都**报错**。
`ToolGuard` `[d.ts]` `contracts.d.ts:374`：`export type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined;`
—— **单调**：只能拒，不能把否决翻回允许（`:366-373`）。

---

## 5 · `@deepseek-ai/dsh-agent`

包目录名 = 包名：`dsh-agent`。

### 5.1 `Agent` 的字段 —— 分两处声明（**这是最容易踩的**）

`[d.ts]` **底座** `dsh-agent/lib/types/types.d.ts:12-15`：

```ts
export interface Agent {
    /** Session-backed Agent identity. */
    readonly id: SessionId;
}
```

`[d.ts]` **增强** `dsh-agent/lib/types/runtime-types.d.ts:163-176`
（`declare module './types.ts' { interface Agent { … } }`，即同一声明的第二段）：

| 字段 | 原文 | 行 |
|---|---|---|
| `id` | `readonly id: SessionId;`（在 `types.d.ts:14`） | — |
| `options` | `readonly options: AgentOptions;` | `runtime-types.d.ts:166` |
| `session` | `readonly session: Session;` | `runtime-types.d.ts:168` |
| `ctx` | `readonly ctx: Context;` | `runtime-types.d.ts:176` |
| `model` | `readonly model: Model;` | `:170` |
| `inbox` | `readonly inbox: Inbox;` | `:172` |
| `status` | `readonly status: AgentStatus;` | `:174` |
| `cancel()` | `cancel(cause: AgentCancelCause, options?: CancelOptions): void;` | `:184` |
| `whenIdle()` | `whenIdle(): Promise<void>;` | `:191` |

**后果**：只 `import type { Agent } from '@deepseek-ai/dsh-agent'` 拿到的是 `types.ts` 那一段 +
`runtime-types.ts` 的 merge —— 但 `runtime-types.ts` 的 merge 只在**它被加载**时生效。
`[d.ts]` `index.d.ts` / `runtime-types.d.ts` 的 re-export 关系决定你 `import` 哪个入口才带全字段。
实际用法（`[d.ts]` `dsh-agent-preset-registry/index.d.ts:116-118` 的 `serviceFor(agent: { ctx: Context })`）
说明 **`agent.ctx` 是别的包也在依赖的公共事实**。

`[d.ts]` `runtime-types.d.ts:176` 对 `ctx` 的语义：「its contributions are agent-local, unwind on disposal,
and reject registration afterward」→ **子 agent 的 `ctx` 上注册的东西随它销毁**，这是"临时挂载 preset / 工具"的正确落点。

### 5.2 `AgentOptions`（`lib/types/runtime-types.d.ts:27-36`，**4 个可选字段**）

```ts
export interface AgentOptions {
    provider?: string;
    model?: string;
    reasoningEffort?: ReasoningEffortId | undefined;
    maxTokens?: number;
}
```
逐行：`provider?` `:29`；`model?` `:31`；`reasoningEffort?` `:33`；`maxTokens?` `:35`。
`[d.ts]` `:22-26` 强调：merge-extensible，**路由字段可以是 live accessor**，
直到 Session 记录 selection 或 request 才快照取值 —— 所以读 `agent.options.model` 可能是**动态**的。

`[d.ts]` 相关：`CreateAgentOptions` `index.d.ts:49-106`（`sessionId` :51 / `parentAgent?` :53 /
`meta?` :65-72（`cwd`/`parentSession`/`isSeeded`/`origin`/`delegationDepth`/`agentPreset`）/
`inheritedEventCount?` :74 / `seed?` :81 / `agentOptions?` :83 / `signal?` :85 / `setup?` :105）；
`AgentHandle` `index.d.ts:145`。

---

## 6 · `@deepseek-ai/dsh-session`

包目录名 = 包名：`dsh-session`。

### 6.1 `Session` 的公开取值面（`lib/types/index.d.ts`，`class Session` 起于 `:139`）

| 成员 | 完整签名原文 | 行 | 状态 |
|---|---|---|---|
| `header` | `readonly header: SessionHeader;` | `:154` | 正常 |
| `seq` | `get seq(): SessionLogOffset;` | `:243` | 正常（`seq = log.length` 连续契约） |
| `deriveMessages` | `deriveMessages(): Message[];` | `:355` | 正常（缓存，尾部 O(new nodes)） |
| `eventAt` | `eventAt(seq: SessionSeq): SessionEvent \| undefined;` | `:217` | **`@deprecated`**（`:212`） |
| `snapshotEvents` | `snapshotEvents(fromSeq?: SessionLogOffset, toSeqExclusive?: SessionLogOffset): readonly SessionEvent[];` | `:228` | **`@deprecated`**（`:222`） |
| `ownEvents` | `ownEvents(): readonly SessionEvent[];` | `:235` | **`@deprecated`**（`:231`） |

⚠️ **三个同步读事件的方法全部标了 `@deprecated`**，注明「new calls are prohibited」，
指向 Agent Note `2026-09-09-deprecate-synchronous-session-event-reads.md`（`:213`）。

**未废弃的替代取值面**（同文件）：

| 成员 | 原文 | 行 |
|---|---|---|
| `surface` | `get surface(): SessionSurface;` | `:145` |
| `id` | `get id(): SessionId;` | `:158` |
| `inheritedEventCount` | `readonly inheritedEventCount: SessionLogOffset;` | `:156` |
| `firstLiveSeq` | `readonly firstLiveSeq: SessionLogOffset;` | `:172` |
| `firstLifecycleSeq` | `readonly firstLifecycleSeq: SessionLogOffset;` | `:178` |
| `append` | `append<T extends SessionEventType>(type: T, data: SessionEventMap[T], ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent<T>] : []): SessionEvent<T>;` | `:286` |
| `requestHeader` | `requestHeader(): EpochHeader \| undefined;` | `:311` |
| `requestContext` | `requestContext(): RequestContext \| undefined;` | `:320` |
| `toolHistory` | `toolHistory(): ToolHistory;` | `:330` |
| `deriveEventMessage` | `deriveEventMessage(event: SessionEvent): Message \| null;` | `:362` |

> **对评测台的直接影响（推断，非契约）**：如果你们的观测折叠打算调 `snapshotEvents()` 取轨迹，
> 那在 0.2.2-rc.1 上是**已废弃路径**。官方给的正路是
> **`ctx.sessionProjections.register()`**（旁路折事件流，`apply(state, event)`）—— 这也正好是 §1 那套 API。
> 即：**观测应该做成一个 projection unit，而不是轮询 `snapshotEvents()`**。

`SessionHeader` `[d.ts]` `lib/types/types.d.ts:59-99`：`version` `:64`（= `SESSION_FORMAT_VERSION`，
`:55` 值为 **4**）/ `id` `:66` / `createdAt` `:68` / `cwd?` `:70` / `parentSession?` `:76` /
`isSeeded` `:81` / `origin?` `:86` / `delegationDepth?` `:92` / `agentPreset?` `:99`。
—— 这 9 个字段就是"每 trial 的确定性元数据"可直接取的那一层（无 I/O）。

### 6.2 `sessions` 服务：`get(id)` / `list()` **都在**，且在 **`dsh-session`** 包

`[d.ts]` **挂载点** `dsh-session/lib/types/index.d.ts:26-30`：

```ts
declare module '@deepseek-ai/cordis' {
    interface Context {
        sessions: SessionStore;
    }
```

`[d.ts]` `class SessionStore extends Service` `:386`；`get` 与 `list`：

| 方法 | 完整签名原文 | 行 |
|---|---|---|
| `get` | `get(id: SessionId): Session \| undefined;` | `:502` |
| `list` | `list(): Session[];` | `:507` |

`[d.ts]` `list()` 语义（`:503-506`）：**所有 live session，按创建顺序；返回新数组**（改动不影响 store）。
`[d.ts]` `get` 语义（`:498-501`）：只认**live** entry；detached/prepared 对象一律查不到。
同文件其他公开面：`create` `:422`、`prepare` `:442`、`enter` `:466`、`announce` `:478`、
`flush` `:494`、`fork` `:524`、`registerMessageProjection` `:399`、`messageProjections` `:391`。

⚠️ **`sessions` 不在 `dsh-session-persistence` 里** —— 那是落盘后端。**别去错包找 `get`/`list`。**

---

## 7 · 「把评测数据写到磁盘」的官方面是哪个？

**结论：两个候选不是二选一，各管一段；而"数据集导出"本身没有一等公民 API。**

### 7.1 结构化 KV 记录 → `ctx.storageDomain`（`@deepseek-ai/dsh-storage-domain`）

`[d.ts]` 挂载点 `dsh-storage-domain/lib/types/index.d.ts:25-29`：

```ts
declare module '@deepseek-ai/cordis' {
    interface Context {
        storageDomain: DomainFacility;
    }
}
```

`[d.ts]` 导出清单 `index.d.ts:16`：`export { defineDomain, domainTable, descriptorOf } from './spec.ts';`

| 符号 | 完整签名原文 | 出处 |
|---|---|---|
| `defineDomain` | `export declare function defineDomain<S extends DomainSpec>(spec: S): S;` | `lib/types/spec.d.ts:93` |
| `domainTable` | `export declare function domainTable<K extends string, V>(schema: ZodType<V>): DomainTableSpec<K, V>;` | `lib/types/spec.d.ts:80` |
| `descriptorOf` | `export declare function descriptorOf(spec: DomainSpec): KvUnitDescriptor;` | `lib/types/spec.d.ts:99` |
| `DomainFacility.open` | `open<S extends DomainSpec>(spec: S): Promise<Domain<S>>;` | `lib/types/index.d.ts:83` |
| `Domain.table` | `table<N extends keyof S['tables'] & string>(name: N): KvTable<TableKeyOf<S, N>, TableValueOf<S, N>>;` | `lib/types/domain.d.ts:112` |
| `KvTable.put` | `put(key: K, value: V): Promise<void>;` | `lib/types/domain.d.ts:63` |
| `Domain.close` | `close(): Promise<void>;` | `lib/types/domain.d.ts:121` |

`DomainSpec` 完整字段 `[d.ts]` `lib/types/spec.d.ts:31-68`：`name` `:33` / `version` `:35` /
`layout?: 'single' \| 'per-record'` `:43` / `compatibleVersions?: readonly number[]` `:52` /
`invalidRecords?: 'backup-and-skip'` `:63` / `global?: DomainGlobalSpec<unknown>` `:65` / `tables` `:67`。
`[d.ts]` `:5-8` 的模块注释是本核查最强的分工证据：

> 「Record schemas are zod (…); plugin `Config` stays schemastery.」

`[README]` `dsh-storage-domain/README.md`「When to use it」：适用于「host-side data that must survive restarts
and stay valid against a schema」，并明确 **「Avoid it when the data belongs in a session event log —
the session persistence seam owns that surface.」** ← **这是 README 推断，不是类型契约。**

### 7.2 路径解析 → `@deepseek-ai/dsh-home-paths`（**包名不是 `dsh-util-home-paths`**）

**先确认真实包名**：安装树里 `dsh-util-home-paths` **不存在**（全树目录检索 0 命中）。
真名是 **`@deepseek-ai/dsh-home-paths`**，目录名 `dsh-home-paths`
（`[d.ts/package.json]` `dsh-home-paths/package.json:2`：`"name": "@deepseek-ai/dsh-home-paths"`）。

| 符号 | 完整签名原文 | 出处 |
|---|---|---|
| `dshHomePath` | `export declare function dshHomePath(...segments: string[]): string;` | `lib/types/index.d.ts:78` |
| `dshCachePath` | `export declare function dshCachePath(optionsOrSegment?: { dshHome?: string; } \| string, ...segments: string[]): string;` | `lib/types/index.d.ts:85-87` |
| `resolveDshHome` | `export declare function resolveDshHome(configured?: string, env?: Record<string, string \| undefined>): string;` | `lib/types/index.d.ts:59` |
| `defaultDshHome` | `export declare function defaultDshHome(): string;` | `lib/types/index.d.ts:36` |
| `expandHomePath` | `export declare function expandHomePath(path: string): string;` | `lib/types/index.d.ts:47` |
| `canonicalizeWatchPath` | `export declare function canonicalizeWatchPath(path: string): Promise<string>;` | `lib/types/index.d.ts:31` |
| `DSH_HOME_DIR_NAME` | `export declare const DSH_HOME_DIR_NAME = ".dsh";` | `lib/types/index.d.ts:7` |
| `DSH_HOME_ENV` | `export declare const DSH_HOME_ENV = "DSH_HOME";` | `lib/types/index.d.ts:11` |

**这个包只有路径计算，没有任何写文件 API**（`lib/types/index.d.ts` 全 106 行，无 I/O 方法）。
`[README]`：`kind: "package-library"`，「Use it as a **direct library dependency**, not through `cordis.yml`」
—— 即：它是**普通库**，不是插件，不需要 `ctx.` 接缝，不存在 `ctx.homePaths`。
依赖它的包（从各包 `package.json` 依赖表读出，共 8 个）：
`dsh-agent-instructions` / `dsh-anonymous-user-id` / `dsh-app-boot` / `dsh-attachment-local` /
`dsh-credentials-local` / `dsh-llm-deepseek` / `dsh-shell-env` / `dsh-skill-filesystem`。

### 7.3 那么评测台该用哪个？—— 按数据形状分

| 你要写的 | 官方接缝 | 依据 |
|---|---|---|
| **每 trial 一行的 JSONL（导出给 R/Python 重算）** | **没有一等公民 API** —— 自己 `fs.appendFile`，路径用 `dshHomePath(...)` / `dshCachePath(...)` 起 | 安装树无任何 "dataset/export append" 服务；`dsh-home-paths` 只给路径（`index.d.ts:78/85`） |
| **需要 schema 校验 + 重启存活 + 变更事件的结构化记录** | `ctx.storageDomain`（`defineDomain` + `domainTable` + `open`） | `storage-domain/lib/types/index.d.ts:16/25-29/83` |
| **超大文本（截断的 tool 结果一类）** | `ctx.spillStore`（`@deepseek-ai/dsh-spill`）的 `saveText` | `dsh-spill/lib/types/index.d.ts:41`（`abstract class SpillStore`）、`:48`（`abstract saveText(input: SaveTextSpill): Promise<SpillRef>;`）、`:21-22`（`spillStore: SpillStore`）—— **不**适合当数据集导出 |

**注意 `layout: 'per-record'`**（`spec.d.ts:37-43`）：适合「records are large, sparse, or individually
disposable — the projection cache」。若走 storageDomain 存 trial 记录，这条正对症。
**`invalidRecords: 'backup-and-skip'`**（`spec.d.ts:53-63`）：可疑记录挪走并继续打开 —— 对"导出数据要能容错"的场景有意义。

> **一句话**：路径用 `@deepseek-ai/dsh-home-paths`；结构化记录用 `@deepseek-ai/dsh-storage-domain`；
> **JSONL 数据集导出没有现成服务，自己写，但目录要经 `dshHomePath()` 免得和宿主数据根分叉**。

---

## 8 · 六个包（+2 个落盘相关包）的确切目录名与 `exports` 分层

### 8.1 目录名 vs 包名

**全部一致，没有"目录名 ≠ 包名"的情况**（原任务担心有些不同 —— 本版**没有**）：

| 包名 | 目录名 | 一致？ |
|---|---|---|
| `@deepseek-ai/dsh-session-projection` | `dsh-session-projection` | ✅ |
| `@deepseek-ai/dsh-agent-preset-registry` | `dsh-agent-preset-registry` | ✅ |
| `@deepseek-ai/dsh-subagent` | `dsh-subagent` | ✅ |
| `@deepseek-ai/dsh-tools` | `dsh-tools` | ✅ |
| `@deepseek-ai/dsh-agent` | `dsh-agent` | ✅ |
| `@deepseek-ai/dsh-session` | `dsh-session` | ✅ |
| `@deepseek-ai/dsh-storage-domain` | `dsh-storage-domain` | ✅ |
| `@deepseek-ai/dsh-home-paths` | `dsh-home-paths` | ✅（**注意不是 `dsh-util-home-paths`**） |

（`[d.ts/package.json]` 逐个读 `package.json:2` 的 `name` 与目录名比对。）

**唯一"名字会骗人"的地方是导出别名，不是目录名**：
`dsh-tools` 的类名叫 `ToolsService`，导出成 `ToolRuntime`（`lib/types/index.d.ts:29` + `:150`）。

### 8.2 `exports` 分层（逐包，`package.json` 原文）

**`dsh-session-projection`**（`package.json:16-27`）
`.` → `lib/types/index.d.ts` ｜ `./types` → `lib/types/types.d.ts` ｜ `./src/*` → `./src/*` ｜
`./package.json` ｜ `./locale/*.json`
`main` = `lib/index.js`（`:14`），`types` = `lib/types/index.d.ts`（`:15`）

**`dsh-agent-preset-registry`**（`package.json:16-39`）
`.` ｜ `./types` → `lib/types/types.d.ts` ｜ **`./display`** → `lib/types/display.d.ts` ｜
**`./typert`** → `lib/typert.host.d.ts` ｜ **`./remote`** → `lib/typert.remote-client.d.ts` ｜
`./src/*` ｜ `./package.json` ｜ `./locale/*.json`

**`dsh-subagent`**（`package.json:16-39`）
`.` ｜ **`./internal`** → `lib/types/internal.d.ts` ｜ **`./client`** → `lib/types/client.d.ts` ｜
**`./typert`** → `lib/typert.host.d.ts` ｜ **`./remote`** → `lib/typert.remote-client.d.ts` ｜
`./src/*` ｜ `./package.json` ｜ `./locale/*.json`
（**注意：没有 `./types`**，与 preset-registry / agent / session 不同）

**`dsh-tools`**（`package.json:16-33`）
`.` ｜ **`./presentation`** → `lib/types/presentation.d.ts` ｜ `./src/*` ｜ `./package.json` ｜
`./locale/*.json` ｜ **`./pipeline`** → `lib/types/pipeline.d.ts`
（**注意：没有 `./types`**）

**`dsh-agent`**（`package.json:16-27`）
`.` ｜ `./types` → `lib/types/types.d.ts` ｜ `./src/*` ｜ `./package.json` ｜ `./locale/*.json`

**`dsh-session`**（`package.json:16-35`）
`.` ｜ `./types` ｜ **`./fork`** → `lib/types/fork.d.ts` ｜ `./src/*` ｜ `./package.json` ｜
**`./surface`** → `lib/types/surface.d.ts` ｜ `./locale/*.json`

**`dsh-storage-domain`**（`package.json:16-24`）
`.` ｜ `./src/*` ｜ `./package.json` ｜ `./locale/*.json`

**`dsh-home-paths`**（`package.json:16-22`）
`.` ｜ `./src/*` ｜ `./package.json`（**唯一没有 locale 的**）

### 8.3 ⚠️ `./src/*` 是**悬空** export

`[d.ts/package.json]` 每个包都导出 `"./src/*": "./src/*"`，但 `files` 只发 `lib/**`。
实测：安装树里 `dsh-session-projection/src`、`dsh-tools/src`、`dsh-session/src` **都不存在**
（`Test-Path` 全 False）。

→ **`import ... from '@deepseek-ai/dsh-tools/src/schema.ts'` 在安装版会解析失败。**
这些子路径只有在**源码检出**里才有效。别照检出写 deep import。

---

## 9 · 【最有价值】检出有 / 安装版没有（与反向）

检出侧 = 宿主源码检出 @ `dsh-v0.2.1-rc.3`（`1f81c047fc`）。
下表每行都标了检出侧的**具体文件:行**，可复核。

### 9.1 `dsh-session-projection` —— 差异最密集，共 7 处

| # | 符号 / 形状 | 检出侧（v0.2.1-rc.3） | 安装版（0.2.2-rc.1） | 影响 |
|---|---|---|---|---|
| P1 | **`register()` 返回类型** | `() => void`（`packages/session/session-projection/src/index.ts:240`、`:252`、`:253-255` 实现） | `Promise<ProjectionHandle<S>>`（`lib/types/index.d.ts:204`、`:214`） | **致命**：照检出写 `ctx.effect(() => register(def))` 能编译；照安装版写才能拿到 `handle.stateOf` |
| P2 | **`ProjectionHandle<S>`** | **不存在**（`ProjectionHandle` 在 `src/*.ts` 0 命中） | `lib/types/index.d.ts:31-53`（含 `stateOf`/`readerFor`/`dispose`） | 安装版独有 |
| P3 | **`handle.readerFor(session)`** | **不存在**（0 命中） | `lib/types/index.d.ts:47` | 安装版独有 |
| P4 | **`onEventChanged`** | **不存在**（`packages/session` 全树 0 命中） | `lib/types/index.d.ts:245` | 安装版独有 |
| P5 | **`SessionProjectionStateMap`** | **存在**：`src/types.ts:24` `export interface SessionProjectionStateMap {}`；且 `ProjectionDefinition` 以它为键约束（`src/index.ts:49-50`） | **不存在**（全安装树 `*.d.ts` 0 命中）；`ProjectionDefinition<K extends string, S>`（`index.d.ts:62`），键约束改成 `keyof SessionProjectionMap` / `string` | **致命**：检出里"host-only 单元"靠 `SessionProjectionStateMap` 声明；安装版改成**第二个重载 + `key: Exclude<K, keyof SessionProjectionMap>`** |
| P6 | **`wire.summary?: boolean`** | **不存在**：检出的 `wire` 只有 `viewSchema` + `view`（`src/index.ts:73-86`，`viewSchema` 在 `:75`、`view` 在 `:84`） | **存在**：`index.d.ts:103`，`@default true`（`:101`） | 安装版独有（控制 summary 是否带该 key） |
| P7 | **`SessionProjectionSummaryExcluded` 家族**（`…Excluded` / `…ExcludedKey` / `…SummaryValues` / `sessionProjectionSummaryExcluded` 符号） | **全部不存在**（`packages/session/session-projection/src/*.ts` 内 `SummaryExcluded` 0 命中；`types.ts` 仅 24 行，只到 `SessionProjectionStateMap`） | `lib/types/types.d.ts:20`、`:29`、`:56`、`:64` | 安装版独有 |

**共有**（两版都有，不是差异）：`snapshot(session, keys?)`（检出 `src/index.ts:339` / 安装 `:257`）、
`cachedSnapshot`（`:363` / `:268`）、`viewCheckpoint`（`:449` / `:329`）、`restoreFloor`（`:426` / `:317`）、
`hydrate`（`:553` / `:370`）。
**仅检出侧有、安装版未核到**：`summaryKeys`（检出 `src/index.ts` 0 命中；安装版 `index.d.ts:278` 有）
→ 即 `summaryKeys()` 是**安装版新增**，不是检出侧有的东西。

> **校准样本的完整答案**：你给的那处差异**准确**。补充两点你没提到但同级重要：
> ① 两个重载**都**改成 `Promise<ProjectionHandle<S>>`（不只是某一个）；
> ② 被标 deprecated 的是**返回值的可调用用法**，`register` 方法本身没被标 `@deprecated`。

### 9.2 `dsh-tools` —— 4 处

| # | 符号 | 检出侧 | 安装版 | 影响 |
|---|---|---|---|---|
| T1 | **`ToolRegistrationOptions`** | **不存在**（`packages/core/tools/src` 全树 0 命中） | `lib/types/contracts.d.ts:110`；`register(definition, options?)`（`index.d.ts:50`） | **致命**：检出侧 `register(definition: ToolDefinition): () => void`（`src/index.ts:1071`，**单参**）；安装版**双参**。照检出写会丢掉"按步激活条件"这个接缝 |
| T2 | **`schemas` 第二参** | `schemas(scope?: ScopeKey): ToolSchema[]`（`src/index.ts:1268`，单参） | `schemas(scope?: ScopeKey, toolSet?: ResolvedToolSet): ToolSchema[]`（`index.d.ts:110`，双参） | 安装版多一个 step 准入集 |
| T3 | **类名 vs 导出名** | 类名就叫 **`ToolRuntime`**（`src/index.ts:808`，`export default ToolRuntime` `:1993`）；**无 `ToolsService`** | 类名 **`ToolsService`**（`index.d.ts:29`），`export { ToolsService as ToolRuntime }`（`:150`） | 两版都导出 `ToolRuntime`；但 `ToolsService` 这个名字**只有安装版有** |
| T4 | **`setExecutor`** | **未命中**（grep `setExecutor` 0 命中） | `index.d.ts:117` | 安装版独有 |

> T4 我标为"未命中"而非"不存在"：grep 的是缩进敏感的模式，可能漏。**如需承重请复核。**

### 9.3 `dsh-agent-preset-registry` —— **无差异**

`[检出侧]` `packages/preset/agent-preset-registry/src/index.ts:81`：
`async register(definition: PresetDefinition): Promise<() => Promise<void>> {` —— 与安装版 `index.d.ts:52` **逐字同形**。
`PresetDefinition`：检出 `src/definition.ts:4-13` 与安装 `lib/types/definition.d.ts:4-13` **字段完全一致**（5 个）。
`acquireScope`（检出 `:373`）、`readDefinition`→`readDocument`（检出 `:218`）、`mount`（`:281`）、
`list`（`:177`）、`resolve`（`:204`）**均存在且形状相同**。

### 9.4 `dsh-subagent` —— **主体无差异**

`startActivation` 两重载：检出 `src/index.ts:255` / `:262` 与安装 `index.d.ts:136` / `:146` **同形**。
`SubagentActivationSpec`（检出 `src/types.ts:25-38`）、`SubagentCapabilities`（4 布尔，检出 `src/types.ts` 内）、
`SubagentStartRequest` **均同形**。

### 9.5 `dsh-session` —— 表面**无差异**（但两边都废弃，别误判）

`eventAt` / `snapshotEvents` / `ownEvents` 在**检出侧也已 `@deprecated`**
（`packages/core/session/src/index.ts:706`、`:719`、`:738`）。
→ 这不是版本差异，**是 0.2.1 就开始了的迁移**。别把它当"检出旧的、安装新的"。

`SessionStore.get` / `list`：安装版有（`lib/types/index.d.ts:502`、`:507`）；检出侧我**未逐行核**（未核到）。

### 9.6 落盘面 —— `dsh-util-home-paths` 在**两版**都叫 `dsh-home-paths`

`dsh-util-home-paths` 在安装树 **0 命中**。任务描述里那个包名**本身就是错的**，不是版本差异
（这一条值得回传给 lead：如果哪份作业书写了 `@deepseek-ai/dsh-util-home-paths`，它在安装版**装不上**）。

---

## 10 · 会让「按检出写代码」踩坑的 Top 3（我的判断）

1. **`ctx.sessionProjections.register()` 的返回值**（§1.1 / §9.1-P1、P2、P5）
   照检出写 → 返回 `() => void`，拿不到 `handle.stateOf()`，且**投影类型的声明方式完全不同**
   （检出靠 `SessionProjectionStateMap`，安装版靠"第二个重载 + `key: Exclude<…>`"）。
   编译期就可能过（两边都被 Cordis effect 接受），运行期拿不到 state —— **静默**。

2. **`ctx.tools.register()` 的第二参 + 观测要改用 projection**（§4.4 / §9.2-T1）
   检出侧单参；安装版有 `ToolRegistrationOptions`（按步激活条件）—— 这是"工具集当受试变量"的核心接缝，
   照检出写等于**放弃这个能力**，但代码能跑、测试能绿。
   同族：`snapshotEvents()` 在两边都 deprecated，正确观测路径是 **projection unit**，不是轮询 session 事件。

3. **zod 实例版本错配 + `./src/*` 深导入**（§1.5 / §8.3）
   `session-projection` / `storage-domain` 等包**自带嵌套 `node_modules/zod@4.4.3`**，而宿主顶层是 `4.6.7`；
   你插件里的 zod 若不同版本，`stateSchema` 的校验走 duck-typing 能过、类标识却不同 —— 排错极难。
   同时**每个包都导出 `./src/*` 但都不发 `src/`**：照检出写 deep import 在安装版**直接解析失败**
   （这是唯一"会响"的一处，反而是安全网）。

---

## 11 · 未核到 / 明确留白

以下我没能给出带出处的结论，**不猜**：

- `dsh-session` 的 `SessionStore.get` / `list` 在**检出侧**的形状（未逐行核；不影响安装版结论）。
- `dsh-tools` 的 `setExecutor` / `resolve` 在**检出侧**是否存在（grep 未命中，但模式缩进敏感，可能漏）。
- `dsh-subagent` 除 `startActivation` 外的其余成员是否与检出全同（只核了 §3 点名的符号）。
- `dsh-agent` 的 `Agent` merge 段在检出侧的字段顺序（未核；安装版已给全）。
- npm 缓存 tarball 的完整性**只验证了 SHA256 与解包后比对**，未校验 npm 自身签名字段。

