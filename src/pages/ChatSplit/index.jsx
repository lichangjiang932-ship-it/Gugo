import { useState, useRef, useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import LeftRail from '../../components/LeftRail'
import { useAppContext } from '../../store/AppContext'
import { SKILLS, getSkillSystemPrompt } from '../../data.js'
import { buildUserContentWithAttachments, describeAttachmentPrompt } from '../../lib/attachments.js'
import { callModelThroughProxyStream, getModelStatus, summarizeSessionTitle } from '../../lib/modelClient.js'
import { buildToolSpecs, buildToolSpecsAsync, executeToolCall, resolveToolsForMode } from '../../lib/tools/index.js'
import { readStoredModel, resolveInitialModel, writeStoredModel } from '../../lib/modelSelection.js'
import { isLoggedInLocally } from '../../lib/accountClient.js'
import { listSkills } from '../../lib/skillClient.js'
import { inferSkillIdFromPrompt, parseSkillCommand } from '../../lib/skillCommands.js'
import { TASK_STATUS, TOOL_CALL_STATUS, HISTORY_STATUS } from '../../store/taskStatus.js'
import ChatHeader from './ChatHeader'
import ChatMessages from './ChatMessages'
import ChatComposer from './ChatComposer'
import RightPreviewPane from './RightPreviewPane'
import CodingWorkbench from './CodingWorkbench'
import TodoTracker from '../../components/TodoTracker'
import { exportSession } from '../../lib/sessionExport.js'
import { compressImageDataUrl } from '../../lib/imageCompress.js'
import { extractPdfText } from '../../lib/pdfExtract.js'
import { fetchCompactionArchive } from '../../lib/compactionClient.js'

const MAX_IMAGE_BYTES = 4 * 1024 * 1024
const MAX_RAW_IMAGE_BYTES = 16 * 1024 * 1024
const MAX_IMAGES_PER_MESSAGE = 5
const MAX_TEXT_BYTES = 256 * 1024
const EMPTY_MESSAGES = []

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error || new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}


function dataUrlByteLength(dataUrl = '') {
  const comma = String(dataUrl).indexOf(',')
  const payload = comma >= 0 ? String(dataUrl).slice(comma + 1) : String(dataUrl)
  return Math.floor((payload.length * 3) / 4)
}

function isPdfFile(file) {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
}

function isTextLikeFile(file) {
  return /^text\/|json|xml|csv|markdown|javascript|typescript/.test(file.type) ||
    /\.(txt|md|json|csv|xml|yml|yaml|log|js|jsx|ts|tsx|css|html)$/i.test(file.name)
}

function isExcelFile(file) {
  return /\.(xlsx|xls|xlsm|xlsb|ods)$/i.test(file.name)
}

async function readExcelAsText(file) {
  const XLSX = await import('@e965/xlsx')
  const buffer = await file.arrayBuffer()
  const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array' })
  const parts = []
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]
    const csv = XLSX.utils.sheet_to_csv(sheet)
    parts.push(`[工作表: ${sheetName}]\n${csv}`)
  }
  return parts.join('\n\n')
}

