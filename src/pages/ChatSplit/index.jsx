import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useNavigate } from '../../lib/router.jsx'
import { useAppContext } from '../../store/AppContext'
import { SKILLS } from '../../data.js'
import { describeAttachmentPrompt } from '../../lib/attachments.js'
import { getModelStatus, summarizeSessionTitle } from '../../lib/modelClient.js'
import { buildToolSpecs, resolveToolsForMode } from '../../lib/tools/index.js'
import { readStoredModel, resolveInitialModel, resolveSessionModel, writeStoredModel } from '../../lib/modelSelection.js'
import { isLoggedInLocally } from '../../lib/accountClient.js'
import { useActiveAgent } from '../../agents/activeAgentContext.js'
import { listSkills } from '../../lib/skillClient.js'
import { listLocalSkills, mergeRuntimeSkills } from '../../lib/localSkills.js'
import { listPromptTemplatesApi, getPromptTemplateContentApi, renderPromptTemplate } from '../../lib/pluginClient.js'
import { createSlashCommandRegistry, normalizeSlashCommandName, parseSlashCommandInput } from '../../lib/slashCommandRegistry.js'
import { CORE_SLASH_COMMANDS, getSlashActionCopy, registerCoreSlashCommands } from '../../lib/slashCoreCommands.js'
import { inferSkillIdFromPrompt, parseSkillCommand } from '../../lib/skillCommands.js'
import { TASK_STATUS } from '../../store/taskStatus.js'
import ChatSplitView from './ChatSplitView.jsx'
import { persistSlashGoals } from '../../lib/slashGoals.js'
import useInputHistory from './useInputHistory.js'
import { useToast } from '../../components/Toast.jsx'
import { useT } from '../../i18n/I18nProvider.jsx'
import { recordLocalChatFeedback } from '../../lib/localChatFeedback.js'
import { fetchCompactionArchive } from '../../lib/compactionClient.js'
import { trimHistoryWithHysteresis } from '../../lib/historyWindow.js'
import { parseChatAttachments } from '../../lib/chatAttachmentParser.js'
import { readContextUsageVisible, readDesktopPetVisible, readWorkbenchOpen, writeContextUsageVisible, writeDesktopPetVisible, writeWorkbenchOpen } from '../../lib/chatUiPreferences.js'
import useChatApprovals from './useChatApprovals.js'
import useDirectoryApproval from './useDirectoryApproval.js'
import { runServerChatTurn } from './serverTurnFlow.js'
import useServerTurnResume from './useServerTurnResume.js'
import useVoiceRecognition from './useVoiceRecognition.js'

