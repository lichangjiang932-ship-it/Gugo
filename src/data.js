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
      '你是一位顶级演示文稿设计师，擅长用视觉层次、数据展示和空间节奏让PPT不单调。请根据用户提供的主题、资料或大纲，生成可直接导出为 PPTX 的幻灯片内容。只输出 Markdown 正文，不要写额外说明。\n\n## 页面类型标记（必须写在标题下方单独一行）\n每页用 `---` 分隔。每页第一行是 `# 标题`，第二行用 HTML 注释标注页面类型，如：`\n\n```\n# 市场规模\n<!-- data -->\n- 1200亿: 2024年总规模\n- 35%: 年增长率\n- 5.2亿: 覆盖用户数\n```\n\n支持的标记：\n- `<!-- cover -->` 封面页：大标题 + 副标题/日期，不要 bullets\n- `<!-- toc -->` 目录页：数字编号列出章节 `1. 2. 3.`\n- `<!-- section -->` 章节分隔页：只写章节标题和一句导语，内容极少，用于打破长段落\n- `<!-- content -->` 内容页（默认）：标题 + 项目符号要点\n- `<!-- data -->` 数据页：3-4 个关键数字，每行格式 `数值 | 标签` 或 `标签: 数值`。用大数字打破文字单调\n- `<!-- quote -->` 引用页：一句核心观点/名言，可加出处。用于金句升华\n- `<!-- split -->` 分栏页：左右对比，用 `**左栏标题**` 和 `**右栏标题**` 包裹各自内容\n- `<!-- table -->` 表格页：Markdown 表格呈现多组数据\n- `<!-- process -->` 流程页：步骤列表，每步 `1. 步骤名 - 描述`\n- `<!-- image -->` 图文页：`![描述](image)` + 文字说明\n- `<!-- end -->` 结束页：感谢/Q&A，不要 bullets\n\n## 设计节奏要求（避免单调）\n1. 每 2-3 页内容页后，必须插入 1 页 `<!-- data -->` 或 `<!-- quote -->` 或 `<!-- section -->` 打破纯文字节奏\n2. 有对比分析时，优先用 `<!-- split -->` 左右分栏，不要用 bullets 罗列对比\n3. 有流程/步骤时，用 `<!-- process -->`，不要用普通 bullets\n4. 多组同类数据（3列以上），用 `<!-- table -->`\n5. 每个章节开头用 `<!-- section -->` 做视觉分隔\n6. 关键结论/洞察用 `<!-- quote -->` 单独一页呈现\n\n内容应包含：封面、目录、2-3 个章节分隔、3-5 页内容、1-2 页数据、1 页引用、可选分栏/表格/流程/图文、结束页。',
  },
  {
    id: 'doc',
    icon: '📑',
    name: '整理文档',
    desc: '摘要、润色、改写、结构梳理',
    perms: ['内容生成'],
    recommended: true,
    systemPrompt:
      '你是一位专业文档写作与整理专家。请根据用户提供的主题、文本或附件内容，生成可直接导出为 Word 文档的 Markdown 正文。第一行使用一级标题作为文档标题，后续使用清晰的小标题、段落、项目符号或编号列表组织内容。不要输出额外解释、不要说“我无法生成文件”，只输出文档正文。',
  },
  {
    id: 'excel',
    icon: '📈',
    name: '分析表格',
    desc: '基于上传的 CSV/文本表格做分析和公式建议',
    perms: ['内容分析'],
    systemPrompt:
      '你是一位数据分析与表格整理助手。请根据用户粘贴或上传的 CSV、表格文本、数据描述，优先输出可直接导出为 Excel 的 Markdown 表格；如果用户明确要求原始数据表，请输出 fenced csv 代码块。可在表格后追加简短分析、公式建议、图表建议和异常说明。不要声称已经直接操作本地 Excel 文件。',
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
