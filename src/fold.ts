/**
 * One reducer over a subject Session's committed events, producing two views of the same trial.
 *
 * ## Two views, one fold
 *
 * A trial answers two different questions, and they must never be conflated:
 *
 * | view | question | example |
 * |---|---|---|
 * | {@link TraceFeatures} | *what did it do?* | 3 tool calls, 1 error, 4.1 s |
 * | {@link ObservedModelInput} | *what was it given?* | this prompt, these tool schemas, this route |
 *
 * The second one is the reason this repository can claim two runs used "the same harness" without
 * trusting a file: the subject's own log records the rendered system prompt (`system/message`) and the
 * exact request header it was built under (`request/header`, carrying the call config and the assembled
 * tool schemas). Nothing has to be inferred, and nothing has to be read back from disk.
 *
 * ## Read path
 *
 * Features are folded **incrementally from the `session/event` feed**, never read off a finished log.
 * `Session.snapshotEvents()` / `eventAt()` / `ownEvents()` all carry `@deprecated … new calls are
 * prohibited` in the running host. {@link summarize} is the same reducer over an array of events, so a
 * persisted log can be re-folded later and must agree with the live fold.
 *
 * ## What is deliberately NOT here
 *
 * No statistic and no semantic judgement. The fold records the raw facts a judgement needs — the last
 * tool failure, the final text, the structured answer — and stops. See docs/ARCHITECTURE.md §4.3.
 *
 * @module dsh-harness-dispatcher/fold
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { digestJson, digestText } from './digest.ts'

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

/** The call configuration a subject's requests were built under. */
export interface ObservedRoute {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort: string | null
  readonly maxTokens: number | null
}

/**
 * What the subject was actually given, folded from its own log.
 *
 * Digests rather than bodies: a record is evidence, not a transcript. The prompt's *length* is kept
 * beside its digest because "the same prompt" and "a truncation of it" have different identities and
 * very different lengths.
 */
export interface ObservedModelInput {
  /** The last rendered system prompt, digested. `null` when the last one was empty or none was sent. */
  readonly systemPrompt: { readonly chars: number; readonly digest: string } | null
  /** How many `system/message` events the session logged; >1 means the prompt was updated mid-run. */
  readonly systemPromptUpdates: number
  /** Model-facing tool names the request header declared, in canonical order. */
  readonly tools: readonly string[] | null
  /** Digest over the assembled tool schemas, signatures included. */
  readonly toolSchemaDigest: string | null
  /** The route the requests actually used, after adapter defaults. */
  readonly route: ObservedRoute | null
  /** How many `request/header` snapshots the session logged; >1 means the header changed. */
  readonly headerSnapshots: number
}

/** Both views of one trial. */
export interface TrialObservations {
  readonly trace: TraceFeatures
  readonly modelInput: ObservedModelInput
}

/** Longest assistant text kept in a record. Records are evidence, not transcripts. */
const TEXT_LIMIT = 2000

/**
 * Mutable fold state.
 *
 * Exposed because incremental folding needs a place to accumulate. Consumers treat it as opaque and
 * hand it back to {@link foldEvent} / {@link finishFold}; the test suite builds it through
 * {@link emptyFold}.
 */
export interface FoldState {
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
  modelInput: {
    systemPrompt: { chars: number; digest: string } | null
    systemPromptUpdates: number
    tools: string[] | null
    toolSchemaDigest: string | null
    route: ObservedRoute | null
    headerSnapshots: number
  }
}

