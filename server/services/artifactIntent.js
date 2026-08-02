/**
 * 文件产物意图的单一判断源。
 *
 * ★ 背景(2026-07-31 事故):用户让 agent「修复量化交易平台的页面刷新 bug」,
 *   62 步跑完后唯一产物是一份 4 页 PPT,标题还是模型的开场白。
 *   根因不是模型犯傻,是系统在推它:
 *     1. create_pptx / create_docx / create_xlsx 无条件出现在 job 工具集里;
 *     2. 系统提示词常驻「不要把内容写成纯文本回答」+ 7 条 PPT 排版铁律;
 *     3. 判断「用户要不要文件」的关键词散落在 jobWorkflow 和前端两处,各判各的。
 *
 * 这里把「用户到底要不要文件产物」收敛成唯一判断源,同时驱动三个决策点:
 *   - jobTools.selectJobToolSpecs  → 模型压根看不到不该用的工具(硬约束)
 *   - jobRuntime 系统提示词分支     → 不给代码任务注入 PPT 排版规则(软约束)
 *   - jobWorkflow.shouldCompileDocx → finalize 自动编译走同一套关键词
 *
 * 语义与前端 src/lib/chatFlowGuards.js 的 filterToolNamesForSkill 保持一致:
 * 文件工具默认不可见,只有明确的产物技能或明确的产物关键词才解锁。
 */

/** 会写出可下载文件的工具。默认对模型不可见。 */
export const FILE_ARTIFACT_TOOLS = Object.freeze([
  'create_pptx',
  'create_docx',
  'create_xlsx',
])

import {
  detectArtifactIntent as detectSharedArtifactIntent,
  parseArtifactSkillId,
} from '../../shared/artifactIntent.js'

/** 从 `/ppt 帮我讲讲 X` 这类提示词里取技能 id;与 jobRuntime.parseSkillPrompt 同规则。 */
export function parseSkillIdFromPrompt(prompt = '') {
  return parseArtifactSkillId(prompt)
}

/**
 * 判断用户是否明确要某类文件产物。
 *
 * @param {string} prompt 用户原始提示词(保留 `/ppt` 这类前缀)
 * @param {object} [options]
 * @param {string|null} [options.skillId] 已解析出的技能 id;不传则从 prompt 自行解析
 * @returns {{pptx:boolean, docx:boolean, xlsx:boolean}}
 */
export function detectArtifactIntent(prompt = '', { skillId = undefined } = {}) {
  return detectSharedArtifactIntent(prompt, { skillId })
}

/**
 * 本次任务允许模型看到的文件工具集合。没有明确意图时返回空集 ——
 * 模型的工具列表里根本不会出现 create_pptx,也就无从"顺手"生成 PPT。
 *
 * @returns {Set<string>}
 */
export function allowedArtifactTools(prompt = '', options = {}) {
  const intent = detectArtifactIntent(prompt, options)
  const allowed = new Set()
  if (intent.pptx) allowed.add('create_pptx')
  if (intent.docx) allowed.add('create_docx')
  if (intent.xlsx) allowed.add('create_xlsx')
  return allowed
}

export function isFileArtifactTool(name) {
  return FILE_ARTIFACT_TOOLS.includes(name)
}

/** 用户是否要了任何一种文件产物。用于 finalize 阶段的交付对账。 */
export function expectsFileArtifact(prompt = '', options = {}) {
  const intent = detectArtifactIntent(prompt, options)
  return intent.pptx || intent.docx || intent.xlsx
}
