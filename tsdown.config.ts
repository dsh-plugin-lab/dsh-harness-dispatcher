import type { UserConfig } from 'tsdown'

/**
 * Host-only bundle.
 *
 * `neverBundle` names the modules the host already provides. They must stay external: a bundled
 * copy would give this plugin its own instance of host helpers, and the identity checks those
 * helpers rely on (service lookups, `defineTool` registration, schema brands) would then disagree
 * with the running host.
 */
export default [
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: true,
    clean: true,
    deps: {
      neverBundle: [
        '@deepseek-ai/cordis',
        '@deepseek-ai/schemastery',
        '@deepseek-ai/dsh-agent',
        '@deepseek-ai/dsh-agent-preset-registry',
        '@deepseek-ai/dsh-session',
        '@deepseek-ai/dsh-session-projection',
        '@deepseek-ai/dsh-subagent',
        '@deepseek-ai/dsh-tools',
      ],
    },
  },
] satisfies UserConfig[]
