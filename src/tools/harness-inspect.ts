/**
 * One tool: inspect a harness without running it.
 *
 * Mounting costs no model call, so this is the one-second, zero-token loop. It answers the three things
 * a static check cannot: will it mount (the registry's own diagnosis, which `register()` swallows);
 * will every row contribute (a policy-denied row mounts disabled and the audit skips it); and what can
 * the subject actually call (the observed names, which a fault must be checked against).
 *
 * Three ways to name the target: `preset` inspects one the host already has — no file, no setup, the
 * first thing a newcomer should call; `harness.file` and the shortcut scalars are mounted privately and
 * unmounted in a `finally`, so an inspection never changes what another agent sees.
 *
 * @module dsh-harness-dispatcher/tools/harness-inspect
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { normalizeFaults, assertFaultsReachable } from '../fault.ts'
import type { ResolveDeps } from '../harness.ts'
import { harnessLabel, harnessRows, resolveHarness, sealedRows } from '../harness.ts'
import {
  SKILL_TOOL,
  hostToolNames,
  mountSubject,
  presetIdFor,
  presetList,
  rowProblems,
  surfaceOf,
} from '../subject.ts'
import type { CapabilitySurface, PresetSummary } from '../subject.ts'
import {
  FAULTS_PARAMETER,
  OPTIONAL_HARNESS,
  ROUTE_PARAMETERS,
  faultsOf,
  harnessInputOf,
} from './params.ts'
import type { HarnessArgs, ModelRouter } from './params.ts'

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    target: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        kind: { type: 'string', required: true },
        label: { type: 'string', required: true },
        fingerprint: { type: 'string' },
        fileName: { type: 'string' },
        digest: { type: 'string' },
        originPath: { type: 'string' },
      },
    },
    // Below: present only when a harness or preset was inspected. A listing mounts nothing, so it has
    // no tools, no rows and no verdict — emitting empty arrays there would read like a measurement.
    tools: { type: 'array', items: { type: 'string' } },
    skills: { type: 'array', items: { type: 'string' } },
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          module: { type: 'string', required: true },
          enabled: { type: 'json', required: true },
          fiberState: { type: 'json' },
        },
      },
    },
    presets: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          name: { type: 'string' },
          isDefault: { type: 'boolean', required: true },
          broken: { type: 'string' },
          rows: { type: 'number', required: true },
        },
      },
    },
    problems: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const

/** What this tool needs from the plugin instance. */
export interface HarnessInspectDeps extends ResolveDeps {
  /** Makes each private mount unique, so overlapping inspections cannot collide. */
  readonly nextId: () => string
}

/**
 * Register `harness_inspect`.
 * @param ctx - context owning the registration.
 * @param deps - defaults, the catalogue, and an id source.
 */
