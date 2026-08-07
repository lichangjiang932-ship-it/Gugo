const ZH_SKILL_COPY = {
  brainstorming: ['创意构思', '在开始创作或功能设计前梳理目标、需求、约束与候选方案。'],
  'code-review': ['代码审查', '检查代码变更的正确性、安全性、可维护性与测试覆盖，并给出可执行的修改建议。'],
  'frontend-app-builder': ['前端应用构建', '从零构建网站、仪表盘、游戏界面和高完成度前端应用，并通过浏览器验证实现效果。'],
  'frontend-testing-debugging': ['前端测试与调试', '通过浏览器检查交互、控制台错误、响应式布局和视觉回归，定位并修复前端问题。'],
  'react-best-practices': ['React 最佳实践', '按照 Vercel 工程规范优化 React 与 Next.js 的组件、数据获取、性能和打包体积。'],
  shadcn: ['Shadcn 组件开发', '搜索、添加、组合和修复 shadcn/ui 组件，并维护组件注册表与项目配置。'],
  'stripe-best-practices': ['Stripe 集成规范', '指导支付、订阅、Connect 平台和结账组件的接口选型、实现与旧版迁移。'],
  'supabase-postgres-best-practices': ['Supabase 数据库优化', '优化 Postgres 查询、表结构和数据库配置，提升性能、可靠性与可维护性。'],
  'game-playtest': ['游戏试玩测试', '自动试玩浏览器游戏，检查操作流程、界面覆盖、截图表现和运行时错误并整理问题。'],
  'game-studio': ['游戏开发导航', '在浏览器游戏开发初期选择技术栈，规划设计、实现、素材和试玩测试流程。'],
  'game-ui-frontend': ['游戏界面设计', '设计游戏 HUD、菜单、弹层和响应式布局，在保护主游戏区域的同时提升可用性。'],
  'phaser-2d-game': ['Phaser 2D 游戏开发', '使用 Phaser、TypeScript 与 Vite 实现场景、玩法系统、镜头、精灵动画和 HUD。'],
  'react-three-fiber-game': ['React Three Fiber 游戏开发', '使用 React Three Fiber 构建 React 承载的 3D 游戏场景、状态与界面。'],
  'sprite-pipeline': ['精灵动画流水线', '生成并规范化 2D 精灵动画，统一锚点、缩放、帧条和预览素材。'],
  'three-webgl-game': ['Three.js 游戏开发', '使用 Three.js、TypeScript 与 WebGL 构建游戏运行时、资源加载、物理和调试流程。'],
  'web-3d-asset-pipeline': ['Web 3D 资产流水线', '整理并优化 GLB、glTF 和纹理资源，处理碰撞体、LOD、压缩、导出与运行时验证。'],
  'web-game-foundations': ['Web 游戏架构', '在编码前确定引擎、渲染边界、输入模型、资源组织、存档、调试和性能策略。'],
  'evaluate-plugin': ['插件评估', '从结构、可用性、工程质量、令牌成本和维护风险等方面评估一个 Codex 插件。'],
  'evaluate-skill': ['技能评估', '检查单个技能的触发说明、指令质量、资源组织和实际执行效果，并指出优先改进项。'],
  'improve-skill': ['技能改进', '把技能评估结果转换成具体重写方案，完善触发条件、工作流、资源和验证要求。'],
  'metric-pack-designer': ['评估指标包设计', '为插件评测设计自定义指标、检查项与可视化输出，形成可复用的评价标准。'],
  'plugin-eval': ['插件与技能评测', '运行技能或插件评测，解释得分、衡量令牌开销、比较基准场景并确定改进顺序。'],
  'remotion-best-practices': ['Remotion 视频制作规范', '使用 React 和 Remotion 制作视频时遵循可靠的组件、时间轴、渲染和性能规范。'],
  'dispatching-parallel-agents': ['并行智能体调度', '识别互不依赖的任务并分配给多个智能体并行处理，再汇总各自结果。'],
  'executing-plans': ['执行既定计划', '按照已确认的实施计划分阶段推进任务，并在关键检查点验证结果。'],
  'finishing-a-development-branch': ['完成开发分支', '在实现和测试完成后选择合并、创建 PR 或清理分支的安全收尾流程。'],
  'receiving-code-review': ['处理审查意见', '严谨评估收到的代码审查意见，验证技术合理性后再实施修改，避免盲目接受。'],
  'requesting-code-review': ['发起代码审查', '在重要功能完成或合并前发起代码审查，确认实现符合需求和质量标准。'],
  'subagent-driven-development': ['子智能体驱动开发', '把实施计划拆成独立任务交给子智能体完成，并在当前会话中逐项审查和整合。'],
  'systematic-debugging': ['系统化调试', '基于证据定位根因：先稳定复现问题，再验证修复，并增加防止问题复发的检查。'],
  'test-driven-development': ['测试驱动开发', '先编写会失败的测试，再实现最小代码使其通过，最后重构并保持测试绿色。'],
  'using-git-worktrees': ['Git Worktree 工作流', '为并行开发创建隔离的 Git 工作树，确认目录安全并避免污染当前分支。'],
  'verification-before-completion': ['完成前验证', '在宣称任务完成前运行对应测试、构建或检查，并依据实际输出确认结果。'],
  'writing-plans': ['编写实施计划', '根据需求和代码现状编写可执行的分步计划，明确文件、验证方式和交付标准。'],
  'writing-skills': ['编写技能', '创建或更新结构清晰、触发准确、资源精简且经过验证的 Codex 技能。'],
  'connector-operator': ['连接器操作', '安全使用已连接的应用和服务，处理权限、状态检查、读取与写入操作。'],
  'needs-runtime-skill': ['运行时技能', '使用依赖额外运行环境的技能，并明确安装要求、可用状态和验证方式。'],
}

