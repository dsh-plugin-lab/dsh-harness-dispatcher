/**
 * The fault gate: one Host-level seam that breaks tools **only for a subject Session**.
 *
 * Why a gate and not a row inside the subject's preset (the obvious design):
 *
 *   1. A preset-mounted fault row would have to sit *after* every tool row, because `tools.restrict()`
 *      rejects unknown global tool names — one wrong order and the whole preset fails to mount, so the
 *      experiment dies instead of producing a result. See docs/ARCHITECTURE.md §2.5.
 *   2. A preset row can only change what the subject *starts with*. The three tool pipelines below are
 *      **Scoped** events that carry `exec.agent`, so a single global listener can apply per-subject
 *      behaviour to work that is already running, including a subject's own children.
 *   3. One implementation means every Harness variant is degraded by exactly the same mechanism —
 *      a precondition for comparing variants.
 *
 * The gate is armed per trial and disarmed when the trial ends, so an idle gate costs one map lookup
 * and never changes any other agent's behaviour.
 *
 * @module dsh-harness-dispatcher/gate
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Fault } from './harness.ts'

/** What a gate needs to know about one armed subject. */
interface ArmedSubject {
  /** Faults keyed by the model-facing tool name. */
  readonly byTool: ReadonlyMap<string, Fault>
}

/** A sleep that ends early — and cleanly — when the caller's signal aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms)
    function finish(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    signal.addEventListener('abort', finish, { once: true })
  })
}

/**
 * Applies armed faults to whichever tool call the subject makes.
 *
 * Lifetime: create one per plugin instance; `arm()` returns the disposer a trial MUST call in a
 * `finally` block. Registration of the pipeline listeners happens once, in `attach()`.
 */
export class FaultGate {
  private readonly armed = new Map<string, ArmedSubject>()

  /** Wire the three tool-pipeline stages. Disposing the owning fiber removes them. */
  attach(ctx: Context): void {
    // `deny` — the tool is not offered. Absence, not failure.
    ctx.on('tools/pre-execute', async (exec, next) => {
      const fault = this.faultFor(exec.agent?.id, exec.name, 'deny')
      if (fault === undefined) return next()
      return { kind: 'deny', reason: fault.message }
    })

    // `latency` — the tool works, the answer is late. Wrappers own only their own delay: the registry
    // re-fuses the caller signal, so an aborted trial is never held hostage by an injected sleep.
    ctx.on('tools/execute', async (exec, next) => {
      const fault = this.faultFor(exec.agent?.id, exec.name, 'latency')
      if (fault === undefined) return next()
      await sleep(fault.latencyMs, exec.signal)
      exec.signal.throwIfAborted()
      return next()
    })

    // `fail` — the tool ran (or was never reached), and the subject receives a failure result it must
    // handle. `block` is the documented way to turn a result into an error result with feedback text.
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const fault = this.faultFor(exec.agent?.id, exec.name, 'fail')
      if (fault === undefined) return next()
      // Preserve a real failure rather than overwriting it with a synthetic one: a fault injection
      // must not disguise a genuine defect as the injected stimulus.
      if (result.isError) return next()
      return { kind: 'block', feedback: [{ type: 'text', text: fault.message }] }
    })
  }

  /**
   * Make `faults` effective for exactly one subject Session.
   * @param sessionId - the subject's Session id (the child id returned by the activation).
   * @param faults - the spec's faults; an empty list arms nothing.
   * @returns the disposer that disarms this subject. Idempotent.
   */
  arm(sessionId: string, faults: readonly Fault[]): () => void {
    if (faults.length === 0) return () => {}
    const byTool = new Map<string, Fault>()
    for (const fault of faults) byTool.set(fault.tool, fault)
    const subject: ArmedSubject = { byTool }
    this.armed.set(sessionId, subject)
    return () => {
      // Only remove this arm, never "everything": two overlapping trials must not disarm each other.
      if (this.armed.get(sessionId) === subject) this.armed.delete(sessionId)
    }
  }

  /** How many subjects are currently armed. Reported by the tool so a leaked arm is visible. */
  get size(): number {
    return this.armed.size
  }

  private faultFor(
    sessionId: string | undefined,
    tool: string,
    mode: Fault['mode'],
  ): Fault | undefined {
    if (sessionId === undefined) return undefined
    const subject = this.armed.get(sessionId)
    if (subject === undefined) return undefined
    const fault = subject.byTool.get(tool)
    return fault?.mode === mode ? fault : undefined
  }
}