export function registerHarnessInspect(ctx: Context, deps: HarnessInspectDeps): void {
  ctx.tools.register(
    defineTool({
      name: 'harness_inspect',
      description:
        'Inspect a harness WITHOUT starting an agent or spending tokens. Reports whether it can serve ' +
        'as a run subject, which rows mounted but contribute nothing, and the tool and skill names the ' +
        'subject could actually call. Call it with NO arguments to list the presets this host has ' +
        '(the ids the other two tools take). Then name a target: `preset` for one the host already has, ' +
        'or `harness` as a file or the shortcut scalars. Start here: it is free, and it is the same ' +
        'resolution `harness_run` uses.',
      parameters: {
        preset: {
          type: 'string',
          description:
            'Inspect a preset the host already has, by id (e.g. "standard"). Call the tool with no ' +
            'arguments at all to see which ids exist. No file needed, nothing is mounted privately.',
        },
        ...OPTIONAL_HARNESS,
        ...ROUTE_PARAMETERS,
        ...FAULTS_PARAMETER,
      },
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => {
          if (value.presets !== undefined) {
            return [
              {
                type: 'text',
                text: presetLines(
                  value.presets.map((preset) => ({
                    id: preset.id,
                    name: preset.name ?? null,
                    isDefault: preset.isDefault,
                    broken: preset.broken ?? null,
                    rows: preset.rows,
                  })),
                ),
              },
            ]
          }
          const head =
            `${value.ok ? 'harness ok' : 'harness NOT runnable'}: ${value.target.label}` +
            `${value.target.fingerprint === undefined ? '' : ` (${value.target.fingerprint})`}`
          const tools = `${String(value.tools?.length ?? 0)} tool(s): ${value.tools?.join(', ') ?? '(none)'}`
          const lines = [head, tools, skillLine(value.tools ?? [], value.skills)]
          if (value.problems.length > 0) lines.push('', `Problems:\n${value.problems.join('\n')}`)
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      isConcurrencySafe: () => false,
      async execute(args) {
        // Neither form names a target, so answer the question that comes before any other: what is
        // there? Without this a caller who does not already know a preset id cannot use the bench.
        if (args.preset === undefined && args.harness === undefined) {
          const presets = await presetList(ctx)
          return {
            ok: true,
            target: { kind: 'presets', label: `${String(presets.length)} preset(s)` },
            presets: presets.map((preset) => ({
              id: preset.id,
              ...(preset.name === null ? {} : { name: preset.name }),
              isDefault: preset.isDefault,
              ...(preset.broken === null ? {} : { broken: preset.broken }),
              rows: preset.rows,
            })),
            problems: [],
          }
        }

        const facts = await inspect(ctx, args, deps)
        const faults = normalizeFaults(faultsOf(args))
        const problems = [...facts.problems]
        const faultsProblem = checkFaults(faults, facts.surface.tools)
        if (faultsProblem !== undefined) problems.push(faultsProblem)

        return {
          ok: problems.length === 0,
          target: facts.target,
          tools: [...facts.surface.tools],
          ...(facts.surface.skills === null ? {} : { skills: [...facts.surface.skills] }),
          rows: facts.surface.rows.map((row) => ({
            ...(row.id === null ? {} : { id: row.id }),
            module: row.module,
            enabled: row.enabled,
            ...(row.fiberState === null ? {} : { fiberState: row.fiberState }),
          })),
          problems,
        }
      },
    }),
  )
}

/**
 * The listing, as a reader needs it: the default marked, and a preset that cannot mount saying why.
 * @param presets - the listing.
 * @returns one block of text.
 */
function presetLines(presets: readonly PresetSummary[]): string {
  if (presets.length === 0) return 'this host reports no presets'
  const lines = presets.map((preset) => {
    const marks = [preset.isDefault ? 'default' : '', preset.broken === null ? '' : 'cannot mount']
      .filter((mark) => mark !== '')
      .join(', ')
    const detail =
      preset.broken === null ? `${String(preset.rows)} row(s)` : firstLine(preset.broken)
    return `  ${preset.id}${marks === '' ? '' : ` (${marks})`} — ${detail}`
  })
  return [
    `${String(presets.length)} preset(s) on this host. Inspect one with { preset: "<id>" }.`,
    ...lines,
  ].join('\n')
}

/** The first line of a multi-line host diagnostic, which is the part that names the cause. */
function firstLine(text: string): string {
  return text.split('\n')[0] ?? text
}

/** What one inspection found, before problems are assembled. */
interface InspectionFacts {
  readonly surface: CapabilitySurface
  readonly problems: readonly string[]
  readonly target: {
    readonly kind: string
    readonly label: string
    readonly fingerprint?: string
    readonly fileName?: string
    readonly digest?: string
    readonly originPath?: string
  }
}

async function inspect(
  ctx: Context,
  args: HarnessArgs & { readonly preset?: string | undefined },
  deps: HarnessInspectDeps,
): Promise<InspectionFacts> {
  const hasPreset = args.preset !== undefined
  const hasHarness = args.harness !== undefined
  if (hasPreset === hasHarness) {
    throw new Error(
      'pass exactly one of `preset` (inspect a preset the host already has) or `harness` ' +
        '(a file or the shortcut scalars)',
    )
  }

  const routeProblem = await checkRoute(ctx, args.provider, args.model)

  if (args.preset !== undefined) {
    // No mount of our own: the preset is already there, and a scope lease is enough to read it.
    const surface = await surfaceOf(ctx, args.preset)
    return {
      surface,
      problems: [...rowProblems(surface), ...(routeProblem === undefined ? [] : [routeProblem])],
      target: { kind: 'preset', label: args.preset },
    }
  }

  const resolved = await resolveHarness(harnessInputOf(args), deps)
  // An inspection has no run directory, so it mounts the source itself: the file the operator will
  // edit, or the compiled rows of the shortcut.
  const mountPath = resolved.captured.source === 'file' ? resolved.captured.originPath : ''
  const subject = await mountSubject(ctx, {
    presetId: presetIdFor(deps.nextId()),
    label: harnessLabel(resolved.captured),
    // The mask goes first: a scope's own registrations are exempt, so mounting the harness after it
    // keeps the harness's tools and hides only the inherited ones.
    rows: [
      ...sealedRows(args.harness?.sealed === true ? hostToolNames(ctx) : []),
      ...harnessRows(resolved.captured, mountPath),
    ],
  })
  try {
    const captured = resolved.captured
    return {
      surface: subject.surface,
      problems: [
        ...rowProblems(subject.surface),
        ...(routeProblem === undefined ? [] : [routeProblem]),
      ],
      target: {
        kind: 'harness',
        label: harnessLabel(captured),
        fingerprint: resolved.fingerprint,
        fileName: captured.fileName,
        digest: captured.digest,
        ...(captured.source === 'file' ? { originPath: captured.originPath } : {}),
      },
    }
  } finally {
    await subject.dispose().catch((error: unknown) => {
      ctx.logger.warn(`harness_inspect: failed to unmount: ${String(error)}`)
    })
  }
}

/**
 * Validate the route before it is used.
 *
 * This is the gap that made an inspection say `ok` and the run fail on trial 1. `resolveModelInfo` asks
 * the adapter whether it knows the route and costs no model call, so the check belongs here rather than
 * in the first expensive step.
 * @param ctx - context that may expose the LLM runtime.
 * @param provider - requested provider, if any.
 * @param model - requested model, if any.
 * @returns a problem line, or `undefined` when the route is absent or known.
 */
async function checkRoute(
  ctx: Context,
  provider: string | undefined,
  model: string | undefined,
): Promise<string | undefined> {
  if (provider === undefined && model === undefined) return undefined
  if (provider === undefined || model === undefined) {
    return 'provider and model must be supplied together or omitted together'
  }
  const llm: ModelRouter | undefined = ctx.get('llm')
  if (llm === undefined) {
    // No model runtime in this composition: the assertion is unknowable here, so say so rather than
    // pretend the route is fine.
    return `cannot verify the route ${provider}/${model}: this host exposes no llm service`
  }
  try {
    await llm.resolveModelInfo(provider, model)
    return undefined
  } catch (error) {
    return (
      `route ${provider}/${model} is not usable: ` +
      `${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/** Turn an unreachable-fault rejection into a reported problem instead of a thrown error. */
function checkFaults(
  faults: ReturnType<typeof normalizeFaults>,
  visible: readonly string[],
): string | undefined {
  try {
    assertFaultsReachable(faults, visible)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * One line for the skill half of the surface.
 *
 * Three cases that must not read the same: no registry on this host, a registry the subject cannot
 * reach, and names it can load. Printing the names alone left a reader unable to tell "no skills" from
 * "nobody looked" — and the scope's six inherited skills used to be reported for a subject with no way
 * to call one.
 * @param tools - tool names callable in the subject's scope.
 * @param skills - loadable skill names, or `undefined` when this host has no registry.
 * @returns one line.
 */
function skillLine(tools: readonly string[], skills: readonly string[] | undefined): string {
  if (skills === undefined) return 'no skill registry on this host'
  if (skills.length === 0) {
    return tools.includes(SKILL_TOOL)
      ? '0 skill(s)'
      : `0 skill(s): no \`${SKILL_TOOL}\` tool here, so none is loadable`
  }
  return `${String(skills.length)} skill(s): ${skills.join(', ')}`
}
