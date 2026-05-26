/**
 * engineSlice — Hanako Engine 前端适配层
 *
 * 模拟 openhanako 的 HanaEngine，管理所有子系统：
 * - AgentManager: agent CRUD / init / switch
 * - SessionCoordinator: session 生命周期
 * - SkillManager: 技能注册/同步
 * - ConfigCoordinator: 配置读写/模型
 * - 工具系统注册表
 */

// 工具注册表 - 模拟 openhanako 的 20+ 工具
const TOOL_REGISTRY = {
  web_search: {
    name: 'web_search',
    description: '搜索互联网获取最新信息',
    category: 'search',
    requiresGrant: false,
    params: { query: 'string', count: 'number?' },
  },
  web_fetch: {
    name: 'web_fetch',
    description: '抓取指定URL的网页内容',
    category: 'search',
    requiresGrant: false,
    params: { url: 'string', extractText: 'boolean?' },
  },
  web_reader: {
    name: 'web_reader',
    description: '智能读取网页内容，提取关键信息',
    category: 'search',
    requiresGrant: false,
    params: { url: 'string' },
  },
  browser: {
    name: 'browser',
    description: '控制浏览器进行网页操作',
    category: 'browser',
    requiresGrant: true,
    params: { action: 'string', url: 'string?', evaluate: 'string?' },
    actions: ['start', 'stop', 'navigate', 'snapshot', 'screenshot', 'click', 'type', 'scroll', 'evaluate', 'show'],
  },
  computer_use: {
    name: 'computer_use',
    description: '控制计算机进行屏幕操作',
    category: 'computer',
    requiresGrant: true,
    params: { action: 'string', x: 'number?', y: 'number?', text: 'string?' },
    actions: ['screenshot', 'click', 'type', 'scroll', 'key', 'wait'],
  },
  terminal: {
    name: 'terminal',
    description: '执行终端命令',
    category: 'system',
    requiresGrant: true,
    params: { command: 'string', cwd: 'string?' },
  },
  todo: {
    name: 'todo',
    description: '管理待办事项列表',
    category: 'productivity',
    requiresGrant: false,
    params: { action: 'string', items: 'string[]?' },
    actions: ['create', 'add', 'complete', 'list', 'clear'],
  },
  cron: {
    name: 'cron',
    description: '创建定时任务',
    category: 'automation',
    requiresGrant: true,
    params: { schedule: 'string', command: 'string', description: 'string?' },
  },
  automation: {
    name: 'automation',
    description: '创建自动化工作流',
    category: 'automation',
    requiresGrant: true,
    params: { trigger: 'string', actions: 'object[]' },
  },
  stage_files: {
    name: 'stage_files',
    description: '生成输出文件',
    category: 'file',
    requiresGrant: false,
    params: { files: 'object[]' },
  },
  artifact: {
    name: 'artifact',
    description: '创建代码片段/可运行组件',
    category: 'code',
    requiresGrant: false,
    params: { type: 'string', title: 'string', content: 'string', language: 'string?' },
  },
  install_skill: {
    name: 'install_skill',
    description: '安装用户技能',
    category: 'skill',
    requiresGrant: true,
    params: { skill_content: 'string', skill_name: 'string' },
  },
  subagent: {
    name: 'subagent',
    description: '委派任务给其他Agent',
    category: 'agent',
    requiresGrant: true,
    params: { agentId: 'string', task: 'string' },
  },
  wait: {
    name: 'wait',
    description: '等待指定时间',
    category: 'utility',
    requiresGrant: false,
    params: { seconds: 'number', reason: 'string?' },
  },
  notify: {
    name: 'notify',
    description: '发送系统通知',
    category: 'utility',
    requiresGrant: false,
    params: { message: 'string', type: 'string?' },
  },
  check_deferred: {
    name: 'check_deferred',
    description: '检查延迟任务状态',
    category: 'utility',
    requiresGrant: false,
    params: { taskId: 'string' },
  },
  current_status: {
    name: 'current_status',
    description: '获取当前Agent状态',
    category: 'utility',
    requiresGrant: false,
    params: {},
  },
  update_settings: {
    name: 'update_settings',
    description: '更新系统设置',
    category: 'system',
    requiresGrant: true,
    params: { key: 'string', value: 'string' },
  },
  stop_task: {
    name: 'stop_task',
    description: '停止正在执行的任务',
    category: 'system',
    requiresGrant: false,
    params: { taskId: 'string?' },
  },
  media_details: {
    name: 'media_details',
    description: '获取媒体文件详细信息',
    category: 'media',
    requiresGrant: false,
    params: { fileId: 'string' },
  },
};

