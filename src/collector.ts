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
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { emptyFold, finishFold, foldEvent } from './fold.ts'
import type { FoldState, TrialObservations } from './fold.ts'

/** One subject's accumulator: the fold, the raw log when asked for, and the Session it belongs to. */
interface Armed {
  readonly state: FoldState
  readonly events: SessionEvent[] | null
  /**
   * The Session object itself, captured from the first committed event.
   *
   * Kept because the host's projections can only be read against a Session, and by the time a trial can
   * read anything the activation has already settled — `ctx.sessions.get(id)` answers `undefined` then.
   * The callback hands it over on every event, so this is the one reference that outlives the store
   * lookup.
   */
  session: unknown
}

/**
 * Collects folds for the Sessions under test.
 *
 * Lifetime: one per plugin instance, armed per trial. An idle collector holds an empty map and costs
 * one lookup per committed event — it must never change behaviour for anyone else's session.
 */
export class FoldCollector {
  private readonly armed = new Map<string, Armed>()

  /**
   * Subscribe to the committed-event feed.
   * @param ctx - context whose fiber owns the subscription.
   */
  attach(ctx: Context): void {
    ctx.on('session/event', (session, event) => {
      const entry = this.armed.get(String(session.id))
      if (entry === undefined) return
      entry.session = session
      foldEvent(entry.state, event)
      entry.events?.push(event)
    })
  }

  /**
   * Begin folding one subject Session.
   * @param sessionId - the subject's Session id.
   * @param recordEvents - also keep every committed event verbatim, for the caller that wants the
   *   bottom layer rather than this repository's reading of it. Required rather than defaulted: the
   *   tool's `record_events` defaults to on, and a second default here would be a second definition of
   *   the same thing — the one shape of drift this repository exists to avoid.
   * @returns the disposer that stops folding and releases the accumulator. Reading afterwards yields
   *   `undefined`, so a leaked read cannot silently return another trial's numbers.
   */
  arm(sessionId: string, recordEvents: boolean): () => void {
    const entry: Armed = {
      state: emptyFold(),
      events: recordEvents ? [] : null,
      session: undefined,
    }
    this.armed.set(sessionId, entry)
    return () => {
      // Only remove this arm: two overlapping trials must not release each other's accumulator.
      if (this.armed.get(sessionId) === entry) this.armed.delete(sessionId)
    }
  }

  /**
   * Read (but do not release) one subject's fold so far.
   * @param sessionId - the subject's Session id.
   * @returns both views, or `undefined` when the subject is not armed.
   */
  read(sessionId: string): TrialObservations | undefined {
    const entry = this.armed.get(sessionId)
    return entry === undefined ? undefined : finishFold(entry.state)
  }

  /**
   * The raw committed events for one subject, in `seq` order.
   * @param sessionId - the subject's Session id.
   * @returns the events, or `undefined` when the subject is not armed or was armed without recording.
   */
  takeEvents(sessionId: string): readonly SessionEvent[] | undefined {
    return this.armed.get(sessionId)?.events ?? undefined
  }

  /**
   * The Session object this subject's events arrived on.
   * @param sessionId - the subject's Session id.
   * @returns the Session, or `undefined` when the subject is not armed or never emitted an event.
   */
  sessionOf(sessionId: string): unknown {
    return this.armed.get(sessionId)?.session
  }
}
