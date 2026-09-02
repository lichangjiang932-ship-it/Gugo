// Public i18n API. Translation data lives in cohesive zh/en domain modules.
import { translations } from './domains/index.js'

export const SUPPORTED_LANGUAGES = [
  { code: 'zh', label: '中文' },
  { code: 'en', label: 'English' },
]

export const DEFAULT_LANGUAGE = 'zh'

export function normalizeUiLanguage(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/_/g, '-')
  if (!normalized) return DEFAULT_LANGUAGE
  if (normalized === 'zh' || normalized === 'zh-cn' || normalized === 'zh-hans') return 'zh'
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en'
  return 'en'
}

export { translations }

export function lookup(dict, key) {
  if (!dict || typeof key !== 'string') return undefined
  const parts = key.split('.')
  let cur = dict
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in cur) cur = cur[p]
    else return undefined
  }
  return typeof cur === 'string' ? cur : undefined
}

export function translateKey(key, lang = DEFAULT_LANGUAGE) {
  const normalizedLang = normalizeUiLanguage(lang)
  const primary = lookup(translations[normalizedLang], key)
  if (primary !== undefined) return primary
  if (normalizedLang !== DEFAULT_LANGUAGE) {
    const fallback = lookup(translations[DEFAULT_LANGUAGE], key)
    if (fallback !== undefined) return fallback
  }
  const tail = String(key).split('.').pop()
  return tail || ''
}