// 技能注册表 - 模拟 openhanako 的技能系统
const SKILL_REGISTRY = {
  'skill-creator': {
    name: 'skill-creator',
    description: '从对话中提取并创建可复用技能',
    source: 'builtin',
    version: '1.0.0',
    commands: ['/xing'],
  },
  'web-search-pro': {
    name: 'web-search-pro',
    description: '高级网页搜索，支持多引擎聚合',
    source: 'builtin',
    version: '1.0.0',
  },
  'code-reviewer': {
    name: 'code-reviewer',
    description: '代码审查，检查质量、安全、性能',
    source: 'builtin',
    version: '1.0.0',
  },
  'data-analyst': {
    name: 'data-analyst',
    description: '数据分析，统计、可视化、洞察',
    source: 'builtin',
    version: '1.0.0',
  },
  'doc-writer': {
    name: 'doc-writer',
    description: '文档写作，技术文档、API文档',
    source: 'builtin',
    version: '1.0.0',
  },
  'translator': {
    name: 'translator',
    description: '多语言翻译，支持语境感知',
    source: 'builtin',
    version: '1.0.0',
  },
  'image-prompt': {
    name: 'image-prompt',
    description: '生成AI绘画提示词',
    source: 'builtin',
    version: '1.0.0',
  },
  'deep-research': {
    name: 'deep-research',
    description: '深度研究，多轮搜索综合分析',
    source: 'builtin',
    version: '1.0.0',
  },
};

// Agent 配置模板
const DEFAULT_AGENT_CONFIG = {
  id: 'default',
  name: 'AI 助手',
  yuan: 'default',
  avatar: null,
  userName: 'User',
  memory: {
    enabled: true,
    masterEnabled: true,
  },
  experience: {
    enabled: true,
  },
  chatModel: null,
  homeFolder: null,
  skills: [],
};

