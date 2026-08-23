const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/

function insertByOriginalOrder(queue, node) {
  let index = queue.length
  while (index > 0 && queue[index - 1].index > node.index) index -= 1
  queue.splice(index, 0, node)
}

function planningError(error, pluginId) {
  return Object.freeze({
    code: String(error?.code || 'PLUGIN_RESTORE_PLAN_RESOLUTION_FAILED'),
    message: String(error?.message || `runtime plugin restore plan failed: ${pluginId}`).slice(0, 1_000),
    retryable: error?.retryable === true,
  })
}

function normalizeDependencies(resolved, pluginId) {
  const requires = resolved?.requires ?? []
  if (!Array.isArray(requires)) {
    const error = new TypeError(`runtime plugin requires must be an array: ${pluginId}`)
    error.code = 'PLUGIN_RESTORE_DEPENDENCIES_INVALID'
    throw error
  }
  const dependencies = []
  const seen = new Set()
  for (const value of requires) {
    const dependencyId = typeof value === 'string' ? value.trim() : ''
    if (!PLUGIN_ID_RE.test(dependencyId)) {
      const error = new TypeError(`runtime plugin dependency id is invalid: ${pluginId}`)
      error.code = 'PLUGIN_RESTORE_DEPENDENCIES_INVALID'
      throw error
    }
    if (seen.has(dependencyId)) continue
    seen.add(dependencyId)
    dependencies.push(dependencyId)
  }
  return dependencies
}

function identifyCycleMembers(nodes) {
  let nextIndex = 0
  const stack = []
  const cycleMembers = new Map()

  function visit(node) {
    node.tarjanIndex = nextIndex
    node.lowLink = nextIndex
    nextIndex += 1
    stack.push(node)
    node.onStack = true

    for (const dependencyId of node.internalDependencies) {
      const dependency = node.byId.get(dependencyId)
      if (dependency.tarjanIndex === undefined) {
        visit(dependency)
        node.lowLink = Math.min(node.lowLink, dependency.lowLink)
      } else if (dependency.onStack) {
        node.lowLink = Math.min(node.lowLink, dependency.tarjanIndex)
      }
    }

    if (node.lowLink !== node.tarjanIndex) return
    const component = []
    while (stack.length > 0) {
      const member = stack.pop()
      member.onStack = false
      component.push(member)
      if (member === node) break
    }
    const isCycle = component.length > 1
      || component[0].internalDependencies.includes(component[0].pluginId)
    if (!isCycle) return
    const ids = Object.freeze(component
      .sort((left, right) => left.index - right.index)
      .map((member) => member.pluginId))
    for (const member of component) cycleMembers.set(member.pluginId, ids)
  }

  for (const node of nodes) {
    if (node.tarjanIndex === undefined) visit(node)
  }
  return cycleMembers
}

function cycleBlockers(node, cycleMembers, memo, visiting = new Set()) {
  if (memo.has(node.pluginId)) return memo.get(node.pluginId)
  if (cycleMembers.has(node.pluginId)) return cycleMembers.get(node.pluginId)
  if (visiting.has(node.pluginId)) return Object.freeze([])
  visiting.add(node.pluginId)
  const blockedBy = new Set()
  for (const dependencyId of node.internalDependencies) {
    const dependency = node.byId.get(dependencyId)
    for (const blocker of cycleBlockers(dependency, cycleMembers, memo, visiting)) {
      blockedBy.add(blocker)
    }
  }
  visiting.delete(node.pluginId)
  const result = Object.freeze([...blockedBy])
  memo.set(node.pluginId, result)
  return result
}

/**
 * Build a deterministic restore plan without letting one malformed manifest
 * prevent unrelated plugins from being planned. Each entry retains the exact
 * input state snapshot and exposes the dependency/cycle metadata needed by the
 * execution layer to fail closed before running plugin code.
 */
export function planRuntimePluginRestore(states, resolvePlugin) {
  if (!Array.isArray(states)) throw new TypeError('runtime plugin states must be an array')
  if (typeof resolvePlugin !== 'function') {
    throw new TypeError('runtime plugin resolver must be a function')
  }

  const ids = new Set()
  const nodes = states.map((state, index) => {
    const pluginId = String(state?.pluginId || '').trim()
    if (!PLUGIN_ID_RE.test(pluginId)) {
      throw new TypeError(`runtime plugin state has an invalid pluginId at index ${index}`)
    }
    if (ids.has(pluginId)) {
      throw new TypeError(`runtime plugin states contain duplicate pluginId: ${pluginId}`)
    }
    ids.add(pluginId)
    return {
      state,
      index,
      pluginId,
      dependencies: [],
      internalDependencies: [],
      dependents: [],
      unresolvedDependencyCount: 0,
      resolutionError: null,
      byId: null,
    }
  })
  const byId = new Map(nodes.map((node) => [node.pluginId, node]))

  for (const node of nodes) {
    node.byId = byId
    try {
      node.dependencies = normalizeDependencies(resolvePlugin(node.pluginId, node.state), node.pluginId)
    } catch (error) {
      node.resolutionError = planningError(error, node.pluginId)
    }
    node.internalDependencies = node.dependencies.filter((dependencyId) => byId.has(dependencyId))
    node.unresolvedDependencyCount = node.internalDependencies.length
    for (const dependencyId of node.internalDependencies) {
      byId.get(dependencyId).dependents.push(node)
    }
  }

  const ready = nodes.filter((node) => node.unresolvedDependencyCount === 0)
  const emitted = new Set()
  const ordered = []
  while (ready.length > 0) {
    const node = ready.shift()
    if (emitted.has(node.pluginId)) continue
    emitted.add(node.pluginId)
    ordered.push(node)
    for (const dependent of node.dependents) {
      dependent.unresolvedDependencyCount -= 1
      if (dependent.unresolvedDependencyCount === 0) insertByOriginalOrder(ready, dependent)
    }
  }
  for (const node of nodes) {
    if (!emitted.has(node.pluginId)) ordered.push(node)
  }

  const cycleMembers = identifyCycleMembers(nodes)
  const blockerMemo = new Map()
  return ordered.map((node) => Object.freeze({
    state: node.state,
    pluginId: node.pluginId,
    dependencies: Object.freeze([...node.dependencies]),
    resolutionError: node.resolutionError,
    cycleMembers: cycleMembers.get(node.pluginId) || Object.freeze([]),
    blockedByCycle: cycleBlockers(node, cycleMembers, blockerMemo),
  }))
}