const PHRASE_COPY = [
  ['best-practices', '最佳实践'],
  ['test-driven-development', '测试驱动开发'],
  ['code-review', '代码审查'],
  ['contact-center', '联络中心'],
  ['meeting-sdk', '会议 SDK'],
  ['video-sdk', '视频 SDK'],
  ['virtual-agent', '虚拟客服'],
  ['react-native', 'React Native'],
  ['frontend', '前端'],
  ['backend', '后端'],
  ['testing', '测试'],
  ['debugging', '调试'],
  ['validation', '验证'],
  ['verification', '验证'],
  ['review', '审查'],
  ['audit', '审计'],
  ['builder', '构建'],
  ['development', '开发'],
  ['design', '设计'],
  ['pipeline', '流水线'],
  ['integration', '集成'],
  ['operator', '操作'],
  ['general', '产品选型'],
]

const SKILL_DETAIL_COPY = {
  zh: { overview: '技能说明', usage: '使用方式', command: '调用命令', originalName: '原始名称', requirements: '运行要求', ready: '当前环境已满足运行要求', requiresApp: '需要对应应用连接', requiresMcp: '需要 MCP 服务', requiresRuntime: '需要额外运行资源', promptPlaceholder: '描述你希望完成的任务' },
  en: { overview: 'Skill overview', usage: 'How to use', command: 'Command', originalName: 'Original name', requirements: 'Requirements', ready: 'Ready in the current environment', requiresApp: 'Requires a connected app', requiresMcp: 'Requires an MCP server', requiresRuntime: 'Requires additional runtime resources', promptPlaceholder: 'describe the task to complete' },
  ja: { overview: 'スキル説明', usage: '使い方', command: '呼び出しコマンド', originalName: '元の名前', requirements: '実行要件', ready: '現在の環境で実行できます', requiresApp: '対応アプリの接続が必要', requiresMcp: 'MCP サービスが必要', requiresRuntime: '追加の実行リソースが必要', promptPlaceholder: '実行したいタスクを入力' },
  ko: { overview: '스킬 설명', usage: '사용 방법', command: '호출 명령', originalName: '원래 이름', requirements: '실행 요구 사항', ready: '현재 환경에서 바로 실행 가능', requiresApp: '해당 앱 연결 필요', requiresMcp: 'MCP 서버 필요', requiresRuntime: '추가 런타임 리소스 필요', promptPlaceholder: '완료할 작업을 설명하세요' },
  'zh-TW': { overview: '技能說明', usage: '使用方式', command: '呼叫指令', originalName: '原始名稱', requirements: '執行要求', ready: '目前環境已滿足執行要求', requiresApp: '需要連接對應應用程式', requiresMcp: '需要 MCP 服務', requiresRuntime: '需要額外執行資源', promptPlaceholder: '描述你希望完成的任務' },
}

function containsChinese(value) {
  return /[\u3400-\u9fff]/u.test(String(value || ''))
}

