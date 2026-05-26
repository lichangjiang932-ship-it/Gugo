/**
 * agentSlice — Agent 配置管理
 *
 * 参考 openhanako 的 agent-slice，管理多 Agent 系统。
 */

export const createAgentSlice = (set) => ({
  // Current agent info
  agentName: 'AI 助手',
  agentYuan: 'default',
  agentAvatarUrl: null,
  userName: 'User',
  userAvatarUrl: null,
  memoryMasterEnabled: true,

  setAgentName: (name) => set({ agentName: name }),
  setAgentYuan: (yuan) => set({ agentYuan: yuan }),
  setAgentAvatarUrl: (url) => set({ agentAvatarUrl: url }),
  setUserName: (name) => set({ userName: name }),
  setUserAvatarUrl: (url) => set({ userAvatarUrl: url }),
  setMemoryMasterEnabled: (enabled) => set({ memoryMasterEnabled: enabled }),

  // Multiple agents
  agents: [],
  setAgents: (agents) => set({ agents }),
  currentAgentId: null,
  setCurrentAgentId: (id) => set({ currentAgentId: id }),

  // Models
  models: [],
  setModels: (models) => set({ models }),
  currentModel: null,
  setCurrentModel: (model) => set({ currentModel: model }),

  // Skills
  installedSkills: [],
  setInstalledSkills: (skills) => set({ installedSkills: skills }),

  // Todos
  todos: [],
  setTodos: (todos) => set({ todos }),
  addTodo: (todo) => set(s => ({ todos: [...s.todos, todo] })),
  updateTodo: (id, updater) => set(s => ({
    todos: s.todos.map(t => t.id === id ? { ...t, ...updater } : t),
  })),
});
