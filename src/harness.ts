/**
 * The Harness under test, expressed as a *controlled* parameter set.
 *
 * ## Why a closed vocabulary instead of a free plugin tree
 *
 * The obvious design is "the model writes the Harness as JSON". It fails silently: a model that emits
 * `{"deny": ["wite"]}` produces a fault injection that does nothing, and a run that did nothing still
 * produces well-formed records. The worst outcome in an experiment is a *plausible empty result*. So
 * every field here is a closed enum or a bounded list, validated before any child is started.
 *
 * ## Why the Harness declares its own rows instead of delta-ing a shipped preset
 *
 * Cloning a baseline looked cheaper, but `agentPresets.readDocument()` renders a declaration as
 * display YAML — `!!js` conditions included, evaluated form not preserved — and nothing accepts that
 * YAML back (see the `agent-preset-registry` README). Re-mounting it would silently change the
 * composition. So a variant names tools from [catalog.ts](catalog.ts) and owns its rows outright.
 *
 * This module is pure: spec in, normalized values out. No loader, no host service.
 *
 * @module dsh-harness-dispatcher/harness
 */

/** How a tool is broken for the subject. Each mode is a *distinct* experimental condition. */
export type FaultMode =
  /** The tool is not offered at all. Tests *absence*. */
  | 'deny'
  /** The tool is offered and returns a failure the model must handle. Tests *failure handling*. */
  | 'fail'
  /** The tool works, its answer arrives late. Tests *patience and retry*. */
  | 'latency'

/** One injected fault. */
export interface Fault {
  /** Model-facing tool name the fault applies to. */
  readonly tool: string
  readonly mode: FaultMode
  /** Literal text the subject sees. Part of the stimulus, so it is recorded and kept stable. */
  readonly message: string
  /** `latency` only: how long the result is withheld. `0` for the other modes. */
  readonly latencyMs: number
}

/** Persona variants the bench ships. */
export type PersonaVariant =
  /** No persona row at all — the deployment persona applies untouched. */
  | 'none'
  | 'terse'
  | 'verbose'
  | 'pair-programmer'
  /** Caller-supplied prose; bounded, and recorded verbatim in the run metadata. */
  | 'custom'

/** The normalized Harness under test. */
export interface HarnessSpec {
  /**
   * Short identity written into every record. A **human label**: free-form, and a hand-written one can
   * disagree with the fields it sits beside. Use {@link HarnessSpec.fingerprint} to compare records.
   */
  readonly id: string
  /**
   * Machine identity: a short digest of every stimulus-constituting field, with `id` excluded.
   *
   * Two records with the same fingerprint describe the same stimulus; two with different fingerprints
   * do not, **whatever their `id` says**. This is what makes "hold the task fixed, change only the
   * harness" checkable after the fact instead of trustable before it.
   */
  readonly fingerprint: string
  /** Catalog keys of the tools this variant offers. */
  readonly tools: readonly string[]
  /** Resolved persona prose, or `null` when the variant mounts no persona row. */
  readonly persona: string | null
  /** Injected faults, in declaration order. */
  readonly faults: readonly Fault[]
  /** Model route override; both `null` means "inherit from the delegating parent". */
  readonly route: { readonly provider: string | null; readonly model: string | null }
  /** Delegation budget granted to the subject, i.e. `request.maxDepth`. */
  readonly maxDepth: number
}

/** What a caller may pass. Every field is a closed enum or a bounded list. */
export interface HarnessInput {
  readonly id?: string | undefined
  readonly tools?: readonly string[] | undefined
  readonly persona?: PersonaVariant | undefined
  /** Used only with `persona: 'custom'`. */
  readonly personaText?: string | undefined
  readonly faults?: readonly FaultInput[] | undefined
  readonly provider?: string | undefined
  readonly model?: string | undefined
  readonly maxDepth?: number | undefined
}

/** A fault as a caller may pass it; `message` and `latencyMs` default per mode. */
export interface FaultInput {
  readonly tool: string
  readonly mode: FaultMode
  readonly message?: string | undefined
  readonly latencyMs?: number | undefined
}

/** Shipped persona prose. Changing this text changes the stimulus — the spec id moves with it. */
const PERSONAS: Readonly<Record<'terse' | 'verbose' | 'pair-programmer', string>> = {
  terse:
    'You are a terse engineer. Answer in as few words as possible, and never explain your plan.',
  verbose:
    'You are a thorough engineer. Before every tool call, state what you intend to do and why, in prose.',
  'pair-programmer':
    'You are pairing with a human. Narrate each step as you take it, and ask a clarifying question ' +
    'whenever a requirement is ambiguous.',
}

