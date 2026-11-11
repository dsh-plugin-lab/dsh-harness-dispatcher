/**
 * One tool: inspect a harness without running it.
 *
 * Mounting costs no model call, so this is the one-second, zero-token loop. It answers the three things
 * a static check cannot: will it mount (the registry's own diagnosis, which `register()` swallows);
 * will every row contribute (a policy-denied row mounts disabled and the audit skips it); and what can
 * the subject actually call (the observed names, which a fault must be checked against).
 *
 * Four ways to ask, and they are ordered by what they cost:
 *
 * 1. **nothing** → the presets and provider routes this host has. Both reads are local.
 * 2. **`provider` alone** → the models that route advertises. One adapter call.
 * 3. **`preset`** → inspect one the host already has. No file, no setup, the first thing a newcomer
 *    should reach for.
 * 4. **`harness.file` / the shortcut scalars** → mounted privately and unmounted in a `finally`, so an
 *    inspection never changes what another agent sees.
 *
 * The split between 1 and 2 is the point: `listProviders()` is synchronous and reads a registry, while
 * `listModels()` is asynchronous because the adapter may answer by asking its endpoint. Folding the
 * second into the first would make the cheap question pay for the expensive one.
 *
 * @module dsh-harness-dispatcher/tools/harness-inspect
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { normalizeFaults, assertFaultsReachable } from '../fault.ts'
import type { ResolveDeps } from '../harness.ts'
import { harnessLabel, mountRows, resolveHarness, sourcePathOf } from '../harness.ts'
import {
  SKILL_TOOL,
  hostToolNames,
  mountSubject,
  presetIdFor,
  presetList,
  rowWarnings,
  surfaceOf,
} from '../subject.ts'
import type { CapabilitySurface, PresetSummary } from '../subject.ts'
import { errorMessage, firstLine } from '../text.ts'
import {
  FAULTS_PARAMETER,
  OPTIONAL_HARNESS,
  ROUTE_PARAMETERS,
  faultsOf,
  harnessInputOf,
} from './params.ts'
import type { HarnessArgs, ModelInfo, ModelRouter, ProviderInfo } from './params.ts'

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
    // The bare listing: what exists. `providers` is the route half of it, and is omitted rather than
    // emptied when there is no llm service, so "nobody answered" and "the answer is none" differ.
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
    providers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          name: { type: 'string', required: true },
        },
      },
    },
    // The one-provider branch: what that route advertises. Every field but the id is the adapter's
    // word, and `inputModalities` is carried because it is what decides whether an image survives.
    models: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          name: { type: 'string', required: true },
          description: { type: 'string' },
          inputModalities: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    // Blocking: the run would fail, or would not be the experiment that was asked for.
    problems: { type: 'array', required: true, items: { type: 'string' } },
    // Advisory: it runs, and these rows contribute nothing to it.
    warnings: { type: 'array', required: true, items: { type: 'string' } },
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
        'subject could actually call. Call it with NO arguments to list the presets and model route ' +
        '`provider`s this host has — that read is local and free. Pass `provider` alone to list the ' +
        'models that one route advertises; that call can be slow, and it is also how you learn which ' +
        'models declare `image` input. Then name a target: `preset` for one the host already has, or ' +
        '`harness` as a file or the shortcut scalars. Start here: it is free, and it is the same ' +
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
          // Dispatched on the question that was asked, not on which field happens to be present: a
          // model listing that FAILED carries no `models`, and falling through to the harness rendering
          // then announced "harness CANNOT run as asked" about a question no harness was involved in.
          if (value.target.kind === 'provider') {
            const lines =
              value.models === undefined
                ? [`${value.target.label}: no models to report`]
                : [
                    modelLines(
                      value.target.label,
                      value.models.map((model) => ({
                        id: model.id,
                        name: model.name,
                        description: model.description ?? null,
                        inputModalities: model.inputModalities ?? null,
                      })),
                    ),
                  ]
            if (value.problems.length > 0) lines.push('', value.problems.join('\n'))
            if (value.warnings.length > 0) lines.push('', value.warnings.join('\n'))
            return [{ type: 'text', text: lines.join('\n') }]
          }
          if (value.presets !== undefined) {
            const lines = [
              presetLines(
                value.presets.map((preset) => ({
                  id: preset.id,
                  name: preset.name ?? null,
                  isDefault: preset.isDefault,
                  broken: preset.broken ?? null,
                  rows: preset.rows,
                })),
              ),
            ]
            // Omitted rather than emptied when this host exposes no llm service, so the absence is not
            // reported as the number zero — `warnings` already carries the reason in that case.
            if (value.providers !== undefined) {
              lines.push(
                '',
                providerLines(
                  value.providers.map((provider) => ({ id: provider.id, name: provider.name })),
                ),
              )
            }
            return [{ type: 'text', text: lines.join('\n') }]
          }
          const head =
            `${value.ok ? 'harness ok' : 'harness CANNOT run as asked'}: ${value.target.label}` +
            `${value.target.fingerprint === undefined ? '' : ` — fingerprint ${value.target.fingerprint}`}`
          const tools = `${String(value.tools?.length ?? 0)} tool(s): ${value.tools?.join(', ') ?? '(none)'}`
          const lines = [head, tools, skillLine(value.tools ?? [], value.skills)]
          if (value.problems.length > 0) lines.push('', `Problems:\n${value.problems.join('\n')}`)
          // Separate from problems on purpose: a denied row does not stop the run, and saying it does
          // would send an operator away from a harness that works.
          if (value.warnings.length > 0) lines.push('', `Warnings:\n${value.warnings.join('\n')}`)
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      isConcurrencySafe: () => false,
      async execute(args) {
        const targeted = args.preset !== undefined || args.harness !== undefined

        // Entry 2: one provider and nothing else. This is the branch that costs something, which is
        // exactly why it is not inside the free one below.
        if (!targeted && args.provider !== undefined && args.model === undefined) {
          return await modelsOf(ctx, args.provider)
        }

        // Entry 1: neither form names a target, so answer the question that comes before any other:
        // what is there? Without this a caller who does not already know a preset id cannot use the
        // bench, and one who does not know a model name had to guess.
        if (!targeted && args.provider === undefined && args.model === undefined) {
          return await listingOf(ctx)
        }

        // A route is not a target. Saying so beats "pass exactly one of preset or harness", which reads
        // as though the caller had been understood and refused.
        if (!targeted) {
          throw new Error(
            'nothing to inspect: `provider`/`model` name a model route, not a harness. Call this tool ' +
              'with no arguments to list presets and providers, with `provider` alone to list that ' +
              "route's models, with `preset` for one the host already has, or with `harness` as a file " +
              'or the shortcut scalars.',
          )
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
          warnings: [...facts.warnings],
        }
      },
    }),
  )
}

/**
 * The bare listing: presets, and the provider routes whose models can be asked for.
 *
 * Both reads are local, so this stays the free call. The provider half is omitted when the host exposes
 * no llm service, and that absence is reported in `warnings` — "no service to ask" and "the answer is
 * none" must not both render as `0`.
 * @param ctx - context that owns the preset registry and may expose the llm runtime.
 * @returns the listing, with no problems of its own.
 */
