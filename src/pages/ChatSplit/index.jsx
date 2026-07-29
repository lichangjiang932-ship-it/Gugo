import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import LeftRail from '../../components/LeftRail'
import { useAppContext } from '../../store/AppContext'
import { SKILLS, getSkillSystemPrompt } from '../../data.js'
import { buildUserContentWithAttachments, describeAttachmentPrompt } from '../../lib/attachments.js'
import { callModelThroughProxyStream, getModelStatus, summarizeSessionTitle } from '../../lib/modelClient.js'
import { buildToolSpecs, buildToolSpecsAsync, executeToolCall, resolveToolsForMode, setCachedApprovalSettings } from '../../lib/tools/index.js'
import { readStoredModel, resolveInitialModel, writeStoredModel } from '../../lib/modelSelection.js'
import { isLoggedInLocally } from '../../lib/accountClient.js'
import { useActiveAgent } from '../../agents/activeAgentContext.js'
import { listSkills } from '../../lib/skillClient.js'
import { listPromptTemplatesApi, getPromptTemplateContentApi, renderPromptTemplate } from '../../lib/pluginClient.js'
import { createSlashCommandRegistry, normalizeSlashCommandName, parseSlashCommandInput } from '../../lib/slashCommandRegistry.js'
import { CORE_SLASH_COMMANDS, registerCoreSlashCommands } from '../../lib/slashCoreCommands.js'
import { handleSlashAutocompleteKeyDown } from '../../components/slashAutocompleteLogic.js'
import { inferSkillIdFromPrompt, parseSkillCommand } from '../../lib/skillCommands.js'
import { TASK_STATUS, TOOL_CALL_STATUS, HISTORY_STATUS } from '../../store/taskStatus.js'
import ChatHeader from './ChatHeader'
import ChatMessages from './ChatMessages'
import ChatComposer from './ChatComposer'
import RightPreviewPane from './RightPreviewPane'
import CodingWorkbench from './CodingWorkbench'
import TodoTracker from '../../components/TodoTracker'
import ApplyPatchApprovalModal from '../../components/ApplyPatchApprovalModal'
import ToolApprovalCard from '../../components/ToolApprovalCard.jsx'
import PermissionModeSwitcher from '../../components/PermissionModeSwitcher.jsx'
import { fetchApprovalSettings, updateApprovalSettings } from '../../lib/approvalClient.js'
import { useToast } from '../../components/Toast.jsx'
import { useT } from '../../i18n/I18nProvider.jsx'
import { buildArtifactPreview } from '../../lib/artifactPreview.js'
import { exportSession } from '../../lib/sessionExport.js'
import { compressImageDataUrl } from '../../lib/imageCompress.js'
import { extractPdfText } from '../../lib/pdfExtract.js'
import { extractDocxText, extractPptxText, isDocxFile, isPptxFile } from '../../lib/officeExtract.js'
import { fetchCompactionArchive } from '../../lib/compactionClient.js'
import { trimHistoryWithHysteresis } from '../../lib/historyWindow.js'
import {
  artifactTypeForSkill,
  buildAssistantToolCallsMessage,
  buildChatFailureMessage,
  filterToolNamesForSkill,
  shouldStopAfterArtifactTool,
} from '../../lib/chatFlowGuards.js'

const MAX_IMAGE_BYTES = 4 * 1024 * 1024
const MAX_RAW_IMAGE_BYTES = 16 * 1024 * 1024
const MAX_IMAGES_PER_MESSAGE = 5
const MAX_TEXT_BYTES = 256 * 1024
// 死循环护栏。正常任务(哪怕读完整个项目再动手改)也远到不了这个量级,
// 它防的是模型反复调同一个工具停不下来,不是给工作设预算。
const RUNAWAY_ROUND_GUARD = 500
const EMPTY_MESSAGES = []

function promptTemplateCommandName(tpl) {
  const byName = normalizeSlashCommandName(tpl?.name)
  return byName || normalizeSlashCommandName(tpl?.id)
}

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

// 统一截断：提取出的文本超过 MAX_TEXT_BYTES 时截到一半字符并加提示，
// 而不是丢掉内容回退成"只有名称"。
function clampTextToBytes(text, label = '内容过长') {
  const value = String(text ?? '')
  if (new TextEncoder().encode(value).length <= MAX_TEXT_BYTES) return value
  const maxChars = Math.floor(MAX_TEXT_BYTES / 2)
  return `${value.slice(0, maxChars)}\n\n[${label}，已截断]`
}