/** Default fault message per mode. Literal and stable: it is part of the stimulus. */
const DEFAULT_MESSAGES: Readonly<Record<FaultMode, string>> = {
  deny: 'This tool is not available in this environment.',
  fail: 'The operation failed: the tool backend returned an internal error.',
  latency: '',
}

/** Default withheld interval for `latency`, in milliseconds. */
const DEFAULT_LATENCY_MS = 1500

/** Hard ceiling on an injected delay: a trial must not be able to outlive its run. */
const MAX_LATENCY_MS = 60_000

/** Longest accepted custom persona, in characters. */
const MAX_PERSONA_TEXT = 4000

/** Error raised for a Harness spec that cannot be run. */
export class HarnessSpecError extends Error {
  override readonly name = 'HarnessSpecError'
}

/** Deployment defaults for omitted fields. */
export interface HarnessDefaults {
  readonly tools: readonly string[]
  readonly maxDepth: number
}

/**
 * The catalog, as `normalize` needs it.
 *
 * Injected rather than imported so this module stays free of the host package ids: the spec layer is
 * pure data validation, and a test can hand it a two-entry table.
 */
export interface HarnessCatalog {
  /** Catalog keys that exist. */
  readonly keys: ReadonlySet<string>
  /**
   * Model-facing tool names the given keys make callable.
   * @param keys - catalog keys the harness mounts.
   * @returns the furnished tool names.
   */
  readonly furnished: (keys: readonly string[]) => ReadonlySet<string>
}

/**
 * Normalize one caller-supplied Harness description into a runnable spec.
 *
 * @param input - the controlled descriptor.
 * @param defaults - deployment defaults for omitted fields.
 * @param catalog - the catalog: which keys exist, and which model-facing tool names each furnishes.
 * @returns the normalized spec.
 * @throws {HarnessSpecError} when the descriptor is internally inconsistent, names unknown catalog
 *   keys, or injects a fault into a tool the chosen composition does not offer.
 */
export function normalize(
  input: HarnessInput,
  defaults: HarnessDefaults,
  catalog: HarnessCatalog,
): HarnessSpec {
  const persona = input.persona ?? 'none'
  if (persona === 'custom') {
    const text = input.personaText?.trim() ?? ''
    if (text === '') throw new HarnessSpecError('persona "custom" requires a non-empty personaText')
    if (text.length > MAX_PERSONA_TEXT) {
      throw new HarnessSpecError(
        `personaText must be at most ${String(MAX_PERSONA_TEXT)} characters`,
      )
    }
  } else if (input.personaText !== undefined) {
    throw new HarnessSpecError('personaText is only meaningful with persona "custom"')
  }

  const tools = [...new Set(input.tools ?? defaults.tools)]
  if (tools.length === 0) {
    // An empty tool set is a legitimate ablation, but it must be asked for explicitly rather than
    // arriving as the result of a typo that emptied a default.
    throw new HarnessSpecError(
      'a harness must offer at least one tool; pass tools explicitly to ablate',
    )
  }
  const unknownTools = tools.filter((tool) => !catalog.keys.has(tool))
  if (unknownTools.length > 0) {
    throw new HarnessSpecError(
      `unknown tool(s) ${unknownTools.map((tool) => `"${tool}"`).join(', ')}; ` +
        `known: ${[...catalog.keys].sort().join(', ')}`,
    )
  }

  const faults = (input.faults ?? []).map((fault, index) => normalizeFault(fault, index))

  // A fault can only fire on a tool this composition actually offers. Without this check the fault is
  // a silent no-op: the run looks like a clean baseline, while its recorded `harness.faults` claims a
  // condition that was never applied. That is the exact failure this repository exists to avoid.
  const offered = catalog.furnished(tools)
  const unfireable = faults.filter((fault) => !offered.has(fault.tool))
  if (unfireable.length > 0) {
    const detail = unfireable.map((fault) => `"${fault.tool}" (${fault.mode})`).join(', ')
    throw new HarnessSpecError(
      `fault(s) target tool(s) this harness does not offer: ${detail}. ` +
        `Note that \`tools\` takes CATALOG KEYS while \`faults[].tool\` takes MODEL-FACING TOOL NAMES — ` +
        `this harness offers: ${[...offered].sort().join(', ') || '(none)'}. ` +
        `Add the catalog key that furnishes the tool, or fix the name.`,
    )
  }

  // One tool under two contradictory conditions is a spec error, not "last one wins": silently
  // choosing would make the record disagree with what the operator believes they configured.
  const seen = new Map<string, FaultMode>()
  for (const fault of faults) {
    const previous = seen.get(fault.tool)
    if (previous !== undefined && previous !== fault.mode) {
      throw new HarnessSpecError(
        `tool "${fault.tool}" has contradictory faults (${previous}, ${fault.mode})`,
      )
    }
    seen.set(fault.tool, fault.mode)
  }

  const maxDepth = input.maxDepth ?? defaults.maxDepth
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) {
    throw new HarnessSpecError(
      'maxDepth must be an integer of at least 1: the subject must be startable',
    )
  }

  const provider = input.provider ?? null
  const model = input.model ?? null
  if ((provider === null) !== (model === null)) {
    throw new HarnessSpecError('provider and model must be supplied together or omitted together')
  }

  const resolvedPersona =
    persona === 'none'
      ? null
      : persona === 'custom'
        ? (input.personaText?.trim() ?? '')
        : PERSONAS[persona]

  const canonical = describe({ tools, persona, resolvedPersona, faults, provider, model })
  const id = input.id ?? canonical
  if (id.trim() === '') throw new HarnessSpecError('harness id must not be empty')

  return {
    id,
    // `id` is a human label and may be anything; `fingerprint` is derived from the fields alone, so it
    // cannot disagree with what actually ran. Compare records by this, never by `id`.
    fingerprint: digest(canonical),
    tools,
    persona: resolvedPersona,
    faults,
    route: { provider, model },
    maxDepth,
  }
}

