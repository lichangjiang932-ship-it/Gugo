export function reduceMessageState(state, action) {
  switch (action.type) {
    case 'SEND_MESSAGE': {
      const payload = action.payload
      let content = typeof payload === 'string' ? payload : payload?.content ?? ''
      const msgAttachments = typeof payload === 'string' ? [] : payload?.attachments || []
      if (msgAttachments.length > 0) {
        const attachmentInfo = msgAttachments.map((a) => `[\u9644\u4ef6: ${a.name}, ${a.sizeKB} KB]`).join('\n')
        content = content ? `${content}\n\n${attachmentInfo}` : `\u8bf7\u5206\u6790\u9644\u4ef6：${msgAttachments.map((a) => a.name).join('、')}`
      }
      const targetSessionId = payload?.sessionId || state.activeSessionId
      if (!targetSessionId) return state

      const userMsg = {
        id: payload?.id || crypto.randomUUID?.() || `${Date.now()}-u`,
        role: 'user',
        content,
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

    case 'APPEND_REASONING_TO_LAST_MESSAGE': {
      const targetSessionId = action.sessionId || state.activeSessionId
      if (!targetSessionId) return state
      const delta = action.payload ?? ''
      if (!delta) return state
      return {
        ...state,
        sessions: state.sessions.map((s) => {
          if (s.id !== targetSessionId || s.messages.length === 0) return s
          const msgs = [...s.messages]
          const messageIndex = action.messageId ? msgs.findIndex((message) => message.id === action.messageId) : msgs.length - 1
          if (messageIndex < 0) return s
          const last = msgs[messageIndex]
          if (last.role !== 'assistant') return s
          const meta = last.meta || {}
          msgs[messageIndex] = {
            ...last,
            meta: { ...meta, reasoning: (meta.reasoning || '') + delta },
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
          msgs[messageIndex] = { ...last, content: last.content + delta }
          return { ...s, messages: msgs, updatedAt: Date.now() }
        }),
      }
    }

    case 'UPDATE_LAST_MESSAGE_META': {
      const targetSessionId = action.sessionId || state.activeSessionId
      if (!targetSessionId) return state
      const meta = action.payload ?? {}
      return {
        ...state,
        sessions: state.sessions.map((s) => {
          if (s.id !== targetSessionId || s.messages.length === 0) return s
          const msgs = [...s.messages]
          const messageIndex = action.messageId ? msgs.findIndex((message) => message.id === action.messageId) : msgs.length - 1
          if (messageIndex < 0) return s
          const last = msgs[messageIndex]
          if (last.role !== 'assistant') return s
          msgs[messageIndex] = { ...last, meta: { ...last.meta, ...meta } }
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
          const existingMeta = last.meta || {}
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
          msgs[messageIndex] = { ...last, meta: { ...existingMeta, toolCalls: nextCalls } }
          return { ...s, messages: msgs, updatedAt: Date.now() }
        }),
      }
    }

    default:
      return null
  }
}
