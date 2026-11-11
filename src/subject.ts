/**
 * Mounting a harness, and reading back what it will actually see.
 *
 * Mounting a Loader tree **does not start a model call**, which is what makes "write it wrong → find
 * out → fix it" cheap. `harness_inspect` is this step and nothing else.
 *
 * Three gates, and the ones that are easy to miss:
 *
 *   1. **Structure.** The registry validates rows before importing anything.
 *   2. **Activation.** `register()` resolves even when the mount failed — the diagnostic stays in its
 *      record. Without reading `resolve(id).broken` back, a broken harness yields a run directory and an
 *      empty `trials.jsonl` instead of an error.
 *   3. **Enablement.** A row the profile's policy denies mounts *disabled*, and the audit skips disabled
 *      rows, so gate 2 can pass while the row contributes nothing. `compositionInventory()` is the only
 *      place that is visible.
 *
 * Probing goes through a scope lease, not the row list: the audit says "did every row start", while the
 * experiment asks *what can the subject call?* `acquireScope(id)` answers that without starting an agent,
 * after shadowing and restriction — and a fault must be checked against it.
 *
 * @module dsh-harness-dispatcher/subject
 */

import type { Context, FiberState } from '@deepseek-ai/cordis'
import { HarnessSpecError } from './harness.ts'
import type { HarnessRow } from './harness.ts'

/** One harness row, as the runtime ended up with it. */
export interface RowFact {
  /** Row id inside the preset's tree, or null when the row declared none. */
  readonly id: string | null
  /** Module specifier the row named. */
  readonly module: string
  /** Enablement after the profile's compatibility policy. */
  readonly enabled: boolean | 'conditional'
  /** Root fiber state, when the row has a live fiber. */
  readonly fiberState: FiberState | null
}

/** What a mounted harness amounts to, observed rather than declared. */
export interface CapabilitySurface {
  readonly rows: readonly RowFact[]
  /** Model-facing tool names callable in the subject's scope, sorted. */
  readonly tools: readonly string[]
  /**
   * Skill names the subject can actually load, sorted; `null` when the host has no skill registry.
   *
   * Reachable, not present: a skill is only loadable if the subject can call the `skill` tool, and the
   * host publishes its catalogue on that same condition. Counting what the registry holds for the scope
   * instead reported six skills to a subject that had no way to load one.
   */
  readonly skills: readonly string[] | null
}

/** A mounted harness. */
export interface Subject {
  readonly presetId: string
  readonly surface: CapabilitySurface
  /** Unmount. Idempotent; the caller owns calling it in a `finally`. */
  dispose(): Promise<void>
}

/** What to mount. */
export interface SubjectPlan {
  /** Process-global preset id; the caller scopes it to the run so two runs cannot collide. */
  readonly presetId: string
  /** Display name, e.g. `minus-web.yml`. */
  readonly label: string
  readonly rows: readonly HarnessRow[]
  /**
   * Tool names the masking row removed, when the caller mounted one.
   *
   * The scope view and step admission disagree about these, and admission wins: a restriction removes a
   * name whether it resolves to the host's definition or to one the harness registered itself. Passing
   * the same list that built the masking row is what keeps {@link CapabilitySurface.tools} honest.
   */
  readonly denied?: readonly string[]
}

/**
 * The names a subject can actually call, given what the masking row removed.
 *
 * Measured 2026-11-11 on `0.2.2-rc.1`: sealing a harness whose own row registers `harness_inspect` — a
 * name the host also exports globally, and therefore a name in the deny list — leaves
 * `tools.definitions(scope)` reporting that tool while the request carries no such schema and the subject
 * cannot call it. Filtering here is what makes the probe agree with the request.
 *
 * Pure, so the disagreement is testable without a host.
 * @param tools - names visible in the subject's scope, before admission.
 * @param denied - names the masking row removed; empty when the harness is not sealed.
 * @returns the same names, minus the denied ones, in the order given.
 */
export function reachableTools(
  tools: readonly string[],
  denied: readonly string[],
): readonly string[] {
  if (denied.length === 0) return [...tools]
  const blocked = new Set(denied)
  return tools.filter((name) => !blocked.has(name))
}

/**
 * Preset id for one mount.
 *
 * Preset ids are process-global and a duplicate throws, so every mount is scoped to whatever owns it —
 * a run, or a one-shot inspection. Two runs, or an inspection that overlaps a run, cannot collide.
 * @param scope - the run id or inspection token.
 * @returns an id safe to register and to dispose.
 */
