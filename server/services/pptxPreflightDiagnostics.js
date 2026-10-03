const nativePreflightFailures = new WeakMap()

export const PPTX_PREFLIGHT_KIND = 'native_pptx_preflight_v1'

/** Only the native, non-writing validation pass may issue this proof. */
export function markNativePptxPreflightFailure(error, diagnostics) {
  nativePreflightFailures.set(error, Object.freeze(diagnostics))
  return error
}

export function nativePptxPreflightDiagnostics(error) {
  return nativePreflightFailures.get(error) || null
}
