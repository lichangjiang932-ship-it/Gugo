import { detectArtifactIntent } from '../../shared/artifactIntent.js'

const CHINESE_DIGITS = Object.freeze({
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
})

function parseRequestedCount(prompt = '') {
  const arabic = String(prompt).match(/(\d+)\s*(?:份|个|条|篇|组|套)/)
  if (arabic) return Number(arabic[1])

  const chinese = String(prompt).match(/([一二两三四五六七八九十]{1,3})\s*(?:份|个|条|篇|组|套)/)
  if (!chinese) return 0
  const token = chinese[1]
  if (token === '十') return 10
  if (token.length === 2 && token.startsWith('十')) return 10 + (CHINESE_DIGITS[token[1]] || 0)
  if (token.length === 2 && token.endsWith('十')) return (CHINESE_DIGITS[token[0]] || 0) * 10
  if (token.length === 3 && token[1] === '十') {
    return (CHINESE_DIGITS[token[0]] || 0) * 10 + (CHINESE_DIGITS[token[2]] || 0)
  }
  return CHINESE_DIGITS[token] || 0
}

function detectTaskType(prompt = '') {
  const text = String(prompt).toLowerCase()
  const artifactIntent = detectArtifactIntent(text)
  if (/(代码|项目|仓库|bug|接口|函数|组件|测试|重构|code|repo|test|refactor)/i.test(text)) return 'code'
  if (artifactIntent.pptx) return 'presentation'
  if (artifactIntent.xlsx) return 'spreadsheet'
  if (artifactIntent.docx) return 'document'
  if (/(分析|调研|研究|比较|评估|总结)/i.test(text)) return 'analysis'
  return 'general'
}

function acceptanceFor(taskType) {
  const common = ['覆盖用户明确提出的全部要求', '结果可直接使用且没有已知阻塞问题']
  if (taskType === 'code') return [...common, '相关检查或测试通过', '没有覆盖任务范围外的用户改动']
  if (['document', 'presentation', 'spreadsheet'].includes(taskType)) {
    return [...common, '所需文件已生成并可下载', '内容和格式经过检查']
  }
  return [...common, '关键结论有依据且表达清楚']
}

function buildStepId(kind, index = 0) {
  return index > 0 ? `${kind}-${index}` : kind
}

export function buildInitialPlan(prompt = '') {
  const trimmed = String(prompt || '').trim()
  const title = trimmed || '未命名任务'
  const count = parseRequestedCount(trimmed)
  const taskType = detectTaskType(trimmed)
  const acceptance = acceptanceFor(taskType)
  const steps = [
    {
      id: buildStepId('plan'),
      title: '理解目标并制定执行计划',
      kind: 'plan',
      input: { taskType, acceptance },
    },
  ]

  if (count > 1) {
    for (let index = 1; index <= count; index += 1) {
      steps.push({
        id: buildStepId('item', index),
        title: `完成第 ${index} / ${count} 项`,
        kind: 'batch_item',
        input: { index, total: count, taskType, acceptance },
      })
    }
  } else {
    steps.push({
      id: buildStepId('execute'),
      title: '执行任务并产出结果',
      kind: 'execute',
      input: { taskType, acceptance },
    })
  }

  steps.push({
    id: buildStepId('verify'),
    title: '验证结果并修正问题',
    kind: 'verify',
    input: { taskType, acceptance },
  })
  steps.push({
    id: buildStepId('finalize'),
    title: '整理交付结果',
    kind: 'finalize',
    input: { taskType, acceptance },
  })
  return { title, prompt: trimmed, taskType, acceptance, steps }
}

function parseJsonObject(text = '') {
  const source = String(text || '').trim()
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim()
  for (const candidate of [fenced, source]) {
    if (!candidate) continue
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      const start = candidate.indexOf('{')
      const end = candidate.lastIndexOf('}')
      if (start < 0 || end <= start) continue
      try {
        const parsed = JSON.parse(candidate.slice(start, end + 1))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
      } catch {
        // Try the deterministic plan below.
      }
    }
  }
  return null
}

