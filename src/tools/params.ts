/**
 * The parameters the harness-facing tools share, and the mappers that read them.
 *
 * Everything lives here so that one vocabulary and no drift hold by construction: a harness is named in
 * exactly one shape, and `harness_inspect` and `harness_run` must answer the same first question
 * identically — whatever the inspection says about a harness, the run applies exactly that.
 *
 * Route and depth are siblings of `harness`, not fields inside it: they are request-level and cannot be
 * written into a row list, so one harness file can run under two routes unedited.
 *
 * @module dsh-harness-dispatcher/tools/params
 */

import type { ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import { catalogLine } from '../catalog.ts'
import type { FaultInput, FaultMode } from '../fault.ts'
import type { HarnessInput, HarnessSelection } from '../harness.ts'
import type { PersonaVariant } from '../shortcut.ts'

/**
 * The properties of the `harness` object.
 *
 * Declared once and composed into each tool's schema so the three descriptions cannot disagree.
 */
export const HARNESS_PROPERTIES = {
  file: {
    type: 'string',
    description:
      'A harness file: a Loader entry list (`id`, `name`, optional `config`/`disabled`/`isolate`), ' +
      'parsed by the host itself. An absolute path is used as given; any other value is a NAME and ' +
      'resolves in the plugin harness directory, with `.yml`/`.yaml`/`.json` supplied when missing. ' +
      'Pass this OR the shortcut scalars below.',
  },
  tools: {
    type: 'array',
    items: { type: 'string' },
    description:
      `Shortcut form: catalogue keys to mount. Available: ${catalogLine()}. ` +
      'These are catalogue keys such as "fs", not tool names such as "read".',
  },
  persona: {
    type: 'string',
    enum: ['none', 'terse', 'verbose', 'pair-programmer', 'custom'],
    description:
      'Shortcut form: persona variant. "none" mounts no persona row, leaving the deployment persona.',
  },
  persona_text: {
    type: 'string',
    description: 'Shortcut form: prose, only with persona "custom".',
  },
  sealed: {
    type: 'boolean',
    description:
      'Make the harness the whole tool set instead of a delta on the host. Without it the subject ' +
      'also sees every tool the host mounts for itself, which is usually not what an experiment ' +
      'wants to hold constant. Part of the stimulus: it changes the fingerprint, because a sealed ' +
      'subject and an unsealed one are different experiments.',
  },
} as const satisfies ParameterSchemaSpec

/** The harness selector, for a tool where it is required. */
export const REQUIRED_HARNESS = {
  harness: {
    type: 'object',
    required: true,
    additionalProperties: false,
    description:
      'The harness under test: a row list file (`file`), or the shortcut scalars (`tools`/`persona`), ' +
      'never both. The shortcut compiles into the same kind of row list and is captured the same way.',
    properties: HARNESS_PROPERTIES,
  },
} as const satisfies ParameterSchemaSpec

/** The harness selector, for a tool where `preset` may be given instead. */
export const OPTIONAL_HARNESS = {
  harness: {
    type: 'object',
    additionalProperties: false,
    description: 'The harness to inspect. Pass this OR `preset`.',
    properties: HARNESS_PROPERTIES,
  },
} as const satisfies ParameterSchemaSpec

/** Request-level settings shared by every tool that can mount or run a harness. */
export const ROUTE_PARAMETERS = {
  provider: {
    type: 'string',
    description:
      'Model route override; supply together with model. Route is request-level: it is NOT in the ' +
      'harness file, so one file can be run under two routes. In `harness_inspect`, passing `provider` ' +
      'alone — no `model`, no `preset`, no `harness` — instead lists the models that route advertises. ' +
      'That call can be slow; the bare listing cannot.',
  },
  model: { type: 'string', description: 'Model route override; supply together with provider.' },
  reasoning_effort: {
    type: 'string',
    description:
      'Adapter-owned reasoning effort for the subject, e.g. "high" or "low" — the identifier the ' +
      'route itself accepts. Requires `provider` and `model`: the host applies a generation control ' +
      'only to a route it selects, so an effort alone is refused rather than silently dropped. Part ' +
      'of the stimulus, so "same model, lower effort" is a comparable experiment.',
  },
  max_tokens: {
    type: 'number',
    description:
      'Maximum output tokens per subject request. Requires `provider` and `model`, for the same ' +
      'reason. Absent inherits from the delegating agent; there is no value meaning "unlimited", ' +
      'because a cap of 0 would cut the subject off at the first token.',
  },
  max_depth: {
    type: 'number',
    description:
      'Caps how deep this subject may be started (>= 1). It does not let the subject delegate deeper: ' +
      "that is its own `tool-subagent` row's `maxDepth`, which the tool applies to the children it " +
      'starts.',
  },
} as const satisfies ParameterSchemaSpec

/** The attachments parameter, shared so the two kinds are described once. */
export const ATTACHMENTS_PARAMETER = {
  attachments: {
    type: 'array',
    description:
      'Files the task carries, sent to the subject in this order after the prompt text. The kind ' +
      'comes from the extension: png/jpeg/webp/gif become an image the subject SEES (only if the ' +
      'route declares image input — otherwise the run is refused rather than run without it); ' +
      'everything else becomes a file the subject can only READ, always projected by the host into ' +
      'one handle line naming a read-only path. Stored once per run and referenced by id; the bytes ' +
      'are never copied into the run directory.',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: {
          type: 'string',
          required: true,
          description:
            'Path to the file, resolved by the host filesystem backend. Relative paths resolve ' +
            'against `cwd` when you pass one, so absolute paths are the safer choice.',
        },
      },
    },
  },
} as const satisfies ParameterSchemaSpec

