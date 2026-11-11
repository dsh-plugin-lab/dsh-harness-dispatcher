/**
 * Injected tool faults: the shape, and the two checks that stop a fault from being a silent no-op.
 *
 * A fault is a **time-varying** stimulus applied on the tool pipelines, not a row in the harness (see
 * [gate.ts](gate.ts)). So the same harness can run under different faults — harness and fault stay two
 * independent variables — and a fault can reach a tool the harness mounts, which we never parsed.
 *
 * A fault naming an unreachable tool would produce a well-formed record of a condition that was never
 * applied. That is worse than no experiment, so it is rejected against the tool names *observed after
 * mounting*, not a static catalogue.
 *
 * @module dsh-harness-dispatcher/fault
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

/** A fault as a caller may pass it; `message` and `latencyMs` default per mode. */
export interface FaultInput {
  readonly tool: string
  readonly mode: FaultMode
  readonly message?: string | undefined
  readonly latencyMs?: number | undefined
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

/** The three modes, as a runtime value, so callers need not keep a second copy. */
export const FAULT_MODES: readonly FaultMode[] = ['deny', 'fail', 'latency']

/** Error raised for a fault set that cannot be run. */
export class FaultSpecError extends Error {
  override readonly name = 'FaultSpecError'
}

/**
 * Validate and default one caller-supplied fault set.
 *
 * Shape only. Whether a fault can actually fire depends on what the harness mounts, which is not
 * known until it is mounted — see {@link assertFaultsReachable}.
 * @param input - faults as the caller passed them.
 * @returns faults in declaration order, with per-mode defaults applied.
 * @throws {FaultSpecError} for an unknown mode, a misused `latencyMs`, or a contradictory pair.
 */
export function normalizeFaults(input: readonly FaultInput[] | undefined): Fault[] {
  const faults = (input ?? []).map(normalizeFault)

  // One tool under two contradictory conditions is a spec error, not "last one wins": silently
  // choosing would make the record disagree with what the operator believes they configured.
  const seen = new Map<string, FaultMode>()
  for (const fault of faults) {
    const previous = seen.get(fault.tool)
    if (previous !== undefined && previous !== fault.mode) {
      throw new FaultSpecError(
        `tool "${fault.tool}" has contradictory faults (${previous}, ${fault.mode})`,
      )
    }
    seen.set(fault.tool, fault.mode)
  }
  return faults
}

function normalizeFault(fault: FaultInput, index: number): Fault {
  if (fault.tool.trim() === '') throw new FaultSpecError(`faults[${String(index)}] names no tool`)
  if (!FAULT_MODES.includes(fault.mode)) {
    throw new FaultSpecError(
      `faults[${String(index)}].mode must be one of ${FAULT_MODES.join(', ')} (got ${JSON.stringify(fault.mode)})`,
    )
  }
  if (fault.mode !== 'latency' && fault.latencyMs !== undefined && fault.latencyMs !== 0) {
    throw new FaultSpecError(`faults[${String(index)}]: latencyMs belongs to mode "latency"`)
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
    throw new FaultSpecError(
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
 * Reject faults that no tool of this harness could ever receive.
 *
 * @param faults - normalized faults.
 * @param visible - model-facing tool names the mounted harness makes callable.
 * @throws {FaultSpecError} naming every unreachable fault, and listing what *was* visible.
 */
export function assertFaultsReachable(faults: readonly Fault[], visible: readonly string[]): void {
  if (faults.length === 0) return
  const reachable = new Set(visible)
  const unreachable = faults.filter((fault) => !reachable.has(fault.tool))
  if (unreachable.length === 0) return
  const detail = unreachable.map((fault) => `"${fault.tool}" (${fault.mode})`).join(', ')
  throw new FaultSpecError(
    `fault(s) target tool(s) this harness does not offer: ${detail}. ` +
      `This harness makes callable: ${visible.join(', ') || '(none)'}. ` +
      'Add the row that furnishes the tool, or fix the name.',
  )
}