const EMPTY_MESSAGES = []

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
  const [showContextUsage, setShowContextUsage] = useState(readContextUsageVisible)
  const [workbenchOpen, setWorkbenchOpen] = useState(readWorkbenchOpen)
  const [workbenchTab, setWorkbenchTab] = useState('files')
  const [desktopPetVisible, setDesktopPetVisible] = useState(readDesktopPetVisible)
  const [slashInlinePanel, setSlashInlinePanel] = useState(null)
  const [showContextPanel, setShowContextPanel] = useState(false)
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [contextSystemPrompts, setContextSystemPrompts] = useState({})
  const abortCtrlRef = useRef(null)
  const resumingTurnIdsRef = useRef(new Set())
  // ★ 流被截断后的续写状态。本地模型跑长回答时中断是常态,
  // 让用户接着写比整轮重发省太多。
  const [resumeState, setResumeState] = useState(null)
  const {
    approvalSettings, changeApprovalMode, requestServerToolApproval,
    resolveToolApproval, setToolApproval, toolApproval, toolApprovalResolveRef,
  } = useChatApprovals({ setWorkbenchMessage, toast, t })
  const {
    authorizeDirectory, directoryApproval, directoryApprovalResolveRef,
    ensureLocalPathAccess, probeLocalPathAccess, resolveDirectoryApproval,
  } = useDirectoryApproval({ lang, t, toast })
  const { handleVoice, voiceState } = useVoiceRecognition({
    dispatch,
    input,
    lang,
    permissions: state.permissions,
    setInput,
    setMessage: setWorkbenchMessage,
    t,
  })
  const stateRef = useRef(state)
  const newDraftVersionRef = useRef(state.newDraftVersion)

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
  useEffect(() => {
    writeContextUsageVisible(showContextUsage)
  }, [showContextUsage])
  useEffect(() => {
    writeWorkbenchOpen(workbenchOpen)
  }, [workbenchOpen])
  useEffect(() => writeDesktopPetVisible(desktopPetVisible), [desktopPetVisible])
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
    registerCoreSlashCommands(registry, { t, lang })
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
  }, [promptTemplates, runtimeSkills, state.skillConfigs, t, lang])

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
      toolApprovalResolveRef.current?.({ approved: false })
      abortCtrlRef.current?.abort()
    }
  }, [state.activeSessionId, toolApprovalResolveRef])

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
      if (isGenerating || directoryApprovalResolveRef.current) return
      let sessionId = state.activeSessionId
      let activeSession = state.sessions.find((s) => s.id === sessionId)
      if (!activeSession) {
        sessionId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
        activeSession = { id: sessionId, title: t('chatReliability.newConversation'), messages: [], agentId: effectiveAgentId || null }
        abortSessionIdRef.current = sessionId
        dispatch({
          type: 'NEW_SESSION',
          payload: { id: sessionId, title: t('chatReliability.newConversation'), agentId: effectiveAgentId || null },
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
            content = content.slice(0, 2000) + `\n${t('chatReliability.truncated')}`
          }
          return { role: m.role, content, name: m.name || undefined, tool_call_id: m.tool_call_id || undefined }
        })
      dispatch({ type: 'SEND_MESSAGE', payload: { content, attachments: explicitAttachments } })
      setWorkbenchMessage('')

      const isFreshSession = activeSession && (
        activeSession.title === t('chatReliability.newConversation')
        || activeSession.title === '新对话'
        || activeSession.title.startsWith(t('chatReliability.newSession'))
        || activeSession.title.startsWith('新会话')
      )
      if (isFreshSession) {
        // ★ #8: 立即兜底用截断, 让用户看到响应; 然后异步用 AI 覆盖一次
        const fallback = content.slice(0, 18).trim() || t('chatReliability.newConversation')
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
      const taskName = skill?.name || t('chatReliability.generalTask')

      if (!isLoggedInLocally()) {
        dispatch({ type: 'RECEIVE_MESSAGE', payload: t('chatReliability.loginRequired') })
        toast.error(t('errors.loginRequired'))
        return
      }

      const localPathAccess = await ensureLocalPathAccess(content)
      if (!localPathAccess.proceed) {
        setWorkbenchMessage(t('taskSteering.directoryRequestCancelled'))
        return
      }

      // 提前生成 task ID,后续 UPDATE_TASK / REMOVE_TASK 用得上
      const taskId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`

      await runServerChatTurn({
        abortCtrlRef,
        agentId: effectiveAgentId,
        attachments,
        content,
        dispatch,
        explicitAttachments,
        historyMessages,
        localPathAccess,
        modelName,
        probeLocalPathAccess,
        requestServerToolApproval,
        resolveToolApproval,
        sessionId,
        setContextSystemPrompts,
        setIsGenerating,
        setToolApproval,
        skill,
        skillId,
        taskId,
        taskName,
        t,
        toast,
        toolApprovalResolveRef,
        toolsConfig: state.toolsConfig,
        userPrompt,
      })

    },
    // ★ #27: 细粒度 deps,只收 triggerSendFlow body 里实际读的字段;
    //         避免依赖整个 state 导致每次 sessionDrafts/tasks 变都重建 callback
    [attachments, directoryApprovalResolveRef, dispatch, ensureLocalPathAccess, probeLocalPathAccess, isGenerating, modelOptions, selectedModel, setToolApproval, toolApprovalResolveRef, runtimeSkills, effectiveAgentId, requestServerToolApproval, resolveToolApproval, toast, t,
      state.activeSessionId, state.sessions, state.skillConfigs, state.toolsConfig]
  )

  useServerTurnResume({
    abortCtrlRef,
    dispatch,
    requestServerToolApproval,
    resolveToolApproval,
    resumingTurnIdsRef,
    setIsGenerating,
    setToolApproval,
    stateActiveSessionId: state.activeSessionId,
    stateRef,
    t,
    toolApprovalResolveRef,
  })

  const executeSlashEntry = useCallback(async (entry, args = '') => {
    if (!entry) return false
    slashRegistry.recordRecent(entry.name)

    if (entry.kind === 'skill') {
      setSlashInlinePanel(null)
      setInput(`/${entry.name} `)
      return true
    }

    try {
      setSlashInlinePanel(null)
      const result = await entry.handler(args, {
        dispatch,
        getState: () => stateRef.current,
        triggerSendFlow,
        navigate,
        openStatus: () => setSlashInlinePanel('status'),
        openMcp: () => setSlashInlinePanel('mcp'),
        openFeedback: () => setSlashInlinePanel('feedback'),
        openGoals: () => setSlashInlinePanel('goals'),
        openSideChat: () => { setWorkbenchTab('chat'); setWorkbenchOpen(true) },
        togglePet: () => setDesktopPetVisible((visible) => !visible),
        setApprovalMode: changeApprovalMode,
        recordFeedback: (value) => recordLocalChatFeedback(value, stateRef.current.activeSessionId),
      })

      if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'input')) {
        const nextInput = String(result.input || '')
        setInput(nextInput)
        if (stateRef.current.activeSessionId) {
          dispatch({ type: 'SET_SESSION_DRAFT', payload: { sessionId: stateRef.current.activeSessionId, text: nextInput } })
        }
        return true
      }

      if (entry.source === 'plugin') {
        setInput(result || `# ${entry.meta?.displayName || entry.name}\n`)
        return true
      }

      setInput('')
      if (stateRef.current.activeSessionId) {
        dispatch({ type: 'SET_SESSION_DRAFT', payload: { sessionId: stateRef.current.activeSessionId, text: '' } })
      }
      if (typeof result === 'string' && result) setWorkbenchMessage(result)
      return true
    } catch (err) {
      setWorkbenchMessage(err?.message || 'Slash command failed.')
      return true
    }
  }, [dispatch, slashRegistry, triggerSendFlow, navigate, changeApprovalMode])
  const slashQuery = input.match(/^\/([^\s/]*)$/i)?.[1]
  const slashCommands = slashQuery === undefined ? [] : slashRegistry.listCommands({ query: slashQuery })

  const handleSend = useCallback(() => {
    if (directoryApproval.open) return
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
  }, [attachments, directoryApproval.open, input, triggerSendFlow, state.activeSessionId, dispatch, slashRegistry, executeSlashEntry])

  // 从已有会话历史的截断处续写，不重发原问题。
  const handleResumeGeneration = useCallback(() => {
    if (!resumeState) return
    setResumeState(null)
    triggerSendFlow(t('chatReliability.continuePrompt'))
  }, [resumeState, t, triggerSendFlow])

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

  const handlePermAllow = () => {
    dispatch({ type: 'SET_PERM_REQUEST', payload: null })
    const pendingTask = [...state.tasks].reverse().find((t) => t.status === 'pending')
    if (pendingTask) {
      dispatch({ type: 'UPDATE_TASK', payload: { id: pendingTask.id, updates: { status: TASK_STATUS.RUNNING, stepLabel: t('chatReliability.permissionReady') } } })
    }
    dispatch({ type: 'RECEIVE_MESSAGE', payload: t('chatReliability.permissionGranted') })
  }

  const handlePermDeny = () => {
    dispatch({ type: 'SET_PERM_REQUEST', payload: null })
    dispatch({ type: 'RECEIVE_MESSAGE', payload: t('chatReliability.permissionDenied') })
  }

  const handleAbortTask = () => abortCtrlRef.current?.abort()

  const handleManageModels = () => {
    if (!isLoggedInLocally()) {
      window.dispatchEvent(new CustomEvent('auth:required', {
        detail: {
          path: '/settings?tab=models',
          message: t('chatReliability.signInForModels'),
        },
      }))
      return
    }
    navigate('/settings?tab=models')
  }

  return (
    <ChatSplitView
      activeSession={activeSession}
      activeSessionId={activeSessionId}
      approvalMode={approvalSettings?.mode || 'normal'}
      attachments={attachments}
      contextSystemPrompt={contextSystemPrompts[state.activeSessionId || '__draft__'] || ''}
      contextToolSpecs={contextToolSpecs}
      contextWindow={selectedContextWindow}
      desktopPetVisible={desktopPetVisible}
      directoryApproval={directoryApproval}
      input={input}
      isGenerating={isGenerating}
      messages={messages}
      modelOptions={modelOptions}
      onAbort={handleAbortTask}
      onApprovalModeChange={changeApprovalMode}
      onAuthorizeDirectory={authorizeDirectory}
      onCloseDesktopPet={() => setDesktopPetVisible(false)}
      onCloseInlinePanel={() => setSlashInlinePanel(null)}
      onCloseModelPicker={() => setShowModelPicker(false)}
      onClosePreview={() => dispatch({ type: 'CLOSE_PREVIEW_ARTIFACT' })}
      onCloseWorkbench={() => setWorkbenchOpen(false)}
      onDirectoryReject={() => resolveDirectoryApproval({ approved: false })}
      onDismissResume={() => setResumeState(null)}
      onExpandCompaction={handleExpandCompaction}
      onFileChange={handleFileChange}
      onGoalsChange={(todos) => persistSlashGoals(
        dispatch,
        stateRef.current.activeSessionId,
        todos,
        getSlashActionCopy(lang).goals[0],
      )}
      onInlineContext={() => {
        setSlashInlinePanel(null)
        setShowContextUsage(true)
        setShowContextPanel(true)
      }}
      onInlineTasks={() => {
        setSlashInlinePanel(null)
        navigate('/tasks')
      }}
      onKeyDown={handleKeyDown}
      onManageMcp={() => {
        setSlashInlinePanel(null)
        navigate('/mcp')
      }}
      onManageModels={handleManageModels}
      onModelChange={setModelForActiveSession}
      onNavigatePermissions={() => navigate('/permissions')}
      onOpenArtifact={(artifact) => dispatch({ type: 'OPEN_PREVIEW_ARTIFACT', payload: artifact })}
      onOpenInPreview={(msg, preview) => dispatch({
        type: 'OPEN_PREVIEW_ARTIFACT',
        payload: {
          messageId: msg.id,
          content: msg.meta?.artifactSource || msg.content,
          preview,
        },
      })}
      onOpenModelPicker={() => setShowModelPicker(true)}
      onPermAllow={handlePermAllow}
      onPermDeny={handlePermDeny}
      onPreviewMessage={setWorkbenchMessage}
      onQuoteSelection={(text) => {
        const quoted = String(text || '')
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n')
        const current = inputRef.current || ''
        dispatch({ type: 'SET_DRAFT_INPUT', payload: current ? `${quoted}\n\n${current}` : `${quoted}\n\n` })
      }}
      onResume={handleResumeGeneration}
      onSend={handleSend}
      onSlashCommandSelect={executeSlashEntry}
      onSubmitFeedback={(value) => recordLocalChatFeedback(value, stateRef.current.activeSessionId)}
      onToolApproval={resolveToolApproval}
      onVoiceClick={handleVoice}
      onWorkbenchSend={(content) => triggerSendFlow(content)}
      onWorkbenchTabChange={setWorkbenchTab}
      onWorkbenchToggle={() => setWorkbenchOpen((open) => !open)}
      previewArtifact={state.previewArtifact}
      resumeAvailable={!!resumeState}
      runtimeSkillIds={runtimeSkills.map((skill) => skill.id)}
      selectedModel={effectiveSelectedModel}
      setAttachments={setAttachments}
      setInput={setInput}
      setShowContextPanel={setShowContextPanel}
      showContextPanel={showContextPanel}
      showContextUsage={showContextUsage}
      showModelPicker={showModelPicker}
      slashCommands={slashCommands}
      slashInlinePanel={slashInlinePanel}
      state={state}
      t={t}
      tasks={state.tasks}
      toolApproval={toolApproval}
      voiceState={voiceState}
      workbenchMessage={workbenchMessage}
      workbenchOpen={workbenchOpen}
      workbenchTab={workbenchTab}
    />
  )
}
