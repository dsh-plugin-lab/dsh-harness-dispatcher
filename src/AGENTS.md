# src/ — 规则层

继承根规则，见 [../AGENTS.md](../AGENTS.md)。本文件只写「在 `src/` 里改代码要遵守什么」，
不写「有哪些文件、改哪波及谁」—— 那是 [README.md](README.md) 的职责。

## 分层：谁能 import 谁

依赖方向**单向**，反过来就是设计坏了：

```
index.ts ─→ tools/ ─→ harness / shortcut / subject / trial / record / fold
                          ↓
                    catalog / digest / text / config / fault / gate / collector
```

- **`index.ts` 是唯一装配点。** 它注册工具、skill、提示段。别的东西不许调 `ctx.tools.define`。
- **纯函数层不碰 `ctx`。** `fold` / `digest` / `catalog` / `text` / `fault` 收数据、返数据，
  不注入服务 —— 这样它们能被单测直接跑，不需要假宿主。
- **`tools/` 是唯一知道宿主 API 形状的地方。** 服务调用写在这里，不往下泄。

## 八条硬约束（每条都对应一条红线）

1. **不解析 harness 文件的方言。** 文件交给宿主的 `cordis:include`；本仓只生成一条 include 行。
   自己解析就有了第二套定义，两边一旦不一致没人能判。（红线 **B8**）
2. **include 的 `path` 必须是 `file:` URL。** `new URL('C:/x', baseUrl)` 把盘符当 scheme，
   `fileURLToPath` 会抛。**Windows 上绝对路径必定挂不上**（2026-11-11 真机实测）。
3. **不挂 run 目录里的副本。** `Include` 把 `baseUrl` 设成 harness 文件所在目录，
   而裸模块名只在 profile 树内 / link 过的包里才解析得到；run 目录两者都不是。
   副本是证据，原文件才是执行体。（同样 B8）
4. **遮罩行必须排在 harness 行之前。** `tools.restrict` 遮的是调用它的作用域，而作用域自身的注册
   豁免；顺序反过来受试体一个工具都看不见。**遮罩只管工具** —— 技能遮不住（宿主没有那条 API，
   实测两次失败），受试体与技能之间只有一个开关：给不给它 `skill` 工具。（**B15 / B17**）
5. **观测只折叠，不索取。** 读会话事件走 `ctx.on('session/event')`；
   `snapshotEvents` / `eventAt` / `ownEvents` 在宿主两侧都标了「新调用禁止」。
6. **探针只报「能到达的」，不报「存在的」。** `surface` 的意思是受试体真能调用什么：技能没有
   `skill` 工具就一个也拿不到，别把注册表在这个作用域里的条目数报成它的能力面。（**B17**）
7. **注册给宿主的每一样东西都挂在 fiber 上。** `ctx.effect(() => svc.register(...))`。
   宿主把 disposer 记在**它自己**的 ctx 上，丢掉返回值 = 卸载后残留、热重载后旧值继续赢。（**B18**）
8. **`finally` 里必须 dispose。** 临时 preset、故障门、探针租约，一个都不许留。
   （红线 **B6**：一次没跑到 trial 1 的 run 必须被 `discard()`）

## 命名：一个词管一件事

| 词 | 只指 | 别用 |
|---|---|---|
| `harness` | 受试的行列表；两种形态 `file` / `tools`+`persona` | `assembly`、`composition`、`config` |
| `shortcut` | 简写形态（编译成行列表） | `quick` |
| `captured` | 一次读/编译得到的字节 + 摘要 + 行 | `composition` |
| `surface` | 挂载后**真正**能调用的东西 | `effective` |
| `modelInput` | 受试体**实际收到**的 prompt / 工具 / 路由 | `assembly` |
| `trace` | 受试体**做了什么** | `facts`、`events` |
| `stimulus` | 一轮 trial 的刺激（harness 身份 + 故障） | `setup` |

**红线 B13 扫源码、B14 扫文档**，所以改名漏一处会红，不靠记性。

## 宿主 API 只能读不能改

- 只用公开服务：`ctx.tools` / `ctx.agentPresets` / `ctx.subagents` / `ctx.systemPrompt` / `ctx.get()`。
- **需要改宿主才能测的东西，不是受试变量，是要上报的缺陷**（根 AGENTS 硬性纪律 2）。
- 两侧版本线可能不同，**以在跑的那版 `.d.ts` 为准**（根 AGENTS「宿主版本线」）。

## 写代码后的自检顺序

```bash
pnpm run typecheck && pnpm run test
```

改了 `harness` / `subject` / `record` / `tools` 的语义 → 先想「哪条红线会红」，
再跑 `pnpm run check`。**红线是判据不是装饰**：改回旧行为它必须红，否则先去补红线。
