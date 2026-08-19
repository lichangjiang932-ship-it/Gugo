function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  const encoded = JSON.stringify(value)
  return encoded === undefined ? String(value) : encoded
}

export function approvalCacheKey(toolName, args) {
  return `${String(toolName)}\n${canonicalJson(args || {})}`
}

export function createSubagentApprovalContext() {
  return { approved: new Map(), pending: new Map() }
}

export function rememberApprovedSubagentCall(context, toolName, args, gate) {
  if (!context?.approved || !gate?.proceed || !gate.approvalId || gate.edited) return false
  context.approved.set(approvalCacheKey(toolName, args), {
    proceed: true,
    args: gate.args ?? args,
    approvalId: gate.approvalId,
  })
  return true
}