function rawSkillName(skill) {
  return String(skill?.name || skill?.id || 'skill').trim()
}

function canonicalSkillName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function translateSkillName(value) {
  let remaining = String(value || 'skill').trim().replace(/^codex-/, '').toLowerCase()
  const parts = []
  for (const [phrase, translated] of PHRASE_COPY) {
    if (!remaining.includes(phrase)) continue
    remaining = remaining.replace(phrase, '-')
    parts.push(translated)
  }
  const preserved = remaining
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((token) => {
      const known = { app: '应用', apps: '应用', game: '游戏', web: 'Web', ui: 'UI', sdk: 'SDK', api: 'API', skill: '技能', plugin: '插件', data: '数据', document: '文档', image: '图像', video: '视频', audio: '音频', security: '安全', performance: '性能', oauth: 'OAuth', android: 'Android', ios: 'iOS', windows: 'Windows', linux: 'Linux', macos: 'macOS', electron: 'Electron', flutter: 'Flutter', unity: 'Unity', unreal: 'Unreal', react: 'React', zoom: 'Zoom' }[token]
      return known || token.replace(/^./, (letter) => letter.toUpperCase())
    })
  return [...preserved, ...parts].join(' · ') || '专业技能'
}

function genericChineseDescription(skill, title) {
  const original = `${skill?.name || ''} ${skill?.desc || skill?.description || ''}`.toLowerCase()
  if (/sdk|api|integration|oauth/.test(original)) {
    return `${title}的集成指南，涵盖环境准备、认证、核心接口、生命周期处理和常见故障排查。`
  }
  if (/test|verify|validation|playtest/.test(original)) {
    return `围绕${title}设计并执行可复现的检查流程，记录证据、问题和通过标准。`
  }
  if (/review|audit|evaluate|quality/.test(original)) {
    return `使用${title}检查实现质量、潜在风险和遗漏项，并输出有优先级的改进建议。`
  }
  if (/build|develop|create|implement|design/.test(original)) {
    return `使用${title}完成从方案、实现到结果验证的专业工作流，并遵循对应技术栈的工程规范。`
  }
  return `提供${title}相关的专业操作流程、关键注意事项和结果验证方法。`
}

export function getPresentedSkill(skill, lang = 'zh') {
  if (!skill || !String(lang).startsWith('zh')) return skill
  if (containsChinese(skill.name) && containsChinese(skill.desc)) return skill

  const originalName = rawSkillName(skill)
  const known = ZH_SKILL_COPY[canonicalSkillName(originalName)] || ZH_SKILL_COPY[skill.id]
  const name = containsChinese(skill.name) ? skill.name : (known?.[0] || translateSkillName(originalName))
  const desc = containsChinese(skill.desc) ? skill.desc : (known?.[1] || genericChineseDescription(skill, name))

  return {
    ...skill,
    name,
    desc,
    description: desc,
    originalName,
    originalDescription: String(skill.desc || skill.description || '').trim(),
  }
}

function semanticSkillKey(skill) {
  if (!skill?.codexPlugin || !skill.originalName || !skill.originalDescription) return null
  return `${skill.originalName.toLowerCase()}\u0000${skill.originalDescription.toLowerCase().replace(/\s+/g, ' ').trim()}`
}

function preferSkill(left, right) {
  if (left.runnable !== right.runnable) return left.runnable === false ? right : left
  if (left.recommended !== right.recommended) return right.recommended ? right : left
  return left
}

const CATALOG_CATEGORY_ORDER = Object.freeze([
  'office',
  'development',
  'analysis',
  'communication',
  'productivity',
  'custom',
])

const CATALOG_CATEGORY_COPY = Object.freeze({
  zh: { office: '办公创作', development: '开发与测试', analysis: '分析与研究', communication: '沟通协作', productivity: '通用效率', custom: '我的技能' },
  en: { office: 'Office & creation', development: 'Development & testing', analysis: 'Analysis & research', communication: 'Communication', productivity: 'Productivity', custom: 'My skills' },
  ja: { office: '文書・制作', development: '開発・テスト', analysis: '分析・調査', communication: 'コミュニケーション', productivity: '生産性', custom: 'マイスキル' },
  ko: { office: '문서 및 제작', development: '개발 및 테스트', analysis: '분석 및 조사', communication: '커뮤니케이션', productivity: '생산성', custom: '내 스킬' },
  'zh-TW': { office: '辦公創作', development: '開發與測試', analysis: '分析與研究', communication: '溝通協作', productivity: '通用效率', custom: '我的技能' },
})

