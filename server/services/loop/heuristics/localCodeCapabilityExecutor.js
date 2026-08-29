import { dispatchLspTool } from '../../../utils/lspTool.js'
import { normalizeToolError } from '../../../utils/toolCallHarness.js'
import { dispatchRunCodeTool } from '../../runCodeRuntime.js'

export async function executeLocalCodeCapabilityTool({
  name,
  args,
  userId = null,
  signal = null,
  toolCallId = null,
}) {
  if (name === 'lsp') {
    try {
      return await dispatchLspTool(args || {}, { userId, signal })
    } catch (err) {
      return normalizeToolError(err, { fallbackCode: 'lsp_tool_failed' })
    }
  }

  try {
    return await dispatchRunCodeTool(name, args || {}, {
      userId,
      signal,
      // The canonical tool loop owns staged lifecycle audit rows. Keep the
      // dispatcher audit for direct/internal calls without double-counting.
      audit: !toolCallId,
    })
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError') throw err
    const normalized = normalizeToolError(err, { fallbackCode: 'code_mode_tool_failed' })
    return err?.denied === true || err?.policyDenied === true
      ? { ...normalized, denied: true, policyDenied: true }
      : normalized
  }
}
