/**
 * Plan-Act-Reflect 思维型工具(M3)。
 *
 * 已有基建:
 *   - manage_todos    → Plan 阶段(模型自己维护 todo 清单)
 *   - 各种工具调用    → Act 阶段
 *
 * 缺口:
 *   - 没有 Reflect 阶段 → 模型堆工具调用不复盘,容易走错路也不知道
 *   - 没有 Clarification → 模型遇阻只能瞎猜或编造,而不是停下问用户
 *
 * 本模块新增两个工具(纯输出型,无副作用):
 *   - reflect(observation, what_worked?, what_didnt?, next_step, confidence)
 *     模型在每步关键决策后调一次,产出结构化反思事件,
 *     前端 UI 可单独渲染(SubagentCard 风格),也进 tool_audit 可审计
 *   - request_clarification(question, why, blocker_kind)
 *     模型遇到歧义/缺信息/权限不足时,显式问用户而非编造
 *     调用后服务端停止当轮 toolsLoop,事件丢给前端,等用户回复继续
 *
 * 与 manage_todos 配合的推荐 system prompt 提示:
 *   "面对多步任务:先 manage_todos 拆分 → 每步动手前简短 reflect 复盘
 *    上一步的事实/收获/下一步预期 → 遇到无法独立判断的歧义,调
 *    request_clarification 问清楚再继续,不要编造。"
 *
 * 设计权衡:
 *   - 全部纯函数式,不写 DB(避免给 jobRuntime 增依赖);
 *     副作用(写 event、暂停 loop)由 caller 解读返回值实现
 *   - reflect 返回 { ok, accepted } 仅作 ack,让模型知道收到了
 *   - request_clarification 返回 { ok, paused: true, question },
 *     caller(toolsLoop)看到 paused → 立刻 break 出循环,把 question
 *     推到 SSE 上让前端弹"用户输入框"
 */

import { sanitizeSuggestedDirectoryPath } from '../../shared/suggestedDirectoryPath.js'
import {
  findAuthorizedDirectoryGrant,
  isExistingLocalDirectory,
} from '../services/localFileAccessService.js'

const MAX_TEXT = 4000
const MAX_SHORT = 600

function badReq(msg, status = 400) {
  const err = new Error(msg)
  err.statusCode = status
  return err
}

function clampStr(v, max) {
  if (typeof v !== 'string') return ''
  return v.length > max ? v.slice(0, max) : v
}

export const VALID_CONFIDENCE = ['low', 'medium', 'high']
export const VALID_BLOCKER_KINDS = ['missing_info', 'ambiguous_intent', 'permission', 'risk_decision', 'other']
export const VALID_DIRECTORY_ACCESS_MODES = ['read_only', 'read_write']

export function reflectTool({
  observation,
  what_worked = null,
  what_didnt = null,
  next_step,
  confidence = 'medium',
} = {}) {
  if (typeof observation !== 'string' || !observation.trim()) {
    throw badReq('observation 必填:简述刚才动作的事实结果')
  }
  if (typeof next_step !== 'string' || !next_step.trim()) {
    throw badReq('next_step 必填:写下下一步要做什么(或 "done" 表示任务完成)')
  }
  if (!VALID_CONFIDENCE.includes(confidence)) {
    throw badReq(`confidence 必须是 ${VALID_CONFIDENCE.join('/')}`)
  }
  const reflection = {
    observation: clampStr(observation, MAX_TEXT).trim(),
    what_worked: what_worked ? clampStr(what_worked, MAX_SHORT).trim() : null,
    what_didnt: what_didnt ? clampStr(what_didnt, MAX_SHORT).trim() : null,
    next_step: clampStr(next_step, MAX_SHORT).trim(),
    confidence,
    is_done: /^\s*done\s*$/i.test(next_step),
    timestamp: Date.now(),
  }
  return { ok: true, accepted: true, reflection }
}

