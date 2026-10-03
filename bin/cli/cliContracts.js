/**
 * The two seams the CLI is built against: `InputEditor` and `ModelCatalog`.
 *
 * Input implementations share cancellation and terminal ownership rules. The model
 * catalog exposes owner/runtime-scoped public snapshots, never execution authority.
 * Wiring checks stay synchronous and never invoke refresh, selection or lifecycle I/O.
 */

import { types } from 'node:util'
import { CliError } from './errors.js'

/**
 * @typedef {object} InputEditor
 * @property {(promptText: string, request?: {signal?: AbortSignal}) => Promise<string|null>} question
 *   question(prompt, {signal} = {}) reads one submission, possibly multiline. Only one
 *   question may be pending; re-entry rejects with CLI_INPUT_BUSY. A request signal
 *   abort discards that question and resolves null; a later question may start empty.
 *   The factory/session signal abort permanently cancels the editor: pending and later
 *   questions resolve null. EOF permanently stops reads without submitting a partial
 *   draft; already accepted complete lines may drain before null. Close clears that
 *   queue immediately. Neither EOF nor close may reopen stdin.
 * @property {() => void} clear
 *   Discard buffered input and settle any pending question with an empty string.
 * @property {() => void} suspend
 *   Release terminal ownership for approval/recovery, discard the unsubmitted draft,
 *   and settle the current question with null. A later question starts empty.
 * @property {() => void} close
 *   Permanently stop reading; safe to call more than once.
 */

/**
 * @typedef {object} ModelCatalogEntry
 * @property {string|null} providerId Durable saved Provider id or named environment id.
 * @property {string|null} providerKey Optional saved Provider alias.
 * @property {string} modelName Model name without an invented Provider prefix.
 * @property {string} displayName Public terminal label.
 * @property {string} value Selection/completion value, qualified when a Provider exists.
 * @property {boolean} enabled Whether this snapshot includes an enabled Provider.
 * @property {number|null} configRevision Current configuration revision when available.
 * @property {object|null} readiness Public readiness metadata, not authorization.
 * @property {object} profile Public capability hints; never endpoints or credentials.
 */

/**
 * @typedef {object} ModelCatalog
 * @property {() => ModelCatalogEntry[]} entries
 *   Synchronous public snapshot, including disabled entries for explicit diagnostics.
 * @property {() => string[]} list
 *   Synchronous enabled completion values from memory. Like entries and diagnostics,
 *   this must not read disk or contact a provider; completion runs on every keystroke.
 * @property {() => {source: 'empty'|'cache'|'local'|'stale'|'unavailable', lastSuccessfulRefresh: number|null, cached: boolean}} diagnostics
 *   Public source/refresh status. A cached name is display-only, not a valid binding.
 * @property {() => Promise<boolean>} refresh
 *   Read current local configuration, replacing even with an empty list after deletion.
 *   May update the scoped disk cache. Resolves whether entries changed; never rejects.
 * @property {(value: string|ModelCatalogEntry, options?: {currentProviderId?: string|null}) => Promise<{modelName: string, providerId: string|null}>} select
 *   Refresh and validate current identity/revision; reject unavailable, ambiguous,
 *   disabled or changed selections. Cached snapshots alone must never authorize a model.
 * @property {() => void} close
 *   Idempotently close; late refreshes cannot write a cache or reopen this catalog.
 */

/** Method names required by each contract, in the order they are documented. */
export const INPUT_EDITOR_METHODS = Object.freeze(['question', 'clear', 'suspend', 'close'])
export const MODEL_CATALOG_METHODS = Object.freeze(['entries', 'list', 'diagnostics', 'refresh', 'select', 'close'])
const MODEL_CATALOG_SOURCES = new Set(['empty', 'cache', 'local', 'stale', 'unavailable'])

function assertMethods(subject, methods, { label, code, level }) {
  if (!subject || (typeof subject !== 'object' && typeof subject !== 'function')) {
    throw new CliError(code, `${label} must be an object exposing ${methods.join(', ')}`)
  }
  for (const method of methods) {
    if (typeof subject[method] !== 'function') {
      throw new CliError(code, `${label} is missing ${method}(); a ${level} must expose ${methods.join(', ')}`)
    }
  }
  return subject
}

/**
 * Verify an editor satisfies {@link InputEditor}. Structural and cheap: it checks shape,
 * never behaviour, so it is safe to call at wiring time.
 */
export function assertInputEditor(editor, { label = 'input editor' } = {}) {
  return assertMethods(editor, INPUT_EDITOR_METHODS, {
    label,
    code: 'CLI_INPUT_EDITOR_INVALID',
    level: 'input editor',
  })
}

function catalogError(message) {
  return new CliError('CLI_MODEL_CATALOG_INVALID', message)
}

function assertSynchronous(value, label) {
  if (types.isPromise(value)) {
    // A plain (non-async) method may still return Promise.reject(). Observe both
    // outcomes before rejecting the contract, without calling a user-defined then.
    Promise.prototype.then.call(value, () => {}, () => {})
    throw catalogError(`${label} must be synchronous; an asynchronous result is not a snapshot`)
  }
  if (value && typeof value.then === 'function') {
    throw catalogError(`${label} must be synchronous; a thenable is not a snapshot`)
  }
}

function readCatalogSnapshot(catalog, method, label) {
  const name = `${label}.${method}()`
  if (types.isAsyncFunction(catalog[method])) throw catalogError(`${name} must be synchronous`)
  let value
  try { value = catalog[method]() }
  catch { throw catalogError(`${name} failed to provide its synchronous snapshot`) }
  assertSynchronous(value, name)
  return value
}

function nonemptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function catalogEntry(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && (value.providerId === null || nonemptyString(value.providerId))
    && (value.providerKey === null || nonemptyString(value.providerKey))
    && ['modelName', 'displayName', 'value'].every((key) => nonemptyString(value[key]))
    && typeof value.enabled === 'boolean'
    && (value.configRevision === null || Number.isSafeInteger(value.configRevision))
    && (value.readiness === null || (typeof value.readiness === 'object' && !Array.isArray(value.readiness)))
    && value.profile && typeof value.profile === 'object' && !Array.isArray(value.profile)
}

/** Check current synchronous snapshots only; never refresh, select, close, or perform I/O. */
export function assertModelCatalog(catalog, { label = 'model catalog' } = {}) {
  assertSynchronous(catalog, label)
  assertMethods(catalog, MODEL_CATALOG_METHODS, { label, code: 'CLI_MODEL_CATALOG_INVALID', level: 'model catalog' })
  const entries = readCatalogSnapshot(catalog, 'entries', label)
  if (!Array.isArray(entries) || !entries.every(catalogEntry)) {
    throw catalogError(`${label}.entries() must return an array of public model entries`)
  }
  const names = readCatalogSnapshot(catalog, 'list', label)
  if (!Array.isArray(names) || !names.every(nonemptyString)) {
    throw catalogError(`${label}.list() must return an array of nonempty strings`)
  }
  const status = readCatalogSnapshot(catalog, 'diagnostics', label)
  if (!status || typeof status !== 'object' || Array.isArray(status) || !MODEL_CATALOG_SOURCES.has(status.source)
    || typeof status.cached !== 'boolean' || (status.lastSuccessfulRefresh !== null
      && (!Number.isFinite(status.lastSuccessfulRefresh) || status.lastSuccessfulRefresh < 0))) {
    throw catalogError(`${label}.diagnostics() must return source, lastSuccessfulRefresh, and cached status`)
  }
  return catalog
}
