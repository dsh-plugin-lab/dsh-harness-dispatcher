import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

export const name = 'harness-tool'

export const inject = ['tools']

export interface Config {
  name: string
  description: string
  parameters?: unknown
  result: string
}

export const Config: z<Config> = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.any(),
  result: z.string(),
})

/** The host reserves this name for the PTC presentation transport; registering it throws there. */
const RESERVED = 'run_code'

/**
 * Model-facing tool names, conservatively.
 *
 * The host does not validate the shape, so a name with a space registers cleanly and is then never
 * callable — visible in the catalogue, unreachable by the model. Rejecting here turns that into an error
 * the operator can read instead of a run that quietly measures a different tool set.
 */
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/

/** A tool this row can stand up, already validated. */
export interface ToolSpec {
  readonly name: string
  readonly description: string
  /** Parameter schema in the host's authoring dialect; `{}` means "no arguments". */
  readonly parameters: ParameterSchemaSpec
  /** Text the tool returns on every call. */
  readonly result: string
}

/** Raised for a row that cannot stand up a usable tool. */
export class ToolSpecError extends Error {
  override readonly name = 'ToolSpecError'
}

/**
 * Validate one row's config into a tool.
 *
 * Pure, so every rule below is testable without a host.
 * @param config - the row's `config`.
 * @returns the tool to register.
 * @throws {ToolSpecError} when the config would produce a tool that exists but cannot be used.
 */
export function toolSpecOf(config: Config): ToolSpec {
  const toolName = config.name.trim()
  const description = config.description.trim()
  if (!TOOL_NAME.test(toolName)) {
    throw new ToolSpecError(
      `tool name ${JSON.stringify(config.name)} is not usable: the host does not validate this field, ` +
        `so a malformed name registers and is then never callable. Use letters, digits, "_" and "-", ` +
        `starting with a letter.`,
    )
  }
  if (toolName === RESERVED) {
    throw new ToolSpecError(
      `"${RESERVED}" is reserved by the host for the PTC presentation transport and cannot be ` +
        `registered or shadowed; pick another name.`,
    )
  }
  if (description === '') {
    throw new ToolSpecError(
      'an empty description makes the tool invisible in practice: the description is the only routing ' +
        'signal the model sees before calling it. Say what the tool is for.',
    )
  }
  if (config.result === '') {
    throw new ToolSpecError(
      '`result` is what the subject gets back, so an empty one teaches it nothing.',
    )
  }
  const parameters = config.parameters ?? {}
  if (typeof parameters !== 'object' || parameters === null || Array.isArray(parameters)) {
    throw new ToolSpecError(
      '`parameters` must be an object of parameter specs (`{ query: { type: "string" } }`), or omitted ' +
        'for a tool that takes nothing.',
    )
  }
  return {
    name: toolName,
    description,
    parameters: parameters as ParameterSchemaSpec,
    result: config.result,
  }
}

/**
 * Stand up one model-facing tool from the row's config, for the agent this row is mounted under.
 *
 * **Why this exists.** Without it, varying a tool's *description* — the single routing signal a model
 * sees — means writing and installing a package, which breaks the free edit-inspect-run loop the rest of
 * the bench is built on. With it, one harness file can define a tool, or redefine a shipped one.
 *
 * **Scope.** A row inside a preset registers into that preset's layer, and a nearer registration shadows
 * a farther one. So the tool is visible to the subject alone, and a name that already exists at host
 * level is *replaced* rather than duplicated — which is how a shipped tool's description becomes a
 * harness variable. A name that collides **inside this preset** fails the mount instead: edit the other
 * row, because two rows in one layer claiming one name has no principled winner.
 *
 * **Not a fault.** This tool always succeeds with `result`. Failing and slow behaviour belongs to
 * `faults` (`fail` / `latency`), which sits on the tool pipelines beside the harness and applies to any
 * visible tool, this one included. Re-implementing it here would be two mechanisms for one thing.
 *
 * The registration is owned by this row's fiber: the host files a registration's disposer under its own
 * context, so a discarded one would outlive the mount and keep answering after the subject is disposed.
 */
export function apply(ctx: Context, config: Config): void {
  const spec = toolSpecOf(config)
  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: spec.name,
          description: spec.description,
          parameters: spec.parameters,
          output: {
            schema: { type: 'string' },
            render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
          },
          execute: () => Promise.resolve(spec.result),
        }),
      ),
    'harness.tool',
  )
}
