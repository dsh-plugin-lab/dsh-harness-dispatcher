import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export const name = 'harness-sealed'

export const inject = ['tools']

export interface Config {
  deny: string[]
}

export const Config: z<Config> = z.object({
  deny: z.array(z.string()).default([]),
})

/**
 * Hide inherited tools from the agent this row is mounted under.
 *
 * `tools.restrict` masks the scope it is called from, and a scope lease exposes a key but no context,
 * so the mask has to be a row inside the subject's tree rather than a call from outside it.
 */
export function apply(ctx: Context, config: Config): void {
  const deny = [...config.deny]
  if (deny.length === 0) return
  ctx.effect(() => ctx.tools.restrict({ deny }), 'harness.sealed')
}
