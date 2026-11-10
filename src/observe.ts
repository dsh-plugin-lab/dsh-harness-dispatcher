/**
 * The trace collector: a per-subject fold fed by the `session/event` feed.
 *
 * ## Why the event feed and not the finished log
 *
 * The running host marks `Session.snapshotEvents()` / `eventAt()` / `ownEvents()` as
 * `@deprecated … new calls are prohibited`. The sanctioned read path for derived per-session state is
 * to fold committed events as they arrive. This collector is that fold: one listener for the whole
 * plugin, one accumulator per armed subject, torn down when the subject's trial ends.
 *
 * ## Why not a Projection unit
 *
 * A Projection unit would also fold events, and it is the right shape for state a *client* should see.
 * It is the wrong shape here, for three concrete reasons:
 *
 *   1. Its `ProjectionDefinition` requires a `zod` schema, and `dsh-session-projection` ships its own
 *      nested `zod` (4.4.3) while the host top level resolves a different one (4.6.7). Handing it a
 *      foreign schema instance is a silent-failure surface, and the failure mode is "no records".
 *   2. A host-only unit never fires `onEventChanged` (that feed is documented as reporting only
 *      *client-visible* unit changes), so a host-only projection cannot be observed by its own owner.
 *   3. A projection's value is per-session *state*, published to clients. This bench needs a value read
 *      exactly once, at end of trial, by the process that armed it — not a published read model.
 *
 * If a future version wants a live benchmark panel in the UI, that is the moment to *also* register a
 * projection for display. The record itself does not depend on one.
 *
 * @module dsh-harness-dispatcher/observe
 */

import type { Context } from '@deepseek-ai/cordis'
import { emptyTrace, finishTrace, foldEvent } from './trace.ts'
import type { TraceFeatures, TraceState } from './trace.ts'

/**
 * Collects folds for the Sessions under test.
 *
 * Lifetime: one per plugin instance, armed per trial. An idle collector holds an empty map and costs
 * one lookup per committed event — it must never change behaviour for anyone else's session.
 */
export class TraceCollector {
  private readonly folds = new Map<string, TraceState>()

  /**
   * Subscribe to the committed-event feed.
   * @param ctx - context whose fiber owns the subscription.
   */
  attach(ctx: Context): void {
    ctx.on('session/event', (session, event) => {
      const fold = this.folds.get(String(session.id))
      if (fold === undefined) return
      foldEvent(fold, event)
    })
  }

  /**
   * Begin folding one subject Session.
   * @param sessionId - the subject's Session id.
   * @returns the disposer that stops folding and releases the accumulator. Reading afterwards yields
   *   `undefined`, so a leaked read cannot silently return another trial's numbers.
   */
  arm(sessionId: string): () => void {
    const state = emptyTrace()
    this.folds.set(sessionId, state)
    return () => {
      // Only remove this arm: two overlapping trials must not release each other's accumulator.
      if (this.folds.get(sessionId) === state) this.folds.delete(sessionId)
    }
  }

  /**
   * Read (but do not release) one subject's fold so far.
   * @param sessionId - the subject's Session id.
   * @returns the features, or `undefined` when the subject is not armed.
   */
  read(sessionId: string): TraceFeatures | undefined {
    const fold = this.folds.get(sessionId)
    return fold === undefined ? undefined : finishTrace(fold)
  }

  /** How many subjects are currently armed. Reported so a leaked arm is visible rather than assumed away. */
  get size(): number {
    return this.folds.size
  }
}
