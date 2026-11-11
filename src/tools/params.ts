/**
 * The parameters the harness-facing tools share, and the mappers that read them.
 *
 * Two properties hold by construction because everything lives here:
 *
 *   1. **One vocabulary.** A harness is named in exactly one place in the tool surface — a `harness`
 *      object with a `file` *or* the shortcut scalars — so a caller cannot learn two ways to say it.
 *   2. **No drift between tools.** `harness_inspect` and `harness_run` answer the same first question,
 *      so they must answer it identically. Whatever the inspection says about a harness, the run applies
 *      exactly that harness.
 *
 * Route and depth are siblings of `harness`, not fields inside it: they are request-level and cannot be
 * written into a row list, so one harness file can be run under two routes without editing it.
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
      'harness file, so one file can be run under two routes.',
  },
  model: { type: 'string', description: 'Model route override; supply together with provider.' },
  max_depth: { type: 'number', description: 'Delegation budget granted to the subject.' },
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
  }
  readonly provider?: string | undefined
  readonly model?: string | undefined
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
  }
  return {
    harness: selection,
    ...(args.provider === undefined ? {} : { provider: args.provider }),
    ...(args.model === undefined ? {} : { model: args.model }),
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

/** The LLM runtime as route validation needs it. Structural, so no extra peer dependency. */
export interface ModelRouter {
  resolveModelInfo(provider: string, model: string): Promise<unknown>
}