const CATALOG_CAPABILITIES = Object.freeze([
  { key: 'presentation', canonicalId: 'ppt', aliases: /(?:^|[-_\s])(pptx?|powerpoint|presentations?|slides?|slide-deck|pitch-deck)(?:$|[-_\s])/i },
  { key: 'document', canonicalId: 'doc', aliases: /^(?:doc|docs|document|documents|word|write-doc)$/i },
  { key: 'spreadsheet', canonicalId: 'excel', aliases: /^(?:excel|xlsx|spreadsheet|spreadsheets|analyze-excel)$/i },
  { key: 'code-review', canonicalId: 'review', aliases: /^(?:review|code-review|code-reviewer)$/i },
  { key: 'translation', canonicalId: 'translate', aliases: /^(?:translate|translation|translator)$/i },
  { key: 'research', canonicalId: 'research', aliases: /^(?:research|deep-research|researcher)$/i },
  { key: 'planning', canonicalId: 'plan', aliases: /^(?:plan|planning|project-planning)$/i },
])

const DEFAULT_PLUGIN_SKILL_IDENTITIES = Object.freeze([
  'brainstorming',
  'frontend-app-builder',
  'frontend-testing-debugging',
  'react-best-practices',
  'systematic-debugging',
  'test-driven-development',
  'verification-before-completion',
  'writing-plans',
])

function catalogLanguage(lang) {
  if (CATALOG_CATEGORY_COPY[lang]) return lang
  return String(lang || '').startsWith('zh') ? 'zh' : 'en'
}

function isUserManagedSkill(skill) {
  return Boolean(
    skill?.custom
    || skill?.localCustom
    || skill?.imported
    || skill?.userId
    || skill?.user_id,
  )
}

function catalogIdentity(skill) {
  const value = typeof skill === 'string'
    ? skill
    : skill?.originalName || skill?.id || skill?.name || ''
  return String(value)
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
}

function capabilityForSkill(skill) {
  const values = [skill?.id, skill?.originalName, skill?.name]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
  return CATALOG_CAPABILITIES.find((definition) => values.some((value) => definition.aliases.test(value))) || null
}

function catalogPreferenceScore(skill, capability) {
  let score = 0
  if (skill?.id === capability?.canonicalId) score += 1_000
  if (skill?.runnable !== false) score += 100
  if (!skill?.codexPlugin && !skill?.external) score += 40
  if (skill?.system) score += 20
  if (skill?.recommended) score += 10
  return score
}

function preferCatalogCanonical(left, right, capability) {
  const delta = catalogPreferenceScore(right, capability) - catalogPreferenceScore(left, capability)
  if (delta !== 0) return delta > 0 ? right : left
  return String(left.id).localeCompare(String(right.id)) <= 0 ? left : right
}

function categoryForSkill(skill, capability) {
  if (isUserManagedSkill(skill)) return 'custom'
  if (['presentation', 'document', 'spreadsheet'].includes(capability?.key)) return 'office'
  const identity = `${skill?.id || ''} ${skill?.originalName || ''} ${skill?.name || ''}`.toLowerCase()
  if (/ppt|slide|presentation|document|word|excel|spreadsheet|webpage|design|image|video/.test(identity)) return 'office'
  if (/code|review|develop|debug|test|react|frontend|backend|git|database|security/.test(identity)) return 'development'
  if (/research|analysis|finance|data|metric|evaluate|audit/.test(identity)) return 'analysis'
  if (/mail|message|connector|slack|discord|meeting|calendar|communication/.test(identity)) return 'communication'
  return 'productivity'
}

export function compareSkillCatalogEntries(left, right) {
  const leftCategory = CATALOG_CATEGORY_ORDER.indexOf(left?.categoryKey)
  const rightCategory = CATALOG_CATEGORY_ORDER.indexOf(right?.categoryKey)
  const categoryDelta = (leftCategory < 0 ? CATALOG_CATEGORY_ORDER.length : leftCategory)
    - (rightCategory < 0 ? CATALOG_CATEGORY_ORDER.length : rightCategory)
  if (categoryDelta !== 0) return categoryDelta
  const recommendedDelta = Number(Boolean(right?.recommended)) - Number(Boolean(left?.recommended))
  if (recommendedDelta !== 0) return recommendedDelta
  return String(left?.name || left?.id || '').localeCompare(String(right?.name || right?.id || ''))
    || String(left?.id || '').localeCompare(String(right?.id || ''))
}

