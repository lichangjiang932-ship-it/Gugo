import { z } from 'zod'

/**
 * @typedef {object} ModelPhaseProgress
 * @property {string} [toolName]
 * @property {string} [toolCallId]
 * @property {number} [toolArgumentsChars]
 * @property {number} [elapsedMs]
 * @property {number} [idleMs]
 */

/** @param {number} limit */
const identityField = (limit) => z.string().min(1).max(limit)
  .refine((text) => text === text.trim() && !/\p{Cc}/u.test(text)).optional()

export const MODEL_PHASE_PROGRESS_FIELDS = Object.freeze({
  toolName: identityField(160),
  toolCallId: identityField(500),
  toolArgumentsChars: z.number().int().nonnegative().optional(),
  elapsedMs: z.number().int().nonnegative().optional(),
  idleMs: z.number().int().nonnegative().optional(),
})

/**
 * Metadata only: partial tool arguments and model reasoning never belong here.
 * @param {unknown} value
 * @returns {ModelPhaseProgress}
 */
export function normalizeModelPhaseProgress(value) {
  /** @type {ModelPhaseProgress} */
  const result = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  const source = /** @type {Record<string, unknown>} */ (value)
  for (const field of /** @type {const} */ (['toolArgumentsChars', 'elapsedMs', 'idleMs'])) {
    const number = source[field]
    if (typeof number === 'number' && Number.isSafeInteger(number) && number >= 0) result[field] = number
  }
  for (const [field, limit] of /** @type {const} */ ([['toolName', 160], ['toolCallId', 500]])) {
    const text = source[field]
    if (typeof text === 'string' && text.length > 0 && text.length <= limit
      && text === text.trim() && !/\p{Cc}/u.test(text)) result[field] = text
  }
  return result
}
