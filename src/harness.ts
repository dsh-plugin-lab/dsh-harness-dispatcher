/**
 * The harness under test: one captured row list, plus the request-level settings that make a stimulus.
 *
 * ## One capture, three consumers
 *
 * A harness arrives one of two ways — an authored file, or the [`shortcut`](shortcut.ts) — and both are
 * reduced to the same three values in one pass:
 *
 * ```
 * text  ──┬─→ digest             the declared identity, written into every record
 *         ├─→ run-directory copy the evidence, byte-identical to what was mounted
 *         └─→ subject rows       what `agentPresets.register` receives
 * ```
 *
 * Because all three come from the *same* string read or built exactly once, "the recorded digest
 * describes what ran" is true by construction rather than by re-reading a path later.
 *
 * ## Who parses a file
 *
 * **Not us.** A file-based harness is handed to the host as a single `cordis:include` row, so the
 * Loader parses its own dialect — groups, `isolate`, `inject`, and `!!js` included. Re-implementing that
 * grammar here would mean a second, subtly different definition of "a harness"; a file the Loader
 * accepts would then have to also pass *our* parser, and the two would drift.
 *
 * The shortcut needs no parser at all: its rows are compiled in [shortcut.ts](shortcut.ts) and
 * serialized as JSON, which the same include row can replay later.
 *
 * ## Route and depth are not the harness
 *
 * `agentOptions` and `maxDepth` are request fields. They cannot be written into a row list, so they sit
 * beside the harness rather than inside either form — which is what lets one file be run under two
 * routes without editing it. {@link ResolvedHarness.fingerprint} covers both anyway, because "the same
 * stimulus" requires the same harness *and* the same request.
 *
 * @module dsh-harness-dispatcher/harness
 */

import { readFile, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join } from 'node:path'
import type { Vocabulary } from './catalog.ts'
import { digestText } from './digest.ts'
import { normalizeShortcut, shortcutLabel, shortcutRows } from './shortcut.ts'
import type { PersonaVariant, ShortcutInput, ShortcutSpec } from './shortcut.ts'

/** One Loader row this module hands to `agentPresets.register`. */
export interface HarnessRow {
  readonly id: string
  readonly name: string
  readonly config?: Readonly<Record<string, unknown>>
}

/** Which door the rows came through. Recorded, never used to branch behaviour after capture. */
export type HarnessSource = 'file' | 'shortcut'

/** The `cordis:include` builtin the host registers; a file harness mounts through it. */
const INCLUDE_PLUGIN = 'cordis:include'

/** Row id of the include row. Stable across runs, so the audit reads it. */
const INCLUDE_ROW_ID = 'bench-harness'

/** Extensions `cordis:include` can parse. A harness file outside these is a spec error. */
export const HARNESS_EXTENSIONS: readonly string[] = ['.yml', '.yaml', '.json']

/** A harness captured once, with everything needed to mount it and to record it. */
export type CapturedHarness =
  | {
      readonly source: 'file'
      /** Absolute path the text was read from. Evidence for a human, never used for mounting. */
      readonly originPath: string
      readonly fileName: string
      readonly text: string
      readonly digest: string
    }
  | {
      readonly source: 'shortcut'
      readonly fileName: string
      readonly text: string
      readonly digest: string
      /** Compiled rows. Also present in `text`, so a replay parses back to the same rows. */
      readonly rows: readonly HarnessRow[]
      readonly spec: ShortcutSpec
    }

/**
 * How a caller names a harness.
 *
 * Exactly one form: a `file`, or the shortcut's scalars. Passing both, or neither, is an error — two
 * ways to say what the subject is assembled from is how two variables get changed at once.
 */
export interface HarnessSelection {
  readonly file?: string | undefined
  readonly tools?: readonly string[] | undefined
  readonly persona?: PersonaVariant | undefined
  readonly personaText?: string | undefined
}

