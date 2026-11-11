# 受试体里能放什么：一行能引用到什么

状态：生效

harness 是「一份插件行列表」，那么一行到底能引用什么，决定了「受试变量是整份装配」这句话能兑现到
什么程度。本篇是 2026-11-11 在跑宿主 `0.2.2-rc.1` 上的实测，含一个**探针与运行时不一致**的缺陷。

## 背景

行只有 `id` / `name` / `config` / `disabled` / `inject` / `intercept` / `isolate`。`name` 是模块
specifier，解析基准是 **`cordis:include` 把 `baseUrl` 设成 harness 文件所在目录**之后的那套解析：

- `cordis-plugin-loader` 的 `createResolve()` 在**离 `baseUrl` 最近的那个带 `package.json` 的祖先目录**
  里写一个 `.cordis/resolve.mjs`，用 `import.meta.resolve` 解析；写不了（只读盘）就回退到宿主模块图里的
  原生 `import()`。
- 实测推论：**宿主自己 import 得到的一切都能写进 `name`**。profile 的 `node_modules/@deepseek-ai` 里
  只有三个包，而 `@deepseek-ai/dsh-tool-fs` 照样挂得上 —— 因为它来自宿主安装目录的 `node_modules`。

## 结论

按「能引用到什么」分四层，**每层都实测挂载成功**：

| 层 | 写法 | 实测 |
|---|---|---|
| 宿主自带包 | `@deepseek-ai/dsh-tool-fs` 等 | `minimal.yml` / `standard.yml` 一直如此 |
| **本仓自己** | `dsh-harness-dispatcher`、`…/tool`、`…/sealed` | 一行挂整份插件 → 受试体拿到 `harness_export`/`harness_inspect`/`harness_run`；`…/tool` 行凭空造工具 |
| **任意本地文件** | `./local-sut.js`、`../local-sut.js`、`file:///C:/…/local-sut.js` | 三种都挂上了；**相对路径的基准是 harness 文件所在目录**，不是仓、不是进程 cwd |
| 非工具零件 | `dsh-persona`（`prefix`）、`dsh-time-context`、`cordis:group` + `isolate`（compaction / planning / delegation）、`!!js` 条件行 | 全部按行生效：`own-parts.yml` 挂上了 persona + 时间上下文 + fs |

**「换掉一个工具」是真的换掉**：一行 `dsh-harness-dispatcher/tool` 用宿主的名字（`read`）注册，受试体
实测拿到的是替换品，不是原件。这就是「工具描述与参数是受试变量」的实现路径，不需要宿主的任何配合。

**递归也是通的**：受试体里挂整份本仓后，`harness_run` 对它可见、可调，它自己的记录落在同一个
`outputRoot` 下。也就是「让受试体自己跑实验」在机制上成立。是否**应该**这么做是另一个问题（见影响）。

## 缺陷：封印会让探针说谎

`sealed: true` 的实现是一行 `tools.restrict({ deny: hostToolNames(ctx) })`，遮的是**全局工具名**。
实测发现：**harness 自己用被遮掉的名字注册的工具，也会在模型可见面上消失**，而
`tools.definitions(scope)` 仍然报它可见。

复现（同一份文件，封印，三个自造工具）：

```
own-shadow3.yml  →  inspect 报 3 个：[harness_inspect, read, zz_unique]
                 →  run 实收 2 个：[read, zz_unique]
                 →  五行全部 enabled=true / fiberState=2，没有一行失败
```

`harness_inspect` 被抹掉，是因为**本插件在这台机器上全局装着**，所以它在那份 deny 名单里；而 `read`
不在名单里（实测 `ctx.tools.definitions()` 的 38 个全局名里没有 `read`/`write`/`edit`/`glob`/`grep`
—— 它们来自会话的 preset 作用域，不是全局层），所以替换品活得下来。

同一机制解释了另一次更刺眼的读数：一行挂整份本仓 + 封印 → 探针报 3 个工具，请求头里 `tools` 是
**空的**，受试体一条工具都没拿到，于是它**编了十个工具名**（`read`/`write`/`glob`/`shell`/`present`…）
当成自己的工具集报了出来 —— 一次看起来正常的 trial，记录里 `byTool: {}`。

**这是 B17 同一个坑的新形状**：不是「注册表 vs 能到达」，而是「作用域视图 vs 步骤准入」。判据没变，
被观测的对象变了。

## 影响

- **探针少说一句就是假证据。** `surface.tools` 现在的含义是「作用域里可见」，而封印会让准入再筛一遍。
  修法很小且不需要宿主配合：`harness_inspect` 自己就知道 `sealed` 与 `hostToolNames(ctx)`，所以它可以
  把 deny 名单从报出的名单里减掉 —— 减掉之后与实测的 2 个一致。
- **`modelInput.tools` 是这条边界上唯一诚实的读数。** 它取自 `request/header`，是受试体**真正收到**的
  工具列表；`surface` 是意图，`modelInput` 是事实。两者不一致本身就是可观测的缺陷信号，不用另造机器。
- **要不要让受试体拿到本仓的三个工具，是实验设计问题，不是能力问题。** 能挂通意味着一个受试体可以
  自己跑实验并写进同一个 `outputRoot` —— 记录会混在一起，run 会嵌套，停止语义会套两层（B28 的
  「一次停止停一切」在嵌套里没有被验证过）。要用就把 `outputRoot` 与 `task_id` 命名区分开，并且知道
  这条路径没验过。
