/**
 * Deterministic trace features, folded from one child Session's committed events.
 *
 * ## Read path
 *
 * Features are folded **incrementally from the `session/event` feed**, not read off a finished log.
 * That is not a style preference: `Session.snapshotEvents()` / `eventAt()` / `ownEvents()` carry
 * `@deprecated … new calls are prohibited` in the running host (see the 2026-09-09 Agent Note on
 * deprecating synchronous session-event reads). A plugin that reads a finished log synchronously is
 * writing against an API the host has already retired.
 *
 * So the shape is: a pure reducer ([foldEvent]) that the collector feeds one event at a time, and
 * [summarize] as the same reducer over an array — the second form exists so a persisted log can be
 * re-folded later by anyone, with any tool, and must agree with the live fold.
 *
 * ## What is deliberately NOT here
 *
 * No statistic (mean, rate, interval, score) and no semantic judgement (was the answer right?).
 * The fold records the raw facts those judgements need — the last tool failure, the final assistant
 * text — and stops. See docs/ARCHITECTURE.md §4.3.
 *
 * @module dsh-harness-dispatcher/trace
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Token counts for one child Session, as reported by the adapter. Never estimated here. */
export interface TraceUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  /**
   * How many assistant settlements carried no `usage`. A missing report is recorded as *missing*, never
   * as zero: conflating "the adapter did not say" with "the model used no tokens" would make every
   * route that omits usage look infinitely cheap.
   */
  readonly unreportedSettlements: number
}

/** One tool's accumulated counts. */
export interface TraceToolCount {
  readonly calls: number
  readonly errors: number
}

/** What one child Session did, stated only as countable or literal facts. */
export interface TraceFeatures {
  /** Completed turns (`turn/end` events). */
  readonly turns: number
  /** Closed steps (`step/end`) — one model call plus the tools it requested. */
  readonly steps: number
  /** Total `tool/call` events, including re-issued call ids from a retried step. */
  readonly toolCalls: number
  /** Total `tool/result` events whose message carries `isError: true`. */
  readonly toolErrors: number
  /** Per-tool-name counts, keyed by the model-facing tool name. */
  readonly byTool: Readonly<Record<string, TraceToolCount>>
  /** Calls that produced no result at all (the run ended inside the call). */
  readonly unansweredCalls: number
  /**
   * `true` when at least one tool failed and the most recent tool result was still a failure — i.e.
   * the run ended with the failure standing. A *structural* fact, not a judgement about the answer.
   */
  readonly endedOnUnrecoveredError: boolean
  /** The last assistant settlement's concatenated text, truncated. `null` when none was produced. */
  readonly finalText: string | null
  /** The `code` of the last tool failure, when the log carries one. */
  readonly lastToolErrorCode: string | null
  /** The `name` of the last tool failure, when the log carries one. */
  readonly lastToolErrorName: string | null
  /** Token accounting; `null` when the adapter reported nothing at all. */
  readonly usage: TraceUsage | null
  /** True when any assistant settlement was marked `interrupted`. */
  readonly interrupted: boolean
  /** Turn-end reason kinds in order, e.g. `['completed']` or `['error']`. */
  readonly turnEndReasons: readonly string[]
}

/** Longest assistant text kept in a record. Records are evidence, not transcripts. */
const TEXT_LIMIT = 2000

/**
 * Mutable fold state.
 *
 * Exposed because incremental folding needs a place to accumulate. Consumers treat it as opaque and
 * hand it back to {@link foldEvent} / {@link finishTrace}; the test suite constructs it only through
 * {@link emptyTrace}.
 */
export interface TraceState {
  turns: number
  steps: number
  toolCalls: number
  toolErrors: number
  byTool: Record<string, { calls: number; errors: number }>
  /** Call ids awaiting a result, in issue order. */
  pending: Map<string, string>
  lastResultErrored: boolean
  finalText: string | null
  lastToolErrorCode: string | null
  lastToolErrorName: string | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  unreportedSettlements: number
  sawAnyUsage: boolean
  interrupted: boolean
  turnEndReasons: string[]
}

/** A fresh, empty fold state. */
export function emptyTrace(): TraceState {
  return {
    turns: 0,
    steps: 0,
    toolCalls: 0,
    toolErrors: 0,
    byTool: {},
    pending: new Map<string, string>(),
    lastResultErrored: false,
    finalText: null,
    lastToolErrorCode: null,
    lastToolErrorName: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    unreportedSettlements: 0,
    sawAnyUsage: false,
    interrupted: false,
    turnEndReasons: [],
  }
}

/** Truncate without leaving a dangling high surrogate at the cut. */
function clip(text: string): string {
  if (text.length <= TEXT_LIMIT) return text
  let end = TEXT_LIMIT
  const code = text.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return text.slice(0, end)
}

