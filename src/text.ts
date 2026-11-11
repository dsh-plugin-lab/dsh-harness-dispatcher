/**
 * The small string conversions every layer needs, in one place.
 *
 * Two jobs that look unrelated and are not: flattening a message body into prose, and turning a thrown
 * value or a multi-line diagnostic into the one line a reader or a status field can hold. Both are
 * "value in, string out", both are reached from four or five modules, and both were copied once per
 * caller before this module held them.
 *
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

/**
 * The message of an unknown thrown value, without losing a non-Error.
 *
 * Every `catch` in this repository receives `unknown`, and every one of them that reports anything has
 * to say what happened. Four modules had their own copy of this before it lived here.
 * @param error - anything thrown.
 * @returns the message, or the value stringified when it is not an `Error`.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The part of a message that belongs on a status line.
 *
 * A job's `detail` and a preset listing both show one line, and a host diagnostic can run to twenty:
 * without this, a whole paragraph lands inside `[status: killed, …]` or replaces the row count a reader
 * was comparing. The full text travels in a field meant to be read, never in a label.
 * @param text - the message.
 * @returns its first line.
 */
export function firstLine(text: string): string {
  return text.split('\n')[0] ?? text
}
