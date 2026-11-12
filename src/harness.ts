/**
 * The harness under test: one captured row list, plus the request settings that make a stimulus.
 *
 * One read, three consumers — digest (the declared identity), run-directory copy (evidence), subject
 * rows (what `agentPresets.register` receives). All three come from that one string, so "the recorded
 * digest describes what ran" holds by construction.
 *
 * A file harness is handed to the host as a single `cordis:include` row: the Loader parses its own
 * dialect, and a second parser here would be a second definition of "a harness".
 *
 * `agentOptions` and `maxDepth` cannot be written into a row list, so they sit beside the harness —
 * which is what lets one file run under two routes. `sealed` is beside them for the same reason: it
 * says how much of the host the harness replaces, not which harness it is, and one file can be run
 * both ways. {@link ResolvedHarness.fingerprint} covers all three.
 *
 * @module dsh-harness-dispatcher/harness
 */

import { readFile, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
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

/** The masking row this package ships; see {@link sealedRows}. */
const SEALED_PLUGIN = 'dsh-harness-dispatcher/sealed'

/** Row id of the masking row. */
const SEALED_ROW_ID = 'bench-sealed'

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
 *
 * `sealed` is not one of those forms: it says how much of the *host* the harness replaces, not which
 * harness it is, so it sits beside them and can be combined with either.
 */
export interface HarnessSelection {
  readonly file?: string | undefined
  readonly tools?: readonly string[] | undefined
  readonly persona?: PersonaVariant | undefined
  readonly personaText?: string | undefined
  /**
   * Make the harness the whole tool set instead of a delta on the host.
   *
   * Part of the stimulus, not a rendering preference: unsealed, the subject also inherits every tool
   * the host mounts, which on this machine was 41 tools against a sealed 4. Measured 2026-11-11 —
   * leaving it out of the fingerprint let those two runs share one identity.
   */
  readonly sealed?: boolean | undefined
}

/** One harness under test, as a caller may pass it. */
export interface HarnessInput {
  readonly harness: HarnessSelection
  /** Request-level route override; both `null` means "inherit from the delegating parent". */
  readonly provider?: string | undefined
  readonly model?: string | undefined
  /**
   * Request-level generation controls, siblings of the route for the same reason it is one.
   *
   * They are the other half of "how the subject was asked": the host's `AgentOptions` carries
   * `reasoningEffort` and `maxTokens` beside `provider`/`model`, and a comparison that holds the model
   * fixed while moving its effort is a standard ablation this bench could not express until now.
   * `null` inherits, so an omitted value changes nothing.
   */
  readonly reasoningEffort?: string | undefined
  readonly maxTokens?: number | undefined
  /** Delegation budget granted to the subject, i.e. `request.maxDepth`. */
  readonly maxDepth?: number | undefined
}

/**
 * How the subject was asked: the route, plus the two generation controls the host keeps beside it.
 *
 * All `null` means "inherit from the delegating parent". The four travel together because the host's own
 * `AgentOptions` is exactly these four fields — splitting them would make the record describe a request
 * the host cannot send.
 */
export interface Route {
  readonly provider: string | null
  readonly model: string | null
  readonly reasoningEffort: string | null
  readonly maxTokens: number | null
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
  /** Whether the mask row is part of this stimulus; see {@link HarnessSelection.sealed}. */
  readonly sealed: boolean
  /**
   * Machine identity of the *stimulus*: harness digest + route + depth + sealed.
   *
   * Two records with the same fingerprint describe the same harness applied the same way. Faults and
   * the task are deliberately outside it — they are independent variables, so "same harness under a
   * different fault" must still look like one harness.
   *
   * `sealed` is **inside** it, and that is a correction rather than an original decision: it is a
   * request-level switch in exactly the same sense as the route and the depth, and omitting it made a
   * 4-tool subject and a 41-tool subject share one identity (measured 2026-11-11, redline B32).
   */
  readonly fingerprint: string
}

/** Error raised for a harness that cannot be captured or mounted. */
export class HarnessSpecError extends Error {
  override readonly name = 'HarnessSpecError'
}

/**
 * The absolute paths a `file` value may mean, most literal first.
 *
 * An absolute path is taken as given; anything else is a *name* and resolves in the harness directory,
 * with the extension supplied when missing. No fallback to the process directory: it once let
 * `file: 'x.yml'` pick up an unrelated file from wherever the process started.
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
  const sealed = input.harness.sealed === true
  const fingerprint = digestText(
    `harness=${captured.digest}` +
      `|route=${route.provider ?? '-'}/${route.model ?? '-'}` +
      // The generation controls are inside the identity for the same reason `sealed` is: they are
      // request-level switches that change what the subject receives, so two runs that differ only here
      // are two experiments. Measured 2026-11-12 — the same harness under two efforts shared one
      // fingerprint before this line existed.
      `|effort=${route.reasoningEffort ?? '-'}` +
      `|maxTokens=${route.maxTokens === null ? '-' : String(route.maxTokens)}` +
      `|maxDepth=${String(maxDepth)}` +
      `|sealed=${String(sealed)}`,
  )
  return { captured, route, maxDepth, sealed, fingerprint }
}

async function captureHarness(
  selection: HarnessSelection,
  deps: ResolveDeps,
): Promise<CapturedHarness> {
  const hasFile = selection.file !== undefined
  // `sealed` is deliberately not one of these: it says how much of the host the harness replaces, not
  // which harness it is. Counting it would make `{ sealed: true }` alone look like a shortcut and mount
  // a harness nobody named.
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
  const reasoningEffort =
    input.reasoningEffort?.trim() === '' ? null : (input.reasoningEffort?.trim() ?? null)
  const maxTokens = resolveMaxTokens(input.maxTokens)
  // The host applies a generation control only to a route it selects: `applyConfiguredRoute` returns
  // early unless both provider and model are present. A control accepted here and dropped there would be
  // the silent kind of wrong, so it is refused here instead. Measured 2026-11-12.
  if (provider === null && (reasoningEffort !== null || maxTokens !== null)) {
    throw new HarnessSpecError(
      'reasoning_effort and max_tokens need a route: name `provider` and `model` as well, because the ' +
        'host applies a generation control only to a route it can select. Leaving all four unset ' +
        "inherits the parent's route and its controls.",
    )
  }
  return { provider, model, reasoningEffort, maxTokens }
}

/**
 * Validate the output-token ceiling.
 *
 * Zero and negatives are not "no limit" — the host would send them as a cap and the subject would be cut
 * off at the first token. Absent is the only way to say "inherit".
 * @param given - the caller's value, if any.
 * @returns the value, or `null` when omitted.
 * @throws {HarnessSpecError} when it is not a positive integer.
 */
function resolveMaxTokens(given: number | undefined): number | null {
  if (given === undefined) return null
  if (!Number.isSafeInteger(given) || given < 1) {
    throw new HarnessSpecError('max_tokens must be a positive integer, or omitted to inherit')
  }
  return given
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
 * The rows to register: one include row for a file, the compiled rows for a shortcut.
 *
 * `path` must be a `file:` URL. The host builds it with `new URL(path, baseUrl)`, so on Windows a drive
 * letter parses as a URL scheme and `fileURLToPath` throws — an absolute path in `path` never mounts.
 * @param captured - the captured harness.
 * @param mountPath - absolute path the harness is readable at when it is mounted.
 * @returns rows in load order.
 */
export function harnessRows(captured: CapturedHarness, mountPath: string): readonly HarnessRow[] {
  if (captured.source === 'shortcut') return captured.rows
  return [{ id: INCLUDE_ROW_ID, name: INCLUDE_PLUGIN, config: { path: fileURLOf(mountPath) } }]
}

/**
 * A row that hides the tools the host would otherwise hand the subject.
 *
 * Must be mounted before the harness's own rows: a scope's own registrations are exempt from
 * restrictions, so ordering is what leaves the harness visible and the inherited tools masked.
 *
 * Tools only: skills cannot be masked, and a subject is cut off from them by not being given a `skill`
 * tool. See [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md), under 增量与封闭.
 * @param deny - tool names to remove; empty produces no row at all.
 * @returns zero or one row.
 */
export function sealedRows(deny: readonly string[]): readonly HarnessRow[] {
  if (deny.length === 0) return []
  return [{ id: SEALED_ROW_ID, name: SEALED_PLUGIN, config: { deny: [...deny] } }]
}

/**
 * The absolute path to mount a file harness from: the operator's file, not the run-directory copy.
 *
 * The copy is evidence. Mounting it would move the resolution base to the run directory, which is
 * outside every profile tree, so every `@deepseek-ai/…` row name in the file would fail to import.
 * @param captured - the captured harness.
 * @param runCopyPath - where the run directory keeps its verbatim copy.
 * @returns the path to mount.
 */
export function mountPathFor(captured: CapturedHarness, runCopyPath: string): string {
  return captured.source === 'file' ? captured.originPath : runCopyPath
}

/**
 * Where an inspection mounts a harness from, when it has no run copy to fall back on.
 *
 * An inspection mounts the operator's file, so that a later edit is what gets inspected. A shortcut has
 * no file at all: its rows are already materialised, and the include row — the only row that ever
 * carries a path — does not exist for it. The empty string is that absence, and it belongs here rather
 * than at the call site, so no caller has to know a shortcut ignores the path.
 * @param captured - the captured harness.
 * @returns an absolute path, or `''` for the shortcut.
 */
export function sourcePathOf(captured: CapturedHarness): string {
  return captured.source === 'file' ? captured.originPath : ''
}

/**
 * Rows in mount order: the mask first, then the harness.
 *
 * The order is semantics, not tidiness. `tools.restrict` masks the scope it is called from while that
 * scope's own registrations are exempt, so a mask mounted *after* the harness hides the harness too and
 * the subject sees nothing at all — a silent empty bench rather than an error. Two call sites building
 * this list by hand would be two chances to write it the wrong way round, so the order has one home
 * here (redline B15).
 * @param captured - the harness under test.
 * @param options.mountPath - where the harness is readable at when it mounts.
 * @param options.denied - tool names to hide; empty mounts no mask row at all.
 * @returns rows in load order, mask first.
 */
export function mountRows(
  captured: CapturedHarness,
  options: { readonly mountPath: string; readonly denied: readonly string[] },
): readonly HarnessRow[] {
  return [...sealedRows(options.denied), ...harnessRows(captured, options.mountPath)]
}

/** A `file:` URL the host's include plugin accepts. See the note on {@link harnessRows}. */
function fileURLOf(absolutePath: string): string {
  return pathToFileURL(absolutePath).href
}

/**
 * One-line human label for a captured harness, used as the mounted preset's display name.
 * @param captured - the captured harness.
 * @returns a short description.
 */
export function harnessLabel(captured: CapturedHarness): string {
  return captured.source === 'file' ? basename(captured.originPath) : shortcutLabel(captured.spec)
}
