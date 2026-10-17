// Explicit process-owned restriction for an isolated verification host. No env,
// HTTP or async-local activation: ordinary hosts never install this lease.
let activeBinding = null

function policyError(message, code = 'HOST_VERIFICATION_POLICY_INVALID_RESULT') {
  return Object.assign(new Error(message), {
    code, retryable: false, unsafeToReplay: true, modelRequestOutcome: 'not_sent',
  })
}

function synchronousResult(result) {
  if (result && typeof result.then === 'function') {
    // A mistakenly async hook must neither authorize work nor leave an unhandled
    // rejection behind. Reservations and dispatch checks are synchronous gates.
    void Promise.resolve(result).catch(() => {})
    throw policyError('Host verification policy hooks must be synchronous')
  }
  return result
}

/** Read-only presence query; it neither installs nor authorizes a policy. */
export function isHostVerificationPolicyConfigured() {
  return activeBinding !== null
}

/** Trusted host JS only; capture just the three restrictive hooks, not policy utilities. */
export function configureHostVerificationPolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new TypeError('Host verification policy must provide three function hooks')
  }
  if (activeBinding) {
    throw policyError('Host verification policy is already configured', 'HOST_VERIFICATION_POLICY_ALREADY_CONFIGURED')
  }
  const captured = {}
  for (const name of ['projectToolSpecs', 'assertToolCall', 'beforeModelRequest']) {
    const hook = policy[name]
    if (typeof hook !== 'function') throw new TypeError(`Host verification policy ${name} must be a function`)
    captured[name] = hook.bind(policy)
  }
  const binding = Object.freeze(captured)
  activeBinding = binding
  let released = false
  return Object.freeze({
    release() {
      if (released) return false
      released = true
      if (activeBinding !== binding) return false
      activeBinding = null
      return true
    },
  })
}

function freezeProjectionInput(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  // Keep original identities, but no in-place schema edits may turn subtraction
  // into authority expansion. This runs only while an explicit lease is active.
  Object.freeze(value)
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (Object.hasOwn(descriptor, 'value')) freezeProjectionInput(descriptor.value, seen)
  }
  return value
}

/** Subtract only from the already-authorized catalog; preserve original spec identities. */
export function projectToolSpecs(specs) {
  const binding = activeBinding
  if (!binding) return specs
  const source = freezeProjectionInput([...specs])
  const projected = synchronousResult(binding.projectToolSpecs(source))
  if (!Array.isArray(projected)) throw policyError('Host verification projection must return an array')
  const available = new Set(source)
  const result = []
  for (const spec of projected) {
    if (!available.delete(spec)) {
      throw policyError('Host verification projection must be an original-reference subset without duplicates')
    }
    result.push(spec)
  }
  return result
}

/** A host restriction cannot authorize a call rejected by the original dispatcher. */
export function assertToolCall(name, args) {
  const binding = activeBinding
  if (!binding) return
  if (synchronousResult(binding.assertToolCall(name, args)) === false) {
    throw policyError('Host verification policy denied the tool call', 'HOST_VERIFICATION_TOOL_DENIED')
  }
}

/** Reserve immediately before each physical fetch, before its request-start callback. */
export function beforeModelRequest(url) {
  const binding = activeBinding
  if (!binding) return
  if (synchronousResult(binding.beforeModelRequest(url)) === false) {
    throw policyError('Host verification policy denied the model request', 'HOST_VERIFICATION_MODEL_REQUEST_DENIED')
  }
}