export default function ChatSplit() {
  const navigate = useNavigate()
  const { state, dispatch } = useAppContext()
  const toast = useToast()
  const { t } = useT()
  const { activeAgentId: globalActiveAgentId } = useActiveAgent()
  const [input, setInput] = useState('')
  const [modelOptions, setModelOptions] = useState([])
  // 0 = 不限轮数(默认)。只有服务端显式配了正数才封顶。
  const [toolMaxRounds, setToolMaxRounds] = useState(0)
  const [selectedModel, setSelectedModel] = useState('')
  const [runtimeSkills, setRuntimeSkills] = useState(SKILLS)
  // Phase 2 S4: prompt-template plugins 进 slash 菜单
  const [promptTemplates, setPromptTemplates] = useState([])
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
  const [applyPatchApproval, setApplyPatchApproval] = useState({ open: false, changes: [], busy: false })
  // ★ 通用工具审批:决策就在对话里做,不用切页面(对齐 Claude Code)
  const [toolApproval, setToolApproval] = useState({ open: false, request: null, busy: false })
  const toolApprovalResolveRef = useRef(null)
  const [approvalSettings, setApprovalSettings] = useState({ mode: 'normal', rememberedTools: [] })
  const abortCtrlRef = useRef(null)
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

  const activeSession = state.sessions.find((s) => s.id === state.activeSessionId)
  // 阶段 6: session sticky agent。优先用 session.agentId，没设则 fallback 全局。
  const sessionAgentId = activeSession?.agentId || null
  const effectiveAgentId = sessionAgentId || globalActiveAgentId || null
  const messages = activeSession?.messages ?? EMPTY_MESSAGES
  const tasks = state.tasks
  const [showCodingWorkbench, setShowCodingWorkbench] = useState(false)
  useEffect(() => {
    stateRef.current = state
  }, [state])

  const slashRegistry = useMemo(() => {
    const registry = createSlashCommandRegistry()
    registerCoreSlashCommands(registry, { t })
    for (const skill of runtimeSkills || []) {
      if (!skill?.id) continue
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
  }, [promptTemplates, runtimeSkills, t])

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
        if (!cancelled && Array.isArray(skills) && skills.length) setRuntimeSkills(skills)
      })
      .catch((err) => {
        console.warn('[ChatSplit] 无法加载远程技能，使用内置技能:', err?.message || err)
        if (!cancelled) setRuntimeSkills(SKILLS)
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

  // ★ 切换会话时自动中断正在进行的模型流
  useEffect(() => {
    // 用 abort 中断上游请求，模型流自然结束会走 finally 清理
    abortCtrlRef.current?.abort()
  }, [state.activeSessionId])

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
  const slashAutocompleteItems = useMemo(
    () => (isSlashActive ? slashRegistry.listCommands({ query: slashQuery }) : []),
    [isSlashActive, slashQuery, slashRegistry],
  )
  const slashItemsCount = slashAutocompleteItems.length

  /* ── send flow ── */
  const triggerSendFlow = useCallback(
    async (content, explicitAttachments = null) => {
      if (isGenerating) return
      const activeSession = state.sessions.find((s) => s.id === state.activeSessionId)
      // ★ 修复: 保留 tool 消息，让模型能回顾上一轮工具结果
      // 但截断过长内容防止 token 溢出
      //
      // ★ 缓存: 用滞回窗口而不是每轮 slice(-20)。固定 slice(-20) 在会话超过 20 条后
      // 每轮都丢掉最老一条,字节前缀每次都变 → 上游前缀缓存从第 21 轮起彻底失效。
      // 改成「超过 HIGH 才裁,一裁裁到 LOW」,前缀能连续稳定约 10 轮再变一次。
      const eligible = (activeSession?.messages || [])
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
        toast.error(t('errors.loginRequired'))
        return
      }

      // 提前生成 task ID,后续 UPDATE_TASK / REMOVE_TASK 用得上
      const taskId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`

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
        const injectedMemoryIdSet = new Set()
        // G1: 工具调用产出的 artifact (create_pptx/docx/xlsx) 暂存,
        // 流程结束后写到 last message meta — 让 ChatMessages 直接渲染卡片 + 弹右栏.
        // 取最后一个,因为同一轮多次生成时模型期望的"最终产物"通常是末次调用.
        // 提升到 try 外:try 内声明会让后面的 finalize 块拿不到。
        let toolArtifact = null

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
            let stopAfterArtifact = false
            for await (const event of callModelThroughProxyStream({
              messages,
              modelName,
              agentId: effectiveAgentId || undefined,
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
              }
            }

            // 本轮没工具调用 → 模型已经给出最终文本,退出
            if (!pendingToolCalls || pendingToolCalls.length === 0) break

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
              messages.push({
                role: 'system',
                content: `你已达到本轮对话的工具调用上限(${toolMaxRounds} 轮)。`
                  + '请立刻基于目前已经拿到的信息给出结论,不要再调用任何工具。'
                  + '如果信息不足以完成用户的全部要求,就说明已经查清了什么、还差什么、建议下一步怎么做。',
              })
              for await (const event of callModelThroughProxyStream({
                messages,
                modelName,
                agentId: effectiveAgentId || undefined,
                signal: controller.signal,
                // 不传 tools,从协议层杜绝它再调工具
              })) {
                if (event.type === 'text') {
                  dispatch({ type: 'APPEND_TO_LAST_MESSAGE', payload: event.delta })
                } else if (event.type === 'done') {
                  if (typeof event.billing?.creditsCharged === 'number') {
                    totalCreditsCharged += event.billing.creditsCharged
                  }
                  if (typeof event.billing?.credits === 'number') {
                    latestCreditsBalance = event.billing.credits
                  }
                }
              }
              break
            }

            // 1) 把模型本轮发出的 assistant tool_calls 落入 messages(给上游做上下文)
            messages.push(buildAssistantToolCallsMessage(pendingToolCalls))

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
                // 只有用户明确要产物时(走了 skill)才把产物当成最终答复;
                // 否则产物只是中间物,必须让模型继续说清改了什么
                if (shouldStopAfterArtifactTool(result.artifact, { artifactWasRequested: !!skillId })) {
                  stopAfterArtifact = true
                }
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
              // ★ 截断过长工具结果，防止下一轮模型调用超出 token 限制
              const MAX_TOOL_RESULT_CHARS = 4000
              let toolContent = String(result.content || '')
              if (toolContent.length > MAX_TOOL_RESULT_CHARS) {
                toolContent = toolContent.slice(0, MAX_TOOL_RESULT_CHARS) + `\n...[截断，共 ${toolContent.length} 字符]`
              }
              messages.push({
                role: 'tool',
                tool_call_id: call.id,
                name: call.name,
                content: toolContent,
              })
            }
            if (stopAfterArtifact) break
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
        if (err.message === '已停止生成') {
          // ★ FIX: 中断也要把任务清掉,不能继续显示 "running 10%"
          dispatch({ type: 'UPDATE_LAST_MESSAGE_META', payload: { streaming: false } })
          dispatch({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { status: TASK_STATUS.CANCELLED, stepLabel: '已中断' } } })
          setTimeout(() => dispatch({ type: 'REMOVE_TASK', payload: taskId }), 3000)
          return
        }
        if (import.meta.env.DEV) console.error('Model call failed:', err)
        toast.error({
          title: t('toast.chatSendFailed'),
          body: err.message,
        })
        setLastFailedPrompt(content)
        dispatch({ type: 'APPEND_TO_LAST_MESSAGE', payload: buildChatFailureMessage(err.message) })
        dispatch({ type: 'UPDATE_LAST_MESSAGE_META', payload: { streaming: false, failed: true } })
        dispatch({ type: 'ADD_HISTORY', payload: { name: taskName, skill: skill?.name || '通用对话', status: HISTORY_STATUS.FAILED, detail: content.length > 60 ? `${content.slice(0, 60)}...` : content, state: `失败: ${err.message}`.slice(0, 80), date: Date.now() } })
        // ★ FIX: 失败时把同一个任务标记 failed (而非再 ADD 一条新的"running 15%"),5 秒后移除
        dispatch({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { status: TASK_STATUS.FAILED, stepLabel: '调用失败' } } })
        setTimeout(() => dispatch({ type: 'REMOVE_TASK', payload: taskId }), 5000)
      }
    },
    // ★ #27: 细粒度 deps,只收 triggerSendFlow body 里实际读的字段;
    //         避免依赖整个 state 导致每次 sessionDrafts/tasks 变都重建 callback
    [attachments, dispatch, isGenerating, modelOptions, selectedModel, toolMaxRounds, runtimeSkills, effectiveAgentId, toast, t,
      state.activeSessionId, state.sessions, state.toolsConfig, state.permissions, state.skillConfigs]
  )

  const executeSlashEntry = useCallback(async (entry, args = '') => {
    if (!entry) return false
    slashRegistry.recordRecent(entry.name)
    setShowSlashMenu(false)

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
  }, [dispatch, slashRegistry, triggerSendFlow])

  const completeSlashEntry = useCallback((entry) => {
    if (!entry?.name) return
    setInput(`/${entry.name} `)
    setShowSlashMenu(false)
  }, [])

  const handleSend = useCallback(() => {
    const typedContent = input.trim()
    if (!typedContent && attachments.length === 0) return
    const parsedSlash = parseSlashCommandInput(typedContent)
    const slashEntry = parsedSlash ? slashRegistry.getCommand(parsedSlash.name) : null
    if (slashEntry && slashEntry.kind !== 'skill') {
      setInput('')
      setShowSlashMenu(false)
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
    setShowSlashMenu(false)
    triggerSendFlow(content, currentAttachments)
  }, [attachments, input, triggerSendFlow, state.activeSessionId, dispatch, slashRegistry, executeSlashEntry])

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
    if (showSlashMenu && slashItemsCount > 0) {
      const handled = handleSlashAutocompleteKeyDown(e, {
        items: slashAutocompleteItems,
        selectedIndex,
        setSelectedIndex,
        onPick: (entry) => executeSlashEntry(entry, ''),
        onComplete: completeSlashEntry,
        onDismiss: () => setShowSlashMenu(false),
      })
      if (handled) return
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
  }, [showSlashMenu, slashItemsCount, slashAutocompleteItems, selectedIndex, handleSend, executeSlashEntry, completeSlashEntry])

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
          const text = clampTextToBytes(await readExcelAsText(file), 'Excel 内容过长')
          nextAttachments.push({ id, name: file.name, sizeKB, type: file.type, kind: 'text', text })
        } else if (isPdfFile(file)) {
          const text = await extractPdfText(file)
          nextAttachments.push({ id, name: file.name, sizeKB, type: file.type, kind: 'text', text })
        } else if (isDocxFile(file)) {
          const text = clampTextToBytes(await extractDocxText(file), 'Word 内容过长')
          nextAttachments.push({ id, name: file.name, sizeKB, type: file.type, kind: 'text', text })
        } else if (isPptxFile(file)) {
          const text = clampTextToBytes(await extractPptxText(file), 'PPT 内容过长')
          nextAttachments.push({ id, name: file.name, sizeKB, type: file.type, kind: 'text', text })
        } else if (isTextLikeFile(file)) {
          // 文本类文件不再因超过 256KB 直接丢内容；统一截断后保留正文。
          const text = clampTextToBytes(await file.text(), '文本内容过长')
          nextAttachments.push({ id, name: file.name, sizeKB, type: file.type, kind: 'text', text })
        } else {
          // 真正无法本地解析的二进制（旧版 .doc/.ppt、.zip、.epub 等）：保留为附件并显式告知原因，
          // 而不是静默变成"只有名称"。
          nextAttachments.push({
            id,
            name: file.name,
            sizeKB,
            type: file.type,
            kind: 'file',
            error: '该格式无法在本地读取正文，仅发送文件名与元信息。',
          })
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
        <ChatHeader
          activeSession={activeSession}
          messages={messages}
          lastFailedPrompt={lastFailedPrompt}
          modelOptions={modelOptions}
          selectedModel={selectedModel}
          hasTasks={tasks.length > 0}
          showWorkbench={showCodingWorkbench}
          onToggleWorkbench={() => {
            if (state.previewArtifact) dispatch({ type: 'CLOSE_PREVIEW_ARTIFACT' })
            setShowCodingWorkbench((visible) => !visible)
          }}
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
          onManageModels={handleManageModels}
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
          <div className="px-4 pb-2">
            <ToolApprovalCard
              open={toolApproval.open}
              request={toolApproval.request}
              busy={toolApproval.busy}
              onDecide={resolveToolApproval}
            />
          </div>
        )}

        {/* 权限档位:随时能改「要被问到什么程度」 */}
        <div className="px-4 pb-1.5 flex items-center">
          <PermissionModeSwitcher
            mode={approvalSettings?.mode || 'normal'}
            onChange={changeApprovalMode}
            disabled={isGenerating}
          />
        </div>

        <ChatComposer
          input={input}
          setInput={setInput}
          onSend={handleSend}
          attachments={attachments}
          setAttachments={setAttachments}
          showSlashMenu={showSlashMenu}
          setShowSlashMenu={setShowSlashMenu}
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
          slashRegistry={slashRegistry}
          onPickSlashCommand={(entry) => executeSlashEntry(entry, '')}
          onCompleteSlashCommand={completeSlashEntry}
        />
      </div>

      {state.previewArtifact ? (
        <RightPreviewPane
          artifact={state.previewArtifact}
          onClose={() => dispatch({ type: 'CLOSE_PREVIEW_ARTIFACT' })}
          onMessage={setWorkbenchMessage}
        />
      ) : showCodingWorkbench ? (
        <CodingWorkbench onMessage={setWorkbenchMessage} />
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
