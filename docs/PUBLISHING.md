# PUBLISHING — 第一次发版前必须做完的事

**本文职责**：本仓发布的前置条件与流程，以及与组织判据的对齐方法。**不负责**：宿主兼容范围
（现查 `package.json` 的 `engines.dsh`）、版本号（在 `package.json`）、日常维护规则（在
[AGENTS.md](../AGENTS.md)）。

**当前状态**：**已发布到 npm**（首个版本已在 registry 上）。首次发布是**手动 `npm publish`** ——
Trusted Publisher 无法完成首次发布，它要求包已经存在，必须先有包才有可绑定的对象。
**Trusted Publisher 尚未配置**，所以后续发布在有它之前仍走手动。

**为什么这篇这么短**：这里只写「本仓已经具备什么」与「发之前必须现查什么」。写一份照抄兄弟仓的
手册，等于把**别人的**版本线、tag 形态、事故判例搬进来 —— 它们会漂，而且是**照着做才发现不对**
的那种漂。

---

## 已经具备的（不是承诺，是当前状态）

- **发布流水线**：`.github/workflows/release.yml`。两个入口（打 tag / 手动 dispatch），
  OIDC 发布，**不 bump 版本号**，全或无顺序（先 publish，再 commit，再 tag 与 Release）。
  它取自兄弟仓，**比模板多**（模板不生成这一份）。
- **草稿**：`.github/workflows/release-drafter.yml`（与模板逐字相同）。发布正文读它的草稿，
  发布完**弃掉草稿**。
- **发布态断言**：[scripts/check-release.mjs](../scripts/check-release.mjs)，
  已进 `pnpm run check`。它现在断言的东西**包含**「拒绝 `private: true`」。
- **红线**：[test/redlines.test.ts](../test/redlines.test.ts)，全部通过且逐条做过反向控制。
- **组织判据**：自动发现本仓（`dsh-` 前缀 + 清单有 `dsh` 字段），
  当前 `14 checks, 0 new findings`。

## 第一次发之前，**必须现查**这几件

顺序就是执行顺序。**每一件的值都不许抄本文件、也不许抄兄弟仓**：

1. **`dsh --version`** —— 决定 `engines.dsh` 的范围要不要动。三处必须逐字相同：
   `engines.dsh` / `peerDependencies` / `devDependencies`。
2. **`node scripts/check-release.mjs`** —— 现跑。它断言的是**当前**清单与 tarball，不是上一次的。
3. **`pnpm run check`** —— 四项全绿。
4. **npm 上是否已有这个包名** —— `npm view dsh-harness-dispatcher versions`。
   包名被占就要改名，**而改名会影响 `cordis.patch.yml` 的 `name` 与 profile 里已装的 link**。
5. **Trusted Publisher 是否已配** —— OIDC 发布的前提，在 npmjs 网页上配，**不是文件里能声明的**。
6. **`.github/release-drafter.yml` 的标签映射** —— 本仓还没这份文件；
   草稿按 label 分类，缺它草稿的正文会是空的（而**不报错**）。发版前要么补，要么接受空正文。
7. **`repository.url` 里的组织名** —— OIDC 要求它与跑 workflow 的组织一致。

## 第一次发之后（已发生）

首次发布走的是**手动 `npm publish`**：Trusted Publisher 要求包已经存在于 registry，所以 OIDC
流水线**无法完成首次发布** —— 必须先手动发出一个版本，它才有可绑定的对象。
**Trusted Publisher 尚未配置**（在 npmjs 网页上配，不是文件里能声明的），配置好之前后续发布仍走手动。

按本文件自己的要求，`AGENTS.md` 的「发布前」节与本文已同批改掉了「从未发布」这句。
**一条会漂的断言留在原地比没有更坏** —— 它读起来像事实。

---

## 与组织判据对齐

组织仓 `dsh-plugin-lab/.github` 的 `scripts/check-criteria.mjs` 按 **`dsh-` 前缀 + 清单有 `dsh` 字段**
**自动发现**本仓，每周独立核一次。**新建或改名都不需要登记**，但**必须满足它**。
2026-11-10 首次核出 6 条（缺 `release.yml` 四条规则 / 缺 `release-drafter.yml` / 缺红线文件），
已补齐，现为 `14 checks, 0 new findings`。

- **核它要 `GITHUB_TOKEN`**：`GITHUB_TOKEN=$(gh auth token) node scripts/check-criteria.mjs`
  —— 不带 token 会匿名超时，**超时不是通过**。
- **`release.yml` 不属于模板生成物**：取来之后必须读一遍它断言了什么（发布顺序、OIDC、tag 形状都是
  不可撤销的动作）。**2026-11-11 实测它带着别人的包名** —— 守卫写的是 `npm view "dsh-dsml-rescue@$VERSION"`，
  于是永远查到「已存在」、永远跳过发布、**报成功但什么都没发**。已修。照抄兄弟仓的代价就是这个。

### 怎么对齐（用组织仓自己的工具，别凭记忆）

```bash
node <组织仓>/scripts/scaffold.mjs <临时目录> --host-only --name dsh-harness-dispatcher
node <组织仓>/scripts/scaffold.mjs check <本仓路径>     # 期望 all byte-identical
```

`scaffold check` 只比**三个**身份件（`.node-version` / `release-drafter.yml` / `.prettierignore`），
**其余文件要自己比**。2026-11-11 人工逐项比抓出四处偏差，两处会伤到人：`.gitignore` 丢了
`*.local.yml`（凭据文件可能被提交）、`scripts/check-release.mjs` 是兄弟仓的旧版（发布断言落后）。

### 有意保留的偏离（**每条都要有理由，否则就是「这个仓特殊」**）

| 偏离 | 理由 |
|---|---|
| `test/smoke.test.ts` 不含模板的 `apply({})` 断言 | `apply` 读四个服务，空 ctx 必抛；保留它会逼出永不发生的防御分支 |
| `check` 是六步（模板四步） | 修 CI 红根因，红线 B9 钉住 |
| `files` 含 [README_zh.md](../README_zh.md) | 双语文档是实际惯例 |
| devDependencies 比模板多六个 `@deepseek-ai/*` | 本仓真的 import 它们；模板那份起始集自称未经校验 |
| 没有 `docs/.gitkeep` / `.agents/notes/.gitkeep` | 两个目录都已非空，占位文件是噪音 |
| `vitest.config.ts` 不含 `contract-live-*` 排除 | 本仓没有 contract 测试 |
