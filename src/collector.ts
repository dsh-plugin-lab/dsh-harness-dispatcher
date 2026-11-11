/**
 * The per-subject fold: one accumulator per armed Session, torn down when its trial ends.
 *
 * Nothing here decides anything. It exists so that a trial can say "fold every committed event of
 * *this* session, and only this one" without the tool loop holding a map of its own, and so that an
 * unarmed collector costs one lookup per host event and changes no one's behaviour.
 *
 * @module dsh-harness-dispatcher/collector
 */

import type { Context } from '@deepseek-ai/cordis'
import { emptyFold, finishFold, foldEvent } from './fold.ts'
import type { FoldState, TrialObservations } from './fold.ts'
/**
 * Collects folds for the Sessions under test.
 *
 * Lifetime: one per plugin instance, armed per trial. An idle collector holds an empty map and costs
 * one lookup per committed event — it must never change behaviour for anyone else's session.
 */
export class FoldCollector {
  private readonly folds = new Map<string, FoldState>()

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
    const state = emptyFold()
    this.folds.set(sessionId, state)
    return () => {
      // Only remove this arm: two overlapping trials must not release each other's accumulator.
      if (this.folds.get(sessionId) === state) this.folds.delete(sessionId)
    }
  }

  /**
   * Read (but do not release) one subject's fold so far.
   * @param sessionId - the subject's Session id.
   * @returns both views, or `undefined` when the subject is not armed.
   */
  read(sessionId: string): TrialObservations | undefined {
    const fold = this.folds.get(sessionId)
    return fold === undefined ? undefined : finishFold(fold)
  }

  /** How many subjects are currently armed. Reported so a leaked arm is visible rather than assumed away. */
  get size(): number {
    return this.folds.size
  }
}
