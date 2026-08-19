import {
  getDynamicTool,
  registerDynamicTool,
  unregisterByOrigin,
  unregisterDynamicTool,
} from '../services/toolRegistry.js'

const mcpEventListeners = new Set()

export function safeMcpName(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40)
}

export function buildRegisteredToolSpec(server, tool) {
  const serverName = safeMcpName(server.name)
  const toolName = `mcp__${serverName}__${safeMcpName(tool.name)}`
  return {
    type: 'function',
    function: {
      name: toolName,
      description: tool.description || `${server.name} - ${tool.name}`,
      parameters: tool.inputSchema || { type: 'object', properties: {} },
    },
  }
}

export function buildMcpRiskMetadata(server, tool, toolName) {
  const configuredTools = server.tools && typeof server.tools === 'object' && !Array.isArray(server.tools)
    ? server.tools
    : {}
  const declaration = configuredTools[tool.name] || configuredTools[toolName]
  if (declaration && typeof declaration === 'object' && !Array.isArray(declaration)) {
    const riskLevel = ['low', 'medium', 'high'].includes(declaration.riskLevel)
      ? declaration.riskLevel
      : 'high'
    const approvalDeclaration = declaration.requiredApproval ?? declaration.requiresApproval
    const requiredApproval = typeof approvalDeclaration === 'boolean' ? approvalDeclaration : true
    const category = ['read', 'write_local', 'exec', 'external'].includes(declaration.category)
      ? declaration.category
      : (riskLevel === 'low' && requiredApproval === false ? 'read' : 'external')
    const isReadOnly = category === 'read'
    return {
      riskLevel,
      category,
      requiredApproval,
      requiresApproval: requiredApproval,
      isReadOnly,
      isConcurrencySafe: declaration.isConcurrencySafe == null
        ? isReadOnly
        : declaration.isConcurrencySafe === true,
      isIdempotent: declaration.isIdempotent == null
        ? isReadOnly || tool.annotations?.idempotentHint === true
        : declaration.isIdempotent === true,
      interruptBehavior: isReadOnly ? 'cancel' : 'block',
      isDestructive: declaration.isDestructive == null
        ? !isReadOnly
        : declaration.isDestructive === true,
      source: 'declared',
      reason: isReadOnly ? null : `MCP: ${server.name}`,
    }
  }

  // autoApprove is retained as a legacy compatibility fallback. MCP
  // annotations are advisory only and never bypass approval on their own.
  const autoApprove = Array.isArray(server.autoApprove)
    && (server.autoApprove.includes(tool.name) || server.autoApprove.includes(toolName))
  return {
    riskLevel: 'high',
    category: 'external',
    requiredApproval: !autoApprove,
    requiresApproval: !autoApprove,
    isReadOnly: false,
    isConcurrencySafe: false,
    isIdempotent: tool.annotations?.idempotentHint === true,
    interruptBehavior: 'block',
    isDestructive: tool.annotations?.destructiveHint !== false,
    source: 'fallback',
    reason: `MCP: ${server.name}`,
  }
}

function mcpToolSource(userId, serverId) {
  return `${userId}:${serverId}`
}

function emitMcpEvent(event) {
  const frozen = Object.freeze({ ...event })
  for (const listener of mcpEventListeners) {
    try { listener(frozen) } catch { /* observers cannot break registry sync */ }
  }
}

export function onMcpEvent(listener) {
  if (typeof listener !== 'function') throw new TypeError('MCP event listener must be a function')
  mcpEventListeners.add(listener)
  return () => mcpEventListeners.delete(listener)
}

export function onMcpToolsChange(listener) {
  return onMcpEvent((event) => {
    if (event.type === 'tools/change') listener(event)
  })
}

function toolRegistrationEntries(server, tools = []) {
  const entries = new Map()
  for (const tool of tools) {
    const spec = buildRegisteredToolSpec(server, tool)
    const name = spec.function.name
    const metadata = buildMcpRiskMetadata(server, tool, name)
    entries.set(name, {
      name,
      spec,
      metadata,
      fingerprint: JSON.stringify({ originalName: tool.name, spec, metadata }),
    })
  }
  return entries
}

function disposeToolRegistration(userId, source, name, registration) {
  if (typeof registration?.dispose === 'function') {
    try { registration.dispose() } catch { /* best effort */ }
    return
  }
  const current = getDynamicTool(name, { userId })
  if (current?.origin === 'mcp' && current.source === source) {
    unregisterDynamicTool(name, { userId })
  }
}

function registerToolEntry(userId, source, entry) {
  const dispose = registerDynamicTool({
    name: entry.name,
    origin: 'mcp',
    source,
    userId,
    spec: entry.spec,
    metadata: entry.metadata,
  })
  return { fingerprint: entry.fingerprint, dispose }
}

export function synchronizeToolsForConnection(userId, server, previousConnection, connection) {
  const source = mcpToolSource(userId, server.id)
  const previousEntries = toolRegistrationEntries(server, previousConnection?.tools || [])
  const nextEntries = toolRegistrationEntries(server, connection?.tools || [])
  const previousRegistrations = previousConnection?._mcpToolRegistrations instanceof Map
    ? previousConnection._mcpToolRegistrations
    : new Map()
  const nextRegistrations = new Map()
  const added = []
  const removed = []
  const updated = []

  for (const [name, previousEntry] of previousEntries) {
    const nextEntry = nextEntries.get(name)
    if (!nextEntry) removed.push(name)
    else if (nextEntry.fingerprint !== previousEntry.fingerprint) updated.push(name)
    else continue
    disposeToolRegistration(userId, source, name, previousRegistrations.get(name))
  }

  for (const [name, nextEntry] of nextEntries) {
    const previousEntry = previousEntries.get(name)
    if (!previousEntry) added.push(name)
    const unchanged = previousEntry?.fingerprint === nextEntry.fingerprint
    if (unchanged) {
      const owned = previousRegistrations.get(name)
      if (owned) {
        nextRegistrations.set(name, owned)
        continue
      }
      const current = getDynamicTool(name, { userId })
      if (current?.origin === 'mcp' && current.source === source) {
        nextRegistrations.set(name, { fingerprint: nextEntry.fingerprint, dispose: null })
        continue
      }
    }
    nextRegistrations.set(name, registerToolEntry(userId, source, nextEntry))
  }

  connection._mcpToolRegistrations = nextRegistrations
  const changes = {
    added: added.sort(),
    removed: removed.sort(),
    updated: updated.sort(),
  }
  if (changes.added.length || changes.removed.length || changes.updated.length) {
    emitMcpEvent({
      type: 'tools/change',
      userId,
      serverId: server.id,
      serverName: server.name,
      ...changes,
      tools: [...nextEntries.keys()].sort(),
    })
  }
  return changes
}

export function unregisterToolsForServer(userId, serverId, connection = null) {
  const source = mcpToolSource(userId, serverId)
  if (connection?._mcpToolRegistrations instanceof Map) {
    for (const [name, registration] of connection._mcpToolRegistrations) {
      disposeToolRegistration(userId, source, name, registration)
    }
    connection._mcpToolRegistrations.clear()
  }
  return unregisterByOrigin('mcp', source, { userId })
}

export function unregisterAllMcpToolsForUser(userId) {
  return unregisterByOrigin('mcp', null, { userId })
}
