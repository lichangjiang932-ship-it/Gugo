/**
 * chatSlice — 聊天消息管理
 *
 * 参考 openhanako 的 chat-slice，管理消息、
 * 内容块、流式缓冲等。
 */

// Content block helpers
export function createTextBlock(html, source) {
  return { type: 'text', html, source };
}

export function createThinkingBlock(content, sealed = false) {
  return { type: 'thinking', content, sealed };
}

export function createMoodBlock(yuan, text) {
  return { type: 'mood', yuan, text };
}

export function createToolGroupBlock(tools, collapsed = false) {
  return { type: 'tool_group', tools, collapsed };
}

export function createFileBlock(fileId, filePath, label, ext, mime, kind, status = 'available') {
  return {
    type: 'file', fileId, filePath, label, ext, mime, kind, status,
  };
}

export function createArtifactBlock(artifactId, artifactType, title, content, language = null) {
  return {
    type: 'artifact', artifactId, artifactType, title, content, language,
  };
}

export function createMediaGenerationBlock(taskId, kind, status, prompt) {
  return {
    type: 'media_generation', taskId, kind, status, prompt,
  };
}

export function createScreenshotBlock(base64, mimeType = 'image/png') {
  return { type: 'screenshot', base64, mimeType };
}

export function createSkillBlock(skillName, skillFilePath) {
  return { type: 'skill', skillName, skillFilePath };
}

export function createSubagentBlock(taskId, task, taskTitle, agentName, streamStatus) {
  return {
    type: 'subagent', taskId, task, taskTitle, agentName, streamStatus,
  };
}

export const createChatSlice = (set, get) => ({
  // Messages by session
  messagesBySession: {},

  setSessionMessages: (sessionId, messages) => set(s => ({
    messagesBySession: { ...s.messagesBySession, [sessionId]: messages },
  })),

  appendMessage: (sessionId, message) => set(s => {
    const existing = s.messagesBySession[sessionId] || [];
    return {
      messagesBySession: { ...s.messagesBySession, [sessionId]: [...existing, message] },
    };
  }),

  updateMessage: (sessionId, messageId, updater) => set(s => {
    const messages = s.messagesBySession[sessionId] || [];
    return {
      messagesBySession: {
        ...s.messagesBySession,
        [sessionId]: messages.map(m => m.id === messageId ? updater(m) : m),
      },
    };
  }),

  deleteMessage: (sessionId, messageId) => set(s => {
    const messages = s.messagesBySession[sessionId] || [];
    return {
      messagesBySession: {
        ...s.messagesBySession,
        [sessionId]: messages.filter(m => m.id !== messageId),
      },
    };
  }),

  clearSessionMessages: (sessionId) => set(s => {
    const next = { ...s.messagesBySession };
    delete next[sessionId];
    return { messagesBySession: next };
  }),

  // Streaming buffer (non-persisted)
  streamBuffers: {},
  setStreamBuffer: (sessionId, buffer) => set(s => ({
    streamBuffers: { ...s.streamBuffers, [sessionId]: buffer },
  })),
  clearStreamBuffer: (sessionId) => set(s => {
    const next = { ...s.streamBuffers };
    delete next[sessionId];
    return { streamBuffers: next };
  }),

  // Quoted selections
  quotedSelections: [],
  setQuotedSelections: (selections) => set({ quotedSelections: selections }),
  addQuotedSelection: (selection) => set(s => ({
    quotedSelections: [...s.quotedSelections, selection],
  })),
  clearQuotedSelections: () => set({ quotedSelections: [] }),

  // Inline errors
  inlineErrors: {},
  setInlineError: (sessionId, error) => set(s => ({
    inlineErrors: { ...s.inlineErrors, [sessionId]: error },
  })),
  clearInlineError: (sessionId) => set(s => {
    const next = { ...s.inlineErrors };
    delete next[sessionId];
    return { inlineErrors: next };
  }),

  // Attached files
  attachedFiles: [],
  setAttachedFiles: (files) => set({ attachedFiles: files }),
  addAttachedFile: (file) => set(s => ({
    attachedFiles: [...s.attachedFiles, file].slice(0, 9), // max 9 files
  })),
  removeAttachedFile: (fileId) => set(s => ({
    attachedFiles: s.attachedFiles.filter(f => f.fileId !== fileId && f.path !== fileId),
  })),
  clearAttachedFiles: () => set({ attachedFiles: [] }),

  // Skills attached to input
  inputSkills: [],
  setInputSkills: (skills) => set({ inputSkills }),
  toggleInputSkill: (skill) => set(s => {
    const exists = s.inputSkills.includes(skill);
    return {
      inputSkills: exists
        ? s.inputSkills.filter(sk => sk !== skill)
        : [...s.inputSkills, skill],
    };
  }),

  // Agent mode (operate | ask | read_only)
  agentMode: 'ask',
  setAgentMode: (mode) => set({ agentMode: mode }),

  // Thinking level
  thinkingLevel: 'none',
  setThinkingLevel: (level) => set({ thinkingLevel: level }),
});
