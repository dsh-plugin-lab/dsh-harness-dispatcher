# skills/ — 规则层

继承根规则，见 [../AGENTS.md](../AGENTS.md)。本目录的结构见 [README.md](README.md)。

这个目录里的 `.md` **不是文档**，是运行时载荷 —— 它在 `apply()` 时被
[../src/skill.ts](../src/skill.ts) 读走交给宿主技能注册表。所以：

- **目录名就是技能名**，且必须 kebab-case（`dsh-harness-dispatcher`），并且**与插件包名同一串** ——
  一份装配里只有一个同名技能条目，重名就是"我以为装的是这个"的开始；而 frontmatter 里的 `name`
  必须**与目录名同一串**，[../src/skill.ts](../src/skill.ts) 会拒掉不一致的。
- **frontmatter 不是装饰，是文件合法的一部分**：`name`、`description` 必填，`author` /
  `metadata.source` 跟着兄弟仓的约定补齐。少了它们，代码注册照样能跑（它自己剥），但文件就不再是
  合法 skill 文件 —— `dsh-skill-filesystem` 会因为缺 frontmatter 直接**忽略**它并只记一条 warn。
- **`description` 必须是单行标量**，且含 `: ` 时要加引号。写成 `>-` 会注册成一个连字符，
  而它是模型唯一的路径信号 —— 技能还在目录里，但不可达，任何一侧都不报错。
- **改它不需要重新编译**，但需要重载插件才生效；载体是 `ctx.effect` 收住的注册，重载会撤掉旧的。
- **删它不会让插件崩**：`readSkill()` 会抛，`registerSkill()` 捕获后记一条 warn，工具半边照常工作。
  所以「技能静默消失」只能靠 [../scripts/check-release.mjs](../scripts/check-release.mjs) 拦，
  那条断言就是这个用途。
- **正文不许为空**。宿主不校验 `content`，空的会长在目录里、加载时渲染成空 —— 没有任何一侧报错。
- **正文只写「读者据此能改变动作」的事实**：改变传什么参数，或改变怎么读结果。读者是**即将调用这几个
  工具的 agent**，不是维护者；「系统是这样的」属于特性，它既不能预防也不能利用，却是每次加载都要付的
  上下文。已经写在工具 schema 里的事实也不写第二遍。判据全文与清掉的四类例子见
  [../AGENTS.md](../AGENTS.md) 的「skill 正文的判据」。
- 不写「里面有什么」，那是 [README.md](README.md) 的职责；不写「正文该说什么」，那是红线
  **B22** 的事（它在 [../test/redlines.test.ts](../test/redlines.test.ts) 里逐条钉着）。
