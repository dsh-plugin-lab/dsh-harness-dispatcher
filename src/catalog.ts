/**
 * The frozen catalog of Host plugin rows a Harness variant may mount.
 *
 * The catalog exists so that a Harness variant names **short, validated keys** instead of module ids
 * a model could mistype. Every entry is a Host package that ships with the runtime, so no row needs a
 * dependency of its own; `name` is resolved by the Loader against the dsh installation.
 *
 * Adding an entry is a deliberate act: it widens the space of subjects. When adding one, record why
 * in docs/ARCHITECTURE.md §5 and keep the key stable — keys appear inside persisted record ids.
 *
 * @module dsh-harness-dispatcher/catalog
 */

/** One Loader row this bench can mount into a subject composition. */
export interface CatalogEntry {
  /** Provider module id the Loader resolves. */
  readonly name: string
  /** Row configuration; omitted when the package has nothing to configure. */
  readonly config?: Readonly<Record<string, unknown>>
  /** One sentence on what this row gives the subject, for the tool description. */
  readonly summary: string
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
  },
  'fs-search': {
    name: '@deepseek-ai/dsh-tool-fs-search',
    summary: 'grep and glob across the workspace',
  },
  pwsh: {
    name: '@deepseek-ai/dsh-tool-pwsh',
    summary: 'run PowerShell commands (Windows hosts)',
  },
  bash: {
    name: '@deepseek-ai/dsh-tool-bash',
    summary: 'run bash commands (POSIX hosts)',
  },
  todo: {
    name: '@deepseek-ai/dsh-tool-todo',
    summary: 'maintain a todo list',
  },
  web: {
    name: '@deepseek-ai/dsh-tool-web',
    config: { fetch: true },
    summary: 'search the web and fetch pages',
  },
  present: {
    name: '@deepseek-ai/dsh-tool-present',
    summary: 'present files as deliverables',
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

/** The keys this bench accepts, for validation and for the tool description. */
export const TOOL_KEYS: ReadonlySet<string> = new Set(Object.keys(TOOL_CATALOG))

/**
 * One-line catalog rendering for the model-facing tool description.
 * @returns keys with their summaries, in catalog order.
 */
export function catalogLine(): string {
  return Object.entries(TOOL_CATALOG)
    .map(([key, entry]) => `${key} (${entry.summary})`)
    .join('; ')
}