/** A fresh, empty fold state. */
export function emptyFold(): FoldState {
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
    modelInput: {
      systemPrompt: null,
      systemPromptUpdates: 0,
      tools: null,
      toolSchemaDigest: null,
      route: null,
      headerSnapshots: 0,
    },
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

/** Concatenate the text blocks of a message body. */
function textOf(blocks: unknown): string {
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

/** Read a string field defensively. */
function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** Count one call or error against a tool name. */
function bump(state: FoldState, tool: string, field: 'calls' | 'errors'): void {
  const bucket = state.byTool[tool] ?? { calls: 0, errors: 0 }
  bucket[field] += 1
  state.byTool[tool] = bucket
}

/**
 * Fold one committed event into the trial's state.
 *
 * Event types this fold does not know are ignored, so a host that adds session event types does not
 * break old records — it only means the new fact is not counted yet.
 *
 * @param state - the accumulator to mutate.
 * @param event - the next committed event, in `seq` order.
 */
export function foldEvent(state: FoldState, event: SessionEvent): void {
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
      const text = textOf(data.message?.content)
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
    case 'system/message':
      foldSystemPrompt(state, event.data)
      break
    case 'request/header':
      foldRequestHeader(state, event.data)
      break
    default:
      break
  }
}

/**
 * The rendered system prompt is the subject's actual instructions, and the log states it verbatim.
 *
 * The *last* one wins, and an empty one is recorded as empty rather than skipped: "the prompt was
 * cleared" and "the prompt arrived once and stayed" are different inputs, and a fold that ignored the
 * empty event would silently report the earlier text.
 */
function foldSystemPrompt(state: FoldState, data: unknown): void {
  const message = (data as { message?: { content?: unknown } }).message
  const text = textOf(message?.content)
  state.modelInput.systemPromptUpdates += 1
  state.modelInput.systemPrompt =
    text === '' ? null : { chars: text.length, digest: digestText(text) }
}

/**
 * The request header states the route and the assembled tool schemas — the rest of "what it was given".
 * Only the fields this bench compares are kept; the schema bodies become one digest.
 */
function foldRequestHeader(state: FoldState, data: unknown): void {
  const header = (data as { header?: { config?: unknown; tools?: unknown } }).header
  state.modelInput.headerSnapshots += 1
  if (header === undefined) return

  const config = header.config as
    | { provider?: unknown; model?: unknown; reasoningEffort?: unknown; maxTokens?: unknown }
    | undefined
  const provider = str(config?.provider)
  const model = str(config?.model)
  if (provider !== null && model !== null) {
    state.modelInput.route = {
      provider,
      model,
      reasoningEffort: str(config?.reasoningEffort),
      maxTokens: typeof config?.maxTokens === 'number' ? config.maxTokens : null,
    }
  }

  const tools = header.tools
  if (Array.isArray(tools) && tools.length > 0) {
    const named = tools as { name?: unknown; description?: unknown; parameters?: unknown }[]
    state.modelInput.tools = named.map((tool) => str(tool.name) ?? '<unnamed>')
    // Signatures too: same names with different parameters is a different input.
    state.modelInput.toolSchemaDigest = digestJson(
      named.map((tool) => [tool.name, tool.description, tool.parameters]),
    )
  } else {
    state.modelInput.tools = []
    state.modelInput.toolSchemaDigest = digestJson([])
  }
}

/**
 * Freeze the accumulator into the record shape.
 * @param state - the fold state.
 * @returns plain JSON: two views of one trial.
 */
export function finishFold(state: FoldState): TrialObservations {
  return {
    trace: {
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
    },
    modelInput: {
      systemPrompt: state.modelInput.systemPrompt,
      systemPromptUpdates: state.modelInput.systemPromptUpdates,
      tools: state.modelInput.tools,
      toolSchemaDigest: state.modelInput.toolSchemaDigest,
      route: state.modelInput.route,
      headerSnapshots: state.modelInput.headerSnapshots,
    },
  }
}

/**
 * Fold a whole event list. The offline twin of the live fold: same reducer, same result.
 * @param events - committed events in `seq` order.
 * @returns both views of the trial.
 */
export function summarize(events: readonly SessionEvent[]): TrialObservations {
  const state = emptyFold()
  for (const event of events) foldEvent(state, event)
  return finishFold(state)
}
