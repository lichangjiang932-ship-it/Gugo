import { classifyToolRisk } from '../utils/approvalPolicy.js'
import { createBuiltinApprovalPolicyAdapter } from './policyAdapter.js'
import { createRuntimeCapabilityRegistry } from './runtimeCapabilityRegistry.js'
import {
  acquireRuntimePolicy,
  activateRuntimePolicy,
  getActiveRuntimePolicyProvenance,
} from './runtimeCapabilityState.js'

const BUILTIN_VERSION = '0.11.31'
const BUILTIN_POLICY_ID = 'builtin.harness-policy'

if (!getActiveRuntimePolicyProvenance()) {
  const registry = createRuntimeCapabilityRegistry()
  registry.register(Object.freeze({
    id: BUILTIN_POLICY_ID,
    type: 'policy',
    slot: 'policy',
    owner: 'builtin',
    version: BUILTIN_VERSION,
    priority: 0,
    implementation: createBuiltinApprovalPolicyAdapter(classifyToolRisk),
    healthCheck: () => true,
  }))
  activateRuntimePolicy(registry.snapshot())
}

export {
  acquireRuntimePolicy,
  getActiveRuntimePolicyProvenance,
}