async function listingOf(ctx: Context): Promise<{
  ok: boolean
  target: { kind: string; label: string }
  presets: {
    id: string
    name?: string
    isDefault: boolean
    broken?: string
    rows: number
  }[]
  providers?: { id: string; name: string }[]
  problems: string[]
  warnings: string[]
}> {
  const presets = await presetList(ctx)
  const llm: ModelRouter | undefined = ctx.get('llm')
  const providers = llm === undefined ? undefined : [...llm.listProviders()]
  return {
    ok: true,
    target: {
      kind: 'listing',
      label:
        `${String(presets.length)} preset(s), ` +
        `${providers === undefined ? 'no provider routes' : `${String(providers.length)} provider(s)`}`,
    },
    presets: presets.map((preset) => ({
      id: preset.id,
      ...(preset.name === null ? {} : { name: preset.name }),
      isDefault: preset.isDefault,
      ...(preset.broken === null ? {} : { broken: preset.broken }),
      rows: preset.rows,
    })),
    ...(providers === undefined ? {} : { providers }),
    problems: [],
    warnings:
      llm === undefined
        ? [
            'this host exposes no llm service, so no model route could be listed; a run states its ' +
              'route at request level and does not need one here',
          ]
        : [],
  }
}

/**
 * One route's advertised models.
 *
 * The failure mode this branch must not have is throwing: an adapter that cannot answer (an
 * unregistered route, a broken endpoint, a credential it will not accept) is an observation about the
 * route, not a defect in the inspect tool, and it must leave the caller with something to read.
 * @param ctx - context that may expose the llm runtime.
 * @param provider - the route to ask.
 * @returns the models, or one problem line explaining why there are none to report.
 */