/** One harness under test, as a caller may pass it. */
export interface HarnessInput {
  readonly harness: HarnessSelection
  /** Request-level route override; both `null` means "inherit from the delegating parent". */
  readonly provider?: string | undefined
  readonly model?: string | undefined
  /** Delegation budget granted to the subject, i.e. `request.maxDepth`. */
  readonly maxDepth?: number | undefined
}

/** Model route override. Both `null` means "inherit from the delegating parent". */
export interface Route {
  readonly provider: string | null
  readonly model: string | null
}

/** Deployment defaults and where authored harness files live. */
export interface HarnessDefaults {
  readonly tools: readonly string[]
  readonly maxDepth: number
  /** The one directory a non-absolute `file` resolves in, and where `harness_export` writes. */
  readonly harnessDir: string
}

/** Everything `resolveHarness` needs besides the input. */
export interface ResolveDeps {
  readonly defaults: HarnessDefaults
  readonly vocabulary: Vocabulary
}

/** The harness, resolved: the capture, the request settings, and the one identity used to compare. */
export interface ResolvedHarness {
  readonly captured: CapturedHarness
  readonly route: Route
  readonly maxDepth: number
  /**
   * Machine identity of the *stimulus*: harness digest + route + depth.
   *
   * Two records with the same fingerprint describe the same harness applied the same way. Faults and
   * the task are deliberately outside it — they are independent variables, so "same harness under a
   * different fault" must still look like one harness.
   */
  readonly fingerprint: string
}

/** Error raised for a harness that cannot be captured or mounted. */
export class HarnessSpecError extends Error {
  override readonly name = 'HarnessSpecError'
}

/**
 * The absolute path a non-absolute `file` resolves in.
 *
 * **One rule, no fallbacks.** An absolute path is taken as given; anything else is a *name* and resolves
 * in the harness directory, with the extension supplied when it is missing. Earlier versions also tried
 * the process directory first, which meant `harness: { file: 'x.yml' }` could silently pick up an
 * unrelated file that happened to sit where the process started. Predictability beats convenience: the
 * harness directory is where `harness_export` writes, so the common case needs no path at all.
 *
 * @param name - the value the caller passed.
 * @param harnessDir - directory names resolve in.
 * @returns absolute candidates, most literal first.
 */
export function harnessPathCandidates(name: string, harnessDir: string): string[] {
  if (isAbsolute(name)) return [name]
  const base = join(harnessDir, name)
  if (extname(base) !== '') return [base]
  return [base, ...HARNESS_EXTENSIONS.map((extension) => `${base}${extension}`)]
}

/**
 * Find the one file a caller meant.
 * @param name - the value the caller passed.
 * @param harnessDir - directory names resolve in.
 * @returns the absolute path that exists.
 * @throws {HarnessSpecError} when no candidate exists, listing what was tried.
 */
