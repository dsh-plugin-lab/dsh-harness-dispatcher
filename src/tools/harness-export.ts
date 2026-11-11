/**
 * One tool: turn a shipped preset into a harness file you can edit.
 *
 * The hard part of writing a harness is not syntax, it is not knowing what a working one looks like.
 * `readDocument(id)` dumps a declaration's child rows in the Loader's own dialect, so the answer is
 * something **known to mount on this host**: delete what you want gone, then inspect it. That also
 * replaces any prose reference to the row syntax.
 *
 * It round-trips because `readDocument` renders `plugins` through `entryListSchema`, whose `!!js` nodes
 * stay unevaluated text — re-mounting re-evaluates them, which is what a snapshot should do. The
 * registry's "nothing accepts YAML back" caveat is about the whole document with its display metadata,
 * not this child list.
 *
 * @module dsh-harness-dispatcher/tools/harness-export
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { digestText } from '../digest.ts'
import { HARNESS_EXTENSIONS } from '../harness.ts'

/** What this tool needs from the plugin instance. */
export interface HarnessExportDeps {
  /** Directory names resolve in, and where an export lands. */
  readonly harnessDir: string
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    preset: { type: 'string', required: true },
    bytes: { type: 'number', required: true },
    digest: { type: 'string', required: true },
  },
} as const

/**
 * Register `harness_export`.
 * @param ctx - context owning the registration.
 * @param deps - where exported files land.
 */
export function registerHarnessExport(ctx: Context, deps: HarnessExportDeps): void {
  ctx.tools.register(
    defineTool({
      name: 'harness_export',
      description:
        "Write a preset's plugin rows to a harness file in the Loader's own format, ready to edit and " +
        'then pass to `harness_inspect` or `harness_run`. Use it to start from a harness that is known ' +
        'to mount on this host, then delete rows. Costs no model call and starts no agent. To only look ' +
        'at a preset, `harness_inspect` needs no file at all.',
      parameters: {
        preset: {
          type: 'string',
          required: true,
          description: 'Preset id to export, as the host reports it (e.g. "standard").',
        },
        name: {
          type: 'string',
          description:
            'File name to write. Defaults to the preset id. A non-absolute value resolves in the ' +
            'plugin harness directory. Never overwrites: an existing file is an error.',
        },
      },
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => [
          {
            type: 'text',
            text:
              `wrote ${String(value.bytes)} bytes → ${value.path}\n` +
              // Named as the *file's* digest: it is a hash of the bytes, while the number an
              // inspection and a record show is the fingerprint (bytes + route + depth + sealed). Two
              // 8-hex values that mean different things must not both be called "the digest".
              `file digest ${value.digest}. Edit it, then call harness_inspect with ` +
              `harness: { file: "${value.path}" }; its fingerprint is what records are compared by.`,
          },
        ],
      },
      // Two exports racing on one path is settled by the `wx` write below, not by scheduling.
      isConcurrencySafe: () => true,
      async execute(args) {
        const document = await ctx.agentPresets.readDocument(args.preset)
        const path = resolveOutPath(args.name ?? args.preset, deps.harnessDir)
        await mkdir(dirname(path), { recursive: true })
        // `wx`: an export that silently replaced a file the operator had edited would destroy work, and
        // "the harness changed and nothing said so" is the exact failure this repository exists to avoid.
        await writeFile(path, document.content, { flag: 'wx', encoding: 'utf8' })
        return {
          path,
          preset: args.preset,
          bytes: Buffer.byteLength(document.content, 'utf8'),
          digest: digestText(document.content),
        }
      },
    }),
  )
}

/**
 * Turn a requested name into an absolute path with a parseable extension.
 * @param requested - the caller's `name`, or the preset id.
 * @param harnessDir - directory non-absolute names resolve in.
 * @returns absolute path.
 */
function resolveOutPath(requested: string, harnessDir: string): string {
  const absolute = isAbsolute(requested) ? requested : join(harnessDir, requested)
  if (HARNESS_EXTENSIONS.includes(extname(absolute))) return absolute
  // `readDocument` serves the Loader's YAML dialect, so the default extension is YAML.
  return `${absolute}.yml`
}
