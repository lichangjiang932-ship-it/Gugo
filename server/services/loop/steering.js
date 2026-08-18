function optionalFunction(value, name) {
  if (value == null) return null
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`)
  return value
}

export function freshSteeringMessages(messages = [], appliedIds = []) {
  const seen = new Set(Array.from(appliedIds || [], (id) => String(id || '').trim()).filter(Boolean))
  return (Array.isArray(messages) ? messages : []).filter((message) => {
    const id = String(message?.id || '').trim()
    if (id && seen.has(id)) return false
    if (id) seen.add(id)
    return true
  })
}

/**
 * Own the durable steering lease lifecycle. A lease is acknowledged only
 * after the checkpoint containing its messages is durable; every failure
 * before that acknowledgement releases the lease for recovery.
 */
export function createSteeringController({
  claim = null,
  acknowledge = null,
  release = null,
  persist,
  appendAssistant = null,
  beforeFinalCompletion = null,
  onCompletionDeferred = null,
} = {}) {
  const claimLease = optionalFunction(claim, 'claim')
  const acknowledgeLease = optionalFunction(acknowledge, 'acknowledge')
  const releaseLease = optionalFunction(release, 'release')
  const persistState = optionalFunction(persist, 'persist')
  const appendCandidate = optionalFunction(appendAssistant, 'appendAssistant')
  const completionGate = optionalFunction(beforeFinalCompletion, 'beforeFinalCompletion')
  const completionDeferred = optionalFunction(onCompletionDeferred, 'onCompletionDeferred')

  const acknowledgeDurable = async (leaseId) => {
    if (leaseId && acknowledgeLease) await acknowledgeLease(leaseId)
  }

  const releaseClaim = async (leaseId) => {
    if (leaseId && releaseLease) await releaseLease(leaseId)
  }

  const persistAndAcknowledge = async (leaseId, persistOptions) => {
    try {
      if (persistState) await persistState(persistOptions)
      await acknowledgeDurable(leaseId)
    } catch (error) {
      await releaseClaim(leaseId)
      throw error
    }
  }

  const claimFresh = async (appliedIds = []) => {
    if (!claimLease) return { leaseId: null, messages: [] }
    const claimed = await claimLease()
    if (!claimed?.messages?.length) {
      return { leaseId: claimed?.leaseId || null, messages: [] }
    }
    const messages = freshSteeringMessages(claimed.messages, appliedIds)
    if (messages.length === 0 && claimed.leaseId) {
      // The checkpoint already contains these ids but the prior ACK was lost.
      await persistAndAcknowledge(claimed.leaseId)
    }
    return {
      leaseId: messages.length > 0 ? claimed.leaseId || null : null,
      messages,
    }
  }

  const completionGateAllowsFinish = async (details) => {
    if (!completionGate) return true
    const result = await completionGate(details)
    return typeof result === 'boolean' ? result : result?.closed !== false
  }

  const prepareCompletion = async ({
    text = '',
    leaseId = null,
    incomplete = false,
    reason = null,
  } = {}) => {
    if (!completionGate) return { closed: true, prepared: false }
    try {
      if (leaseId) {
        if (text && appendCandidate) appendCandidate(text)
        if (persistState) await persistState()
        await acknowledgeDurable(leaseId)
      }
      const closed = await completionGateAllowsFinish({ text, incomplete, reason })
      if (!closed) {
        if (!leaseId) {
          if (text && appendCandidate) appendCandidate(text)
          if (persistState) await persistState()
        }
        if (completionDeferred) completionDeferred()
      }
      return { closed, prepared: Boolean(leaseId) || !closed }
    } catch (error) {
      await releaseClaim(leaseId)
      throw error
    }
  }

  return Object.freeze({
    acknowledge: acknowledgeDurable,
    claimFresh,
    completionGateAllowsFinish,
    persistAndAcknowledge,
    prepareCompletion,
    release: releaseClaim,
  })
}
