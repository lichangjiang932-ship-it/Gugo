import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useNavigate } from '../../lib/router.jsx'
import LeftRail from '../../components/LeftRail'
import { useAppContext } from '../../store/AppContext'
import { SKILLS, getSkillSystemPrompt } from '../../data.js'
import { buildUserContentWithAttachments, describeAttachmentPrompt } from '../../lib/attachments.js'
import { callModelThroughProxyStream, getModelStatus, summarizeSessionTitle } from '../../lib/modelClient.js'
import { buildToolSpecs, buildToolSpecsAsync, executeToolCall, resolveToolsForMode, setCachedApprovalSettings } from '../../lib/tools/index.js'
import { readStoredModel, resolveInitialModel, resolveSessionModel, writeStoredModel } from '../../lib/modelSelection.js'
import { isLoggedInLocally } from '../../lib/accountClient.js'
import { useActiveAgent } from '../../agents/activeAgentContext.js'
import { listSkills } from '../../lib/skillClient.js'
import { listLocalSkills, mergeRuntimeSkills } from '../../lib/localSkills.js'
import { listPromptTemplatesApi, getPromptTemplateContentApi, renderPromptTemplate } from '../../lib/pluginClient.js'
import { createSlashCommandRegistry, normalizeSlashCommandName, parseSlashCommandInput } from '../../lib/slashCommandRegistry.js'
import { CORE_SLASH_COMMANDS, registerCoreSlashCommands } from '../../lib/slashCoreCommands.js'
import { inferSkillIdFromPrompt, parseSkillCommand } from '../../lib/skillCommands.js'
import { TASK_STATUS, TOOL_CALL_STATUS, HISTORY_STATUS } from '../../store/taskStatus.js'
import ChatMessages from './ChatMessages'
import ChatComposer from './ChatComposer'
import RightPreviewPane from './RightPreviewPane'
import useInputHistory from './useInputHistory.js'
import ApplyPatchApprovalModal from '../../components/ApplyPatchApprovalModal'
import ToolApprovalCard from '../../components/ToolApprovalCard.jsx'
import { fetchApprovalSettings, updateApprovalSettings } from '../../lib/approvalClient.js'
import { useToast } from '../../components/Toast.jsx'
import { useT } from '../../i18n/I18nProvider.jsx'
import { buildArtifactPreview } from '../../lib/artifactPreview.js'
import { exportSession } from '../../lib/sessionExport.js'
import { fetchCompactionArchive } from '../../lib/compactionClient.js'
import { trimHistoryWithHysteresis } from '../../lib/historyWindow.js'
import { StreamingToolExecutor } from '../../lib/StreamingToolExecutor.js'
import { parseChatAttachments } from '../../lib/chatAttachmentParser.js'
import { readContextUsageVisible, writeContextUsageVisible } from '../../lib/chatUiPreferences.js'
import {
  getSpeechRecognitionConstructor,
  mergeSpeechTranscript,
  readSpeechRecognitionEvent,
  resolveSpeechRecognitionLanguage,
} from '../../lib/voiceRecognition.js'
import {
  artifactTypeForSkill,
  buildAssistantToolCallsMessage,
  buildChatFailureMessage,
  buildToolRunSummary,
  clipChatToolContent,
  createChatToolLoopGuard,
  filterToolNamesForSkill,
  getVisibleModelErrorMessage,
  isStreamingSafeToolCall,
  normalizeChatToolCalls,
  shouldForceChatTextWrapUp,
  shouldStopAfterArtifactTool,
  validateChatToolCallAllowed,
} from '../../lib/chatFlowGuards.js'

// 死循环护栏。正常任务(哪怕读完整个项目再动手改)也远到不了这个量级,
// 它防的是模型反复调同一个工具停不下来,不是给工作设预算。
// ★ 500 → 2000:和后端 JOB_MAX_ITERS 对齐。前端有用户盯着、随时能点停止,
// 护栏可以比后端更松。真正拦重复调用的是 createChatToolLoopGuard。
const RUNAWAY_ROUND_GUARD = 2000
const EMPTY_MESSAGES = []

/**
 * 用户是不是主动点了「停止」。
 *
 * ★ 原来到处比对 `err.message === '已停止生成'`,但真实的 AbortController
 * 在 reader.read() 期间抛的是 DOMException("The user aborted a request."),
 * 中文 message 只在极少数路径上成立 —— 于是按停止键通常会走到失败分支:
 * 弹错误 toast、把「模型调用失败」塞进用户消息、写一条 FAILED 历史。
 * 按 name/code 判断才靠谱。
 */
function isUserStopped(err) {
  return err?.name === 'AbortError' || err?.code === 'USER_STOPPED' || err?.message === '已停止生成'
}

function promptTemplateCommandName(tpl) {
  const byName = normalizeSlashCommandName(tpl?.name)
  return byName || normalizeSlashCommandName(tpl?.id)
}