async function modelsOf(
  ctx: Context,
  provider: string,
): Promise<{
  ok: boolean
  target: { kind: string; label: string }
  models?: { id: string; name: string; description?: string; inputModalities?: string[] }[]
  problems: string[]
  warnings: string[]
}> {
  const target = { kind: 'provider', label: provider }
  const llm: ModelRouter | undefined = ctx.get('llm')
  if (llm === undefined) {
    return {
      ok: false,
      target,
      problems: [
        `cannot list the models of "${provider}": this host exposes no llm service, so no route is ` +
          'registered anywhere',
      ],
      warnings: [],
    }
  }
  let models: readonly ModelInfo[]
  try {
    models = await llm.listModels(provider)
  } catch (error) {
    // Deliberately not phrased as "the harness cannot run": nothing was mounted, and the question here
    // was about a route. The adapter's own message is the diagnosis, so it is quoted rather than
    // paraphrased.
    return {
      ok: false,
      target,
      problems: [
        `cannot list the models of "${provider}": ${errorMessage(error)}. A route is listed only while its ` +
          'adapter is registered; the bare listing names the ones that answer that way.',
      ],
      warnings: [],
    }
  }
  return {
    ok: true,
    target,
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      ...(model.description === undefined ? {} : { description: model.description }),
      ...(model.inputModalities === undefined
        ? {}
        : { inputModalities: [...model.inputModalities] }),
    })),
    problems: [],
    // An empty list is the adapter's report, not a fact about the route: the pi-ai adapter returns an
    // empty list for a route whose credential is missing, so "none" and "not configured" arrive here
    // as the same value. Saying so is the difference between a dead end and a next step.
    warnings:
      models.length === 0
        ? [
            `"${provider}" reported no models. That is the adapter's answer, not a lookup failure: some ` +
              'adapters report none for a route that has no credential configured.',
          ]
        : [],
  }
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

/**
 * The provider half of the listing, with its cost stated.
 *
 * A caller who does not know that the second entry is a different kind of call will put it in a loop.
 * The word "adapter" is doing real work here: it is why the answer is not instant and not free.
 * @param providers - registered routes, in the host's registration order.
 * @returns one block of text.
 */
function providerLines(providers: readonly ProviderInfo[]): string {
  if (providers.length === 0) return 'this host reports no registered model route'
  return [
    `${String(providers.length)} model route(s). Listing one's models can be slow — ask with ` +
      `{ provider: "<id>" }:`,
    ...providers.map((provider) => `  ${provider.id} — ${provider.name}`),
  ].join('\n')
}

/**
 * One route's models, as a reader needs them.
 *
 * `inputModalities` is printed because it is not decoration: it is the value that decides whether an
 * attached image reaches the subject or is swapped for a placeholder line. **Absent is printed as
 * `unknown`, never as "no image"** — the host's own gate treats the two differently, and a listing that
 * collapsed them would tell an operator to drop an image that would have worked.
 *
 * Exported because it is a pure decision about a host value, so it can be held by a test without a
 * host — the same reason `presetSummaries` is pure.
 * @param route - the provider that was asked.
 * @param models - what its adapter reported.
 * @returns one block of text.
 */
export function modelLines(
  route: string,
  models: readonly {
    id: string
    name: string
    description: string | null
    inputModalities: readonly string[] | null
  }[],
): string {
  if (models.length === 0) return `${route} reported no models`
  const lines = models.map((model) => {
    const input =
      model.inputModalities === null ? 'input unknown' : `input ${model.inputModalities.join('+')}`
    const detail = model.name === model.id ? input : `${model.name} — ${input}`
    const note = model.description === null ? '' : ` (${model.description})`
    return `  ${model.id} — ${detail}${note}`
  })
  return [
    `${String(models.length)} model(s) on ${route}. Run one with { provider: "${route}", model: "<id>" }.`,
    ...lines,
  ].join('\n')
}

/** What one inspection found, before problems are assembled. */
interface InspectionFacts {
  readonly surface: CapabilitySurface
  /** Blocking: a run of this harness would fail, or would not be the experiment asked for. */
  readonly problems: readonly string[]
  /** Advisory: rows that mounted but contribute nothing. */
  readonly warnings: readonly string[]
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
      problems: routeProblem === undefined ? [] : [routeProblem],
      warnings: rowWarnings(surface),
      target: { kind: 'preset', label: args.preset },
    }
  }

  const resolved = await resolveHarness(harnessInputOf(args), deps)
  const denied = resolved.sealed ? hostToolNames(ctx) : []
  const subject = await mountSubject(ctx, {
    presetId: presetIdFor(deps.nextId()),
    label: harnessLabel(resolved.captured),
    rows: mountRows(resolved.captured, { mountPath: sourcePathOf(resolved.captured), denied }),
    ...(denied.length === 0 ? {} : { denied }),
  })
  try {
    const captured = resolved.captured
    return {
      surface: subject.surface,
      problems: routeProblem === undefined ? [] : [routeProblem],
      warnings: rowWarnings(subject.surface),
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
