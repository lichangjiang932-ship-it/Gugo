import { resolveTurnPersistenceBootstrap } from '../core/turnPersistenceBootstrap.js'

const builtinProvenanceAdapters = new WeakMap()

async function loadBuiltinSqliteTurnPersistenceAdapter() {
  const { SQLITE_TURN_PERSISTENCE_ADAPTER } = await import('./sqliteTurnPersistenceAdapter.js')
  return SQLITE_TURN_PERSISTENCE_ADAPTER
}

/**
 * Distribution-owned bootstrap for the bundled SQLite backend. This function
 * deliberately accepts no backend override: callers may request a trusted
 * module through env, but only the exact bundled fallback can mint authority
 * for SQLite-specific Headless session lookup.
 */
export async function resolveBuiltinSqliteTurnPersistenceBootstrap(options = {}) {
  const result = await resolveTurnPersistenceBootstrap({
    ...options,
    builtinAdapter: null,
    builtinAdapterFactory: loadBuiltinSqliteTurnPersistenceAdapter,
  })
  if (result.provenance.source === 'builtin') {
    builtinProvenanceAdapters.set(result.provenance, result.adapter)
  }
  return result
}

export function isBuiltinSqliteTurnPersistenceProvenance(provenance, adapter) {
  if (!adapter || !provenance || (
    typeof provenance !== 'object'
    && typeof provenance !== 'function'
  )) return false
  return builtinProvenanceAdapters.get(provenance) === adapter
}
