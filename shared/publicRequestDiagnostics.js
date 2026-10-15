import { modelWireDiagnosticsSchema } from './modelWireDiagnostics.js'
import { modelContextDiagnosticsSchema } from './modelContextDiagnostics.js'
import { promptCompilerDiagnosticsSchema } from './promptCompilerDiagnostics.js'
import { modelContextUsageSchema } from './modelContextUsage.js'
/** Optional display evidence only; invalid/legacy fields never become execution authority.
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
export function publicRequestDiagnostics(value) {
  /** @type {Record<string, unknown>} */
  const result = {}
  const input = /** @type {Record<string, unknown>} */ (value && typeof value === 'object' && !Array.isArray(value) ? value : {})
  const schemas = /** @type {const} */ ([['modelWireDiagnostics', modelWireDiagnosticsSchema], ['modelContextDiagnostics', modelContextDiagnosticsSchema], ['modelCompilerDiagnostics', promptCompilerDiagnosticsSchema], ['modelContextUsage', modelContextUsageSchema]])
  for (const [key, schema] of schemas) {
    const parsed = schema.safeParse(input[key])
    if (parsed.success) result[key] = parsed.data
  }
  return result
}
