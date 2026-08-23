import { buildPresentationPlannerPrompt } from './lib/presentationPlanner.js'
import { canonicalizeSkillId } from '../shared/artifactIntent.js'

export const USER = {
  name: '\u672a\u767b\u5f55',
  handle: '',
  email: '',
  avatar: '',
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

import { SKILLS } from './data/skillCatalog.js'
export { SKILLS } from './data/skillCatalog.js'

export const DEFAULT_SKILL_CONFIGS = {}
SKILLS.forEach((skill) => {
  DEFAULT_SKILL_CONFIGS[skill.id] = {
    enabled: true,
    systemPrompt: skill.systemPrompt,
    temperature: null,
    maxTokens: null,
  }
})

function findSkill(skillId, externalSkills = []) {
  const canonicalId = canonicalizeSkillId(skillId)
  return [...externalSkills, ...SKILLS].find((item) => item.id === canonicalId)
}

/**
 * @param {object} [context]
 * @param {string} [context.userPrompt]
 * @param {boolean} [context.split] \u4f20 true \u65f6\u8fd4\u56de { base, perTurn } \u800c\u4e0d\u662f\u62fc\u597d\u7684\u5b57\u7b26\u4e32\u3002
 *   base   = \u7a33\u5b9a\u57fa\u5e95,\u53ef\u8fdb\u4e0a\u6e38\u524d\u7f00\u7f13\u5b58
 *   perTurn = \u4f9d\u8d56\u672c\u8f6e\u8f93\u5165\u7684\u89c4\u5212\u5668,\u8c03\u7528\u65b9\u5e94\u653e\u5230 history \u4e4b\u540e
 *   \u8001\u8c03\u7528\u65b9\u4e0d\u4f20 split \u65f6\u884c\u4e3a\u4e0d\u53d8(\u4ecd\u8fd4\u56de\u62fc\u63a5\u540e\u7684\u5b57\u7b26\u4e32)\u3002
 */
export function getSkillSystemPrompt(skillId, skillConfigs, externalSkills = [], context = {}) {
  const canonicalId = canonicalizeSkillId(skillId)
  const cfg = skillConfigs?.[canonicalId]
  const skill = findSkill(canonicalId, externalSkills)
  const basePrompt = cfg?.systemPrompt != null ? cfg.systemPrompt : skill?.systemPrompt || ''
  const usesPlanner = canonicalId === 'ppt' && context?.userPrompt
  const perTurn = usesPlanner ? buildPresentationPlannerPrompt(context.userPrompt, { skillId: canonicalId }) : ''
  if (context?.split) return { base: basePrompt, perTurn }
  return perTurn ? `${basePrompt}${perTurn}` : basePrompt
}

export function getSkillEffectiveConfig(skillId, skillConfigs, externalSkills = []) {
  const canonicalId = canonicalizeSkillId(skillId)
  const skill = findSkill(canonicalId, externalSkills)
  const cfg = skillConfigs?.[canonicalId] || {}
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
    name: '\u9ea6\u514b\u98ce\u8f93\u5165',
    code: 'MIC',
    scope: '\u6d4f\u89c8\u5668\u8bed\u97f3\u8bc6\u522b',
    enabled: true,
    usage: '\u672c\u5730\u5f00\u5173',
  },
  {
    id: 'notify',
    name: '\u6d4f\u89c8\u5668\u901a\u77e5',
    code: 'PUSH',
    scope: '\u4efb\u52a1\u5b8c\u6210\u63d0\u9192',
    enabled: true,
    usage: '\u672c\u5730\u5f00\u5173',
  },
]

export const TASK_STEPS = []

export const QUICK_ACTIONS = [
  { icon: '', name: '\u5236\u4f5c PPT', active: true },
  { icon: '', name: '\u4ee3\u7801\u751f\u6210', active: true },
  { icon: '', name: '\u6574\u7406\u6587\u6863', active: false },
  { icon: '', name: '\u5206\u6790\u8868\u683c', active: false },
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
    remaining: '\u65e0',
    permsUsed: 0,
    transferred: '0 KB',
  },
}

export const SETTINGS_NAV = [
  '\u8d26\u6237',
  '\u6743\u9650\u4e2d\u5fc3',
  '\u5916\u89c2',
  '\u5feb\u6377\u952e',
  '\u6570\u636e & \u5bfc\u51fa',
]