export const SLASH_ACTION_COPY = {
  "en": {
    "mcp": [
      "MCP",
      "Show MCP server status"
    ],
    "side": [
      "Side chat",
      "Start a temporary side conversation"
    ],
    "init": [
      "Initialize",
      "Create an AGENTS.md file with workspace instructions"
    ],
    "compact": [
      "Compact",
      "Compact the context of this chat"
    ],
    "feedback": [
      "Feedback",
      "Send feedback about this chat"
    ],
    "continue": [
      "Continue in new chat",
      "Create a new chat carrying the current context"
    ],
    "pet": [
      "Pet",
      "Wake or hide the desktop pet"
    ],
    "new": [
      "New chat",
      "Open a blank chat in the same workspace"
    ],
    "status": [
      "Status",
      "Show chat ID, context, model, and running tasks"
    ],
    "goals": [
      "Goals",
      "Set a goal to keep pursuing"
    ],
    "plan": [
      "Plan mode",
      "Turn on plan-only mode"
    ],
    "notices": {
      "mcp": "Opened MCP servers.",
      "side": "Opened side chat.",
      "init": "Creating AGENTS.md.",
      "compact": "Chat context compacted.",
      "compactEmpty": "This chat is still too short to compact.",
      "feedback": "Feedback saved locally.",
      "continue": "Created a new chat with the current context.",
      "pet": "Desktop pet toggled.",
      "new": "Opened a new chat.",
      "goal": "Goal added: {goal}",
      "plan": "Plan mode enabled.",
      "noSession": "No active chat."
    },
    "prompts": {
      "init": "Create or update AGENTS.md in the current workspace with concise, practical instructions for working in this repository."
    },
    "petGreeting": "Ready when you are.",
    "statusPanel": {
      "title": "Chat status",
      "chatId": "Chat ID",
      "model": "Model",
      "context": "Context",
      "messages": "Messages",
      "tasks": "Tasks",
      "approval": "Permission mode",
      "running": "running",
      "pending": "pending",
      "noChat": "Draft chat",
      "openTasks": "View tasks",
      "close": "Close status",
      "normal": "Normal",
      "acceptEdits": "Accept edits",
      "plan": "Plan",
      "bypass": "Bypass approvals"
    },
    "mcpPanel": {
      "title": "MCP servers",
      "close": "Close MCP status",
      "loading": "Checking server status…",
      "retry": "Retry",
      "empty": "No MCP servers configured",
      "configured": "configured",
      "connected": "connected",
      "disconnected": "Not connected",
      "tools": "tools",
      "manage": "Manage MCP",
      "loadError": "Could not load MCP server status"
    },
    "feedbackPanel": {
      "title": "Send feedback",
      "close": "Close feedback",
      "placeholder": "What should be improved about this chat?",
      "note": "Feedback is saved on this device only.",
      "cancel": "Cancel",
      "submit": "Save feedback",
      "saved": "Feedback saved.",
      "required": "Write a short note before saving.",
      "failed": "Feedback could not be saved."
    },
    "goalsPanel": {
      "title": "Goals",
      "close": "Close goals",
      "empty": "No goals for this chat yet.",
      "placeholder": "Add a goal to keep pursuing",
      "add": "Add goal",
      "remove": "Remove goal",
      "markDone": "Mark complete",
      "markOpen": "Mark active",
      "active": "Active",
      "completed": "Completed"
    }
  },
  "zh": {
    "mcp": [
      "MCP",
      "显示 MCP 服务器状态"
    ],
    "side": [
      "侧边",
      "发起临时侧边聊天"
    ],
    "init": [
      "初始化",
      "创建包含工作区说明的 AGENTS.md 文件"
    ],
    "compact": [
      "压缩",
      "压缩此聊天的上下文"
    ],
    "feedback": [
      "反馈",
      "发送有关此聊天的反馈"
    ],
    "continue": [
      "在新聊天中继续",
      "携带当前上下文创建新聊天"
    ],
    "pet": [
      "宠物",
      "唤醒或收起桌面宠物"
    ],
    "new": [
      "新聊天",
      "在同一工作空间中开启空白聊天"
    ],
    "status": [
      "状态",
      "显示聊天 ID、上下文、模型和运行任务"
    ],
    "goals": [
      "目标",
      "设置要持续追求的目标"
    ],
    "plan": [
      "计划模式",
      "开启仅规划模式"
    ],
    "notices": {
      "mcp": "已打开 MCP 服务器。",
      "side": "已打开侧边聊天。",
      "init": "正在创建 AGENTS.md。",
      "compact": "已压缩聊天上下文。",
      "compactEmpty": "当前聊天内容较少，暂时无需压缩。",
      "feedback": "反馈已保存在本机。",
      "continue": "已携带当前上下文创建新聊天。",
      "pet": "已切换桌面宠物。",
      "new": "已开启新聊天。",
      "goal": "已添加目标：{goal}",
      "plan": "已开启计划模式。",
      "noSession": "当前没有可操作的聊天。"
    },
    "prompts": {
      "init": "请在当前工作区创建或更新 AGENTS.md，写入简洁、实用、适合本仓库的协作与开发说明。"
    },
    "petGreeting": "我在，随时可以开始。",
    "statusPanel": {
      "title": "聊天状态",
      "chatId": "聊天 ID",
      "model": "模型",
      "context": "上下文",
      "messages": "消息",
      "tasks": "任务",
      "approval": "权限模式",
      "running": "运行中",
      "pending": "等待中",
      "noChat": "草稿聊天",
      "openTasks": "查看任务",
      "close": "关闭状态",
      "normal": "正常",
      "acceptEdits": "自动接受编辑",
      "plan": "计划",
      "bypass": "跳过审批"
    },
    "mcpPanel": {
      "title": "MCP 服务器",
      "close": "关闭 MCP 状态",
      "loading": "正在检查服务器状态…",
      "retry": "重试",
      "empty": "尚未配置 MCP 服务器",
      "configured": "个已配置",
      "connected": "个已连接",
      "disconnected": "未连接",
      "tools": "个工具",
      "manage": "管理 MCP",
      "loadError": "无法加载 MCP 服务器状态"
    },
    "feedbackPanel": {
      "title": "发送反馈",
      "close": "关闭反馈",
      "placeholder": "这次聊天有哪些地方需要改进？",
      "note": "反馈目前仅保存在此设备。",
      "cancel": "取消",
      "submit": "保存反馈",
      "saved": "反馈已保存。",
      "required": "请先填写简短反馈。",
      "failed": "反馈保存失败。"
    },
    "goalsPanel": {
      "title": "目标",
      "close": "关闭目标",
      "empty": "当前聊天还没有目标。",
      "placeholder": "添加一个要持续追求的目标",
      "add": "添加目标",
      "remove": "删除目标",
      "markDone": "标记完成",
      "markOpen": "恢复进行中",
      "active": "进行中",
      "completed": "已完成"
    }
  }
}