export function presetIdFor(scope: string): string {
  return `bench-${scope}`
}

/** Sorted model-facing names from a definition list, the shape both callers need. */
function toolNames(definitions: readonly { readonly name: string }[]): string[] {
  return definitions.map((definition) => definition.name).sort()
}

/**
 * Every tool name the host makes globally visible, i.e. what a subject would inherit.
 *
 * Read from the plugin's own scope, which sits above the subject's: a preset adds rows to a child tree,
 * so whatever is global here is what leaks into a harness that does not seal itself.
 * @param ctx - context outside any preset.
 * @returns sorted tool names.
 */
export function hostToolNames(ctx: Context): readonly string[] {
  return toolNames(ctx.tools.definitions())
}

/**
 * The model-facing tool that loads a skill.
 *
 * A host-contract name, like the catalogue in [catalog.ts](catalog.ts): `@deepseek-ai/dsh-tool-skill`
 * registers it and publishes the catalogue on `agent/pre-step` only where that tool is visible, so this
 * one string decides whether the subject can reach any skill at all.
 */
export const SKILL_TOOL = 'skill'

/** One preset, as a listing shows it. */
export interface PresetSummary {
  readonly id: string
  readonly name: string | null
  readonly isDefault: boolean
  /** Why its rows cannot be read, or `null`. A broken preset is listed, never hidden. */
  readonly broken: string | null
  /** Declared row count; `0` for a broken preset, whose rows cannot be counted. */
  readonly rows: number
}

/** The inventory entry this module reads. Structural, for the same reason as {@link SkillCatalog}. */
interface PresetComposition {
  readonly id: string
  readonly name?: string
  readonly isDefault: boolean
  readonly broken?: string
  readonly rows: readonly unknown[]
}

/**
 * Every preset the host knows, in the order a caller should read them.
 *
 * A preset whose rows cannot be read is **listed with its reason** rather than dropped: a listing that
 * hid it would leave the caller picking a different id and wondering why nothing matches, and "the
 * option you wanted was there and unusable" is the fact they need.
 *
 * Pure, so the ordering and the broken-row handling are testable without a host.
 * @param inventory - whatever `compositionInventory()` returned.
 * @returns the default preset first, then the rest by id.
 */
export function presetSummaries(inventory: readonly PresetComposition[]): readonly PresetSummary[] {
  return inventory
    .map((preset) => ({
      id: preset.id,
      name: preset.name ?? null,
      isDefault: preset.isDefault,
      broken: preset.broken ?? null,
      rows: preset.rows.length,
    }))
    .sort((left, right) => {
      if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
    })
}

/**
 * Every preset the host knows. Costs nothing: no mount, no scope lease, no agent.
 * @param ctx - context that owns the preset registry.
 * @returns the listing.
 */
export async function presetList(ctx: Context): Promise<readonly PresetSummary[]> {
  return presetSummaries(await ctx.agentPresets.compositionInventory())
}

/**
 * The skill registry as this module needs it.
 *
 * Declared structurally instead of imported so this plugin does not take a peer dependency on a service
 * it uses only when the host happens to mount it.
 */
interface SkillCatalog {
  list(options: { readonly scope?: object }): Promise<readonly SkillSummary[]>
}

/** The part of a skill summary that decides reachability. */
interface SkillSummary {
  readonly name: string
  readonly invocation: { readonly modelInvocable: boolean }
}

/**
 * Register, audit and probe one harness.
 *
 * @param ctx - context owning the registration; disposing it unmounts via Cordis too.
 * @param plan - id, label and rows.
 * @returns the mounted subject with its observed capability surface.
 * @throws {HarnessSpecError} when the harness cannot be mounted, or mounts but is unusable.
 */
export async function mountSubject(ctx: Context, plan: SubjectPlan): Promise<Subject> {
  const presets = ctx.agentPresets
  const unregister = await presets.register({
    id: plan.presetId,
    name: plan.label,
    plugins: plan.rows,
  })

  try {
    // Gate 2. `register()` resolves even when the mount failed; this is the only way to hear about it.
    const health = await presets.resolve(plan.presetId)
    if (health.broken !== undefined) {
      throw new HarnessSpecError(
        `this harness cannot be mounted, so no trial can run:\n${health.broken}`,
      )
    }
    const observed = await surfaceOf(ctx, plan.presetId)
    // Admission filters once more than the scope view does, and only for names the mask removed.
    const surface: CapabilitySurface = {
      rows: observed.rows,
      tools: reachableTools(observed.tools, plan.denied ?? []),
      skills: observed.skills,
    }
    assertUsable(surface)
    return { presetId: plan.presetId, surface, dispose: unregister }
  } catch (error) {
    // A harness that failed the gate must not leave a Loader tree behind.
    await unregister().catch(() => undefined)
    throw error
  }
}