function normalizeModelPlan(prompt, exploration, rawPlan) {
  const fallback = buildInitialPlan(prompt)
  const parsed = parseJsonObject(rawPlan)
  if (!parsed) return null
  const allowedKinds = new Set(['execute', 'batch_item', 'verify', 'finalize'])
  const proposed = Array.isArray(parsed.steps) ? parsed.steps : []
  const normalized = proposed
    .filter((step) => step && typeof step === 'object' && allowedKinds.has(step.kind))
    .slice(0, 20)
    .map((step, index) => ({
      id: buildStepId(step.kind, index || 0),
      title: String(step.title || '').trim().slice(0, 160) || `执行步骤 ${index + 1}`,
      kind: step.kind,
      input: step.input && typeof step.input === 'object' && !Array.isArray(step.input)
        ? step.input
        : {},
    }))
  if (!normalized.length) return null
  if (!normalized.some((step) => step.kind === 'verify')) {
    normalized.push({ id: 'verify', title: '验证结果并修正问题', kind: 'verify', input: {} })
  }
  if (!normalized.some((step) => step.kind === 'finalize')) {
    normalized.push({ id: 'finalize', title: '整理并交付结果', kind: 'finalize', input: {} })
  }
  const acceptance = Array.isArray(parsed.acceptance)
    ? parsed.acceptance.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 12)
    : fallback.acceptance
  const taskType = String(parsed.taskType || fallback.taskType).trim().slice(0, 40) || fallback.taskType
  const planStep = {
    id: 'plan',
    title: '探索上下文并制定执行计划',
    kind: 'plan',
    input: {
      taskType,
      acceptance,
      exploration: String(exploration || '').trim().slice(0, 12_000),
      planningSource: 'model',
    },
  }
  return {
    title: String(parsed.title || fallback.title).trim().slice(0, 200) || fallback.title,
    prompt: fallback.prompt,
    taskType,
    acceptance,
    steps: [planStep, ...normalized],
    planningSource: 'model',
  }
}

/**
 * Two-pass planner: the first model pass explores constraints and likely
 * project context, and the second pass turns those findings into a durable
 * structured plan. The old deterministic planner remains the availability
 * fallback when no provider is configured or the response is malformed.
 */
export async function buildExploredPlan(prompt = '', { runModel, exploreModel = runModel, userId } = {}) {
  const fallback = buildInitialPlan(prompt)
  if (typeof runModel !== 'function' || typeof exploreModel !== 'function') {
    return { ...fallback, planningSource: 'fallback' }
  }
  try {
    const exploration = await exploreModel({
      phase: 'explore',
      userId,
      messages: [
        {
          role: 'system',
          content: 'You are the exploration pass for an autonomous task planner. Analyze the request before planning. Identify relevant project areas, dependencies, constraints, risks, unknowns, and concrete verification targets. Do not propose a final step list yet. Be concise and factual.',
        },
        { role: 'user', content: String(prompt || '').trim() },
      ],
    })
    const planText = await runModel({
      phase: 'plan',
      userId,
      messages: [
        {
          role: 'system',
          content: [
            'Create a concrete execution plan using the exploration notes.',
            'Return JSON only with: title, taskType, acceptance (string array), and steps.',
            'Each step must contain title, kind, and optional input. Allowed kinds: execute, batch_item, verify, finalize.',
            'Use 2-12 steps, keep steps independently verifiable, include verification and final delivery.',
          ].join(' '),
        },
        { role: 'user', content: `Request:\n${String(prompt || '').trim()}\n\nExploration notes:\n${String(exploration || '')}` },
      ],
    })
    return normalizeModelPlan(prompt, exploration, planText) || { ...fallback, planningSource: 'fallback' }
  } catch (error) {
    return {
      ...fallback,
      planningSource: 'fallback',
      planningError: String(error?.message || error || '').slice(0, 500),
    }
  }
}

export function getRequestedBatchSize(prompt = '') {
  return parseRequestedCount(prompt)
}

export function getTaskType(prompt = '') {
  return detectTaskType(prompt)
}