function normalizeFault(fault: FaultInput, index: number): Fault {
  if (fault.tool.trim() === '') throw new HarnessSpecError(`faults[${String(index)}] names no tool`)
  if (fault.mode !== 'deny' && fault.mode !== 'fail' && fault.mode !== 'latency') {
    throw new HarnessSpecError(
      `faults[${String(index)}].mode must be one of deny, fail, latency (got ${JSON.stringify(fault.mode)})`,
    )
  }
  if (fault.mode !== 'latency' && fault.latencyMs !== undefined && fault.latencyMs !== 0) {
    throw new HarnessSpecError(`faults[${String(index)}]: latencyMs belongs to mode "latency"`)
  }
  if (fault.mode !== 'latency') {
    return {
      tool: fault.tool,
      mode: fault.mode,
      message: fault.message ?? DEFAULT_MESSAGES[fault.mode],
      latencyMs: 0,
    }
  }
  const latencyMs = fault.latencyMs ?? DEFAULT_LATENCY_MS
  if (!Number.isSafeInteger(latencyMs) || latencyMs <= 0 || latencyMs > MAX_LATENCY_MS) {
    throw new HarnessSpecError(
      `faults[${String(index)}]: latencyMs must be a positive integer of at most ${String(MAX_LATENCY_MS)}`,
    )
  }
  return {
    tool: fault.tool,
    mode: 'latency',
    message: fault.message ?? DEFAULT_MESSAGES.latency,
    latencyMs,
  }
}

/**
 * A short, stable digest of one canonical description.
 *
 * FNV-1a over UTF-8, rendered as 10 lowercase hex characters. Not cryptographic and not meant to be:
 * it only has to make "same fields → same value, different fields → different value" true and cheap,
 * so a record can be grouped without re-reading its `harness` object.
 * @param text - the canonical description.
 * @returns the digest.
 */
function digest(text: string): string {
  let hash = 0x811c9dc5
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte
    // `Math.imul` keeps the multiply in 32-bit space; `*` would lose the low bits to float rounding.
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * Canonical description of the stimulus, used for both `fingerprint` and a derived `id`.
 *
 * Derived only from fields that change the stimulus, in a fixed order, so two descriptions of the same
 * Harness produce the same string — that is what lets records be compared without a join.
 * @param parts - the stimulus-constituting fields.
 * @returns a deterministic description.
 */
function describe(parts: {
  tools: readonly string[]
  persona: PersonaVariant
  resolvedPersona: string | null
  faults: readonly Fault[]
  provider: string | null
  model: string | null
}): string {
  const segments = [`tools=${[...parts.tools].sort().join(',')}`]
  // A custom persona's identity is its text; a shipped variant's identity is its name.
  segments.push(
    parts.persona === 'custom'
      ? `persona=custom:${parts.resolvedPersona ?? ''}`
      : `persona=${parts.persona}`,
  )
  if (parts.faults.length > 0) {
    segments.push(
      `faults=${parts.faults
        .map((fault) => `${fault.mode}:${fault.tool}`)
        .sort()
        .join('+')}`,
    )
  }
  if (parts.provider !== null && parts.model !== null)
    segments.push(`route=${parts.provider}/${parts.model}`)
  return segments.join('|')
}
