/**
 * The frozen catalog of Host plugin rows a Harness variant may mount.
 *
 * The catalog exists so that a Harness variant names **short, validated keys** instead of module ids a
 * model could mistype. Every entry is a Host package that ships with the runtime, so no row needs a
 * dependency of its own; `name` is resolved by the Loader against the dsh installation.
 *
 * ## Two namespaces, and why `furnishes` exists
 *
 * A harness names **catalog keys** (`fs`, `fs-search`, …) for what it *mounts*, and **model-facing tool
 * names** (`read`, `grep`, …) for what it *breaks* via `faults[].tool`. Those are different namespaces,
 * and the failure of confusing them is silent: `faults: [{tool: 'fs', mode: 'fail'}]` matches no tool,
 * so the fault never fires and the run looks like a clean baseline. `furnishes` is what lets
 * `normalize()` reject that before a child is started.
 *
 * The lists below are the `defineTool({ name })` values of each package. They are a **contract with the
 * host**, so they are pinned by a redline; re-check them when `engines.dsh` moves.
 *
 * @module dsh-harness-dispatcher/catalog
 */

import type { HarnessCatalog } from './harness.ts'

/** One Loader row this bench can mount into a subject composition. */
export interface CatalogEntry {
  /** Provider module id the Loader resolves. */
  readonly name: string
  /** Row configuration; omitted when the package has nothing to configure. */
  readonly config?: Readonly<Record<string, unknown>>
  /** One sentence on what this row gives the subject, for the tool description. */
  readonly summary: string
  /** Model-facing tool names this row makes callable. `faults[].tool` must name one of these. */
  readonly furnishes: readonly string[]
}

/**
 * Tool rows, keyed by the short names a Harness variant uses.
 *
 * Only file/process/search tools are here on purpose. Delegation, jobs, scheduling and skills each
 * change the *shape* of the run in ways that need their own analysis, so they are separate decisions
 * rather than part of the default subject.
 */
export const TOOL_CATALOG: Readonly<Record<string, CatalogEntry>> = {
  fs: {
    name: '@deepseek-ai/dsh-tool-fs',
    summary: 'read, write, edit files under the session directory',
    furnishes: ['read', 'write', 'edit', 'read_image'],
  },
  'fs-search': {
    name: '@deepseek-ai/dsh-tool-fs-search',
    summary: 'grep and glob across the workspace',
    furnishes: ['grep', 'glob'],
  },
  pwsh: {
    name: '@deepseek-ai/dsh-tool-pwsh',
    summary: 'run PowerShell commands (Windows hosts)',
    furnishes: ['pwsh'],
  },
  bash: {
    name: '@deepseek-ai/dsh-tool-bash',
    summary: 'run bash commands (POSIX hosts)',
    furnishes: ['bash'],
  },
  todo: {
    name: '@deepseek-ai/dsh-tool-todo',
    summary: 'maintain a todo list',
    furnishes: ['todo_write'],
  },
  web: {
    name: '@deepseek-ai/dsh-tool-web',
    config: { fetch: true },
    summary: 'search the web and fetch pages',
    furnishes: ['web_search', 'web_fetch'],
  },
  present: {
    name: '@deepseek-ai/dsh-tool-present',
    summary: 'present files as deliverables',
    furnishes: ['present'],
  },
}

/**
 * The default subject tool set: the smallest set that can do real work on this host.
 *
 * Deliberately excludes anything that spawns (delegation, jobs, schedules): the subject under test is
 * one agent doing one task, and an accidental grandchild would silently double the sample.
 */
export const DEFAULT_TOOLS: readonly string[] = ['fs', 'fs-search', 'pwsh']

/** Persona row. Mounted only when a variant asks for one. */
export const PERSONA_ROW = '@deepseek-ai/dsh-persona'

/** The catalog keys this bench accepts, for validation and for the tool description. */
export const TOOL_KEYS: ReadonlySet<string> = new Set(Object.keys(TOOL_CATALOG))

/**
 * Every model-facing tool name the given catalog keys make callable.
 *
 * This is the set `faults[].tool` is validated against. A fault naming anything else can never fire,
 * and a fault that can never fire is worse than no experiment: it produces a well-formed record whose
 * `harness.faults` claims a condition that was never applied.
 *
 * @param keys - catalog keys the harness mounts.
 * @returns the furnished tool names, deduplicated.
 */
export function furnishedTools(keys: readonly string[]): Set<string> {
  const names = new Set<string>()
  for (const key of keys) {
    for (const name of TOOL_CATALOG[key]?.furnishes ?? []) names.add(name)
  }
  return names
}

/**
 * One-line catalog rendering for the model-facing tool description.
 *
 * Names the catalog key *and* the tools it furnishes, because the two namespaces are exactly where a
 * caller goes wrong.
 * @returns keys with their summaries and furnished tool names, in catalog order.
 */
export function catalogLine(): string {
  return Object.entries(TOOL_CATALOG)
    .map(([key, entry]) => `${key} → ${entry.furnishes.join('/')} (${entry.summary})`)
    .join('; ')
}

/**
 * The catalog as [harness.ts](harness.ts) consumes it, assembled once.
 *
 * Exported as a value rather than read by `normalize` directly: the spec layer stays pure data
 * validation with no host package ids, and its tests can hand it a two-entry table instead.
 */
export const HARNESS_CATALOG: HarnessCatalog = {
  keys: TOOL_KEYS,
  furnished: furnishedTools,
}