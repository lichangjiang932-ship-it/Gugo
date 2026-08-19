import { TOOL_LIVE_OUTPUT_CHAR_LIMIT } from '../../lib/turnClient/toolOutputBuffer.js'
import { removeVerifiedLocalFilesFromRetained } from '../../lib/localFileReferences.js'
import { TOOL_CALL_STATUS } from '../taskStatus.js'

function applyStreamCursor(message, action) {
  const meta = message.meta || {}
  if (action.transientTurnActivity) {
    if (action.serverTurnId && meta.serverTurnId && action.serverTurnId !== meta.serverTurnId) {
      return { ignored: true, meta }
    }
    if (meta.streaming === false) return { ignored: true, meta }
  }
  if (!Number.isInteger(action.serverSequence)) return { ignored: false, meta }
  if (action.serverTurnId && meta.serverTurnId && action.serverTurnId !== meta.serverTurnId) {
    return { ignored: true, meta }
  }
  if (Number.isInteger(meta.serverLastSequence) && action.serverSequence <= meta.serverLastSequence) {
    return { ignored: true, meta }
  }
  return {
    ignored: false,
    meta: {
      ...meta,
      ...(action.serverTurnId ? { serverTurnId: action.serverTurnId } : {}),
      serverLastSequence: action.serverSequence,
    },
  }
}

function finalizeRunningToolCalls(meta, finalizer) {
  if (!finalizer) return meta
  const status = finalizer.status === TOOL_CALL_STATUS.ERROR
    ? TOOL_CALL_STATUS.ERROR
    : TOOL_CALL_STATUS.CANCELLED
  const calls = Array.isArray(meta.toolCalls) ? meta.toolCalls : []
  let changed = false
  const toolCalls = calls.map((call) => {
    if (call?.status !== TOOL_CALL_STATUS.RUNNING) return call
    changed = true
    return {
      ...call,
      status,
      ...(status === TOOL_CALL_STATUS.ERROR
        ? {
            error: finalizer.error || call.error || 'Turn ended before the tool returned a result',
            errorCode: finalizer.errorCode || call.errorCode || 'TURN_TERMINATED',
          }
        : {}),
    }
  })
  return changed ? { ...meta, toolCalls } : meta
}

