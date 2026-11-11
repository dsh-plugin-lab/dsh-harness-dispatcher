/**
 * Short, stable digests — the machine identity of everything this bench compares.
 *
 * Answers two questions without comparing prose: did the operator change the harness file (digest the
 * bytes), and did two trials receive the same model input (digest the prompt and tool schemas).
 *
 * FNV-1a over bytes, 8 lowercase hex characters. Not cryptographic and not meant to be — it only has to
 * make "same input → same value" true and cheap, so a record can be grouped without re-reading what it
 * digested.
 *
 * @module dsh-harness-dispatcher/digest
 */

const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193

/**
 * Digest raw bytes.
 * @param bytes - the exact bytes to digest.
 * @returns 8 lowercase hex characters.
 */
export function digestBytes(bytes: Uint8Array): string {
  let hash = FNV_OFFSET_BASIS
  for (const byte of bytes) {
    hash ^= byte
    // `Math.imul` keeps the multiply in 32-bit space; `*` would lose the low bits to float rounding.
    hash = Math.imul(hash, FNV_PRIME) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

const encoder = new TextEncoder()

/**
 * Digest text as UTF-8.
 * @param text - the text to digest.
 * @returns 8 lowercase hex characters.
 */
export function digestText(text: string): string {
  return digestBytes(encoder.encode(text))
}

/**
 * Digest any JSON-representable value through its canonical serialization.
 *
 * Callers pass structures they built themselves (a tool list, a schema array), so `JSON.stringify`'s
 * key order is stable across calls without sorting.
 * @param value - the value to digest.
 * @returns 8 lowercase hex characters.
 */
export function digestJson(value: unknown): string {
  return digestText(JSON.stringify(value) ?? '')
}
