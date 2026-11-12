/**
 * The shortcut's vocabulary: the only place a subject row is named from a fixed table.
 *
 * The catalogue is **not** the definition of a harness — a harness is a row-list file (see
 * `.agents/notes/2026-11-11-harness-shape.md`). It makes the *shortcut* safe: compiling rows by hand is
 * where a typo becomes a silently different stimulus, so a fixed table turns it into an error.
 *
 * Two namespaces: a shortcut names **catalogue keys** (`fs`) for what it mounts and **model-facing tool
 * names** (`read`) for what `faults[].tool` breaks. Confusing them is silent — a fault naming `fs`
 * matches nothing, so it never fires and the run looks like a clean baseline.
 *
 * `furnishes` is the static half of that check and only a lower bound: a file harness names rows we
 * cannot see, so the authoritative check compares faults against the names observed after mounting
 * (see [subject.ts](subject.ts)).
 *
 * The lists below are each package's `defineTool({ name })` values — a contract with the host, pinned by
 * a redline and to be re-checked when `engines.dsh` moves.
 *
 * @module dsh-harness-dispatcher/catalog
 */

/** One Loader row the shortcut can mount into a subject harness. */
export interface CatalogEntry {
  /** Provider module id the Loader resolves. */
  readonly name: string
  /** Row configuration; omitted when the package has nothing to configure. */
  readonly config?: Readonly<Record<string, unknown>>
  /** One sentence on what this row gives the subject, for the tool description. */
  readonly summary: string
  /** Model-facing tool names this row makes callable. */
  readonly furnishes: readonly string[]
}

/**
 * Tool rows, keyed by the short names a shortcut uses.
 *
 * Only file/process/search tools are here on purpose. Delegation, jobs, scheduling and skills each
 * change the *shape* of the run in ways that need their own analysis, so they are separate decisions
 * rather than part of the default subject. A harness that wants them says so in its own file.
 */
export const TOOL_CATALOG: Readonly<Record<string, CatalogEntry>> = {
  fs: {
    name: '@deepseek-ai/dsh-tool-fs',
    summary: 'read, write, edit files under the session directory',
    furnishes: ['read', 'write', 'edit', 'read_image'],
  },
  'fs-search': {
    name: '@deepseek-ai/dsh-tool-fs-search',
    // Required by the package's own `Config` on host 0.2.2-rc.1, and it has no default: a row that
    // omits it does not mount at all (`$.sampleOverCapGlobResults missing required value`). Measured
    // 2026-11-12 — it made `DEFAULT_TOOLS`, and therefore the bare `{ persona }` shortcut, unusable.
    // `false` is the shipping presets' value: over-cap pages take the modification-time head.
    config: { sampleOverCapGlobResults: false },
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

/** Persona row. Mounted only when a shortcut asks for one. */
export const PERSONA_ROW = '@deepseek-ai/dsh-persona'

/** Shipped persona prose. Changing this text changes the stimulus — the fingerprint moves with it. */
export const PERSONAS: Readonly<Record<'terse' | 'verbose' | 'pair-programmer', string>> = {
  terse:
    'You are a terse engineer. Answer in as few words as possible, and never explain your plan.',
  verbose:
    'You are a thorough engineer. Before every tool call, state what you intend to do and why, in prose.',
  'pair-programmer':
    'You are pairing with a human. Narrate each step as you take it, and ask a clarifying question ' +
    'whenever a requirement is ambiguous.',
}

/** The catalogue keys the shortcut accepts, for validation and for the tool description. */
export const TOOL_KEYS: ReadonlySet<string> = new Set(Object.keys(TOOL_CATALOG))

/**
 * Every model-facing tool name the given catalogue keys make callable.
 * @param keys - catalogue keys the shortcut mounts.
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
 * One-line catalogue rendering for the model-facing tool description.
 *
 * Names the catalogue key *and* the tools it furnishes, because the two namespaces are exactly where a
 * caller goes wrong.
 * @returns keys with their summaries and furnished tool names, in catalogue order.
 */
export function catalogLine(): string {
  return Object.entries(TOOL_CATALOG)
    .map(([key, entry]) => `${key} → ${entry.furnishes.join('/')} (${entry.summary})`)
    .join('; ')
}

/**
 * The catalogue as [shortcut.ts](shortcut.ts) consumes it.
 *
 * Injected rather than imported there so the shortcut layer stays pure validation, and its tests can
 * hand it a two-entry table instead of the host package ids.
 */
export interface Vocabulary {
  /** Catalogue keys that exist. */
  readonly keys: ReadonlySet<string>
  /**
   * Model-facing tool names the given keys make callable.
   * @param keys - catalogue keys the shortcut mounts.
   * @returns the furnished tool names.
   */
  readonly furnished: (keys: readonly string[]) => ReadonlySet<string>
}

/** The real catalogue, assembled once. */
export const CATALOG: Vocabulary = {
  keys: TOOL_KEYS,
  furnished: furnishedTools,
}