export function reduceMessageState(state, action) {
  switch (action.type) {
    case 'SEND_MESSAGE': {
      const payload = action.payload
      const content = typeof payload === 'string' ? payload : payload?.content ?? ''
      const msgAttachments = typeof payload === 'string' ? [] : payload?.attachments || []
      const safeAttachments = msgAttachments.filter((item) => item?.id).map((item) => ({
        id: String(item.id),
        name: String(item.name || 'attachment').split(/[\\/]/).pop(),
        mimeType: String(item.mimeType || 'application/octet-stream'),
        size: Math.max(0, Number(item.size) || 0),
        sha256: String(item.sha256 || ''),
        downloadUrl: String(item.downloadUrl || ''),
      }))
      const targetSessionId = payload?.sessionId || state.activeSessionId
      if (!targetSessionId) return state

      const userMsg = {
        id: payload?.id || crypto.randomUUID?.() || `${Date.now()}-u`,
        role: 'user',
        content,
        attachments: safeAttachments,
        meta: { pendingServerSync: true },
        timestamp: Date.now(),
      }

      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === targetSessionId
            ? { ...s, messages: [...s.messages, userMsg], updatedAt: Date.now() }
            : s
        ),
      }
    }

    case 'INSERT_STEERING_MESSAGE': {
      const payload = action.payload || {}
      const targetSessionId = payload.sessionId || state.activeSessionId
      const content = String(payload.content || '').trim()
      const id = String(payload.id || '').trim()
      const clientRequestId = String(payload.clientRequestId || '').trim()
      if (!targetSessionId || !content || !id || !clientRequestId) return state

      return {
        ...state,
        sessions: state.sessions.map((session) => {
          if (session.id !== targetSessionId) return session
          const duplicate = session.messages.some((message) => (
            message.id === id
              || message?.meta?.steeringClientRequestId === clientRequestId
          ))
          if (duplicate) return session
          let assistantIndex = payload.beforeMessageId
            ? session.messages.findIndex((message) => message.id === payload.beforeMessageId)
            : -1
          if (assistantIndex < 0) {
            assistantIndex = session.messages.findLastIndex((message) => (
              message?.role === 'assistant'
                && message?.meta?.serverTurnId === payload.turnId
            ))
          }
          if (assistantIndex < 0) return session
          const messages = [...session.messages]
          messages.splice(assistantIndex, 0, {
            id,
            role: 'user',
            content,
            meta: {
              pendingServerSync: true,
              steering: true,
              steeringClientRequestId: clientRequestId,
              serverTurnId: payload.turnId || null,
            },
            timestamp: Number(payload.createdAt) || Date.now(),
          })
          return { ...session, messages, updatedAt: Date.now() }
        }),
      }
    }

    case 'RECEIVE_MESSAGE': {
      const content =
        typeof action.payload === 'string'
          ? action.payload
          : action.payload?.content ?? ''
      const meta = typeof action.payload === 'object' ? action.payload?.meta ?? null : null
      const targetSessionId = action.payload?.sessionId || state.activeSessionId
      if (!targetSessionId) return state

      const assistantMsg = {
        id: action.payload?.id || crypto.randomUUID?.() || `${Date.now() + 1}-a`,
        role: 'assistant',
        content,
        meta,
        timestamp: Date.now() + 1,
      }

      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === targetSessionId
            ? { ...s, messages: [...s.messages, assistantMsg], updatedAt: Date.now() }
            : s
        ),
      }
    }

    case 'RESET_LAST_MESSAGE_STREAM': {
      const targetSessionId = action.sessionId || state.activeSessionId
      if (!targetSessionId) return state
      return {
        ...state,
        sessions: state.sessions.map((session) => {
          if (session.id !== targetSessionId || session.messages.length === 0) return session
          const messages = [...session.messages]
          const messageIndex = action.messageId
            ? messages.findIndex((message) => message.id === action.messageId)
            : messages.length - 1
          if (messageIndex < 0 || messages[messageIndex].role !== 'assistant') return session
          const message = messages[messageIndex]
          const cursor = applyStreamCursor(message, action)
          if (cursor.ignored) return session
          messages[messageIndex] = {
            ...message,
            content: String(action.payload?.content || ''),
            meta: {
              ...cursor.meta,
              ...(action.meta || {}),
              reasoning: String(action.payload?.reasoning || ''),
            },
          }
          return { ...session, messages, updatedAt: Date.now() }
        }),
      }
    }

    case 'APPEND_REASONING_TO_LAST_MESSAGE': {
      const targetSessionId = action.sessionId || state.activeSessionId
      if (!targetSessionId) return state
      const delta = action.payload ?? ''
      if (!delta && !Number.isInteger(action.serverSequence)) return state
      return {
        ...state,
        sessions: state.sessions.map((s) => {
          if (s.id !== targetSessionId || s.messages.length === 0) return s
          const msgs = [...s.messages]
          const messageIndex = action.messageId ? msgs.findIndex((message) => message.id === action.messageId) : msgs.length - 1
          if (messageIndex < 0) return s
          const last = msgs[messageIndex]
          if (last.role !== 'assistant') return s
          const cursor = applyStreamCursor(last, action)
          if (cursor.ignored) return s
          msgs[messageIndex] = {
            ...last,
            meta: {
              ...cursor.meta,
              ...(action.meta || {}),
              reasoning: (cursor.meta.reasoning || '') + delta,
            },
          }
          return { ...s, messages: msgs, updatedAt: Date.now() }
        }),
      }
    }

    case 'APPEND_TO_LAST_MESSAGE': {
      const targetSessionId = action.sessionId || state.activeSessionId
      if (!targetSessionId) return state
      const delta = action.payload ?? ''
      return {
        ...state,
        sessions: state.sessions.map((s) => {
          if (s.id !== targetSessionId || s.messages.length === 0) return s
          const msgs = [...s.messages]
          const messageIndex = action.messageId ? msgs.findIndex((message) => message.id === action.messageId) : msgs.length - 1
          if (messageIndex < 0) return s
          const last = msgs[messageIndex]
          if (last.role !== 'assistant') return s
          const failureDisplayKey = String(action.meta?.serverFailureDisplayKey || '').trim()
          if (failureDisplayKey && last.meta?.serverFailureDisplayKey === failureDisplayKey) return s
          const cursor = applyStreamCursor(last, action)
          if (cursor.ignored) return s
          msgs[messageIndex] = {
            ...last,
            content: (last.content || '') + delta,
            meta: { ...cursor.meta, ...(action.meta || {}) },
          }
          return { ...s, messages: msgs, updatedAt: Date.now() }
        }),
      }
    }

    case 'UPDATE_LAST_MESSAGE_META': {
      const targetSessionId = action.sessionId || state.activeSessionId
      if (!targetSessionId) return state
      const { finalizeRunningToolCalls: finalizer = null, ...meta } = action.payload ?? {}
      return {
        ...state,
        sessions: state.sessions.map((s) => {
          if (s.id !== targetSessionId || s.messages.length === 0) return s
          const msgs = [...s.messages]
          const messageIndex = action.messageId ? msgs.findIndex((message) => message.id === action.messageId) : msgs.length - 1
          if (messageIndex < 0) return s
          const last = msgs[messageIndex]
          if (last.role !== 'assistant') return s
          const cursor = applyStreamCursor(last, action)
          if (cursor.ignored) return s
          const finalizedMeta = finalizeRunningToolCalls({ ...cursor.meta, ...meta }, finalizer)
          const nextMeta = Object.hasOwn(finalizedMeta, 'retainedLocalFiles')
            ? {
                ...finalizedMeta,
                retainedLocalFiles: removeVerifiedLocalFilesFromRetained(
                  finalizedMeta.retainedLocalFiles,
                  finalizedMeta.verifiedLocalFiles,
                ),
              }
            : finalizedMeta
          msgs[messageIndex] = { ...last, meta: nextMeta }
          return { ...s, messages: msgs, updatedAt: Date.now() }
        }),
      }
    }

    case 'APPEND_TOOL_CALL_TO_LAST_MESSAGE': {
      // payload: { id, name, arguments, status, result, error, approvalAuthorization }
      const targetSessionId = action.sessionId || state.activeSessionId
      if (!targetSessionId) return state
      const entry = action.payload
      if (!entry) return state
      return {
        ...state,
        sessions: state.sessions.map((s) => {
          if (s.id !== targetSessionId || s.messages.length === 0) return s
          const msgs = [...s.messages]
          const messageIndex = action.messageId ? msgs.findIndex((message) => message.id === action.messageId) : msgs.length - 1
          if (messageIndex < 0) return s
          const last = msgs[messageIndex]
          if (last.role !== 'assistant') return s
          const cursor = applyStreamCursor(last, action)
          if (cursor.ignored) return s
          const existingMeta = cursor.meta
          const existingCalls = Array.isArray(existingMeta.toolCalls) ? existingMeta.toolCalls : []
          const idx = existingCalls.findIndex((c) => c.id === entry.id)
          let nextCalls
          if (idx === -1) {
            // ★ \u8bb0\u4e0b\u8fd9\u6b21\u5de5\u5177\u8c03\u7528\u53d1\u751f\u65f6\u6b63\u6587\u5df2\u7ecf\u5199\u5230\u54ea —— \u6709\u4e86\u8fd9\u4e2a\u951a\u70b9,
            // \u6e32\u67d3\u65f6\u624d\u80fd\u628a「\u8bf4\u7684\u8bdd」\u548c「\u505a\u7684\u4e8b」\u6309\u771f\u5b9e\u5148\u540e\u987a\u5e8f\u4ea4\u9519\u6392\u5217。
            // \u4ee5\u524d\u53ea\u5b58\u4e00\u4e2a toolCalls \u6570\u7ec4,\u6e32\u67d3\u53ea\u80fd\u6574\u5757\u5806\u5728\u6b63\u6587\u524d\u9762,
            // \u7528\u6237\u8bfb\u8d77\u6765\u5c31\u662f「\u5148\u7ed9\u7ed3\u8bba\u540e\u5e72\u6d3b」,\u987a\u5e8f\u662f\u53cd\u7684。
            nextCalls = [...existingCalls, { ...entry, textOffset: (last.content || '').length }]
          } else {
            nextCalls = existingCalls.slice()
            nextCalls[idx] = { ...nextCalls[idx], ...entry }
          }
          msgs[messageIndex] = {
            ...last,
            meta: { ...existingMeta, ...(action.meta || {}), toolCalls: nextCalls },
          }
          return { ...s, messages: msgs, updatedAt: Date.now() }
        }),
      }
    }

    case 'APPEND_TOOL_CALL_OUTPUT': {
      // payload: { id, name, chunk, stream }
      const targetSessionId = action.sessionId || state.activeSessionId
      if (!targetSessionId) return state
      const entry = action.payload
      if (!entry || typeof entry.chunk !== 'string' || !entry.chunk) return state
      return {
        ...state,
        sessions: state.sessions.map((s) => {
          if (s.id !== targetSessionId || s.messages.length === 0) return s
          const msgs = [...s.messages]
          const messageIndex = action.messageId ? msgs.findIndex((message) => message.id === action.messageId) : msgs.length - 1
          if (messageIndex < 0) return s
          const last = msgs[messageIndex]
          if (last.role !== 'assistant') return s
          const existingMeta = last.meta || {}
          const existingCalls = Array.isArray(existingMeta.toolCalls) ? existingMeta.toolCalls : []
          const idx = existingCalls.findIndex((c) => c.id === entry.id)
          if (idx === -1) return s
          const nextCalls = existingCalls.slice()
          const existing = nextCalls[idx]
          if (existing?.status !== TOOL_CALL_STATUS.RUNNING) return s
          const appended = `${existing.liveOutput || ''}${entry.chunk}`
          nextCalls[idx] = {
            ...existing,
            liveOutput: appended.length > TOOL_LIVE_OUTPUT_CHAR_LIMIT
              ? appended.slice(-TOOL_LIVE_OUTPUT_CHAR_LIMIT)
              : appended,
            liveStream: entry.stream || existing.liveStream || 'stdout',
          }
          msgs[messageIndex] = { ...last, meta: { ...existingMeta, toolCalls: nextCalls } }
          return { ...s, messages: msgs, updatedAt: Date.now() }
        }),
      }
    }

    case 'FINALIZE_RUNNING_TOOL_CALLS': {
      const targetSessionId = action.sessionId || state.activeSessionId
      if (!targetSessionId) return state
      const status = action.payload?.status === TOOL_CALL_STATUS.ERROR
        ? TOOL_CALL_STATUS.ERROR
        : TOOL_CALL_STATUS.CANCELLED
      return {
        ...state,
        sessions: state.sessions.map((session) => {
          if (session.id !== targetSessionId || session.messages.length === 0) return session
          const messages = [...session.messages]
          const messageIndex = action.messageId
            ? messages.findIndex((message) => message.id === action.messageId)
            : messages.length - 1
          if (messageIndex < 0) return session
          const message = messages[messageIndex]
          if (message.role !== 'assistant') return session
          const meta = message.meta || {}
          const calls = Array.isArray(meta.toolCalls) ? meta.toolCalls : []
          let changed = false
          const nextCalls = calls.map((call) => {
            if (call?.status !== TOOL_CALL_STATUS.RUNNING) return call
            changed = true
            return {
              ...call,
              status,
              ...(status === TOOL_CALL_STATUS.ERROR
                ? {
                    error: action.payload?.error || call.error || 'Turn ended before the tool returned a result',
                    errorCode: action.payload?.errorCode || call.errorCode || 'TURN_TERMINATED',
                  }
                : {}),
            }
          })
          if (!changed) return session
          messages[messageIndex] = { ...message, meta: { ...meta, toolCalls: nextCalls } }
          return { ...session, messages, updatedAt: Date.now() }
        }),
      }
    }

    default:
      return null
  }
}