/** Concatenate the text blocks of an assistant message body. */
function assistantText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  let text = ''
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue
    const candidate = block as { type?: unknown; text?: unknown }
    if (candidate.type === 'text' && typeof candidate.text === 'string') text += candidate.text
  }
  return text
}

/** Read a numeric field defensively; absent or non-numeric reads as zero. */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Count one call or error against a tool name. */
function bump(state: TraceState, tool: string, field: 'calls' | 'errors'): void {
  const bucket = state.byTool[tool] ?? { calls: 0, errors: 0 }
  bucket[field] += 1
  state.byTool[tool] = bucket
}

/**
 * Fold one committed event into the trace.
 *
 * Event types this fold does not know are ignored, so a host that adds session event types does not
 * break old records — it only means the new fact is not counted yet.
 *
 * @param state - the accumulator to mutate.
 * @param event - the next committed event, in `seq` order.
 */
export function foldEvent(state: TraceState, event: SessionEvent): void {
  switch (event.type) {
    case 'turn/end': {
      state.turns += 1
      const reason = (event.data as { reason?: { kind?: unknown } }).reason
      state.turnEndReasons.push(typeof reason?.kind === 'string' ? reason.kind : 'unknown')
      break
    }
    case 'step/end':
      state.steps += 1
      break
    case 'tool/call': {
      const data = event.data as { callId?: unknown; name?: unknown }
      const name = typeof data.name === 'string' ? data.name : '<unnamed>'
      state.toolCalls += 1
      bump(state, name, 'calls')
      // A re-issued call id replaces its predecessor rather than counting twice as pending.
      if (typeof data.callId === 'string') state.pending.set(data.callId, name)
      break
    }
    case 'tool/result': {
      const data = event.data as {
        message?: { isError?: unknown; toolCallId?: unknown }
        error?: { name?: unknown; code?: unknown }
      }
      const message = data.message
      const callId = typeof message?.toolCallId === 'string' ? message.toolCallId : undefined
      // The tool that issued the call owns the error count; the result carries only the call id.
      const issuedBy = callId === undefined ? undefined : state.pending.get(callId)
      if (callId !== undefined) state.pending.delete(callId)
      const errored = message?.isError === true
      state.lastResultErrored = errored
      if (!errored) break
      state.toolErrors += 1
      if (issuedBy !== undefined) bump(state, issuedBy, 'errors')
      state.lastToolErrorCode = typeof data.error?.code === 'string' ? data.error.code : null
      state.lastToolErrorName = typeof data.error?.name === 'string' ? data.error.name : null
      break
    }
    case 'assistant/message': {
      const data = event.data as {
        message?: { content?: unknown }
        usage?: {
          inputTokens?: unknown
          outputTokens?: unknown
          cacheReadTokens?: unknown
          cacheWriteTokens?: unknown
        }
        interrupted?: unknown
      }
      const text = assistantText(data.message?.content)
      if (text !== '') state.finalText = clip(text)
      if (data.interrupted === true) state.interrupted = true
      if (data.usage === undefined) {
        state.unreportedSettlements += 1
      } else {
        state.sawAnyUsage = true
        state.inputTokens += num(data.usage.inputTokens)
        state.outputTokens += num(data.usage.outputTokens)
        state.cacheReadTokens += num(data.usage.cacheReadTokens)
        state.cacheWriteTokens += num(data.usage.cacheWriteTokens)
      }
      break
    }
    default:
      break
  }
}

/**
 * Freeze the accumulator into the record shape.
 * @param state - the fold state.
 * @returns plain JSON.
 */
export function finishTrace(state: TraceState): TraceFeatures {
  return {
    turns: state.turns,
    steps: state.steps,
    toolCalls: state.toolCalls,
    toolErrors: state.toolErrors,
    byTool: state.byTool,
    unansweredCalls: state.pending.size,
    endedOnUnrecoveredError: state.toolErrors > 0 && state.lastResultErrored,
    finalText: state.finalText,
    lastToolErrorCode: state.lastToolErrorCode,
    lastToolErrorName: state.lastToolErrorName,
    usage: state.sawAnyUsage
      ? {
          inputTokens: state.inputTokens,
          outputTokens: state.outputTokens,
          cacheReadTokens: state.cacheReadTokens,
          cacheWriteTokens: state.cacheWriteTokens,
          unreportedSettlements: state.unreportedSettlements,
        }
      : null,
    interrupted: state.interrupted,
    turnEndReasons: state.turnEndReasons,
  }
}

/**
 * Fold a whole event list. The offline twin of the live fold: same reducer, same result.
 * @param events - committed events in `seq` order.
 * @returns the features.
 */
export function summarize(events: readonly SessionEvent[]): TraceFeatures {
  const state = emptyTrace()
  for (const event of events) foldEvent(state, event)
  return finishTrace(state)
}
