# 2026-11-11 —— `check` 全绿不代表 CI 会绿

## 症状

推送后 CI 红，而同一台机器上 `pnpm run check` 刚跑过、四项全绿。

红在 `verify` 作业的最后一步：

```
✓ typecheck   ✓ build   ✓ test   ✓ lint
X Format check
```

## 原因：`check` 与 CI 不是同一条命令

| | 跑什么 |
|---|---|
| CI 的 `verify` 作业 | `typecheck` → `build` → `test` → `lint` → `format:check` |
| 本仓的 `check`（当时） | `typecheck` → `build` → `test` → `check:release` |

**差在 `format:check`。** 而这一次恰好就是在那里断了。

**为什么断**：上一轮我用 PowerShell 字符串替换改了 `src/harness.ts`、`src/catalog.ts` 和两个测试文件，
新插入的代码块没有经过 prettier。prettier 的检查**不在 `check` 里**，所以它没有任何地方会报错。

## 为什么这个失败比别的失败更贵

- 它**只在你已经推送之后**才出现。
- 而它断的是一个**纯格式**步骤 —— 代码逻辑、类型、测试全是对的，所以本地那四项绿**如实反映了它们各自覆盖的范围**。
- 于是它教人一个错误的结论：「本机的 check 不可信」。**真正不可信的是我以为它等于 CI。**

## 修法：两层，缺一不可

1. **让 `check` 包含 CI 的每一步**（顺序与 CI 一致，发布态断言放最后）。
   `check` = `typecheck` → `build` → `test` → `lint` → `format:check` → `check:release`。
2. **把这条等价性写成红线 B9**（[test/redlines.test.ts](../../test/redlines.test.ts)）：
   读 `package.json` 的 `check`，断言它包含 CI 那五步；再读 `ci.yml` 的 `run:` 行，
   断言没有哪一步是「CI 有、`check` 没有」的。

**第 2 条才是关键**。只做第 1 条，下一个人往 CI 加一步就又会漂。红线的方向是**双向**的：
`check` 缺一步要红，CI 多一步也要红。

**反向控制已做**：把 `&& pnpm run lint && pnpm run format:check` 从 `check` 里删掉，
`B9 / runs every step the CI workflow runs` 当场变红；复原后 25 条全绿。
「现在这条绿」与「这条判据有牙齿」是两件事，后者单独证过。

## 带走的两条

1. **判据要问「哪两个东西本该相同」**，而不是「命令退出码是不是 0」。
   `check` 与 CI 本该同形 —— 这个「本该」从来没被断言过，所以它可以安静地漂。
2. **用脚本改源码之后必须跑格式检查。** 字符串替换会带上不合格式的换行，
   而**所有编译器与测试都不会因此报错**。这类改动越正确，越容易漏掉格式。
