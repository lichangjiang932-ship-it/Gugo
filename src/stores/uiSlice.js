/**
 * uiSlice — UI 状态管理
 *
 * 参考 openhanako 的 ui-slice，管理全局 UI 状态：
 * - sidebar 开关
 * - preview 面板开关
 * - welcome 页面显示
 * - 连接状态
 * - 当前标签页
 */

export const createUiSlice = (set, get) => ({
  // Sidebar
  sidebarOpen: true,
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  toggleSidebar: () => set(s => ({ sidebarOpen: !s.sidebarOpen })),

  // Preview Panel
  previewOpen: false,
  setPreviewOpen: (open) => set({ previewOpen: open }),
  togglePreview: () => set(s => ({ previewOpen: !s.previewOpen })),

  // Welcome Screen
  welcomeVisible: true,
  setWelcomeVisible: (visible) => set({ welcomeVisible: visible }),

  // Connection
  connected: false,
  setConnected: (connected) => set({ connected }),

  // Active Tab
  currentTab: 'chat',
  setCurrentTab: (tab) => set({ currentTab: tab }),

  // Theme
  theme: 'system',
  setTheme: (theme) => set({ theme }),

  // Agent selector
  selectedAgentId: null,
  setSelectedAgentId: (id) => set({ selectedAgentId: id }),

  // Active Panel (activity | bridge | automation | null)
  activePanel: null,
  setActivePanel: (panel) => set({ activePanel: panel }),

  // Streaming sessions
  streamingSessions: [],
  setStreamingSessions: (sessions) => set({ streamingSessions: sessions }),
  addStreamingSession: (sessionId) => set(s => ({
    streamingSessions: [...s.streamingSessions, sessionId],
  })),
  removeStreamingSession: (sessionId) => set(s => ({
    streamingSessions: s.streamingSessions.filter(id => id !== sessionId),
  })),

  // Global shortcuts
  showShortcuts: false,
  setShowShortcuts: (show) => set({ showShortcuts: show }),

  // Settings modal
  settingsOpen: false,
  setSettingsOpen: (open) => set({ settingsOpen: open }),

  // Memory
  memoryEnabled: true,
  setMemoryEnabled: (enabled) => set({ memoryEnabled: enabled }),
});