/**
 * Build the compact skill-library catalog without changing runtime skill ids.
 * User-created/imported skills are never merged; only repository/system/plugin
 * entries compete for a canonical display slot.
 */
export function organizeSkillCatalog(skills, lang = 'zh') {
  const presented = presentSkillCollection(skills, lang)
  const catalog = []
  const canonicalIndexes = new Map()

  for (const skill of presented) {
    const capability = capabilityForSkill(skill)
    const protectedUserSkill = isUserManagedSkill(skill)
    const identity = catalogIdentity(skill)
    const key = protectedUserSkill
      ? null
      : capability?.key
        ? `capability:${capability.key}`
        : identity
          ? `name:${identity}`
          : null
    const decorated = { ...skill, capabilityKey: capability?.key || null }

    if (!key || !canonicalIndexes.has(key)) {
      if (key) canonicalIndexes.set(key, catalog.length)
      catalog.push(decorated)
      continue
    }
    const index = canonicalIndexes.get(key)
    catalog[index] = preferCatalogCanonical(catalog[index], decorated, capability)
  }

  const copy = CATALOG_CATEGORY_COPY[catalogLanguage(lang)]
  return catalog.map((skill) => {
    const capability = capabilityForSkill(skill)
    const categoryKey = categoryForSkill(skill, capability)
    return { ...skill, categoryKey, categoryLabel: copy[categoryKey] }
  }).sort(compareSkillCatalogEntries)
}

function isDefaultPluginSkill(skill) {
  if (!skill?.codexPlugin || skill?.runnable === false) return false
  const identities = [skill.id, skill.originalName, skill.name].map(catalogIdentity)
  return DEFAULT_PLUGIN_SKILL_IDENTITIES.some((expected) => (
    identities.some((identity) => identity === expected || identity.endsWith(`-${expected}`))
  ))
}

export function selectDefaultSkillCatalog(skills) {
  return (Array.isArray(skills) ? skills : []).filter((skill) => (
    isUserManagedSkill(skill)
    || (!skill?.codexPlugin && !skill?.external)
    || isDefaultPluginSkill(skill)
  ))
}

export function presentSkillCollection(skills, lang = 'zh') {
  const deduped = []
  const semanticIndexes = new Map()
  for (const rawSkill of Array.isArray(skills) ? skills : []) {
    const skill = getPresentedSkill(rawSkill, lang)
    const key = semanticSkillKey(skill)
    if (!key || !semanticIndexes.has(key)) {
      if (key) semanticIndexes.set(key, deduped.length)
      deduped.push(skill)
      continue
    }
    const index = semanticIndexes.get(key)
    deduped[index] = preferSkill(deduped[index], skill)
  }

  const titleCounts = new Map()
  for (const skill of deduped) titleCounts.set(skill.name, (titleCounts.get(skill.name) || 0) + 1)
  const usedTitles = new Set()
  return deduped.map((skill) => {
    let name = skill.name
    if ((titleCounts.get(name) || 0) > 1) {
      const qualifier = skill.pluginName || skill.originalName || skill.id
      name = `${name}（${qualifier}）`
    }
    if (usedTitles.has(name)) name = `${name} · ${skill.originalName || skill.id}`
    usedTitles.add(name)
    return name === skill.name ? skill : { ...skill, name }
  })
}

export function getSkillDetailCopy(lang = 'zh') {
  return SKILL_DETAIL_COPY[lang] || SKILL_DETAIL_COPY[String(lang).startsWith('zh') ? 'zh' : 'en']
}

export function describeSkillRequirements(skill, lang = 'zh') {
  const copy = getSkillDetailCopy(lang)
  const requirements = skill?.requirements || {}
  const items = []
  if (requirements.app) items.push(copy.requiresApp)
  if (requirements.mcp) items.push(copy.requiresMcp)
  if (Array.isArray(requirements.runtime) && requirements.runtime.length) {
    items.push(`${copy.requiresRuntime}：${requirements.runtime.join('、')}`)
  }
  return items.length ? items : [copy.ready]
}