/** The raw-event parameter: on by default, because the raw layer is the product. */
export const RECORD_EVENTS_PARAMETER = {
  record_events: {
    type: 'boolean',
    description:
      "Write the subject's committed Session events verbatim to events.jsonl. Defaults to true, and " +
      'leaving it on is the recommendation: those events are what lets a record be re-folded under a ' +
      'definition this plugin never had, and they carry the tool arguments, tool results, injected ' +
      'context and per-step timestamps that no aggregate preserves. Set false only to save space — it ' +
      'also means anything not in the record is gone. The file holds prompts and model output as the ' +
      'subject saw them.',
  },
} as const satisfies ParameterSchemaSpec

/** The faults parameter, shared so the tools describe the three modes identically. */
export const FAULTS_PARAMETER = {
  faults: {
    type: 'array',
    description:
      'Injected tool faults, applied on the tool pipelines rather than in the harness, so they are ' +
      'NOT part of a harness file and can be combined with any harness. "deny" hides the tool ' +
      '(tests absence), "fail" makes it return an error the subject must handle (tests failure ' +
      'handling), "latency" delays the result (tests patience). These are three different experiments, ' +
      'not three settings of one.',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tool: {
          type: 'string',
          required: true,
          description: 'Model-facing tool name, e.g. "read" — not a catalogue key like "fs".',
        },
        mode: { type: 'string', required: true, enum: ['deny', 'fail', 'latency'] },
        message: { type: 'string', description: 'Literal text the subject sees.' },
        latency_ms: { type: 'number', description: 'Withheld interval, mode "latency" only.' },
      },
    },
  },
} as const satisfies ParameterSchemaSpec

/** Harness plus request settings, as the model passes them. */
export interface HarnessArgs {
  readonly harness?: {
    readonly file?: string | undefined
    readonly tools?: readonly string[] | undefined
    readonly persona?: string | undefined
    readonly persona_text?: string | undefined
    readonly sealed?: boolean | undefined
  }
  readonly provider?: string | undefined
  readonly model?: string | undefined
  readonly reasoning_effort?: string | undefined
  readonly max_tokens?: number | undefined
  readonly max_depth?: number | undefined
}

