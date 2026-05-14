export const USER = {
  name: '未登录',
  handle: '',
  email: '',
  avatar: '',
  plan: '',
  joinedAt: '',
  totalCalls: 0,
}

export const SESSIONS = {
  today: [],
  week: [],
}

export const CURRENT_MESSAGES = []
export const CURRENT_TASKS = []
export const HISTORY = []

export const SKILLS = [
  {
    id: 'ppt',
    icon: '📊',
    name: '制作 PPT',
    desc: '根据主题、资料或大纲生成演示文稿内容',
    perms: ['内容生成'],
    recommended: true,
    systemPrompt:
      '你是一位专业的演示文稿设计师。请根据用户提供的主题、资料或大纲，生成结构清晰、可直接导出为 PPTX 的幻灯片内容。只输出 Markdown 幻灯片正文，不要写额外说明。每页必须用单独一行 --- 分隔；每页第一行是标题，后续用短句或项目符号表达要点。内容应包含标题页、目录页、核心分析页、图表建议页和结束页。',
  },
  {
    id: 'doc',
    icon: '📑',
    name: '整理文档',
    desc: '摘要、润色、改写、结构梳理',
    perms: ['内容生成'],
    recommended: true,
    systemPrompt:
      '你是一位文档整理专家。请根据用户提供的文本或附件内容，完成摘要、润色、改写、结构梳理、会议纪要或正式文档草稿。输出要清晰、专业、便于直接使用。',
  },
  {
    id: 'excel',
    icon: '📈',
    name: '分析表格',
    desc: '基于上传的 CSV/文本表格做分析和公式建议',
    perms: ['内容分析'],
    systemPrompt:
      '你是一位数据分析助手。请根据用户粘贴或上传的 CSV、表格文本、数据描述，进行数据清洗建议、公式建议、图表建议、异常说明和分析报告。不要声称已经直接操作本地 Excel 文件。',
  },
  {
    id: 'mail',
    icon: '✉️',
    name: '邮件起草',
    desc: '根据要点生成邮件草稿',
    perms: ['内容生成'],
    systemPrompt:
      '你是一位商务写作专家。请根据用户提供的要点，生成得体、专业、符合商务礼仪的邮件草稿。包含称呼、正文结构和礼貌结尾。不要声称已经发送邮件。',
  },
  {
    id: 'finance',
    icon: '🧮',
    name: '财务分析',
    desc: '基于上传文本或表格做核对分析',
    perms: ['内容分析'],
    systemPrompt:
      '你是一位财务分析助手。请根据用户提供的表格文本、凭证摘要或附件内容，进行核对思路、差异分析、异常项标记和报告草稿。不要声称已经直接读取或修改本地财务文件。',
  },
]

export const DEFAULT_SKILL_CONFIGS = {}
SKILLS.forEach((skill) => {
  DEFAULT_SKILL_CONFIGS[skill.id] = {
    enabled: true,
    systemPrompt: skill.systemPrompt,
    temperature: null,
    maxTokens: null,
  }
})

export function getSkillSystemPrompt(skillId, skillConfigs) {
  const cfg = skillConfigs?.[skillId]
  if (cfg?.systemPrompt != null) return cfg.systemPrompt
  const skill = SKILLS.find((item) => item.id === skillId)
  return skill?.systemPrompt || ''
}

export function getSkillEffectiveConfig(skillId, skillConfigs) {
  const skill = SKILLS.find((item) => item.id === skillId)
  const cfg = skillConfigs?.[skillId] || {}
  return {
    enabled: cfg.enabled !== false,
    systemPrompt: cfg.systemPrompt ?? skill?.systemPrompt ?? '',
    temperature: cfg.temperature ?? null,
    maxTokens: cfg.maxTokens ?? null,
  }
}

export const PERMISSIONS = [
  {
    id: 'mic',
    name: '麦克风输入',
    code: 'MIC',
    scope: '浏览器语音识别',
    enabled: false,
    usage: '本地开关',
  },
  {
    id: 'notify',
    name: '浏览器通知',
    code: 'PUSH',
    scope: '任务完成提醒',
    enabled: false,
    usage: '本地开关',
  },
]

export const TASK_STEPS = []

export const QUICK_ACTIONS = [
  { icon: '📊', name: '制作 PPT', active: true },
  { icon: '📑', name: '整理文档', active: false },
  { icon: '📈', name: '分析表格', active: false },
]

export const PERM_REQUEST = null

export const REMOTE_STATE = {
  deviceName: null,
  userName: null,
  connectionType: null,
  activeTask: null,
  taskProgress: 0,
  taskStep: null,
  stats: {
    tasks: 0,
    remaining: '无',
    permsUsed: 0,
    transferred: '0 KB',
  },
}

export const SETTINGS_NAV = [
  '账户',
  '权限中心',
  '外观',
  '快捷键',
  '数据 & 导出',
]