export default function ChatSplit() {
  const navigate = useNavigate()
  const { state, dispatch } = useAppContext()
  const toast = useToast()
  const { t, lang } = useT()
  const { activeAgentId: globalActiveAgentId } = useActiveAgent()
  const [input, setInput] = useState('')
  const [modelOptions, setModelOptions] = useState([])
  // 0 = 不限轮数(默认)。只有服务端显式配了正数才封顶。
  const [toolMaxRounds, setToolMaxRounds] = useState(0)
  const [selectedModel, setSelectedModel] = useState('')
  const [runtimeSkills, setRuntimeSkills] = useState(() => mergeRuntimeSkills(listLocalSkills(), SKILLS))
  // Phase 2 S4: prompt-template plugins 仍可通过手动输入 slash 命令调用
  const [promptTemplates, setPromptTemplates] = useState([])
  const [workbenchMessage, setWorkbenchMessage] = useState('')
  // ★ #18: workbench 提示 5s 自动消失,避免长期残留
  useEffect(() => {
    if (!workbenchMessage) return undefined
    const t = setTimeout(() => setWorkbenchMessage(''), 5000)
    return () => clearTimeout(t)
  }, [workbenchMessage])
  const [attachments, setAttachments] = useState([])
  const [isGenerating, setIsGenerating] = useState(false)
  const [voiceState, setVoiceState] = useState('idle')
  const [showContextUsage, setShowContextUsage] = useState(readContextUsageVisible)
  const [showContextPanel, setShowContextPanel] = useState(false)
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [applyPatchApproval, setApplyPatchApproval] = useState({ open: false, changes: [], busy: false })
  // ★ 通用工具审批:决策就在对话里做,不用切页面(对齐 Claude Code)
  const [toolApproval, setToolApproval] = useState({ open: false, request: null, busy: false })
  const toolApprovalResolveRef = useRef(null)
  const [approvalSettings, setApprovalSettings] = useState({ mode: 'normal', rememberedTools: [] })
  const [contextSystemPrompts, setContextSystemPrompts] = useState({})
  const abortCtrlRef = useRef(null)
  // ★ 流被截断后的续写状态。本地模型跑长回答时中断是常态,
  // 让用户接着写比整轮重发省太多。
  const [resumeState, setResumeState] = useState(null)
  const applyPatchApprovalResolveRef = useRef(null)

  const resolveApplyPatchApproval = useCallback((approved) => {
    const resolve = applyPatchApprovalResolveRef.current
    applyPatchApprovalResolveRef.current = null
    setApplyPatchApproval((current) => ({ ...current, busy: true }))
    if (resolve) resolve(approved)
    if (typeof window !== 'undefined') {
      window.setTimeout(() => setApplyPatchApproval({ open: false, changes: [], busy: false }), 0)
    } else {
      setApplyPatchApproval({ open: false, changes: [], busy: false })
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const approvalGateway = (changes) => new Promise((resolve) => {
      if (applyPatchApprovalResolveRef.current) {
        applyPatchApprovalResolveRef.current(false)
      }
      applyPatchApprovalResolveRef.current = resolve
      setApplyPatchApproval({
        open: true,
        changes: Array.isArray(changes) ? changes : [],
        busy: false,
      })
    })
    window.__applyPatchApproval = approvalGateway
    return () => {
      if (window.__applyPatchApproval === approvalGateway) {
        delete window.__applyPatchApproval
      }
      if (applyPatchApprovalResolveRef.current) {
        applyPatchApprovalResolveRef.current(false)
        applyPatchApprovalResolveRef.current = null
      }
    }
  }, [])
  // ★ 通用工具审批闸口:executeToolCall 调 window.__toolApprovalGate,
  // 这里把它变成对话里的一张卡,用户点完 promise 才 resolve。
  const resolveToolApproval = useCallback((decision) => {
    const resolve = toolApprovalResolveRef.current
    toolApprovalResolveRef.current = null
    setToolApproval((cur) => ({ ...cur, busy: true }))
    if (resolve) resolve(decision)
    if (typeof window !== 'undefined') {
      window.setTimeout(() => setToolApproval({ open: false, request: null, busy: false }), 0)
    } else {
      setToolApproval({ open: false, request: null, busy: false })
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const gate = (request) => new Promise((resolve) => {
      // 上一张卡还没决策就来了新的:按拒绝处理,避免 promise 泄漏
      if (toolApprovalResolveRef.current) toolApprovalResolveRef.current({ approved: false })
      toolApprovalResolveRef.current = resolve
      setToolApproval({ open: true, request, busy: false })
    })
    window.__toolApprovalGate = gate
    return () => {
      if (window.__toolApprovalGate === gate) delete window.__toolApprovalGate
      if (toolApprovalResolveRef.current) {
        toolApprovalResolveRef.current({ approved: false })
        toolApprovalResolveRef.current = null
      }
    }
  }, [])

  // 拉审批档位 + 「总是允许」清单,喂给 executeToolCall 的本地缓存
  useEffect(() => {
    let alive = true
    const load = () => {
      fetchApprovalSettings()
        .then((s) => {
          if (!alive) return
          // 双保险:客户端已归一化,这里再挡一道,绝不让 null 进 state
          const safe = s && typeof s === 'object' ? s : { mode: 'normal', rememberedTools: [] }
          setApprovalSettings(safe)
          setCachedApprovalSettings(safe)
        })
        .catch(() => { /* 拉不到就用默认的最严档位 */ })
    }
    Promise.resolve().then(load)
    return () => { alive = false }
  }, [])

  const changeApprovalMode = useCallback(async (mode) => {
    const prev = approvalSettings
    const next = { ...approvalSettings, mode }
    setApprovalSettings(next)
    setCachedApprovalSettings(next)
    try {
      const saved = await updateApprovalSettings({ mode })
      const safe = saved && typeof saved === 'object' ? saved : next
      setApprovalSettings(safe)
      setCachedApprovalSettings(safe)
    } catch (err) {
      setApprovalSettings(prev)
      setCachedApprovalSettings(prev)
      toast.error({ title: t('errors.saveFailed'), body: err.message })
    }
  }, [approvalSettings, toast, t])

  const recognitionRef = useRef(null)
  const stateRef = useRef(state)
  const newDraftVersionRef = useRef(state.newDraftVersion)

  useEffect(() => () => {
    recognitionRef.current?.abort?.()
    recognitionRef.current = null
  }, [])

  const activeSession = state.sessions.find((s) => s.id === state.activeSessionId)
  const activeSessionId = activeSession?.id || null
  // 阶段 6: session sticky agent。优先用 session.agentId，没设则 fallback 全局。
  const sessionAgentId = activeSession?.agentId || null
  const effectiveAgentId = sessionAgentId || globalActiveAgentId || null
  const messages = activeSession?.messages ?? EMPTY_MESSAGES
  const navigateInputHistory = useInputHistory({
    messages,
    input,
    setInput,
    sessionId: activeSessionId,
  })

  const contextToolSpecs = useMemo(() => {
    try {
      return buildToolSpecs(resolveToolsForMode(state.toolsConfig || {}))
    } catch {
      return []
    }
  }, [state.toolsConfig])
  const effectiveSelectedModel = resolveSessionModel(modelOptions, {
    sessionModel: activeSession?.modelName,
    selectedModel,
    storedModel: readStoredModel(),
  }) || activeSession?.modelName || selectedModel || readStoredModel()
  const selectedContextWindow = modelOptions.find((model) => model.name === effectiveSelectedModel)?.contextWindow || 1_000_000
  const setContextUsageVisible = useCallback((visible) => {
    const next = Boolean(visible)
    setShowContextUsage(next)
    if (!next) setShowContextPanel(false)
  }, [])
  useEffect(() => {
    writeContextUsageVisible(showContextUsage)
  }, [showContextUsage])
  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    if (newDraftVersionRef.current === state.newDraftVersion) return
    newDraftVersionRef.current = state.newDraftVersion
    setInput('')
    setAttachments([])
    setWorkbenchMessage('')
  }, [state.newDraftVersion])

  const setModelForActiveSession = useCallback((modelName) => {
    const normalized = String(modelName || '').trim()
    if (!normalized) return
    setSelectedModel(normalized)
    writeStoredModel(normalized)
    if (activeSessionId) {
      dispatch({
        type: 'SET_SESSION_MODEL',
        payload: { sessionId: activeSessionId, modelName: normalized },
      })
    }
  }, [activeSessionId, dispatch])

  const slashRegistry = useMemo(() => {
    const registry = createSlashCommandRegistry()
    registerCoreSlashCommands(registry, { t })
    for (const skill of runtimeSkills || []) {
      if (!skill?.id) continue
      if (state.skillConfigs?.[skill.id]?.enabled === false) continue
      const name = normalizeSlashCommandName(skill.id)
      if (!name || CORE_SLASH_COMMANDS.includes(name)) continue
      registry.register({
        name,
        description: skill.name || skill.desc || skill.description || skill.id,
        hint: '<prompt>',
        kind: 'skill',
        handler: async () => `/${name} `,
        meta: { displayName: skill.name || skill.id },
      }, 'core')
    }

    for (const tpl of promptTemplates || []) {
      if (!tpl?.id) continue
      let name = promptTemplateCommandName(tpl)
      if (!name) continue
      if (registry.getCommand(name)?.source === 'core') {
        name = normalizeSlashCommandName(tpl.id)
      }
      if (!name || registry.getCommand(name)?.source === 'core') continue
      registry.register({
        name,
        description: tpl.description || tpl.name || tpl.id,
        kind: 'prompt-template',
        handler: async () => {
          try {
            const content = await getPromptTemplateContentApi(tpl.id)
            if (!content) return `# ${tpl.name || tpl.id}\n`
            return renderPromptTemplate(content, {
              name: tpl.name || '',
              description: tpl.description || '',
            })
          } catch {
            return `# ${tpl.name || tpl.id}\n`
          }
        },
        meta: { pluginId: tpl.id, displayName: tpl.name || tpl.id },
      }, 'plugin')
    }
    return registry
  }, [promptTemplates, runtimeSkills, state.skillConfigs, t])

  useEffect(() => {
    let cancelled = false
    async function loadModels() {
      try {
        const status = await getModelStatus()
        if (cancelled) return
        const models = status.models?.length
          ? status.models
          : status.modelName
          ? [{ name: status.modelName, multiplier: 1, active: true }]
          : []
        setModelOptions(models)
        setSelectedModel((current) => resolveInitialModel(models, current || readStoredModel()))
        // 后端权威决定工具循环轮数;status 拿不到字段时维持默认 5
        if (Number.isFinite(status.toolMaxRounds) && status.toolMaxRounds >= 0 && status.toolMaxRounds <= 1000) {
          setToolMaxRounds(status.toolMaxRounds)
        }
      } catch {
        if (!cancelled) setModelOptions([])
      }
    }
    loadModels()
    window.addEventListener('model-providers:changed', loadModels)
    return () => {
      cancelled = true
      window.removeEventListener('model-providers:changed', loadModels)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    listSkills()
      .then(({ skills }) => {
        if (!cancelled && Array.isArray(skills) && skills.length) {
          setRuntimeSkills(mergeRuntimeSkills(listLocalSkills(), skills))
        }
      })
      .catch((err) => {
        console.warn('[ChatSplit] 无法加载远程技能，使用内置技能:', err?.message || err)
        if (!cancelled) setRuntimeSkills(mergeRuntimeSkills(listLocalSkills(), SKILLS))
      })
    return () => { cancelled = true }
  }, [])

  // Phase 2 S4: 拉 prompt-template plugins 进 slash 菜单
  useEffect(() => {
    let cancelled = false
    listPromptTemplatesApi()
      .then((list) => {
        if (!cancelled && Array.isArray(list)) setPromptTemplates(list)
      })
      .catch(() => {
        if (!cancelled) setPromptTemplates([])
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (state.draftInput) {
      const nextInput = state.draftInput
      const timer = window.setTimeout(() => setInput(nextInput), 0)
      dispatch({ type: 'SET_DRAFT_INPUT', payload: '' })
      return () => window.clearTimeout(timer)
    }
    return undefined
  }, [state.draftInput, dispatch])

  // ★ 切换会话时中断正在进行的模型流。
  //
  // 原来这个 effect 在**首次挂载**时也会跑一次 abort —— 组件因为任何原因
  // 重挂载(路由回退、HMR、父组件 key 变化)都会把正在跑的流杀掉,
  // 用户看到的是「说到一半突然停了」。
  // 现在只在 sessionId 真正从 A 变成 B 时才中断,首次挂载不动。
  const abortSessionIdRef = useRef(state.activeSessionId)
  useEffect(() => {
    if (abortSessionIdRef.current !== state.activeSessionId) {
      abortSessionIdRef.current = state.activeSessionId
      // 用 abort 中断上游请求，模型流自然结束会走 finally 清理
      abortCtrlRef.current?.abort()
    }
  }, [state.activeSessionId])

  // 组件真正卸载时才无条件中断,避免留下没人消费的流
  useEffect(() => () => abortCtrlRef.current?.abort(), [])

  // #13 切会话保草稿:
  //   - 切走前:把当前 input 写入 sessionDrafts[旧 id]
  //   - 切到新 id:从 sessionDrafts[新 id] 拉草稿,没草稿就清空
  // 用 ref 拿"上一次的 sessionId",避免每次 input 变就 dispatch
  const prevSessionIdRef = useRef(state.activeSessionId)
  const inputRef = useRef(input)
  useEffect(() => { inputRef.current = input }, [input])

  useEffect(() => {
    const prevId = prevSessionIdRef.current
    const nextId = state.activeSessionId
    if (prevId === nextId) return
    if (prevId) {
      // 把切走前那一刻的输入塞回 store
      dispatch({ type: 'SET_SESSION_DRAFT', payload: { sessionId: prevId, text: inputRef.current } })
    }
    const nextDraft = (state.sessionDrafts || {})[nextId] || ''
    setInput(nextDraft)
    prevSessionIdRef.current = nextId
    // sessionDrafts 在依赖里会让此 effect 在草稿写入时重跑;但 prevId === nextId 直接 return
    // 所以不会引发循环
  }, [state.activeSessionId, state.sessionDrafts, dispatch])

  // 输入过程中持续保存当前会话草稿；刷新页面时不再依赖“先切换会话”才能落盘。
  useEffect(() => {
    const sessionId = state.activeSessionId
    if (!sessionId) return undefined
    const timer = window.setTimeout(() => {
      dispatch({ type: 'SET_SESSION_DRAFT', payload: { sessionId, text: input } })
    }, 250)
    return () => window.clearTimeout(timer)
  }, [dispatch, input, state.activeSessionId])

  /* ── send flow ── */
  const triggerSendFlow = useCallback(
    async (content, explicitAttachments = null, historyLimit = null) => {
      if (isGenerating) return
      let sessionId = state.activeSessionId
      let activeSession = state.sessions.find((s) => s.id === sessionId)
      if (!activeSession) {
        sessionId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
        activeSession = { id: sessionId, title: '新对话', messages: [], agentId: effectiveAgentId || null }
        abortSessionIdRef.current = sessionId
        dispatch({
          type: 'NEW_SESSION',
          payload: { id: sessionId, title: '新对话', agentId: effectiveAgentId || null },
        })
      }
      const modelName = resolveSessionModel(modelOptions, {
        sessionModel: activeSession?.modelName,
        selectedModel,
        storedModel: readStoredModel(),
      }) || activeSession?.modelName || selectedModel || readStoredModel() || resolveInitialModel(modelOptions)
      if (activeSession?.id && modelName && activeSession.modelName !== modelName) {
        dispatch({
          type: 'SET_SESSION_MODEL',
          payload: { sessionId: activeSession.id, modelName },
        })
      }
      // ★ 修复: 保留 tool 消息，让模型能回顾上一轮工具结果
      // 但截断过长内容防止 token 溢出
      //
      // ★ 缓存: 用滞回窗口而不是每轮 slice(-20)。固定 slice(-20) 在会话超过 20 条后
      // 每轮都丢掉最老一条,字节前缀每次都变 → 上游前缀缓存从第 21 轮起彻底失效。
      // 改成「超过 HIGH 才裁,一裁裁到 LOW」,前缀能连续稳定约 10 轮再变一次。
      const sourceMessages = historyLimit == null
        ? (activeSession?.messages || [])
        : (activeSession?.messages || []).slice(0, historyLimit)
      const eligible = sourceMessages
        .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool')
      const historyMessages = trimHistoryWithHysteresis(eligible)
        .map((m) => {
          let content = typeof m.content === 'string' ? m.content : ''
          // tool 消息通常有大量 JSON，截断
          if (m.role === 'tool' && content.length > 2000) {
            content = content.slice(0, 2000) + '\n...[已截断]'
          }
          return { role: m.role, content, name: m.name || undefined, tool_call_id: m.tool_call_id || undefined }
        })
      dispatch({ type: 'SEND_MESSAGE', payload: { content, attachments: explicitAttachments } })
      setWorkbenchMessage('')

      const isFreshSession = activeSession && (activeSession.title === '新对话' || activeSession.title.startsWith('新会话'))
      if (isFreshSession) {
        // ★ #8: 立即兜底用截断, 让用户看到响应; 然后异步用 AI 覆盖一次
        const fallback = content.slice(0, 18).trim() || '新对话'
        const initialTitle = fallback.length > 15 ? fallback.slice(0, 15) + '…' : fallback
        const sessionIdSnapshot = sessionId
        dispatch({ type: 'UPDATE_SESSION_TITLE_FOR', payload: { sessionId, title: initialTitle } })
        // fire-and-forget — 拿到 AI 标题后再 dispatch 一次
        // 不在回调里读取闭包 state, 完全依赖 reducer 做 onlyIfMatches 校验,
        // 避免闭包 state 陈旧导致误判。
        summarizeSessionTitle({ firstUserContent: content, modelName })
          .then((aiTitle) => {
            if (!aiTitle) return
            dispatch({ type: 'UPDATE_SESSION_TITLE_FOR', payload: { sessionId: sessionIdSnapshot, title: aiTitle, onlyIfMatches: initialTitle } })
          })
          .catch(() => {/* fallback 已经显示了 */})
      }

      const parsedSkill = parseSkillCommand(content)
      const requestedSkillId = parsedSkill.skillId || inferSkillIdFromPrompt(content)
      const requestedSkill = requestedSkillId ? runtimeSkills.find((s) => s.id === requestedSkillId) : null
      const skill = requestedSkill && state.skillConfigs?.[requestedSkill.id]?.enabled !== false
        ? requestedSkill
        : null
      const skillId = skill?.id || null
      const userPrompt = parsedSkill.skillId && skill ? parsedSkill.userPrompt : content
      const taskName = skill?.name || '通用任务'

      if (!isLoggedInLocally()) {
        dispatch({ type: 'RECEIVE_MESSAGE', payload: '请登录账户' })
        toast.error(t('errors.loginRequired'))
        return
      }

      // 提前生成 task ID,后续 UPDATE_TASK / REMOVE_TASK 用得上
      const taskId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`

      // ★ 这两个必须声明在**最外层 try 之外** —— 下面 1155 行的 catch 要读它们。
      //
      // 中途失败(network error / 上游 5xx)时,前面几十步工具调用的成果
      // 不能静默作废:用户至少要知道"读过什么、改到哪了、要不要回滚"。
      // 声明在 try 内的话 catch 里是 ReferenceError,整条兜底链路直接断掉。
      let toolArtifact = null
      const executedToolCalls = []

      try {
        const messages = []
        // ★ 缓存: 技能 system prompt 拆成「稳定基底」和「随本轮输入变化的规划器」两段。
        // 基底放最前面(可进缓存前缀),规划器放到 history 之后、紧邻用户消息
        // —— 它本来就是为这一轮生成的,放前面等于每轮亲手炸掉整个前缀。
        const skillPrompt = skillId
          ? getSkillSystemPrompt(skillId, state.skillConfigs, runtimeSkills, { userPrompt, split: true })
          : ''
        const stablePrompt = typeof skillPrompt === 'string' ? skillPrompt : skillPrompt.base
        const volatilePrompt = typeof skillPrompt === 'string' ? '' : skillPrompt.perTurn
        if (stablePrompt) messages.push({ role: 'system', content: stablePrompt })
        // ★ 没走 skill = 用户没点名要产物。明确禁止模型自作主张生成
        // PPT/Excel/网页 —— 以前它会在「帮我改代码」这种任务里凭空产出一个
        // Excel,既没人要,又因为产物会中断循环导致它没机会解释改了什么。
        // 同时要求它改完必须说清楚,别扔下一堆工具调用就没了。
        if (!skillId) {
          messages.push({
            role: 'system',
            content: [
              '【产物纪律】用户没有明确要求文件时,不要调用 create_pptx / create_docx / create_xlsx /',
              'create_html_app 等产物工具。直接在对话里回答。只有用户说了「做个 PPT」「导出表格」',
              '这类明确要求,才生成文件。',
              '',
              '【修 bug / 改代码的任务永远不产出文件】用户让你「优化某个页面」「修复某个功能」',
              '「改一下样式」时,他要的是**你去改代码**,然后用文字告诉他改了什么。',
              '把说明写进 PPT 或文档是完全错误的 —— 那既没解决问题,也让他读不到你的结论。',
              '',
              '【改完要交代】如果你修改了文件,回复里必须说清楚:',
              '1. 改了哪几个文件,每个文件改了什么(一句话说清)',
              '2. 为什么这么改 —— 原来的问题是什么',
              '3. 预期效果 —— 用户现在应该能看到什么变化',
              '4. 还剩什么问题 / 你没能解决的部分 / 需要用户验证的地方',
              '不要只贴一堆工具调用就结束。用户看不懂工具调用,他要的是人话总结。',
            ].join('\n'),
          })
        }
        messages.push(...historyMessages)
        if (volatilePrompt) messages.push({ role: 'system', content: volatilePrompt })
        const requestSystemPrompt = messages
          .filter((message) => message.role === 'system' && typeof message.content === 'string')
          .map((message) => message.content)
          .join('\n\n')
        const contextSessionKey = sessionId || '__draft__'
        setContextSystemPrompts((current) => current[contextSessionKey] === requestSystemPrompt
          ? current
          : { ...current, [contextSessionKey]: requestSystemPrompt })
        const attachmentsToUse = explicitAttachments || attachments
        messages.push({ role: 'user', content: buildUserContentWithAttachments(userPrompt || content, attachmentsToUse) })

        dispatch({
          type: 'ADD_TASK',
          payload: { id: taskId, name: taskName, detail: content, status: TASK_STATUS.RUNNING, step: 1, stepLabel: '调用模型中', perms: skill?.perms || [] },
        })

        const initialArtifactType = artifactTypeForSkill(skillId)
        dispatch({
          type: 'RECEIVE_MESSAGE',
          payload: {
            content: '',
            meta: {
              skillId,
              artifactType: initialArtifactType,
              artifactTitle: initialArtifactType ? taskName : undefined,
              // ★ #1/#2: 标记本条进入流式态 → 点亮打字光标 + 让贴底用户跟手自动滚.
              //   收尾/中断/失败三条路径都会清掉(见 finalize / catch).
              streaming: true,
            },
          },
        })

        let latency = 0
        const started = Date.now()
        const controller = new AbortController()
        abortCtrlRef.current = controller
        setIsGenerating(true)

        // 工具调用每轮都会真的请求一次模型,后端每轮都会扣费.把每轮 billing.creditsCharged
        // 累加上来,UI 能看到实际花了多少积分,余额取最后一次后端返回的快照.
        // ★ batchF P1: 这三个原本在 try 块内声明,导致 try 后的 UPDATE_LAST_MESSAGE_META
        //   读不到 → ReferenceError 把整条收尾链路打断.提到 try 外修掉.
        let totalCreditsCharged = 0
        let latestCreditsBalance = null
        let billingRoundError = null
        const injectedMemoryIdSet = new Set()
        // G1: 工具调用产出的 artifact (create_pptx/docx/xlsx) 暂存,
        // 流程结束后写到 last message meta — 让 ChatMessages 直接渲染卡片 + 弹右栏.
        // 取最后一个,因为同一轮多次生成时模型期望的"最终产物"通常是末次调用.
        // 提升到最外层 try 外(见上面 taskId 附近的声明)。

        try {
          // 工具调用循环:每轮 stream 模型 → 收 tool_calls → 本地执行 → messages 追加 tool 结果 → 再 stream
          // 上限 5 轮防止失控;无 tool_calls 即文本回复完成,直接退出
          const enabledToolNames = filterToolNamesForSkill(
            resolveToolsForMode(state.toolsConfig || {}),
            skillId,
          )
          // Feature 1: 拉服务端拼上 MCP / skill 动态工具,fallback 到纯本地 builtin
          let tools
          try {
            tools = await buildToolSpecsAsync({ enabledBuiltinNames: enabledToolNames, mode: 'chat' })
          } catch {
            tools = buildToolSpecs(enabledToolNames)
          }
          const allowedToolNames = new Set(tools.map((spec) => spec?.function?.name).filter(Boolean))
          const executeAuthorizedToolCall = (call) => executeToolCall(call, { allowedArtifactTools: allowedToolNames, lang })
          const toolLoopGuard = createChatToolLoopGuard({ lang })
          const beforeToolExecution = (call) => {
            const declared = validateChatToolCallAllowed(call, allowedToolNames, lang)
            return declared.ok ? toolLoopGuard.before(call) : declared
          }
          let completedToolCalls = 0
          // 最后一次模型调用的终止原因。'length' = 被 max_tokens 砍断,
          // 这是「跑完工具却一个字都没说」最常见的真实原因。
          let lastFinishReason = null

          const streamToolLoopWrapUp = async (reason) => {
            messages.push({ role: 'system', content: reason })
            let producedText = false
            for await (const event of callModelThroughProxyStream({
              messages,
              modelName,
              agentId: effectiveAgentId || undefined,
              sessionId: sessionId || undefined,
              signal: controller.signal,
              // ★ 收尾必须拿到独立的、更大的输出预算。
              // 推理模型的「思考」和正文共用 max_tokens,默认 4096 常常在
              // 写正文之前就被思考吃光 —— 那正是「工具跑完却一个字都没有」的原因。
              maxTokensBoost: 8192,
              // 不传 tools,从协议层杜绝收尾时再次调用工具
            })) {
              if (event.type === 'text') {
                producedText = true
                dispatch({ type: 'APPEND_TO_LAST_MESSAGE', payload: event.delta })
              } else if (event.type === 'reasoning') {
                dispatch({ type: 'APPEND_REASONING_TO_LAST_MESSAGE', payload: event.delta })
              } else if (event.type === 'billing') {
                if (typeof event.billing?.creditsCharged === 'number') {
                  totalCreditsCharged += event.billing.creditsCharged
                }
                if (typeof event.billing?.credits === 'number') {
                  latestCreditsBalance = event.billing.credits
                }
                if (event.billing?.error) billingRoundError = event.billing.error
                if (event.finishReason) lastFinishReason = event.finishReason
              }
            }
            return producedText
          }

          // G1: 工具调用产出的 artifact (create_pptx/docx/xlsx) 暂存,
          // 流程结束后写到 last message meta — 让 ChatMessages 直接渲染卡片 + 弹右栏.
          // 取最后一个,因为同一轮多次生成时模型期望的"最终产物"通常是末次调用.
          // ↑ 已提升到 try 外

          // ★ 不设轮数上限:循环本来就在模型停止调工具时自然退出,
          // 想让它停随时点「停止生成」。toolMaxRounds<=0 表示无限制。
          // 只保留一个极高的防呆护栏(RUNAWAY_ROUND_GUARD),防的是
          // 模型陷入死循环反复调同一个工具,不是防正常工作。
          for (let round = 0; toolMaxRounds <= 0 || round < toolMaxRounds; round += 1) {
            if (round >= RUNAWAY_ROUND_GUARD) {
              dispatch({
                type: 'APPEND_TO_LAST_MESSAGE',
                payload: `\n\n[已连续调用工具 ${RUNAWAY_ROUND_GUARD} 轮,疑似死循环,已停下。可以再发一条消息让我继续。]`,
              })
              break
            }
            let pendingToolCalls = null
            let sawTextThisRound = false
            let sawReasoningThisRound = false
            const streamingToolExecutor = new StreamingToolExecutor({
              isSafe: isStreamingSafeToolCall,
              before: beforeToolExecution,
              execute: executeAuthorizedToolCall,
              onStart: (call) => {
                dispatch({
                  type: 'APPEND_TOOL_CALL_TO_LAST_MESSAGE',
                  payload: { id: call.id, name: call.name, arguments: call.arguments, status: TOOL_CALL_STATUS.RUNNING },
                })
                dispatch({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { stepLabel: `调用 ${call.name}` } } })
              },
            })
            const beginToolExecution = (call, options) => streamingToolExecutor.begin(call, options)
            for await (const event of callModelThroughProxyStream({
              messages,
              modelName,
              agentId: effectiveAgentId || undefined,
              sessionId: sessionId || undefined,
              signal: controller.signal,
              tools: tools.length > 0 ? tools : undefined,
            })) {
              // ★ 以前每收到一个流式事件就覆盖一次 latency,最后留下的是
              // 「最后两个 chunk 之间的间隔」而不是总耗时 —— 本地模型真跑了
              // 25 秒,界面上显示 117ms,用户完全看不出慢在哪。
              // 现在只记第一个 token 的到达时间(TTFT),这才是「等了多久」的体感。
              if (!latency) latency = Date.now() - started
              if (event.type === 'phase') {
                // ★ 服务端在首 token 之前发的状态帧。本地模型加载权重要几十秒,
                // 这段时间界面原来是完全空白的 —— 用户唯一的判断是「卡死了」。
                dispatch({
                  type: 'UPDATE_TASK',
                  payload: {
                    id: taskId,
                    updates: { stepLabel: event.phase === 'connecting' ? '模型加载中' : '生成中' },
                  },
                })
                continue
              }
              if (event.type === 'text') {
                dispatch({ type: 'APPEND_TO_LAST_MESSAGE', payload: event.delta })
                if (!sawTextThisRound) {
                  sawTextThisRound = true
                  dispatch({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { stepLabel: '生成中' } } })
                }
              } else if (event.type === 'reasoning') {
                // 推理模型先思考后回答。思考阶段可能持续十几秒,
                // 不显示的话屏幕上什么都没有,用户以为卡死了。
                dispatch({ type: 'APPEND_REASONING_TO_LAST_MESSAGE', payload: event.delta })
                if (!sawReasoningThisRound) {
                  sawReasoningThisRound = true
                  dispatch({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { stepLabel: '思考中' } } })
                }
              } else if (event.type === 'tool_calls') {
                pendingToolCalls = normalizeChatToolCalls(event.toolCalls)
              } else if (event.type === 'tool_call_ready') {
                const [readyCall] = normalizeChatToolCalls([event.toolCall])
                if (readyCall) beginToolExecution(readyCall, { eager: true })
              } else if (event.type === 'billing') {
                if (Array.isArray(event.injectedMemoryIds)) {
                  for (const id of event.injectedMemoryIds) injectedMemoryIdSet.add(id)
                }
                if (typeof event.billing?.creditsCharged === 'number') {
                  totalCreditsCharged += event.billing.creditsCharged
                }
                if (typeof event.billing?.credits === 'number') {
                  latestCreditsBalance = event.billing.credits
                }
                if (event.billing?.error) billingRoundError = event.billing.error
                if (event.finishReason) lastFinishReason = event.finishReason
              }
            }

            // 本轮没工具调用 → 模型应该给出最终文本。工具已经执行过却仍然
            // 没有正文时,再发一次禁用工具的强制收尾,不能给用户留下空白或纯文件卡。
            if (!pendingToolCalls || pendingToolCalls.length === 0) {
              if (shouldForceChatTextWrapUp({ completedToolCalls, sawTextThisRound })) {
                let produced = await streamToolLoopWrapUp(
                  '工具执行已经结束,但你还没有给用户最终文字答复。'
                  + '请用简洁文字说明完成了什么、关键结果、验证情况和仍存在的问题。'
                  + '如果生成了文件,说明文件是什么以及包含什么。不要再调用工具。',
                )
                // ★ 第一次收尾没出正文时再试一次,用更硬的指令。
                //
                // 最常见的原因是推理模型把 max_tokens 全用在「思考」上了
                // (截图里那次思考了 93778 字,而 MODEL_MAX_TOKENS=4096)。
                // 明确要求它别再思考、直接写结论,通常一次就能拿到。
                if (!produced) {
                  produced = await streamToolLoopWrapUp(
                    '你上一次没有输出任何正文。现在**不要再思考**，直接用中文写出结论，'
                    + '控制在 300 字以内：做了哪些修改、关键结果、还有什么没做完。立刻开始写正文。',
                  )
                }
                if (!produced) {
                  // ★ 模型两次都不给正文 → 我们自己按执行记录写。
                  //
                  // 原来这里只留一句「模型未返回详细文字总结，请重试生成说明。」——
                  // 用户跑了几十步工具、等了几分钟,拿到一句正确的废话:
                  // 没说改了什么、没说哪里没做完、也没给下一步。
                  // 而这些事实前端全都有,不需要再问模型。
                  dispatch({
                    type: 'APPEND_TO_LAST_MESSAGE',
                    payload: `\n\n${buildToolRunSummary({
                      toolCalls: executedToolCalls,
                      artifact: toolArtifact,
                      finishReason: lastFinishReason,
                      lang,
                    })}`,
                  })
                }
              }
              break
            }

            // ★ 最后一轮还在调工具 → 不能就这么切断(用户会看到「让我继续...」然后没了)。
            // 收掉工具,强制模型基于已有结果给个交代,和 subagent/job 循环的做法一致。
            // 只有在真的设了上限、且这是最后一轮时才强制收尾。
            // 无限制模式(toolMaxRounds<=0)下走不到这里 —— 循环靠模型自己停。
            const isLastRound = toolMaxRounds > 0 && round === toolMaxRounds - 1
            if (isLastRound) {
              messages.push(buildAssistantToolCallsMessage(pendingToolCalls))
              for (const call of pendingToolCalls) {
                dispatch({
                  type: 'APPEND_TOOL_CALL_TO_LAST_MESSAGE',
                  payload: {
                    id: call.id,
                    name: call.name,
                    arguments: call.arguments,
                    status: 'error',
                    error: JSON.stringify({ ok: false, error: `已达工具调用轮数上限(${toolMaxRounds})` }),
                  },
                })
                messages.push({
                  role: 'tool',
                  tool_call_id: call.id,
                  name: call.name,
                  content: JSON.stringify({ ok: false, error: `已达工具调用轮数上限(${toolMaxRounds}),不要再调工具` }),
                })
              }
              await streamToolLoopWrapUp(
                `你已达到本轮对话的工具调用上限(${toolMaxRounds} 轮)。`
                + '请立刻基于目前已经拿到的信息给出结论,不要再调用任何工具。'
                + '如果信息不足以完成用户的全部要求,就说明已经查清了什么、还差什么、建议下一步怎么做。',
              )
              break
            }

            // 1) 把模型本轮发出的 assistant tool_calls 落入 messages(给上游做上下文)
            messages.push(buildAssistantToolCallsMessage(pendingToolCalls))

            // 2) 在 UI 上为每个 call 先展示 running 状态,然后执行,然后回填结果
            let noProgressReason = null
            for (let callIndex = 0; callIndex < pendingToolCalls.length; callIndex += 1) {
              const call = pendingToolCalls[callIndex]
              const execution = streamingToolExecutor.get(call.id) || beginToolExecution(call)
              const guardDecision = execution.guardDecision
              const result = await execution.promise
              completedToolCalls += 1
              // ★ 记下事实,供模型收尾失败时本地合成说明用
              executedToolCalls.push({
                name: call.name,
                arguments: call.arguments,
                ok: result.ok !== false,
                error: result.ok === false ? result.content : undefined,
              })
              if (!guardDecision.ok) noProgressReason = guardDecision.reason
              if (typeof result.billing?.creditsCharged === 'number') {
                totalCreditsCharged += result.billing.creditsCharged
              }
              if (typeof result.billing?.credits === 'number') {
                latestCreditsBalance = result.billing.credits
              }
              if (result.billing?.error) billingRoundError = result.billing.error
              // G1: create_* 工具会在 result.artifact 里挂 { type, title, source }
              if (result.artifact && result.artifact.type && result.artifact.source) {
                toolArtifact = result.artifact
                // 产物不能代替文字答复;循环继续一轮让模型说明结果。
                shouldStopAfterArtifactTool(result.artifact, { artifactWasRequested: !!skillId })
              }
              // Feature 8: manage_todos 返回 todos 字段 → 派发 SET_TODOS 让 UI 同步
              if (Array.isArray(result.todos)) {
                dispatch({ type: 'SET_TODOS', payload: { todos: result.todos } })
              }
              dispatch({
                type: 'APPEND_TOOL_CALL_TO_LAST_MESSAGE',
                payload: {
                  id: call.id,
                  name: call.name,
                  arguments: call.arguments,
                  status: result.ok ? 'success' : 'error',
                  result: result.ok ? result.content : undefined,
                  error: !result.ok ? result.content : undefined,
                },
              })
              const progress = toolLoopGuard.after(result, call)
              if (!progress.ok && !noProgressReason) noProgressReason = progress.reason
              // ★ 自动打开右侧预览：create_* / Agent 工具成功时
              if (result.ok && result.artifact) {
                const artPreview = buildArtifactPreview({
                  content: result.artifact.source || '',
                  meta: {
                    artifactType: result.artifact.type,
                    artifactTitle: result.artifact.title,
                    artifactSource: result.artifact.source,
                    artifactDescription: result.artifact.description,
                  },
                })
                if (artPreview) {
                  dispatch({
                    type: 'OPEN_PREVIEW_ARTIFACT',
                    payload: {
                      messageId: null, // 新消息还没 id，传 null 让 reducer 找最新的
                      content: result.artifact.source || '',
                      preview: artPreview,
                    },
                  })
                }
              }
              // 保持长 JSON 的语法完整,让模型明确知道结果被截断而不是误判解析失败。
              const toolContent = clipChatToolContent(result.content, 24_000, lang)
              messages.push({
                role: 'tool',
                tool_call_id: call.id,
                name: call.name,
                content: toolContent,
              })

              if (noProgressReason) {
                for (const skipped of pendingToolCalls.slice(callIndex + 1)) {
                  const skippedContent = JSON.stringify({
                    code: 'tool_execution_skipped',
                    error: noProgressReason,
                    retryable: false,
                  })
                  dispatch({
                    type: 'APPEND_TOOL_CALL_TO_LAST_MESSAGE',
                    payload: {
                      id: skipped.id,
                      name: skipped.name,
                      arguments: skipped.arguments,
                      status: 'error',
                      error: skippedContent,
                    },
                  })
                  messages.push({
                    role: 'tool',
                    tool_call_id: skipped.id,
                    name: skipped.name,
                    content: skippedContent,
                  })
                }
                break
              }
            }
            if (noProgressReason) {
              const produced = await streamToolLoopWrapUp(
                `工具循环因无进展停止:${noProgressReason}。`
                + '请基于已经获得的信息给出部分结论,不要再调用工具。',
              )
              if (!produced) {
                // 同样不能只丢一句「循环已停止」——把实际做过的事交代清楚
                dispatch({
                  type: 'APPEND_TO_LAST_MESSAGE',
                  payload: `\n\n[工具循环已停止:${noProgressReason}]\n\n${buildToolRunSummary({
                    toolCalls: executedToolCalls,
                    artifact: toolArtifact,
                    finishReason: lastFinishReason,
                    lang,
                  })}`,
                })
              }
              break
            }
            // 进入下一轮 stream,模型基于 tool 结果继续生成
          }
        } catch (err) {
          if (isUserStopped(err)) {
            dispatch({ type: 'APPEND_TO_LAST_MESSAGE', payload: '\n\n[已停止生成]' })
          }
          throw err
        } finally {
          setIsGenerating(false)
          abortCtrlRef.current = null
        }

        if (!explicitAttachments) setAttachments([])
        // G1: 工具产出的 artifact 优先于 slash skill 的 artifactType,
        //     因为它是模型显式选择的产物,且自带 source(模型给的 markdown).
        let artifactType = artifactTypeForSkill(skillId)
        let artifactTitle = artifactType ? taskName : undefined
        let artifactSource
        let artifactDescription
        if (toolArtifact) {
          artifactType = toolArtifact.type
          artifactTitle = toolArtifact.title || taskName
          artifactSource = toolArtifact.source
          artifactDescription = toolArtifact.description || undefined
        }
        dispatch({
          type: 'UPDATE_LAST_MESSAGE_META',
          payload: {
            type: 'model_reply',
            modelName: modelName || 'backend-default',
            creditsCharged: totalCreditsCharged,
            creditsBalance: latestCreditsBalance,
            billingError: billingRoundError,
            latency,
            skillId,
            artifactType,
            artifactTitle,
            artifactSource,
            artifactDescription,
            artifactExplicit: !!toolArtifact,
            injectedMemoryIds: [...injectedMemoryIdSet],
            streaming: false,
          },
        })

        // ★ FIX: 标记任务完成,5 秒后从 LIVE TASKS 移除
        dispatch({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { status: TASK_STATUS.COMPLETED, stepLabel: '已完成' } } })
        setTimeout(() => dispatch({ type: 'REMOVE_TASK', payload: taskId }), 5000)

        dispatch({
          type: 'ADD_HISTORY',
          payload: { name: taskName, skill: skill?.name || '通用对话', status: HISTORY_STATUS.SUCCESS, detail: content.length > 60 ? `${content.slice(0, 60)}...` : content, state: '已完成', date: Date.now() },
        })

        const notifyPerm = state.permissions.find((p) => p.id === 'notify')
        if (notifyPerm?.enabled && 'Notification' in window && Notification.permission === 'granted') {
          try {
            new Notification('模型回复完成', { body: taskName, icon: '/favicon.svg' })
          } catch {
            // Notification delivery can be blocked by browser/user settings.
          }
        }
      } catch (err) {
        setIsGenerating(false)
        abortCtrlRef.current = null
        if (isUserStopped(err)) {
          // ★ FIX: 中断也要把任务清掉,不能继续显示 "running 10%"
          dispatch({ type: 'UPDATE_LAST_MESSAGE_META', payload: { streaming: false } })
          dispatch({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { status: TASK_STATUS.CANCELLED, stepLabel: '已中断' } } })
          setTimeout(() => dispatch({ type: 'REMOVE_TASK', payload: taskId }), 3000)
          return
        }
        if (import.meta.env.DEV) console.error('Model call failed:', err)
        // ★ 流被截断(连接断了但没收到 done 帧)是可续的,不是普通失败。
        // 已经吐出来的正文要保留,并给用户一个「继续生成」的入口 ——
        // 本地模型跑长回答时中断是常态,让用户整轮重发代价太大。
        const truncated = err?.code === 'STREAM_TRUNCATED'
        const visibleErrorMessage = getVisibleModelErrorMessage(err, t)
        toast.error({
          title: truncated ? t('toast.chatTruncated') : t('toast.chatSendFailed'),
          body: visibleErrorMessage,
        })
        if (truncated) {
          setResumeState({ prompt: content, partialText: err.partialText || '' })
          dispatch({ type: 'APPEND_TO_LAST_MESSAGE', payload: `\n\n[${visibleErrorMessage}]` })
        } else {
          dispatch({ type: 'APPEND_TO_LAST_MESSAGE', payload: buildChatFailureMessage(visibleErrorMessage) })
          // 中途失败时保留已经执行过的工具结果，避免前面的工作不可追溯。
          if (executedToolCalls.length > 0) {
            dispatch({
              type: 'APPEND_TO_LAST_MESSAGE',
              payload: `\n\n${buildToolRunSummary({
                toolCalls: executedToolCalls,
                artifact: toolArtifact,
                finishReason: null,
                lang,
              })}`,
            })
          }
          // 失败的轮次同样可以重发,把 prompt 留住
          setResumeState({ prompt: content, partialText: '' })
        }
        dispatch({ type: 'UPDATE_LAST_MESSAGE_META', payload: { streaming: false, failed: true } })
        dispatch({ type: 'ADD_HISTORY', payload: { name: taskName, skill: skill?.name || '通用对话', status: HISTORY_STATUS.FAILED, detail: content.length > 60 ? `${content.slice(0, 60)}...` : content, state: `失败: ${visibleErrorMessage}`.slice(0, 80), date: Date.now() } })
        // ★ FIX: 失败时把同一个任务标记 failed (而非再 ADD 一条新的"running 15%"),5 秒后移除
        dispatch({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { status: TASK_STATUS.FAILED, stepLabel: '调用失败' } } })
        setTimeout(() => dispatch({ type: 'REMOVE_TASK', payload: taskId }), 5000)
      }
    },
    // ★ #27: 细粒度 deps,只收 triggerSendFlow body 里实际读的字段;
    //         避免依赖整个 state 导致每次 sessionDrafts/tasks 变都重建 callback
    [attachments, dispatch, isGenerating, modelOptions, selectedModel, toolMaxRounds, runtimeSkills, effectiveAgentId, toast, t, lang,
      state.activeSessionId, state.sessions, state.toolsConfig, state.permissions, state.skillConfigs]
  )

  const executeSlashEntry = useCallback(async (entry, args = '') => {
    if (!entry) return false
    slashRegistry.recordRecent(entry.name)

    if (entry.kind === 'skill') {
      setInput(`/${entry.name} `)
      return true
    }

    try {
      const result = await entry.handler(args, {
        dispatch,
        getState: () => stateRef.current,
        registry: slashRegistry,
        triggerSendFlow,
        confirm: (message) => (typeof window === 'undefined' ? true : window.confirm(message)),
        openSessionSearch: (query) => {
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('session-search:open', { detail: { query } }))
          }
        },
        navigate,
        selectedModel: effectiveSelectedModel,
        modelOptions,
        setModel: setModelForActiveSession,
        openModelPicker: () => setShowModelPicker(true),
        contextUsageVisible: showContextUsage,
        setContextUsage: setContextUsageVisible,
        copyText: (text) => navigator.clipboard?.writeText(text),
        exportSession,
      })

      if (entry.source === 'plugin') {
        setInput(result || `# ${entry.meta?.displayName || entry.name}\n`)
        return true
      }

      setInput('')
      if (stateRef.current.activeSessionId) {
        dispatch({ type: 'SET_SESSION_DRAFT', payload: { sessionId: stateRef.current.activeSessionId, text: '' } })
      }
      if (result && entry.name !== 'help') setWorkbenchMessage(result)
      return true
    } catch (err) {
      setWorkbenchMessage(err?.message || 'Slash command failed.')
      return true
    }
  }, [dispatch, slashRegistry, triggerSendFlow, navigate, effectiveSelectedModel, modelOptions, setModelForActiveSession, showContextUsage, setContextUsageVisible])

  const handleSend = useCallback(() => {
    const typedContent = input.trim()
    if (!typedContent && attachments.length === 0) return
    const parsedSlash = parseSlashCommandInput(typedContent)
    const slashEntry = parsedSlash ? slashRegistry.getCommand(parsedSlash.name) : null
    if (slashEntry && slashEntry.kind !== 'skill') {
      setInput('')
      executeSlashEntry(slashEntry, parsedSlash.args)
      return
    }
    const currentAttachments = [...attachments]
    const content = typedContent || describeAttachmentPrompt(currentAttachments)
    setInput('')
    setAttachments([])
    // 发送后顺手清掉本会话草稿,免得切走再回来还残留
    if (state.activeSessionId) {
      dispatch({ type: 'SET_SESSION_DRAFT', payload: { sessionId: state.activeSessionId, text: '' } })
    }
    triggerSendFlow(content, currentAttachments)
  }, [attachments, input, triggerSendFlow, state.activeSessionId, dispatch, slashRegistry, executeSlashEntry])

  // 从已有会话历史的截断处续写，不重发原问题。
  const handleResumeGeneration = useCallback(() => {
    if (!resumeState) return
    setResumeState(null)
    triggerSendFlow('接着上面被中断的地方继续写完，不要重复已经写过的内容，也不要重新开头。')
  }, [resumeState, triggerSendFlow])

  // ★ Reasonix-style ask_choice: 监听 choice-selected 事件 → 发送选择作为用户消息
  useEffect(() => {
    const handler = (e) => {
      const { choiceId, choiceTitle } = e.detail || {}
      if (choiceId && choiceTitle) {
        triggerSendFlow(`[[choice:${choiceId}]] ${choiceTitle}`)
      }
    }
    window.addEventListener('choice-selected', handler)
    return () => window.removeEventListener('choice-selected', handler)
  }, [triggerSendFlow])

  const handleKeyDown = useCallback((e) => {
    if (navigateInputHistory(e)) return
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
  }, [handleSend, navigateInputHistory])

  const handleExpandCompaction = useCallback(async (archiveId) => {
    if (!archiveId) return
    try {
      const archive = await fetchCompactionArchive(archiveId)
      dispatch({
        type: 'EXPAND_COMPACTED',
        payload: {
          sessionId: state.activeSessionId,
          archiveId,
          archivedMessages: archive.archivedMessages || [],
        },
      })
      setWorkbenchMessage(`Restored ${archive.replacedMessageCount || 0} archived messages.`)
    } catch (err) {
      setWorkbenchMessage(err.message || 'Failed to restore compacted context.')
    }
  }, [dispatch, state.activeSessionId])

  const handleFileChange = async (e) => {
    const selectedFiles = Array.from(e.target.files || [])
    e.target.value = ''
    if (!selectedFiles.length) return
    const nextAttachments = await parseChatAttachments(selectedFiles, {
      existingImageCount: attachments.filter((item) => item.kind === 'image').length,
      messages: {
        imageLimit: t('chatAttachments.imageLimit'),
        imageTooLarge: t('chatAttachments.imageTooLarge'),
        compressedTooLarge: t('chatAttachments.compressedTooLarge'),
        excelTooLong: t('chatAttachments.excelTooLong'),
        wordTooLong: t('chatAttachments.wordTooLong'),
        pptTooLong: t('chatAttachments.pptTooLong'),
        textTooLong: t('chatAttachments.textTooLong'),
        unsupportedFormat: t('chatAttachments.unsupportedFormat'),
        readFailed: t('chatAttachments.readFailed'),
      },
    })
    // ★ #25: 超过 8 个时提示截断
    setAttachments((current) => {
      const merged = [...current, ...nextAttachments]
      const dropped = merged.length - 8
      const result = merged.slice(0, 8)
      if (dropped > 0) {
        setWorkbenchMessage(t('chatAttachments.maxCountNotice', { count: dropped }))
      } else {
        setWorkbenchMessage(t('chatAttachments.addedNotice', { count: nextAttachments.length }))
      }
      return result
    })
  }

  const handleVoice = async () => {
    if (voiceState === 'requesting') return
    if (voiceState === 'listening') {
      recognitionRef.current?.stop?.()
      setWorkbenchMessage(t('chatMessages.voiceStopped'))
      return
    }
    const SR = getSpeechRecognitionConstructor(window)
    if (!SR) {
      setVoiceState('unsupported')
      setWorkbenchMessage(t('chatMessages.voiceUnsupported'))
      return
    }

    setVoiceState('requesting')
    try {
      const rec = new SR()
      rec.lang = resolveSpeechRecognitionLanguage(lang)
      rec.continuous = false
      rec.interimResults = true
      const baseInput = input.trimEnd()
      let finalTranscript = ''
      let failed = false
      rec.onstart = () => {
        const micPerm = state.permissions.find((permission) => permission.id === 'mic')
        if (!micPerm?.enabled) dispatch({ type: 'TOGGLE_PERM', payload: 'mic' })
        setVoiceState('listening')
      }
      rec.onresult = (event) => {
        const next = readSpeechRecognitionEvent(event, finalTranscript)
        finalTranscript = next.committed
        setInput(mergeSpeechTranscript(baseInput, next.transcript))
      }
      rec.onend = () => {
        if (recognitionRef.current === rec) recognitionRef.current = null
        if (!failed) setVoiceState('idle')
      }
      rec.onerror = (event) => {
        failed = true
        recognitionRef.current = null
        const error = event?.error || 'unknown'
        const status = error === 'not-allowed' || error === 'service-not-allowed'
          ? 'denied'
          : 'error'
        const messageKey = status === 'denied'
          ? 'chatMessages.voiceDenied'
          : error === 'no-speech'
            ? 'chatMessages.voiceNoSpeech'
            : error === 'network'
              ? 'chatMessages.voiceNetworkError'
              : 'chatMessages.voiceError'
        setVoiceState(status)
        setWorkbenchMessage(t(messageKey))
      }
      recognitionRef.current = rec
      rec.start()
    } catch (err) {
      const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError'
      setVoiceState(denied ? 'denied' : 'error')
      setWorkbenchMessage(t(denied ? 'chatMessages.voiceDenied' : 'chatMessages.voiceError'))
    }
  }

  const handlePermAllow = () => {
    dispatch({ type: 'SET_PERM_REQUEST', payload: null })
    const pendingTask = [...state.tasks].reverse().find((t) => t.status === 'pending')
    if (pendingTask) {
      dispatch({ type: 'UPDATE_TASK', payload: { id: pendingTask.id, updates: { status: TASK_STATUS.RUNNING, stepLabel: '权限已获取，继续执行' } } })
    }
    dispatch({ type: 'RECEIVE_MESSAGE', payload: '✅ 已授权，继续执行中。' })
  }

  const handlePermDeny = () => {
    dispatch({ type: 'SET_PERM_REQUEST', payload: null })
    dispatch({ type: 'RECEIVE_MESSAGE', payload: '已拒绝该操作。' })
  }

  const handleAbortTask = () => abortCtrlRef.current?.abort()

  const handleManageModels = () => {
    if (!isLoggedInLocally()) {
      window.dispatchEvent(new CustomEvent('auth:required', {
        detail: {
          path: '/settings?tab=models',
          message: '登录后即可添加和使用第三方或本地模型。',
        },
      }))
      return
    }
    navigate('/settings?tab=models')
  }

  return (
    <div className="h-screen flex bg-paper overflow-hidden">
      <LeftRail />

      <div className="flex-1 flex flex-col min-w-0">
        <ChatMessages
          key={activeSessionId || '__draft__'}
          messages={messages}
          state={state}
          workbenchMessage={workbenchMessage}
          showContextUsage={showContextUsage}
          showContextPanel={showContextPanel}
          setShowContextPanel={setShowContextPanel}
          selectedModel={effectiveSelectedModel}
          contextWindow={selectedContextWindow}
          toolSpecs={contextToolSpecs}
          systemPrompt={contextSystemPrompts[state.activeSessionId || '__draft__'] || ''}
          isGenerating={isGenerating}
          onPermAllow={handlePermAllow}
          onPermDeny={handlePermDeny}
          onNavigatePermissions={() => navigate('/permissions')}
          onQuoteSelection={(text) => {
            // ★ PR3: 选中文本 → 在 composer 顶部插入 markdown 引用块
            // 复用 SET_DRAFT_INPUT,index.jsx 的 useEffect 会自动同步到 setInput
            const quoted = String(text || '')
              .split('\n')
              .map((line) => `> ${line}`)
              .join('\n')
            const current = inputRef.current || ''
            const next = current ? `${quoted}\n\n${current}` : `${quoted}\n\n`
            dispatch({ type: 'SET_DRAFT_INPUT', payload: next })
          }}
          onOpenInPreview={(msg, preview) =>
            dispatch({
              type: 'OPEN_PREVIEW_ARTIFACT',
              // G1: 优先把模型显式给的 artifactSource 当 content,
              //     这样 ChatMessages 嗅探来源 / RightPreviewPane 复用都基于同一份源.
              payload: {
                messageId: msg.id,
                content: msg.meta?.artifactSource || msg.content,
                preview,
              },
            })
          }
          onExpandCompaction={handleExpandCompaction}
        />

        {/* ★ 工具审批卡:紧贴输入框上方,在对话流里就能决策,不用切页面 */}
        {toolApproval.open && (
          <div className="mx-auto w-full max-w-[872px] px-4 pb-2">
            <ToolApprovalCard
              open={toolApproval.open}
              request={toolApproval.request}
              busy={toolApproval.busy}
              onDecide={resolveToolApproval}
            />
          </div>
        )}

        {/* ★ 流被截断后的续写入口。
            本地模型跑长回答时中断是常态,原来只有「整轮重发」一条路 ——
            前面已经生成的内容全部作废,慢模型上代价极大。
            这里把已有的部分作为上下文,让模型接着往下写。 */}
        {resumeState && !isGenerating && (
          <div className="mx-auto w-full max-w-[872px] px-4 pb-1.5">
            <div className="flex items-center gap-2 text-xs border border-amber-500/40 bg-amber-500/5 rounded-md px-3 py-2">
              <span className="flex-1 text-ink-soft">{t('toast.chatResumeHint')}</span>
              <button
                type="button"
                onClick={handleResumeGeneration}
                className="h-7 px-3 rounded-md bg-ember text-paper"
              >
                {t('toast.chatResumeButton')}
              </button>
              <button
                type="button"
                onClick={() => setResumeState(null)}
                className="h-7 px-2 text-ink-fade hover:text-ink"
              >
                {t('toast.chatResumeDismiss')}
              </button>
            </div>
          </div>
        )}

        <ChatComposer
          input={input}
          setInput={setInput}
          onSend={handleSend}
          attachments={attachments}
          setAttachments={setAttachments}
          voiceState={voiceState}
          modelPickerOpen={showModelPicker}
          modelOptions={modelOptions}
          selectedModel={effectiveSelectedModel}
          isGenerating={isGenerating}
          onAbort={handleAbortTask}
          onFileChange={handleFileChange}
          onVoiceClick={handleVoice}
          onOpenModelPicker={() => setShowModelPicker(true)}
          onCloseModelPicker={() => setShowModelPicker(false)}
          onModelChange={setModelForActiveSession}
          onManageModels={handleManageModels}
          approvalMode={approvalSettings?.mode || 'normal'}
          onApprovalModeChange={changeApprovalMode}
          handleKeyDown={handleKeyDown}
        />
      </div>

      {state.previewArtifact ? (
        <RightPreviewPane
          artifact={state.previewArtifact}
          onClose={() => dispatch({ type: 'CLOSE_PREVIEW_ARTIFACT' })}
          onMessage={setWorkbenchMessage}
        />
      ) : null}

      <ApplyPatchApprovalModal
        open={applyPatchApproval.open}
        changes={applyPatchApproval.changes}
        busy={applyPatchApproval.busy}
        onApprove={() => resolveApplyPatchApproval(true)}
        onReject={() => resolveApplyPatchApproval(false)}
      />
    </div>
  )
}
