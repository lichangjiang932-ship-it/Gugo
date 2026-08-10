function normalizeText(value) {
  return String(value || '').trim()
}

function clarificationRequestType(message) {
  const clarification = message?.meta?.serverClarification || {}
  return normalizeText(clarification.request_type || clarification.requestType)
}

function isPendingServerMessage(message) {
  const meta = message?.meta || {}
  return meta.paused === true
    || ['paused', 'reconnecting'].includes(meta.serverConnectionState)
    || meta.directoryAuthorizationPending === true
    || !!meta.serverResumeResolution
}

export function resolvePendingDirectorySend(messages = []) {
  const message = [...(Array.isArray(messages) ? messages : [])].reverse().find((candidate) => (
    candidate?.role === 'assistant'
      && normalizeText(candidate?.meta?.serverTurnId)
      && clarificationRequestType(candidate) === 'directory'
      && isPendingServerMessage(candidate)
  ))
  if (!message) return null
  const meta = message.meta || {}
  return {
    message,
    state: meta.directoryAuthorizationPending === true || !!meta.serverResumeResolution
      ? 'resuming'
      : 'authorization_required',
  }
}

export function isResumeNudge(value) {
  const normalized = normalizeText(value).toLocaleLowerCase().replace(/[!！。,.，?？\s]+/g, '')
  return [
    '\u7ee7\u7eed',
    '\u7ee7\u7eed\u6267\u884c',
    '\u7ee7\u7eed\u4efb\u52a1',
    '\u63a5\u7740\u505a',
    'continue',
    'resume',
    'goon',
  ].includes(normalized)
}

export function buildServerTurnResumeMeta(resolution) {
  return {
    streaming: true,
    paused: false,
    failed: false,
    serverConnectionState: 'reconnecting',
    directoryAuthorizationPending: true,
    directoryAuthorizationError: null,
    serverResumeResolution: resolution,
  }
}