export const createEngineSlice = (set, get) => ({
  // ═══════════════════════════════════════════
  // Engine 核心状态
  // ═══════════════════════════════════════════

  // 工具注册表
  toolRegistry: { ...TOOL_REGISTRY },
  availableTools: Object.keys(TOOL_REGISTRY),
  enabledTools: Object.keys(TOOL_REGISTRY).filter(k => !TOOL_REGISTRY[k].requiresGrant),

  // 技能注册表
  skillRegistry: { ...SKILL_REGISTRY },
  installedSkills: [],
  skillBundles: [],

  // Agent 管理
  agents: [{ ...DEFAULT_AGENT_CONFIG }],
  currentAgentId: 'default',

  // 引擎状态
  engineStatus: 'ready', // 'ready' | 'initializing' | 'error'
  engineVersion: '0.240.7',

  // ═══════════════════════════════════════════
  // Engine Actions
  // ═══════════════════════════════════════════

  // 工具管理
  setToolEnabled: (toolName, enabled) => set(s => ({
    enabledTools: enabled
      ? [...s.enabledTools, toolName]
      : s.enabledTools.filter(t => t !== toolName),
  })),

  getToolSchema: (toolName) => {
    const tool = get().toolRegistry[toolName];
    return tool || null;
  },

  listToolsByCategory: (category) => {
    const tools = get().toolRegistry;
    return Object.values(tools).filter(t => t.category === category);
  },

  // 技能管理
  installSkill: (skillData) => set(s => {
    const exists = s.installedSkills.find(sk => sk.name === skillData.name);
    if (exists) {
      return {
        installedSkills: s.installedSkills.map(sk =>
          sk.name === skillData.name ? { ...sk, ...skillData, updatedAt: Date.now() } : sk
        ),
      };
    }
    return {
      installedSkills: [...s.installedSkills, { ...skillData, installedAt: Date.now() }],
    };
  }),

  uninstallSkill: (skillName) => set(s => ({
    installedSkills: s.installedSkills.filter(sk => sk.name !== skillName),
  })),

  enableSkillForAgent: (skillName, agentId) => set(s => ({
    agents: s.agents.map(a =>
      a.id === agentId
        ? { ...a, skills: [...(a.skills || []), skillName] }
        : a
    ),
  })),

  // Agent 管理
  createAgent: (config) => set(s => {
    const id = config.id || `agent-${Date.now()}`;
    const newAgent = { ...DEFAULT_AGENT_CONFIG, ...config, id };
    return {
      agents: [...s.agents, newAgent],
      currentAgentId: id,
    };
  }),

  switchAgent: (agentId) => set({ currentAgentId: agentId }),

  updateAgentConfig: (agentId, updates) => set(s => ({
    agents: s.agents.map(a =>
      a.id === agentId ? { ...a, ...updates } : a
    ),
  })),

  // 获取当前 Agent 配置
  getCurrentAgent: () => {
    const state = get();
    return state.agents.find(a => a.id === state.currentAgentId) || state.agents[0];
  },

  // 记忆管理
  memoryEnabled: true,
  setMemoryEnabled: (enabled) => set({ memoryEnabled: enabled }),

  experienceEnabled: true,
  setExperienceEnabled: (enabled) => set({ experienceEnabled: enabled }),

  // 引擎控制
  setEngineStatus: (status) => set({ engineStatus: status }),

  // 获取完整引擎状态报告
  getEngineStatus: () => {
    const state = get();
    return {
      version: state.engineVersion,
      status: state.engineStatus,
      currentAgent: state.currentAgentId,
      agentsCount: state.agents.length,
      toolsAvailable: Object.keys(state.toolRegistry).length,
      toolsEnabled: state.enabledTools.length,
      skillsInstalled: state.installedSkills.length,
      memoryEnabled: state.memoryEnabled,
      experienceEnabled: state.experienceEnabled,
    };
  },

  // ═══════════════════════════════════════════
  // Hanako 特有功能
  // ═══════════════════════════════════════════

  // Desk 工作台状态
  deskBasePath: '',
  deskFiles: [],
  deskExpandedPaths: [],
  setDeskBasePath: (path) => set({ deskBasePath: path }),
  setDeskFiles: (files) => set({ deskFiles: files }),

  // 浏览器状态
  browserRunning: false,
  browserUrl: null,
  browserThumbnail: null,
  setBrowserRunning: (running) => set({ browserRunning: running }),
  setBrowserUrl: (url) => set({ browserUrl: url }),

  // 计算机视觉状态
  computerOverlay: null,
  setComputerOverlay: (overlay) => set({ computerOverlay: overlay }),

  // CRON 任务
  cronJobs: [],
  setCronJobs: (jobs) => set({ cronJobs: jobs }),
  addCronJob: (job) => set(s => ({ cronJobs: [...s.cronJobs, job] })),

  // 自动化工作流
  automations: [],
  setAutomations: (automations) => set({ automations }),

  // 桥接状态
  bridgeConnected: false,
  bridgePlatforms: [],
  setBridgeConnected: (connected) => set({ bridgeConnected: connected }),

  // 频道状态
  channels: [],
  currentChannel: null,
  setChannels: (channels) => set({ channels }),
  setCurrentChannel: (channel) => set({ currentChannel: channel }),

  // 插件状态
  plugins: [],
  setPlugins: (plugins) => set({ plugins }),

  // 活动追踪
  activities: [],
  addActivity: (activity) => set(s => ({
    activities: [activity, ...s.activities].slice(0, 100),
  })),

  // 选择/引用
  quotedSelections: [],
  addQuotedSelection: (selection) => set(s => ({
    quotedSelections: [...s.quotedSelections, selection],
  })),
  clearQuotedSelections: () => set({ quotedSelections: [] }),

  // 上下文用量
  contextTokens: null,
  contextWindow: null,
  contextPercent: null,
  setContextUsage: (tokens, window, percent) => set({
    contextTokens: tokens,
    contextWindow: window,
    contextPercent: percent,
  }),

  // 截图进度
  screenshotProgress: null,
  setScreenshotProgress: (progress) => set({ screenshotProgress: progress }),
});
