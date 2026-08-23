const TRUSTED_INTERNAL_LOOP_PRINCIPAL = Object.freeze({
  kind: 'gugo.trusted-internal-loop-principal',
})

/**
 * Opaque capability for in-process harnesses that have no durable user owner.
 * Object identity is intentional: serialized input cannot forge this token.
 */
export function trustedInternalLoopPrincipal() {
  return TRUSTED_INTERNAL_LOOP_PRINCIPAL
}

export function isTrustedInternalLoopPrincipal(value) {
  return value === TRUSTED_INTERNAL_LOOP_PRINCIPAL
}
