const modelBindingResolvers = []

function resolverUnavailableError() {
  return Object.assign(
    new Error('subagent model binding resolver is not configured'),
    {
      code: 'SUBAGENT_MODEL_BINDING_RESOLVER_NOT_CONFIGURED',
      statusCode: 503,
      retryable: false,
    },
  )
}

/** Configure the process-owned model binding resolver without selecting it in the Subagent core. */
export function configureSubagentModelBindingResolver(resolver) {
  if (typeof resolver !== 'function') {
    throw new TypeError('subagent model binding resolver must be a function')
  }
  const binding = Object.freeze({ resolver })
  modelBindingResolvers.push(binding)
  let released = false
  return () => {
    if (released) return false
    released = true
    const index = modelBindingResolvers.indexOf(binding)
    if (index < 0) return false
    modelBindingResolvers.splice(index, 1)
    return true
  }
}

/** Resolve one immutable Subagent model binding through the active process host. */
export function resolveSubagentModelBinding(input) {
  const binding = modelBindingResolvers.at(-1)
  if (typeof binding?.resolver !== 'function') throw resolverUnavailableError()
  return binding.resolver(input)
}