/** A fault list, as the model passes it. */
export interface FaultArgs {
  readonly faults?:
    | readonly {
        readonly tool: string
        readonly mode: string
        readonly message?: string | undefined
        readonly latency_ms?: number | undefined
      }[]
    | undefined
}

/**
 * Translate the tool's snake_case harness argument into the harness layer's input.
 * @param args - the tool arguments.
 * @returns the harness input; a missing `harness` reaches the layer as an empty selection, which it
 *   rejects with a message that names both forms.
 */
export function harnessInputOf(args: HarnessArgs): HarnessInput {
  const selection: HarnessSelection = {
    ...(args.harness?.file === undefined ? {} : { file: args.harness.file }),
    ...(args.harness?.tools === undefined ? {} : { tools: args.harness.tools }),
    ...(args.harness?.persona === undefined
      ? {}
      : { persona: args.harness.persona as PersonaVariant }),
    ...(args.harness?.persona_text === undefined ? {} : { personaText: args.harness.persona_text }),
    // Carried here rather than read again at each tool: one read means the mask a run mounts and the
    // mask its fingerprint claims cannot disagree (redline B32).
    ...(args.harness?.sealed === undefined ? {} : { sealed: args.harness.sealed }),
  }
  return {
    harness: selection,
    ...(args.provider === undefined ? {} : { provider: args.provider }),
    ...(args.model === undefined ? {} : { model: args.model }),
    ...(args.reasoning_effort === undefined ? {} : { reasoningEffort: args.reasoning_effort }),
    ...(args.max_tokens === undefined ? {} : { maxTokens: args.max_tokens }),
    ...(args.max_depth === undefined ? {} : { maxDepth: args.max_depth }),
  }
}

/**
 * Translate the tool's fault argument into the fault layer's input.
 * @param args - the tool arguments.
 * @returns faults in declaration order, or an empty list.
 */
export function faultsOf(args: FaultArgs): FaultInput[] {
  return (args.faults ?? []).map((fault) => ({
    tool: fault.tool,
    mode: fault.mode as FaultMode,
    ...(fault.message === undefined ? {} : { message: fault.message }),
    ...(fault.latency_ms === undefined ? {} : { latencyMs: fault.latency_ms }),
  }))
}

/** One registered provider route, as the host describes it. */
export interface ProviderInfo {
  /** Route key, i.e. what `provider` names. */
  readonly id: string
  /** Human-readable name, for a listing that has to be read by a person. */
  readonly name: string
}

/** One model a provider route advertises, as its adapter described it. */
export interface ModelInfo {
  readonly id: string
  readonly name: string
  readonly description?: string | undefined
  /**
   * Accepted input modalities. **Absent means unknown, and unknown is not a promise** — the same
   * distinction the image gate in [harness-run.ts](harness-run.ts) is built on.
   */
  readonly inputModalities?: readonly string[] | undefined
}

/**
 * The LLM runtime, as this plugin needs it. Structural, so no extra peer dependency.
 *
 * The two discovery calls are deliberately asymmetric, and that asymmetry is why
 * `harness_inspect` has two entry points rather than one:
 *
 * - {@link ModelRouter.listProviders} is **synchronous** and local — the host's own words are
 *   "detached provider metadata in registration order". It reads a registry, so it costs nothing.
 * - {@link ModelRouter.listModels} is **asynchronous because the adapter decides** whether answering
 *   means asking its endpoint (`LlmAdapter.listModels`); `resolveModelInfo`'s optional `signal` is
 *   the host admitting the lookup is "adapter-owned".
 *
 * So a caller who only wants to know what exists must not be made to await an adapter.
 */
export interface ModelRouter {
  resolveModelInfo(provider: string, model: string): Promise<unknown>
  listProviders(): readonly ProviderInfo[]
  listModels(provider: string): Promise<readonly ModelInfo[]>
}
