import { modelRequestSourceSchema } from '../../../shared/modelRequestSource.js'

/** Use the actual fenced physical route, including failover and restored responses. */
export function modelRequestAttribution(state) {
  const invocation = state.modelInvocation
  const attempt = invocation?.providerAttempts?.at(-1)
  if (!attempt || !/^[A-Za-z0-9._:-]{1,200}$/u.test(invocation.id || '')) return {}
  const source = modelRequestSourceSchema.safeParse({ version: 1, providerId: attempt.providerId,
    endpointFingerprint: attempt.endpointFingerprint, configFingerprint: attempt.configFingerprint })
  return source.success ? { modelRequestId: invocation.id, physicalAttempt: attempt.sequence, modelSource: source.data } : {}
}
