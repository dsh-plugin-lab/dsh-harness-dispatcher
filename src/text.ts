/**
 * Flatten the subject's final answer into one string.
 * @module dsh-harness-dispatcher/text
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/**
 * Flatten model-facing content blocks into one string.
 *
 * Only `text` blocks carry prose; images and files are recorded as markers rather than silently
 * dropped, so an output that was "an image with no text" does not look like an empty answer.
 *
 * The whole text, never a prefix. This field was capped at 4 000 characters while it was the only
 * place the answer could live; it is not any more, and a cut cannot be recomputed, so a cap now only
 * loses text the record needs. The cost side is settled: one trivial one-step trial already writes
 * 47.7 KB of `events.jsonl`, so trimming the smallest file in the run directory bought nothing. The
 * prompt is still a digest, and that asymmetry is deliberate — a prompt repeats unchanged on every
 * trial, while each answer is the measurement.
 * @param blocks - result content blocks.
 * @returns the flattened text, whole.
 */
export function contentBlocksOf(blocks: readonly ContentBlock[] | undefined): string {
  if (blocks === undefined) return ''
  let text = ''
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        text += block.text
        break
      case 'image':
        text += '[image]'
        break
      case 'file':
        text += '[file]'
        break
      case 'reasoning':
        break
      default:
        text += `[${block.type}]`
        break
    }
  }
  return text
}
