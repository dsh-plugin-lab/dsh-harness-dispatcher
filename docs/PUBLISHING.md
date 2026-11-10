# PUBLISHING — 第一次发版前必须做完的事

**本文职责**：本仓发布的前置条件与流程。**不负责**：宿主兼容范围（现查 `package.json` 的 `engines.dsh`）、
跨仓判据（在组织仓）、版本号（在 `package.json`）。

**为什么这篇这么短**：本仓**从未发布过**。写一份照抄兄弟仓的手册，等于把**别人的**版本线、
tag 形态、事故判例搬进来 —— 它们会漂，而且是**照着做才发现不对**的那种漂。
所以这里只写「本仓已经具备什么」与「第一次发之前必须现查什么」。

---

## 已经具备的（不是承诺，是当前状态）

- **发布流水线**：`.github/workflows/release.yml`。两个入口（打 tag / 手动 dispatch），
  OIDC 发布，**不 bump 版本号**，全或无顺序（先 publish，再 commit，再 tag 与 Release）。
  它取自兄弟仓，**比模板多**（模板不生成这一份）。
- **草稿**：`.github/workflows/release-drafter.yml`（与模板逐字相同）。发布正文读它的草稿，
  发布完**弃掉草稿**。
- **发布态断言**：[scripts/check-release.mjs](../scripts/check-release.mjs)，
  已进 `pnpm run check`。它现在断言的东西**包含**「拒绝 `private: true`」。
- **红线**：[test/redlines.test.ts](../test/redlines.test.ts)，8 组 23 条，已做反向控制。
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

## 第一次发之后

`AGENTS.md` 的「发布前」节与本文都要同批改：把「从未发布」这句换成当前的版本线判例。
**一条会漂的断言留在原地比没有更坏** —— 它读起来像事实。