export function requestClarificationTool({
  question,
  why = null,
  blocker_kind = 'missing_info',
  options = null,
} = {}) {
  if (typeof question !== 'string' || !question.trim()) {
    throw badReq('question 必填:写下你需要用户回答的具体问题')
  }
  if (!VALID_BLOCKER_KINDS.includes(blocker_kind)) {
    throw badReq(`blocker_kind 必须是 ${VALID_BLOCKER_KINDS.join('/')}`)
  }
  let normalizedOptions = null
  if (Array.isArray(options)) {
    normalizedOptions = options
      .filter((o) => typeof o === 'string' && o.trim())
      .slice(0, 8)
      .map((o) => clampStr(o, 200).trim())
    if (normalizedOptions.length === 0) normalizedOptions = null
  }
  return {
    ok: true,
    paused: true, // ★ 关键标志:toolsLoop 看到 paused → 中断
    clarification: {
      question: clampStr(question, MAX_TEXT).trim(),
      why: why ? clampStr(why, MAX_SHORT).trim() : null,
      blocker_kind,
      options: normalizedOptions,
      timestamp: Date.now(),
    },
  }
}

export function requestDirectoryTool({
  purpose,
  access_mode = 'read_only',
  suggested_path = null,
} = {}, {
  userId = null,
  resolveDirectoryGrant = findAuthorizedDirectoryGrant,
  directoryPathExists = isExistingLocalDirectory,
} = {}) {
  if (typeof purpose !== 'string' || !purpose.trim()) {
    throw badReq('purpose 必填:说明为什么需要用户授权目录')
  }
  if (!VALID_DIRECTORY_ACCESS_MODES.includes(access_mode)) {
    throw badReq(`access_mode 必须是 ${VALID_DIRECTORY_ACCESS_MODES.join('/')}`)
  }
  const normalizedPurpose = clampStr(purpose, MAX_SHORT).trim()
  const rawSuggestedPath = suggested_path ? clampStr(suggested_path, MAX_SHORT).trim() : ''
  const suggestedPath = sanitizeSuggestedDirectoryPath(rawSuggestedPath, {
    pathExists: directoryPathExists,
  }) || null
  if (userId && suggestedPath && typeof resolveDirectoryGrant === 'function') {
    let existingGrant = null
    try {
      existingGrant = resolveDirectoryGrant({
        userId,
        rawPath: suggestedPath,
        accessMode: access_mode,
      })
    } catch {
      // Authorization lookup failures fail closed by keeping the pause flow.
    }
    if (existingGrant) {
      return {
        ok: true,
        paused: false,
        already_authorized: true,
        authorization: {
          path: existingGrant.path,
          resource_type: 'directory',
          access_mode: existingGrant.accessMode,
        },
        message: `Directory access is already authorized for ${existingGrant.path}. Continue the original task without requesting authorization again.`,
      }
    }
  }
  return {
    ok: true,
    paused: true,
    clarification: {
      question: 'Please choose and authorize a directory so this task can continue.',
      why: normalizedPurpose,
      blocker_kind: 'permission',
      request_type: 'directory',
      access_mode,
      suggested_path: suggestedPath || null,
      purpose: normalizedPurpose,
      timestamp: Date.now(),
    },
  }
}

export function sleepUntilTool({ wake_at, reason = null } = {}, { now = Date.now() } = {}) {
  const wakeAt = typeof wake_at === 'number' ? wake_at : Date.parse(String(wake_at || ''))
  if (!Number.isFinite(wakeAt)) throw badReq('wake_at must be a valid ISO date or Unix millisecond timestamp')
  if (wakeAt <= now) throw badReq('wake_at must be in the future')
  if (wakeAt - now > 366 * 24 * 60 * 60 * 1000) throw badReq('wake_at must be within 366 days')
  return {
    ok: true,
    paused: true,
    clarification: {
      question: `Sleeping until ${new Date(wakeAt).toISOString()}`,
      why: reason ? clampStr(reason, MAX_SHORT).trim() : null,
      blocker_kind: 'scheduled_wake',
      options: null,
      wakeAt,
      timestamp: now,
    },
  }
}

