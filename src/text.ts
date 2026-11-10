/**
 * Small text helpers shared by the tool and the trace fold.
 * @module dsh-harness-dispatcher/text
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** Longest subject output kept in a record. Records are evidence, not transcripts. */
const MAX_OUTPUT = 4000

/**
 * Flatten model-facing content blocks into one string.
 *
 * Only `text` blocks carry prose; images and files are recorded as markers rather than silently
 * dropped, so an output that was "an image with no text" does not look like an empty answer.
 * @param blocks - result content blocks.
 * @returns the flattened text, truncated.
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
  return text.length <= MAX_OUTPUT ? text : text.slice(0, MAX_OUTPUT)
}