export default function ChatSplit() {
  const navigate = useNavigate()
  const { state, dispatch } = useAppContext()
  const [input, setInput] = useState('')
  const [modelOptions, setModelOptions] = useState([])
  const [toolMaxRounds, setToolMaxRounds] = useState(5)
  const [selectedModel, setSelectedModel] = useState('')
  const [runtimeSkills, setRuntimeSkills] = useState(SKILLS)
  const [showSlashMenu, setShowSlashMenu] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [lastFailedPrompt, setLastFailedPrompt] = useState('')
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
  const [showContextPanel, setShowContextPanel] = useState(false)
  const abortCtrlRef = useRef(null)
  const recognitionRef = useRef(null)

  const activeSession = state.sessions.find((s) => s.id === state.activeSessionId)
  const messages = activeSession?.messages ?? EMPTY_MESSAGES
  const tasks = state.tasks
  const agentMode = state.agentMode || 'chat'
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
        if (Number.isFinite(status.toolMaxRounds) && status.toolMaxRounds >= 1 && status.toolMaxRounds <= 12) {
          setToolMaxRounds(status.toolMaxRounds)
        }
      } catch {
        if (!cancelled) setModelOptions([])
      }
    }
    loadModels()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    listSkills()
      .then(({ skills }) => {
        if (!cancelled && Array.isArray(skills) && skills.length) setRuntimeSkills(skills)
      })
      .catch(() => {
        if (!cancelled) setRuntimeSkills(SKILLS)
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

  useEffect(() => {
    if (!state.activeSessionId) {
      dispatch({ type: 'NEW_SESSION', payload: '新对话' })
    }
  }, [dispatch, state.activeSessionId])

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

  const isSlashActive = input.startsWith('/') && !input.includes(' ')
  const slashQuery = isSlashActive ? input.slice(1).toLowerCase() : ''
  const filteredSkills = slashQuery
    ? runtimeSkills.filter((s) => s.id.toLowerCase().includes(slashQuery) || s.name.toLowerCase().includes(slashQuery))
    : runtimeSkills

  /* ── send flow ── */
  const triggerSendFlow = useCallback(
    async (content, explicitAttachments = null) => {
      if (isGenerating) return
      const activeSession = state.sessions.find((s) => s.id === state.activeSessionId)
      const historyMessages = (activeSession?.messages || [])
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .slice(-20)
        .map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' }))
      dispatch({ type: 'SEND_MESSAGE', payload: { content, attachments: explicitAttachments } })
      setWorkbenchMessage('')

      const isFreshSession = activeSession && (activeSession.title === '新对话' || activeSession.title.startsWith('新会话'))
      if (isFreshSession) {
        // ★ #8: 立即兜底用截断, 让用户看到响应; 然后异步用 AI 覆盖一次
        const fallback = content.slice(0, 18).trim() || '新对话'
        const initialTitle = fallback.length > 15 ? fallback.slice(0, 15) + '…' : fallback
        const sessionIdSnapshot = state.activeSessionId
        dispatch({ type: 'UPDATE_SESSION_TITLE', payload: initialTitle })
        // fire-and-forget — 拿到 AI 标题后再 dispatch 一次
        // 不在回调里读取闭包 state, 完全依赖 reducer 做 onlyIfMatches 校验,
        // 避免闭包 state 陈旧导致误判。
        summarizeSessionTitle({ firstUserContent: content, modelName: selectedModel })
          .then((aiTitle) => {
            if (!aiTitle) return
            dispatch({ type: 'UPDATE_SESSION_TITLE_FOR', payload: { sessionId: sessionIdSnapshot, title: aiTitle, onlyIfMatches: initialTitle } })
          })
          .catch(() => {/* fallback 已经显示了 */})
      }

      const parsedSkill = parseSkillCommand(content)
      const skillId = parsedSkill.skillId || inferSkillIdFromPrompt(content)
      const userPrompt = parsedSkill.skillId ? parsedSkill.userPrompt : content
      const skill = skillId ? runtimeSkills.find((s) => s.id === skillId) : null
      const taskName = skill?.name || (content.toLowerCase().includes('ppt') ? '制作 PPT' : content.toLowerCase().includes('excel') ? '分析表格' : '通用任务')

      if (!isLoggedInLocally()) {
        dispatch({ type: 'RECEIVE_MESSAGE', payload: '请登录账户' })
        return
      }

      // 提前生成 task ID,后续 UPDATE_TASK / REMOVE_TASK 用得上
      const taskId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`

      try {
        const messages = []
        const systemPrompt = skillId ? getSkillSystemPrompt(skillId, state.skillConfigs, runtimeSkills) : ''
        if (systemPrompt) messages.push({ role: 'system', content: systemPrompt })
        if (agentMode === 'plan') {
          messages.push({
            role: 'system',
            content: 'Plan mode: inspect/read only. Do not modify files, do not run shell/build/test commands, and return a concise implementation plan with risks and acceptance checks.',
          })
        } else if (agentMode === 'code') {
          messages.push({
            role: 'system',
            content: 'Code mode: behave like a local coding agent. Inspect git status/diff, read files before editing, use precise file edits, run allowed checks when useful, and summarize changed files. Never commit or push; the user must do that from Coding Workbench.',
          })
        }
        messages.push(...historyMessages)
        const attachmentsToUse = explicitAttachments || attachments
        messages.push({ role: 'user', content: buildUserContentWithAttachments(userPrompt || content, attachmentsToUse) })

        dispatch({
          type: 'ADD_TASK',
          payload: { id: taskId, name: taskName, detail: content, status: TASK_STATUS.RUNNING, step: 1, stepLabel: '调用模型中', perms: skill?.perms || [] },
        })

        dispatch({ type: 'RECEIVE_MESSAGE', payload: '' })

        const modelName = selectedModel || resolveInitialModel(modelOptions)
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
        // G1: 工具调用产出的 artifact (create_pptx/docx/xlsx) 暂存,
        // 流程结束后写到 last message meta — 让 ChatMessages 直接渲染卡片 + 弹右栏.
        // 取最后一个,因为同一轮多次生成时模型期望的"最终产物"通常是末次调用.
        // 提升到 try 外:try 内声明会让后面的 finalize 块拿不到。
        let toolArtifact = null

        try {
          // 工具调用循环:每轮 stream 模型 → 收 tool_calls → 本地执行 → messages 追加 tool 结果 → 再 stream
          // 上限 5 轮防止失控;无 tool_calls 即文本回复完成,直接退出
          const enabledToolNames = resolveToolsForMode(state.toolsConfig || {}, agentMode)
          // Feature 1: 拉服务端拼上 MCP / skill 动态工具,fallback 到纯本地 builtin
          let tools
          try {
            tools = await buildToolSpecsAsync({ enabledBuiltinNames: enabledToolNames, mode: agentMode })
          } catch {
            tools = buildToolSpecs(enabledToolNames)
          }

          // G1: 工具调用产出的 artifact (create_pptx/docx/xlsx) 暂存,
          // 流程结束后写到 last message meta — 让 ChatMessages 直接渲染卡片 + 弹右栏.
          // 取最后一个,因为同一轮多次生成时模型期望的"最终产物"通常是末次调用.
          // ↑ 已提升到 try 外

          for (let round = 0; round < toolMaxRounds; round += 1) {
            let pendingToolCalls = null
            let sawTextThisRound = false
            for await (const event of callModelThroughProxyStream({
              messages,
              modelName,
              signal: controller.signal,
              tools: tools.length > 0 ? tools : undefined,
            })) {
              latency = Date.now() - started
              if (event.type === 'text') {
                dispatch({ type: 'APPEND_TO_LAST_MESSAGE', payload: event.delta })
                if (!sawTextThisRound) {
                  sawTextThisRound = true
                  dispatch({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { stepLabel: '生成中' } } })
                }
              } else if (event.type === 'tool_calls') {
                pendingToolCalls = event.toolCalls
              } else if (event.type === 'billing') {
                if (typeof event.billing?.creditsCharged === 'number') {
                  totalCreditsCharged += event.billing.creditsCharged
                }
                if (typeof event.billing?.credits === 'number') {
                  latestCreditsBalance = event.billing.credits
                }
                if (event.billing?.error) billingRoundError = event.billing.error
              }
            }

            // 本轮没工具调用 → 模型已经给出最终文本,退出
            if (!pendingToolCalls || pendingToolCalls.length === 0) break

            // 1) 把模型本轮发出的 assistant tool_calls 落入 messages(给上游做上下文)
            messages.push({
              role: 'assistant',
              content: '',
              tool_calls: pendingToolCalls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: c.arguments || '{}' },
              })),
            })

            // 2) 在 UI 上为每个 call 先展示 running 状态,然后执行,然后回填结果
            for (const call of pendingToolCalls) {
              dispatch({
                type: 'APPEND_TOOL_CALL_TO_LAST_MESSAGE',
                payload: { id: call.id, name: call.name, arguments: call.arguments, status: TOOL_CALL_STATUS.RUNNING },
              })
              dispatch({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { stepLabel: `调用 ${call.name}` } } })
              const result = await executeToolCall(call)
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
              messages.push({
                role: 'tool',
                tool_call_id: call.id,
                name: call.name,
                content: result.content,
              })
            }
            // 进入下一轮 stream,模型基于 tool 结果继续生成
          }
        } catch (err) {
          if (err.message === '已停止生成') {
            dispatch({ type: 'APPEND_TO_LAST_MESSAGE', payload: '\n\n[已停止生成]' })
          }
          throw err
        } finally {
          setIsGenerating(false)
          abortCtrlRef.current = null
        }

        setLastFailedPrompt('')
        if (!explicitAttachments) setAttachments([])
        // G1: 工具产出的 artifact 优先于 slash skill 的 artifactType,
        //     因为它是模型显式选择的产物,且自带 source(模型给的 markdown).
        let artifactType =
          skillId === 'ppt' ? 'pptx' :
          skillId === 'htmlppt' ? 'html' :
          skillId === 'doc' ? 'docx' :
          skillId === 'excel' ? 'xlsx' :
          undefined
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
        if (err.message === '已停止生成') {
          // ★ FIX: 中断也要把任务清掉,不能继续显示 "running 10%"
          dispatch({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { status: TASK_STATUS.CANCELLED, stepLabel: '已中断' } } })
          setTimeout(() => dispatch({ type: 'REMOVE_TASK', payload: taskId }), 3000)
          return
        }
        if (import.meta.env.DEV) console.error('Model call failed:', err)
        setLastFailedPrompt(content)
        dispatch({ type: 'APPEND_TO_LAST_MESSAGE', payload: `\n\n模型调用失败：${err.message}\n\n请联系管理员检查后端 .env 中的 MODEL_BASE_URL、MODEL_NAME 和 MODEL_API_KEY。` })
        dispatch({ type: 'ADD_HISTORY', payload: { name: taskName, skill: skill?.name || '通用对话', status: HISTORY_STATUS.FAILED, detail: content.length > 60 ? `${content.slice(0, 60)}...` : content, state: `失败: ${err.message}`.slice(0, 80), date: Date.now() } })
        // ★ FIX: 失败时把同一个任务标记 failed (而非再 ADD 一条新的"running 15%"),5 秒后移除
        dispatch({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { status: TASK_STATUS.FAILED, stepLabel: '调用失败' } } })
        setTimeout(() => dispatch({ type: 'REMOVE_TASK', payload: taskId }), 5000)
      }
    },
    // ★ #27: 细粒度 deps,只收 triggerSendFlow body 里实际读的字段;
    //         避免依赖整个 state 导致每次 sessionDrafts/tasks 变都重建 callback
    [attachments, dispatch, isGenerating, modelOptions, selectedModel, toolMaxRounds, runtimeSkills, agentMode,
      state.activeSessionId, state.sessions, state.toolsConfig, state.permissions, state.skillConfigs]
  )

  const handleSend = useCallback(() => {
    const typedContent = input.trim()
    if (!typedContent && attachments.length === 0) return
    const currentAttachments = [...attachments]
    const content = typedContent || describeAttachmentPrompt(currentAttachments)
    setInput('')
    setAttachments([])
    // 发送后顺手清掉本会话草稿,免得切走再回来还残留
    if (state.activeSessionId) {
      dispatch({ type: 'SET_SESSION_DRAFT', payload: { sessionId: state.activeSessionId, text: '' } })
    }
    setShowSlashMenu(false)
    triggerSendFlow(content, currentAttachments)
  }, [attachments, input, triggerSendFlow, state.activeSessionId, dispatch])

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
    if (showSlashMenu && filteredSkills.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIndex((i) => (i + 1) % filteredSkills.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIndex((i) => (i - 1 + filteredSkills.length) % filteredSkills.length); return }
      if (e.key === 'Enter') {
        e.preventDefault()
        const skill = filteredSkills[selectedIndex]
        if (skill) { setInput(`/${skill.id} `); setShowSlashMenu(false) }
        return
      }
      if (e.key === 'Escape') { setShowSlashMenu(false); return }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
  }, [showSlashMenu, filteredSkills, selectedIndex, handleSend])

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
    const nextAttachments = []
    let imageCount = attachments.filter((item) => item.kind === 'image').length
    for (const file of selectedFiles) {
      const sizeKB = (file.size / 1024).toFixed(1)
      const id = crypto.randomUUID?.() ?? `${Date.now()}-${file.name}`
      try {
        if (file.type.startsWith('image/')) {
          if (imageCount >= MAX_IMAGES_PER_MESSAGE) {
            nextAttachments.push({ id, name: file.name, sizeKB, type: file.type, kind: 'file', error: 'Image limit reached; only 5 images can be sent in one message.' })
          } else if (file.size > MAX_RAW_IMAGE_BYTES) {
            nextAttachments.push({ id, name: file.name, sizeKB, type: file.type, kind: 'file', error: 'Image is too large to process locally.' })
          } else {
            const rawDataUrl = await readFileAsDataUrl(file)
            const dataUrl = await compressImageDataUrl(rawDataUrl)
            if (dataUrlByteLength(dataUrl) > MAX_IMAGE_BYTES) {
              nextAttachments.push({ id, name: file.name, sizeKB, type: file.type, kind: 'file', error: 'Compressed image is still over 4MB.' })
            } else {
              imageCount += 1
              nextAttachments.push({ id, name: file.name, sizeKB, type: file.type, kind: 'image', dataUrl })
            }
          }
        } else if (isExcelFile(file)) {
          const text = await readExcelAsText(file)
          const textBytes = new TextEncoder().encode(text).length
          if (textBytes > MAX_TEXT_BYTES) {
            const maxChars = Math.floor(MAX_TEXT_BYTES / 2)
            const truncated = text.slice(0, maxChars) + '\n\n[Excel 内容过长，已截断]'
            nextAttachments.push({ id, name: file.name, sizeKB, type: file.type, kind: 'text', text: truncated })
          } else {
            nextAttachments.push({ id, name: file.name, sizeKB, type: file.type, kind: 'text', text })
          }
        } else if (isPdfFile(file)) {
          const text = await extractPdfText(file)
          nextAttachments.push({ id, name: file.name, sizeKB, type: file.type, kind: 'text', text })
        } else if (isTextLikeFile(file) && file.size <= MAX_TEXT_BYTES) {
          nextAttachments.push({ id, name: file.name, sizeKB, type: file.type, kind: 'text', text: await file.text() })
        } else {
          nextAttachments.push({ id, name: file.name, sizeKB, type: file.type, kind: 'file' })
        }
      } catch (err) {
        nextAttachments.push({ id, name: file.name, sizeKB, type: file.type, kind: 'file', error: err.message || '读取失败' })
      }
    }
    // ★ #25: 超过 8 个时提示截断
    setAttachments((current) => {
      const merged = [...current, ...nextAttachments]
      const dropped = merged.length - 8
      const result = merged.slice(0, 8)
      if (dropped > 0) {
        setWorkbenchMessage(`附件最多 8 个,已保留前 8 个,丢弃 ${dropped} 个。`)
      } else {
        setWorkbenchMessage(`已添加 ${nextAttachments.length} 个附件。`)
      }
      return result
    })
  }

  const handleVoice = () => {
    const micPerm = state.permissions.find((p) => p.id === 'mic')
    if (!micPerm?.enabled) { setWorkbenchMessage('请在权限中心开启麦克风输入权限。'); return }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) { setVoiceState('unsupported'); setTimeout(() => setVoiceState('idle'), 2000); return }
    if (voiceState === 'listening') { recognitionRef.current?.stop(); return }
    try {
      const rec = new SR()
      rec.lang = 'zh-CN'
      rec.continuous = false
      rec.interimResults = true
      rec.onresult = (event) => {
        const transcript = Array.from(event.results).map((r) => r[0]?.transcript || '').join('')
        setInput((prev) => {
          const base = prev.replace(/\s*\[识别中：[^\]]*\]\s*$/, '')
          return event.results[0]?.isFinal ? `${base}${base ? ' ' : ''}${transcript}` : `${base} [识别中：${transcript}]`
        })
      }
      rec.onend = () => setVoiceState('idle')
      rec.onerror = () => setVoiceState('idle')
      rec.start()
      recognitionRef.current = rec
      setVoiceState('listening')
    } catch (err) {
      console.warn('voice error:', err)
      setVoiceState('idle')
    }
  }

  const handleEditMessage = useCallback((msgId, content) => {
    const idx = messages.findIndex((m) => m.id === msgId)
    if (idx === -1) return
    setInput(content)
    dispatch({ type: 'TRUNCATE_MESSAGES', payload: idx })
  }, [messages, dispatch])

  // ★ #9: 重发 — 找到消息位置,截掉它之后的所有消息(含本条),
  //   再用本条文本走完整发送流程(经过 triggerSendFlow 才能跑完工具/计费/SSE)
  const handleRegenerate = useCallback((msgId) => {
    const currentMessages = state.sessions.find((s) => s.id === state.activeSessionId)?.messages ?? EMPTY_MESSAGES
    const idx = currentMessages.findIndex((m) => m.id === msgId)
    if (idx === -1) return
    const target = currentMessages[idx]
    // 用户消息: 截到本条之前 → 重发本条 (相当于编辑后不改直接发)
    // 助手消息: 截到本条之前(含上一条 user 也保留) → 重发上一条 user 触发新回复
    let resendText
    if (target.role === 'user') {
      dispatch({ type: 'TRUNCATE_MESSAGES', payload: idx })
      resendText = target.content
    } else {
      // 找上一条 user
      let prevUserIdx = -1
      for (let i = idx - 1; i >= 0; i -= 1) {
        if (currentMessages[i].role === 'user') { prevUserIdx = i; break }
      }
      if (prevUserIdx === -1) return
      dispatch({ type: 'TRUNCATE_MESSAGES', payload: prevUserIdx })
      resendText = currentMessages[prevUserIdx].content
    }
    if (resendText) triggerSendFlow(resendText)
  }, [dispatch, state.activeSessionId, state.sessions, triggerSendFlow])

  // ★ #10: 删除单条消息
  const handleDeleteMessage = useCallback((msgId) => {
    if (!msgId) return
    if (typeof window !== 'undefined' && !window.confirm('删除这条消息?')) return
    dispatch({ type: 'DELETE_MESSAGE', payload: msgId })
  }, [dispatch])


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

  return (
    <div className="h-screen flex bg-paper overflow-hidden">
      <LeftRail />

      <div className="flex-1 flex flex-col min-w-0">
        <ChatHeader
          activeSession={activeSession}
          messages={messages}
          lastFailedPrompt={lastFailedPrompt}
          modelOptions={modelOptions}
          selectedModel={selectedModel}
          hasTasks={tasks.length > 0}
          agentMode={agentMode}
          onAgentModeChange={(mode) => dispatch({ type: 'SET_AGENT_MODE', payload: mode })}
          onExport={(format = 'json') => {
            if (!activeSession) return
            exportSession(activeSession, format)
            setWorkbenchMessage(format === 'md' ? '当前会话已导出为 Markdown。' : '当前会话已导出为 JSON。')
          }}
          onCompress={() => {
            if (messages.length <= 8) { setWorkbenchMessage('当前上下文还不长，暂时不需要压缩。'); return }
            dispatch({ type: 'COMPRESS_CURRENT_SESSION' })
            setWorkbenchMessage('已压缩较早上下文，保留最近消息。')
          }}
          onRetry={() => { if (lastFailedPrompt) triggerSendFlow(lastFailedPrompt) }}
          onModelChange={(val) => { setSelectedModel(val); writeStoredModel(val) }}
          onNavigateTask={() => navigate('/task')}
        />

        {/* Feature 8: Todo 追踪 sticky strip */}
        {Array.isArray(activeSession?.todos) && activeSession.todos.length > 0 && (
          <TodoTracker
            todos={activeSession.todos}
            onClear={() => dispatch({ type: 'CLEAR_TODOS' })}
          />
        )}

        <ChatMessages
          messages={messages}
          state={state}
          workbenchMessage={workbenchMessage}
          showContextPanel={showContextPanel}
          setShowContextPanel={setShowContextPanel}
          selectedModel={selectedModel}
          isGenerating={isGenerating}
          onExampleClick={(label) => triggerSendFlow(label)}
          onEditMessage={handleEditMessage}
          onRegenerateMessage={handleRegenerate}
          onDeleteMessage={handleDeleteMessage}
          onPermAllow={handlePermAllow}
          onPermDeny={handlePermDeny}
          onNavigatePermissions={() => navigate('/permissions')}
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

        <ChatComposer
          input={input}
          setInput={setInput}
          onSend={handleSend}
          attachments={attachments}
          setAttachments={setAttachments}
          showSlashMenu={showSlashMenu}
          setShowSlashMenu={setShowSlashMenu}
          filteredSkills={filteredSkills}
          selectedIndex={selectedIndex}
          setSelectedIndex={setSelectedIndex}
          voiceState={voiceState}
          setVoiceState={setVoiceState}
          showContextPanel={showContextPanel}
          setShowContextPanel={setShowContextPanel}
          isGenerating={isGenerating}
          onAbort={handleAbortTask}
          messages={messages}
          onFileChange={handleFileChange}
          onVoiceClick={handleVoice}
          onContextClick={() => setShowContextPanel((v) => !v)}
          onQuickSkillClick={(skill) => {
            if (skill.solid) { navigate('/skills'); return }
            setInput(skill.command + ' ')
          }}
          handleKeyDown={handleKeyDown}
          skills={runtimeSkills}
        />
      </div>

      {state.previewArtifact ? (
        <RightPreviewPane
          artifact={state.previewArtifact}
          onClose={() => dispatch({ type: 'CLOSE_PREVIEW_ARTIFACT' })}
          onMessage={setWorkbenchMessage}
        />
      ) : agentMode === 'code' ? (
        <CodingWorkbench onMessage={setWorkbenchMessage} />
      ) : null}
    </div>
  )
}
