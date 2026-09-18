/** Host-owned diagnostic dependencies; never selected from model or HTTP arguments. */
import { AsyncLocalStorage } from 'node:async_hooks'

const scopes = new AsyncLocalStorage()

export function getDiagnosticRuntimeScope() {
  return scopes.getStore() || null
}

/** The caller owns connection mode/lifetime. Credentials are always read-only in this scope. */
export function withDiagnosticRuntimeScope({ database, env }, work) {
  if (!database || typeof database.prepare !== 'function' || typeof work !== 'function') {
    throw new TypeError('A diagnostic scope requires a caller-owned database and operation')
  }
  return scopes.run(Object.freeze({ database, env: Object.freeze({ ...env }), credentialsReadOnly: true }), work)
}
