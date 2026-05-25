// i18n v1 翻译表 —— zh 为默认/兜底语言，en 为补充。
// 命名规范：<domain>.<key>，domain 限定为 nav / settings / errors / common。
// 加新 key 时，zh 和 en 必须同步加（tests/i18n.test.js 会校验对称性）。

export const SUPPORTED_LANGUAGES = [
  { code: 'zh', label: '中文' },
  { code: 'en', label: 'English' },
]

export const DEFAULT_LANGUAGE = 'zh'

export const translations = {
  zh: {
    nav: {
      home: '首页',
      chat: '对话',
      task: '任务',
      skills: '技能库',
      permissions: '权限中心',
      memory: '记忆',
      agents: 'Agent',
      mcp: 'MCP',
      hooks: 'Hooks',
      history: '历史',
      settings: '设置',
      newChat: '新对话',
      searchPlaceholder: '搜索会话…',
      groupToday: '今天',
      groupWeek: '本周',
      groupEarlier: '更早',
      emptyTitle: '还没有对话',
      emptyHint: '点击"新对话"开始',
      searchResults: '搜索结果',
      searchNoMatch: '未找到匹配会话',
    },
    settings: {
      sectionTitle: '设置',
      language: '语言',
      languageHint: '切换界面显示语言。',
      systemDiagnostics: '系统诊断',
      account: '账户',
      appearance: '外观',
      theme: '主题',
      themeDark: '深色',
      themeLight: '浅色',
      themeSystem: '跟随系统',
      tools: '模型工具',
      shortcuts: '快捷键',
      dataExport: '数据 & 导出',
      exportSessions: '导出会话',
      exportSettings: '导出设置',
      refresh: '刷新',
    },
    errors: {
      networkFailed: '网络请求失败,请稍后再试。',
      loginRequired: '请先登录账户',
      sessionExpired: '会话已过期,请重新登录。',
      unknown: '出现未知错误。',
      invalidInput: '输入不合法。',
      notFound: '请求的资源不存在。',
      serverError: '服务端错误,请稍后再试。',
      loadFailed: '加载失败',
      saveFailed: '保存失败',
      deleteFailed: '删除失败',
    },
    common: {
      loading: '加载中…',
      confirm: '确定',
      cancel: '取消',
      save: '保存',
      saving: '保存中…',
      delete: '删除',
    },
    agents: {
      title: 'Agent',
      subtitle: '管理你的 AI 人格。每个 Agent 有独立的 SOUL 与 IDENTITY 卡片。',
      newAgent: '新建 Agent',
      newTitle: '新建 Agent',
      editTitle: '编辑 Agent',
      emptyHint: '还没有 Agent。点“新建 Agent”开始。',
      defaultBadge: '默认',
      setAsDefault: '设为默认',
      fieldName: '名称',
      fieldSoul: 'SOUL.md—人格、谈话风格、底线',
      fieldIdentity: 'IDENTITY.md—身份卡片（名字、角色、偏好）',
      fieldAvatar: '头像 URL（可选）',
      soulPlaceholder: '你是谁？怎么说话？重视什么？不做什么？',
      identityPlaceholder: '- Name: ...\n- Role: ...\n- Style: ...',
      noSoul: '未填写 SOUL',
      import: '导入',
      export: '导出',
      confirmDelete: '确定删除 “{name}” 这个 Agent 吗？',
      errNameRequired: '名称不能为空',
    },
  },
  en: {
    nav: {
      home: 'Home',
      chat: 'Chat',
      task: 'Tasks',
      skills: 'Skills',
      permissions: 'Permissions',
      memory: 'Memory',
      agents: 'Agents',
      mcp: 'MCP',
      hooks: 'Hooks',
      history: 'History',
      settings: 'Settings',
      newChat: 'New chat',
      searchPlaceholder: 'Search sessions…',
      groupToday: 'Today',
      groupWeek: 'This week',
      groupEarlier: 'Earlier',
      emptyTitle: 'No conversations yet',
      emptyHint: 'Click "New chat" to start',
      searchResults: 'Results',
      searchNoMatch: 'No matching sessions',
    },
    settings: {
      sectionTitle: 'Settings',
      language: 'Language',
      languageHint: 'Switch the interface language.',
      systemDiagnostics: 'System diagnostics',
      account: 'Account',
      appearance: 'Appearance',
      theme: 'Theme',
      themeDark: 'Dark',
      themeLight: 'Light',
      themeSystem: 'System',
      tools: 'Model tools',
      shortcuts: 'Shortcuts',
      dataExport: 'Data & export',
      exportSessions: 'Export sessions',
      exportSettings: 'Export settings',
      refresh: 'Refresh',
    },
    errors: {
      networkFailed: 'Network request failed, please try again later.',
      loginRequired: 'Please sign in first',
      sessionExpired: 'Session expired, please sign in again.',
      unknown: 'An unknown error occurred.',
      invalidInput: 'Invalid input.',
      notFound: 'The requested resource was not found.',
      serverError: 'Server error, please try again later.',
      loadFailed: 'Failed to load',
      saveFailed: 'Failed to save',
      deleteFailed: 'Failed to delete',
    },
    common: {
      loading: 'Loading…',
      confirm: 'Confirm',
      cancel: 'Cancel',
      save: 'Save',
      saving: 'Saving…',
      delete: 'Delete',
    },
    agents: {
      title: 'Agents',
      subtitle: 'Manage your AI personas. Each agent has its own SOUL and IDENTITY card.',
      newAgent: 'New Agent',
      newTitle: 'New Agent',
      editTitle: 'Edit Agent',
      emptyHint: 'No agents yet. Click "New Agent" to start.',
      defaultBadge: 'Default',
      setAsDefault: 'Set as default',
      fieldName: 'Name',
      fieldSoul: 'SOUL.md — persona, voice, boundaries',
      fieldIdentity: 'IDENTITY.md — identity card (name, role, preferences)',
      fieldAvatar: 'Avatar URL (optional)',
      soulPlaceholder: 'Who are you? How do you talk? What do you care about? What do you refuse?',
      identityPlaceholder: '- Name: ...\n- Role: ...\n- Style: ...',
      noSoul: 'No SOUL written yet',
      import: 'Import',
      export: 'Export',
      confirmDelete: 'Delete agent “{name}”?',
      errNameRequired: 'Name is required',
    },
  },
}

// 按 'a.b.c' 在 dict 里取叶子；找不到返回 undefined。
export function lookup(dict, key) {
  if (!dict || typeof key !== 'string') return undefined
  const parts = key.split('.')
  let cur = dict
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in cur) {
      cur = cur[p]
    } else {
      return undefined
    }
  }
  return typeof cur === 'string' ? cur : undefined
}

// 纯函数版本翻译（给测试和非 React 模块用）：
// 1. 命中目标语言 → 用它
// 2. fallback 到 zh
// 3. 还没有 → 返回 key 末尾段（不抛错、不返回 'key.not.found'，保证 UI 不显空）
export function translateKey(key, lang = DEFAULT_LANGUAGE) {
  const primary = lookup(translations[lang], key)
  if (primary !== undefined) return primary
  if (lang !== DEFAULT_LANGUAGE) {
    const fallback = lookup(translations[DEFAULT_LANGUAGE], key)
    if (fallback !== undefined) return fallback
  }
  const tail = String(key).split('.').pop()
  return tail || ''
}
