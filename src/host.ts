/**
 * The host's own numbers, read verbatim.
 *
 * This module exists because recomputing what the host already computes produces two numbers with one
 * name. It did: this bench counted `turn/end` events and called the result `turns`, while the host's
 * `sessionStats` counts *turns carrying at least one closed step*, excluding rejected and empty ones.
 * A record and the status bar then disagreed about the same session, and neither was wrong.
 *
 * So the rule here is **export, do not process**: {@link HOST_KEYS} names projection keys the host
 * maintains, and whatever comes back is written into the record unchanged. A new host projection costs
 * one string in that list — no fold, no schema field, no migration. A key that is not registered simply
 * does not appear, which is the honest outcome: the reader learns the host does not compute it, rather
 * than being shown a zero.
 *
 * Both services are **optional**. Injecting them would make the whole plugin wait for a profile that
 * mounts no projection registry — the trap this repository already documented for `skills`.
 *
 * @module dsh-harness-dispatcher/host
 */

import type { Context } from '@deepseek-ai/cordis'

/**
 * Projection keys this bench exports.
 *
 * Chosen for what a harness comparison needs and cannot get elsewhere: timing and counts
 * (`sessionStats`), the four disjoint token buckets (`tokenUsage`), how close the context came to its
 * window and what it was made of (`contextPressure` / `contextBreakdown`), the policy the subject ran
 * under (`permissions`), and the behaviours that are pure harness decisions rather than model output —
 * whether it compacted, delegated, planned, or tracked a todo list.
 */
export const HOST_KEYS = [
  'sessionStats',
  'tokenUsage',
  'contextPressure',
  'contextBreakdown',
  'permissions',
  'workingDirectory',
  'subagentCatalog',
  'subagentTiming',
  'turnOutline',
  'agentPreset',
  'modelSelection',
  'title',
  'goal',
  'plan',
  'todos',
] as const

/**
 * The host's projection values at one log cut.
 *
 * `asOfSeq` is kept because the values are only meaningful with it: a projection read mid-turn and one
 * read after settlement are different facts, and the field says which one this is.
 */
export interface HostSnapshot {
  /** Seq of the last event the values reflect; `-1` for an empty log. */
  readonly asOfSeq: number
  /** One entry per projection the host actually registered among {@link HOST_KEYS}. */
  readonly values: Readonly<Record<string, unknown>>
}

/** The projection registry as this module needs it. */
interface ProjectionReader {
  snapshot(
    session: never,
    keys: readonly string[],
  ): { asOfSeq: number; values: Record<string, unknown> }
}

/**
 * The outcome of one host read: the values, or the reason there are none.
 *
 * A reason rather than a bare `null`, because "this profile mounts no projection registry" and "the
 * Session was already torn down when we asked" are different findings, and the first one means the
 * reader should stop looking for host numbers while the second means this bench asked too late.
 */
export type HostRead =
  | { readonly ok: true; readonly asOfSeq: number; readonly values: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string }

/**
 * Read the host's projection values for one subject Session.
 *
 * Takes the **Session object**, not an id. `SubagentActivation.result` settles only after teardown, so
 * by the time a trial can read anything the session store no longer answers for that child — measured
 * on host `0.2.2-rc.1`: every trial recorded `host: null` while its events were landing normally. The
 * object arrives on every `session/event` callback, so the collector keeps it and this module folds
 * the registry over that in-memory log instead of looking a dead session up.
 *
 * @param ctx - the plugin context, used only to look the registry up.
 * @param session - the subject's Session, as delivered by `session/event`.
 * @returns the values with the seq they describe, or the reason there are none.
 */
export function readHost(ctx: Context, session: unknown): HostRead {
  if (session === undefined) {
    return { ok: false, reason: 'the subject emitted no events, so there was no Session to read' }
  }
  const projections = ctx.get('sessionProjections') as ProjectionReader | undefined
  if (projections === undefined) {
    return { ok: false, reason: 'this profile mounts no projection registry (sessionProjections)' }
  }
  try {
    const taken = projections.snapshot(session as never, HOST_KEYS)
    return { ok: true, asOfSeq: taken.asOfSeq, values: taken.values }
  } catch (error) {
    // A projection that refuses to fold is the host's answer too, and losing the trial over it would
    // be worse than recording why the numbers are missing.
    return {
      ok: false,
      reason: `the host refused to fold its projections for this Session: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }
}