/**
 * Read any preset's capability surface, mounted by anyone.
 *
 * This is what makes the first step free of files: a shipped preset can be inspected as it is, because
 * the probe only needs the preset's scope, not ownership of the registration.
 * @param ctx - context that owns the registries.
 * @param presetId - an id the registry already knows.
 * @returns rows, visible tool names, visible skill names.
 * @throws {HarnessSpecError} when the registry does not know the id, or it is not usable.
 */
export async function surfaceOf(ctx: Context, presetId: string): Promise<CapabilitySurface> {
  const presets = ctx.agentPresets
  const health = await presets.resolve(presetId)
  if (health.broken !== undefined) {
    throw new HarnessSpecError(`preset "${presetId}" is not usable:\n${health.broken}`)
  }

  const inventory = await presets.compositionInventory()
  const found = inventory.find((entry) => entry.id === presetId)
  if (found === undefined) {
    // We resolved it a moment ago, so an absent entry means the registry dropped it.
    throw new HarnessSpecError(`the runtime no longer knows preset "${presetId}"`)
  }
  const rows = found.rows.map((row): RowFact => ({
    id: row.entryId,
    module: row.moduleName,
    enabled: row.enabled,
    fiberState: row.fiberState ?? null,
  }))

  // A lease, not an agent: no session, no model call, and the revision is released in the `finally`.
  // Written with try/finally rather than `await using` so every cleanup in this plugin reads the same.
  const lease = await presets.acquireScope(presetId)
  try {
    const tools = toolNames(ctx.tools.definitions(lease.key))
    return { rows, tools, skills: await loadableSkills(ctx, lease.key, tools) }
  } finally {
    await lease[Symbol.asyncDispose]()
  }
}

/**
 * The skills the subject can reach: the ones a `skill` tool in its own scope would let it load.
 *
 * @param ctx - context that owns the registry.
 * @param scope - the subject's scope key.
 * @param tools - the tool names visible in that same scope.
 * @returns sorted loadable names; `null` when the host has no skill registry.
 */
async function loadableSkills(
  ctx: Context,
  scope: object,
  tools: readonly string[],
): Promise<string[] | null> {
  const skills: SkillCatalog | undefined = ctx.get('skills')
  if (skills === undefined) return null
  // No loader, no reachable skill — and the host sends no catalogue either. Saying "the registry holds
  // six" here is how a sealed subject came to be described as having skills it could not name.
  if (!tools.includes(SKILL_TOOL)) return []
  const found = await skills.list({ scope })
  return found
    .filter((skill) => skill.invocation.modelInvocable)
    .map((skill) => skill.name)
    .sort()
}

/**
 * Reject a harness that mounted but cannot be the subject of a run.
 * @param surface - the observed surface.
 * @throws {HarnessSpecError} when it makes no tools callable at all.
 */
function assertUsable(surface: CapabilitySurface): void {
  if (surface.tools.length === 0) {
    throw new HarnessSpecError(
      'this harness mounted but makes no tool callable: ' +
        'either it declares no tool row, or the profile does not admit the ones it declares',
    )
  }
}

/**
 * Rows that are declared but contribute nothing — the failure mode the activation audit cannot see.
 *
 * **Not** a blocking problem, and the distinction is measured: an exported `minimal` harness reaches the
 * subject with two callable tools while two of its rows are denied by the profile's policy, and a run of
 * exactly that file completed. Calling it "not runnable" would have had an operator abandon a working
 * harness. The record still has to be told which rows were dead, because otherwise it credits the whole
 * file with an effect only part of it had.
 * @param surface - the observed surface.
 * @returns one line per row that mounts but does not run.
 */
export function rowWarnings(surface: CapabilitySurface): string[] {
  const warnings: string[] = []
  for (const row of surface.rows) {
    const label = `${row.id ?? '(no id)'} (${row.module})`
    if (row.enabled === false) {
      warnings.push(
        `${label}: mounted disabled — the profile's compatibility policy does not admit it, ` +
          'so it contributes nothing to the subject',
      )
    } else if (row.enabled === 'conditional') {
      warnings.push(`${label}: enablement could not be evaluated outside a mount`)
    }
  }
  return warnings
}
