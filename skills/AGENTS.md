# skills/ — 规则层

继承根规则，见 [../AGENTS.md](../AGENTS.md)。本目录的结构见 [README.md](README.md)。

这个目录里的 `.md` **不是文档**，是运行时载荷 —— 它在 `apply()` 时被
[../src/skill.ts](../src/skill.ts) 读走交给宿主技能注册表。所以：

- **目录名就是技能名**，且必须 kebab-case（`dsh-harness-bench`）。宿主按目录名找正文，改名等于换技能。
- **改它不需要重新编译**，但需要重载插件才生效；载体是 `ctx.effect` 收住的注册，重载会撤掉旧的。
- **删它不会让插件崩**：`readSkillBody()` 会抛，`registerSkill()` 捕获后记一条 warn，工具半边照常工作。
  所以「技能静默消失」只能靠 [../scripts/check-release.mjs](../scripts/check-release.mjs) 拦，
  那条断言就是这个用途。
- **正文不许为空**。宿主不校验 `content`，空的会长在目录里、加载时渲染成空 —— 没有任何一侧报错。
- 不写「里面有什么」，那是 [README.md](README.md) 的职责；不写「正文该说什么」，那是红线
  **B22** 的事（它在 [../test/redlines.test.ts](../test/redlines.test.ts) 里逐条钉着）。
