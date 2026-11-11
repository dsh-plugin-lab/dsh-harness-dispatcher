/**
 * Mounting a harness, and reading back what it will actually see.
 *
 * ## Why this is a separate step from running a trial
 *
 * Mounting a Loader tree **does not start a model call**. That single fact is what makes the whole
 * design affordable: a harness can be mounted, audited and inspected in a second, for zero tokens, so
 * "write it wrong → find out → fix it" is cheap enough to iterate on. `harness_inspect` is this step
 * and nothing else.
 *
 * ## The three gates, and the one that is easy to miss
 *
 *   1. **Structure.** The registry validates rows before importing anything.
 *   2. **Activation.** `mountPreset` audits row by row and reports import, activation and
 *      missing-service failures. But it *swallows* them: `register()` resolves normally and keeps the
 *      diagnostic in its record, so the failure only surfaces when a child tries to join the preset.
 *      Reading `resolve(id).broken` back is not optional — without it a broken harness would produce a
 *      run directory and an empty `trials.jsonl` instead of an error.
 *   3. **Enablement.** A row the profile's compatibility policy denies mounts *disabled*, and the audit
 *      skips disabled rows — so a harness can pass gate 2 while contributing nothing.
 *      `compositionInventory()` is the only place that is visible.
 *
 * ## Why probe through a scope lease rather than the row list
 *
 * The audit answers "did every row start". The experiment needs a different question: *what can the
 * subject call?* `acquireScope(id)` hands out a scope for a preset **without starting an agent**, and
 * the tool and skill registries answer for that scope — global contributions plus the preset's own,
 * after shadowing and restriction. That is the capability surface, and it is what a fault
 * must be checked against.
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
  /** Skill names visible in the subject's scope, sorted. `null` when the host has no skill registry. */
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

/**
 * The skill registry as this module needs it.
 *
 * Declared structurally instead of imported so this plugin does not take a peer dependency on a service
 * it uses only when the host happens to mount it.
 */
interface SkillCatalog {
  list(options: { readonly scope: object }): Promise<readonly { readonly name: string }[]>
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
    const surface = await surfaceOf(ctx, plan.presetId)
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
    const tools = ctx.tools
      .definitions(lease.key)
      .map((definition) => definition.name)
      .sort()
    return { rows, tools, skills: await skillNames(ctx, lease.key) }
  } finally {
    await lease[Symbol.asyncDispose]()
  }
}

async function skillNames(ctx: Context, scope: object): Promise<string[] | null> {
  const skills: SkillCatalog | undefined = ctx.get('skills')
  if (skills === undefined) return null
  const found = await skills.list({ scope })
  return found.map((skill) => skill.name).sort()
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
 * Reported as data rather than thrown: a harness with one denied row may still be exactly what the
 * operator intended to measure, but they must be told, because the record would otherwise credit the
 * whole file with an effect only part of it had.
 * @param surface - the observed surface.
 * @returns one line per row that mounts but does not run.
 */
export function rowProblems(surface: CapabilitySurface): string[] {
  const problems: string[] = []
  for (const row of surface.rows) {
    const label = `${row.id ?? '(no id)'} (${row.module})`
    if (row.enabled === false) {
      problems.push(
        `${label}: mounted disabled — the profile's compatibility policy does not admit it, ` +
          'so it contributes nothing to the subject',
      )
    } else if (row.enabled === 'conditional') {
      problems.push(`${label}: enablement could not be evaluated outside a mount`)
    }
  }
  return problems
}
