/**
 * Harness spec → Loader rows.
 *
 * **Row order is load order and therefore semantics.** The persona row must exist before the system
 * prompt is assembled; tool rows must all precede any row that inspects the tool registry. This module
 * owns that order so no caller can get it wrong.
 *
 * Kept apart from [harness.ts](harness.ts) so the spec layer stays pure data with no Loader types: a
 * unit test can assert the row list without importing the runtime.
 *
 * @module dsh-harness-dispatcher/preset-rows
 */

import type { HarnessSpec } from './harness.ts'
import { PERSONA_ROW, TOOL_CATALOG } from './catalog.ts'

/**
 * One Loader row, structurally.
 *
 * Declared here rather than imported from `cordis-plugin-loader` so this module — and the tests that
 * cover it — do not need the Loader package. `EntryOptions` is a superset of this shape; the preset
 * registry validates the rest (`entryListProblem`) when it mounts.
 */
export interface PresetRow {
  readonly id: string
  readonly name: string
  readonly config?: Readonly<Record<string, unknown>>
}

/** One preset declaration, structurally. */
export interface PresetDefinition {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly order?: number
  readonly plugins: readonly PresetRow[]
}

/**
 * Build the subject composition's rows.
 *
 * Deliberately minimal: a persona row (when the variant asks for one) followed by the catalog's tool
 * rows. Nothing is inherited from the operator's own preset — that is what makes two variants
 * comparable, and what keeps the subject from acquiring tools the bench did not choose.
 *
 * @param spec - the normalized Harness.
 * @returns rows in load order.
 * @throws when the spec names a catalog key that does not exist (defence in depth: `normalize`
 *   already rejects it, but this function is also callable directly from tests).
 */
export function harnessRows(spec: HarnessSpec): PresetRow[] {
  const rows: PresetRow[] = []
  if (spec.persona !== null) {
    rows.push({ id: 'bench-persona', name: PERSONA_ROW, config: { prefix: spec.persona } })
  }
  for (const key of spec.tools) {
    const entry = TOOL_CATALOG[key]
    if (entry === undefined) throw new Error(`harness names an unknown catalog key "${key}"`)
    rows.push({
      // The row id is derived from the catalog key, so a composition diff between two variants is
      // readable and stable.
      id: `bench-tool-${key}`,
      name: entry.name,
      ...(entry.config === undefined ? {} : { config: entry.config }),
    })
  }
  return rows
}

/**
 * Preset id for one benchmark run.
 *
 * Preset ids are process-global and a duplicate throws, so the id is scoped to a run. A concurrent
 * second run therefore cannot collide with the first.
 * @param runId - the run identity.
 * @returns an id safe to register and to dispose.
 */
export function harnessPresetId(runId: string): string {
  return `bench-${runId}`
}