/* ─── tool spec + dispatcher ─── */

export const AGENTIC_TOOL_SPECS = [
  {
    type: 'function',
    function: {
      name: 'reflect',
      description: '★ 在多步任务里每完成一个关键动作后调一次,简短复盘(不超过 3 行)→ 让你下一步决策更准.observation 写刚才发生的事实(成功/失败/输出要点);what_worked / what_didnt 选填;next_step 写下一步具体要做什么,或 "done" 表示任务完成;confidence ∈ low|medium|high.这个工具没有副作用,只产出可观察的反思事件.',
      parameters: {
        type: 'object',
        properties: {
          observation: { type: 'string', description: '事实(刚才工具调用的结果要点,不要编造)' },
          what_worked: { type: 'string', description: '选填:有效的部分' },
          what_didnt: { type: 'string', description: '选填:没奏效或意外的部分' },
          next_step: { type: 'string', description: '下一步具体行动(或 "done")' },
          confidence: { type: 'string', enum: VALID_CONFIDENCE },
        },
        required: ['observation', 'next_step'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'request_clarification',
      description: '★ 遇到歧义/缺信息/需用户授权/有风险决策时调它,而不是编造或瞎选.调用后当轮 toolsLoop 会停下来,等用户回答了再继续.不要用它问"你想要什么"这种宽泛问题,问具体可决策的细节.options 给 2-5 个选项可显著加速回复.工具列表是当前轮次能力的唯一事实来源:不要用此工具声称已列出的执行、写入或搜索工具不存在;参数校验失败时应修正参数并重试.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '具体问题(一两句话)' },
          why: { type: 'string', description: '选填:为什么需要这个信息' },
          blocker_kind: { type: 'string', enum: VALID_BLOCKER_KINDS },
          options: {
            type: 'array',
            description: '选填:给用户的候选选项(最多 8 个)',
            items: { type: 'string' },
          },
        },
        required: ['question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'request_directory',
      description: 'Pause this durable job and ask the user to choose and explicitly authorize a local directory. Use read_write when the task must create, edit, patch, rename, or delete files; use read_only only for inspection. Use this instead of guessing alternate subdirectories after a permission error. The same job resumes after authorization.',
      parameters: {
        type: 'object',
        properties: {
          purpose: { type: 'string', description: 'Why this task needs access to the directory.' },
          access_mode: { type: 'string', enum: VALID_DIRECTORY_ACCESS_MODES, default: 'read_only', description: 'Request the least privilege needed. File-changing tasks require read_write; inspection-only tasks use read_only. Defaults to read_only.' },
          suggested_path: { type: 'string', description: 'Optional path hint shown to the user; it is never authorized automatically.' },
        },
        required: ['purpose'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sleep_until',
      description: 'Pause this same durable job until a future time, then continue with the same conversation and tool state. Use this for follow-ups or waiting on an external condition; do not create a separate cron job.',
      parameters: {
        type: 'object',
        properties: {
          wake_at: { type: 'string', description: 'Future ISO-8601 date/time including timezone.' },
          reason: { type: 'string', description: 'What to continue or check after waking.' },
        },
        required: ['wake_at'],
      },
    },
  },
]

export async function dispatchAgenticTool(name, args, context = {}) {
  switch (name) {
    case 'reflect': return reflectTool(args || {})
    case 'request_clarification': return requestClarificationTool(args || {})
    case 'request_directory': return requestDirectoryTool(args || {}, context)
    case 'sleep_until': return sleepUntilTool(args || {})
    default: throw new Error(`unknown agentic tool: ${name}`)
  }
}

/**
 * 给现有 toolsLoop 用的便捷判定:如果工具返回带 paused=true,
 * caller 应当 break 出循环并把 result.clarification 推给前端/用户.
 */
export function isLoopPauseResult(toolResult) {
  return !!(toolResult && typeof toolResult === 'object' && toolResult.paused === true && toolResult.clarification)
}