export async function locateHarnessFile(name: string, harnessDir: string): Promise<string> {
  const candidates = harnessPathCandidates(name, harnessDir)
  for (const candidate of candidates) {
    if (await isFile(candidate)) {
      if (!HARNESS_EXTENSIONS.includes(extname(candidate))) {
        throw new HarnessSpecError(
          `"${candidate}" is not a harness file: the host parses only ${HARNESS_EXTENSIONS.join(', ')}`,
        )
      }
      return candidate
    }
  }
  throw new HarnessSpecError(
    `no harness file for "${name}". Tried: ${candidates.join(', ')}. ` +
      `Write one into ${harnessDir}, or call harness_export to start from a shipped preset.`,
  )
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * Capture the harness and resolve the request settings into one recorded value.
 *
 * @param input - the caller's harness selection plus route and depth.
 * @param deps - defaults and the catalogue.
 * @returns the resolved harness and its fingerprint.
 * @throws {HarnessSpecError} when the selection is ambiguous or the file cannot be used.
 */
export async function resolveHarness(
  input: HarnessInput,
  deps: ResolveDeps,
): Promise<ResolvedHarness> {
  const captured = await captureHarness(input.harness, deps)
  const route = resolveRoute(input)
  const maxDepth = resolveMaxDepth(input.maxDepth, deps.defaults.maxDepth)
  const fingerprint = digestText(
    `harness=${captured.digest}` +
      `|route=${route.provider ?? '-'}/${route.model ?? '-'}` +
      `|maxDepth=${String(maxDepth)}`,
  )
  return { captured, route, maxDepth, fingerprint }
}

async function captureHarness(
  selection: HarnessSelection,
  deps: ResolveDeps,
): Promise<CapturedHarness> {
  const hasFile = selection.file !== undefined
  const hasShortcut =
    selection.tools !== undefined ||
    selection.persona !== undefined ||
    selection.personaText !== undefined
  if (hasFile === hasShortcut) {
    throw new HarnessSpecError(
      hasFile
        ? 'pass either `file` or the shortcut scalars (tools / persona), never both: ' +
            'two ways to describe one harness is how two variables get changed at once'
        : 'a harness needs either `file` (a row list) or the shortcut scalars (tools / persona)',
    )
  }

  if (hasShortcut) {
    const shortcut: ShortcutInput = {
      ...(selection.tools === undefined ? {} : { tools: selection.tools }),
      ...(selection.persona === undefined ? {} : { persona: selection.persona }),
      ...(selection.personaText === undefined ? {} : { personaText: selection.personaText }),
    }
    const spec = normalizeShortcut(shortcut, { tools: deps.defaults.tools }, deps.vocabulary)
    const rows = shortcutRows(spec)
    // JSON, not YAML: this text is both what the run directory captures and what a replay parses back,
    // and `JSON.stringify` needs no dialect of its own to be correct.
    const text = `${JSON.stringify(rows, null, 2)}\n`
    return {
      source: 'shortcut',
      fileName: 'harness.json',
      text,
      digest: digestText(text),
      rows,
      spec,
    }
  }

  const originPath = await locateHarnessFile(selection.file ?? '', deps.defaults.harnessDir)
  const text = await readFile(originPath, 'utf8')
  if (text.trim() === '') {
    throw new HarnessSpecError(`harness file "${originPath}" is empty`)
  }
  return {
    source: 'file',
    originPath,
    // The extension is kept: it is how the host decides which parser to use on replay.
    fileName: `harness${extname(originPath)}`,
    text,
    digest: digestText(text),
  }
}

function resolveRoute(input: HarnessInput): Route {
  const provider = input.provider ?? null
  const model = input.model ?? null
  if ((provider === null) !== (model === null)) {
    throw new HarnessSpecError('provider and model must be supplied together or omitted together')
  }
  return { provider, model }
}

function resolveMaxDepth(given: number | undefined, fallback: number): number {
  const maxDepth = given ?? fallback
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) {
    throw new HarnessSpecError(
      'max_depth must be an integer of at least 1: the subject must be startable',
    )
  }
  return maxDepth
}

/**
 * The rows to register, for a harness that will be read from `mountPath`.
 *
 * A file harness becomes exactly one include row, so the host parses the file. A shortcut is already
 * rows and ignores the path — its compiled form is what ran, and its captured JSON is what a replay
 * will parse.
 * @param captured - the captured harness.
 * @param mountPath - absolute path the harness is readable at when it is mounted.
 * @returns rows in load order.
 */
export function harnessRows(captured: CapturedHarness, mountPath: string): readonly HarnessRow[] {
  if (captured.source === 'shortcut') return captured.rows
  return [{ id: INCLUDE_ROW_ID, name: INCLUDE_PLUGIN, config: { path: mountPath } }]
}

/**
 * One-line human label for a captured harness, used as the mounted preset's display name.
 * @param captured - the captured harness.
 * @returns a short description.
 */
export function harnessLabel(captured: CapturedHarness): string {
  return captured.source === 'file' ? basename(captured.originPath) : shortcutLabel(captured.spec)
}
