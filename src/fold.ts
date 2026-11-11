/**
 * One reducer over a subject Session's committed events, producing the two views the host does not.
 *
 * | view | question |
 * |---|---|
 * | {@link TraceFeatures} | *which tools did it call, and which failed?* |
 * | {@link ObservedModelInput} | *what was it given?* |
 *
 * Both survive here for one reason each, and nothing else does. The second is why two runs can be
 * called "the same harness" without trusting a file: the subject's own log records the rendered system
 * prompt and the request header it was built under. The first is the only count no host projection
 * offers — turn, step, token and timing figures are the host's, read through
 * [host.ts](host.ts) instead of recomputed here.
 *
 * Features are folded from the `session/event` feed, never read off a finished log: `snapshotEvents`,
 * `eventAt` and `ownEvents` are all marked "new calls prohibited" in the running host.
 * {@link summarize} runs the same reducer over an array, so a persisted log re-folds identically.
 *
 * No statistic and no judgement — the fold records what a judgement needs and stops. See
 * docs/ARCHITECTURE.md 的「边界从「算不算」改成「谁已经算过」」.
 *
 * @module dsh-harness-dispatcher/fold
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { digestJson, digestText } from './digest.ts'

/** One tool's accumulated counts. */
export interface TraceToolCount {
  readonly calls: number
  readonly errors: number
}

/**
 * What one child Session did, stated only as countable or literal facts.
 *
 * Three fields, and each is here because no host projection answers it. Everything this type used to
 * carry has moved or gone: `turns`/`steps` are the host's `sessionStats`, `usage` is its `tokenUsage`,
 * and `finalText` was a duplicate of the record's own `output` — which already comes from the
 * activation's result. The rest (`turnEndReasons`, `interrupted`, `unansweredCalls`,
 * `endedOnUnrecoveredError`, the last-error pair) are all recoverable from `events.jsonl`, which the
 * run directory carries verbatim.
 *
 * What remains is the one thing no projection offers: per-tool counts. "Which tool was called how
 * often, and how often it failed" is the most-read signal in a harness comparison.
 */
export interface TraceFeatures {
  /** Total `tool/call` events, including re-issued call ids from a retried step. */
  readonly toolCalls: number
  /** Total `tool/result` events whose message carries `isError: true`. */
  readonly toolErrors: number
  /** Per-tool-name counts, keyed by the model-facing tool name. */
  readonly byTool: Readonly<Record<string, TraceToolCount>>
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

/**
 * Mutable fold state.
 *
 * Exposed because incremental folding needs a place to accumulate. Consumers treat it as opaque and
 * hand it back to {@link foldEvent} / {@link finishFold}; the test suite builds it through
 * {@link emptyFold}.
 */
export interface FoldState {
  toolCalls: number
  toolErrors: number
  byTool: Record<string, { calls: number; errors: number }>
  /** Call ids awaiting a result, in issue order. */
  pending: Map<string, string>
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
    toolCalls: 0,
    toolErrors: 0,
    byTool: {},
    pending: new Map<string, string>(),
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
      const data = event.data as { message?: { isError?: unknown; toolCallId?: unknown } }
      const message = data.message
      const callId = typeof message?.toolCallId === 'string' ? message.toolCallId : undefined
      // The tool that issued the call owns the error count; the result carries only the call id.
      const issuedBy = callId === undefined ? undefined : state.pending.get(callId)
      if (callId !== undefined) state.pending.delete(callId)
      if (message?.isError !== true) break
      state.toolErrors += 1
      if (issuedBy !== undefined) bump(state, issuedBy, 'errors')
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
      toolCalls: state.toolCalls,
      toolErrors: state.toolErrors,
      byTool: state.byTool,
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
