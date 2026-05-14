import { useState, useRef, useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  LayoutList,
  ChevronDown,
  Check,
  Circle,
  Pause,
  X,
  ArrowUpRight,
  Download,
  FolderOpen,
  BarChart3,
  FileText,
  Paperclip,
  Mic,
  Minimize2,
  RotateCcw,
  Send,
} from 'lucide-react'
import LeftRail from '../components/LeftRail'
import { useAppContext } from '../store/AppContext'
import { SKILLS, getSkillSystemPrompt } from '../data.js'
import { buildUserContentWithAttachments, describeAttachmentPrompt } from '../lib/attachments.js'
import { callModelThroughProxy, getModelStatus } from '../lib/modelClient.js'
import { readStoredModel, resolveInitialModel, writeStoredModel } from '../lib/modelSelection.js'
import { isLoggedInLocally } from '../lib/accountClient.js'

const EXAMPLE_QUESTIONS = [
  { icon: FileText, label: '生成周报' },
  { icon: BarChart3, label: '分析数据' },
]

const QUICK_SKILLS = [
  { label: '/ppt', command: '/ppt', active: true },
  { label: '/excel', command: '/excel', active: false },
  { label: '/doc', command: '/doc', active: false },
  { label: '+ 全部技能', command: null, solid: true },
]

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

const MAX_IMAGE_BYTES = 4 * 1024 * 1024
const MAX_TEXT_BYTES = 256 * 1024

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error || new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

function isTextLikeFile(file) {
  return /^text\/|json|xml|csv|markdown|javascript|typescript/.test(file.type) ||
    /\.(txt|md|json|csv|xml|yml|yaml|log|js|jsx|ts|tsx|css|html)$/i.test(file.name)
}

export default function ChatSplit() {
  const navigate = useNavigate()
  const { state, dispatch } = useAppContext()
  const [input, setInput] = useState('')
  const [modelOptions, setModelOptions] = useState([])
  const [selectedModel, setSelectedModel] = useState('')
  const [showSlashMenu, setShowSlashMenu] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [lastFailedPrompt, setLastFailedPrompt] = useState('')
  const [workbenchMessage, setWorkbenchMessage] = useState('')
  const [attachments, setAttachments] = useState([])
  const textareaRef = useRef(null)
  const fileInputRef = useRef(null)
  const activeSession = state.sessions.find((s) => s.id === state.activeSessionId)
  const messages = activeSession?.messages ?? []
  const hasMessages = messages.length > 0
  const tasks = state.tasks
  const hasTasks = tasks.length > 0
  const activeTask = tasks.find((t) => t.status === 'running') || tasks[0]
  const skillChain = activeTask?.perms || []

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
    return () => {
      cancelled = true
    }
  }, [])

  /* 鈹€鈹€ apply draft input from skill market 鈹€鈹€ */
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (state.draftInput) {
      setInput(state.draftInput)
      dispatch({ type: 'SET_DRAFT_INPUT', payload: '' })
      setTimeout(() => textareaRef.current?.focus(), 50)
    }
  }, [state.draftInput, dispatch])
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!state.activeSessionId) {
      dispatch({ type: 'NEW_SESSION', payload: '新对话' })
    }
  }, [dispatch, state.activeSessionId])

  /* 鈹€鈹€ slash menu filtering 鈹€鈹€ */
  const isSlashActive = input.startsWith('/') && !input.includes(' ')
  const slashQuery = isSlashActive ? input.slice(1).toLowerCase() : ''
  const filteredSkills = slashQuery
    ? SKILLS.filter(
        (s) =>
          s.id.toLowerCase().includes(slashQuery) ||
          s.name.toLowerCase().includes(slashQuery)
      )
    : SKILLS

  const handleInputChange = (e) => {
    const val = e.target.value
    const prev = input
    setInput(val)

    const shouldShow = (v) => {
      if (!v.startsWith('/') || v.includes(' ')) return false
      const q = v.slice(1).toLowerCase()
      if (!q) return true
      return SKILLS.some(
        (s) =>
          s.id.toLowerCase().includes(q) ||
          s.name.toLowerCase().includes(q)
      )
    }

    const nowShow = shouldShow(val)
    const wasShow = shouldShow(prev)

    if (nowShow && !wasShow) {
      setShowSlashMenu(true)
      setSelectedIndex(0)
    } else if (!nowShow && wasShow) {
      setShowSlashMenu(false)
    }
  }

  /* 鈹€鈹€ send flow 鈹€鈹€ */
  const triggerSendFlow = useCallback(
    async (content) => {
      dispatch({ type: 'SEND_MESSAGE', payload: content })
      setWorkbenchMessage('')

      // 解析技能命令 /skillId 后面的内容
      const skillMatch = content.match(/^\/(\w+)\s*(.*)/)
      const skillId = skillMatch ? skillMatch[1] : null
      const userPrompt = skillMatch ? skillMatch[2] : content

      const isSensitive = false

      const skill = skillId ? SKILLS.find((s) => s.id === skillId) : null
      const taskName = skill?.name || (content.toLowerCase().includes('ppt') ? '制作 PPT' : content.toLowerCase().includes('excel') ? '分析表格' : '通用任务')

      if (!isLoggedInLocally()) {
        dispatch({
          type: 'RECEIVE_MESSAGE',
          payload: '请登录账户',
        })
        return
      }

      try {
        const messages = []
        const systemPrompt = skillId ? getSkillSystemPrompt(skillId) : ''
        if (systemPrompt) messages.push({ role: 'system', content: systemPrompt })
        messages.push({
          role: 'user',
          content: buildUserContentWithAttachments(userPrompt || content, attachments),
        })

        dispatch({
          type: 'ADD_TASK',
          payload: {
            name: taskName,
            detail: content,
            status: isSensitive ? 'pending' : 'running',
            progress: isSensitive ? 0 : 10,
            step: 1,
            stepLabel: '调用模型中',
            perms: skill?.perms || [],
          },
        })

        const modelName = selectedModel || resolveInitialModel(modelOptions)
        const result = await callModelThroughProxy({ messages, modelName })
        setLastFailedPrompt('')
        setAttachments([])
        dispatch({
          type: 'RECEIVE_MESSAGE',
          payload: {
            content: result.reply,
            meta: {
              type: 'model_reply',
              modelName: modelName || 'backend-default',
              creditsCharged: result.creditsCharged ?? 0,
              balance: result.user?.credits,
              latency: result.latency,
            },
          },
        })
        dispatch({
          type: 'ADD_HISTORY',
          payload: {
            name: taskName,
            skill: skill?.name || '通用对话',
            status: 'success',
            detail: content.length > 60 ? `${content.slice(0, 60)}...` : content,
            state: '已完成',
            date: Date.now(),
          },
        })
        const notifyPerm = state.permissions.find((p) => p.id === 'notify')
        if (notifyPerm?.enabled && 'Notification' in window && Notification.permission === 'granted') {
          try {
            new Notification('模型回复完成', { body: taskName, icon: '/favicon.svg' })
          } catch {
            // ignore notification errors
          }
        }
      } catch (err) {
        console.error('Model call failed:', err)
        setLastFailedPrompt(content)
        dispatch({
          type: 'RECEIVE_MESSAGE',
          payload: `模型调用失败：${err.message}\n\n请联系管理员检查后端 .env 中的 MODEL_BASE_URL、MODEL_NAME 和 MODEL_API_KEY。`,
        })

        dispatch({
          type: 'ADD_HISTORY',
          payload: {
            name: taskName,
            skill: skill?.name || '通用对话',
            status: 'failed',
            detail: content.length > 60 ? `${content.slice(0, 60)}...` : content,
            state: `失败: ${err.message}`.slice(0, 80),
            date: Date.now(),
          },
        })

        dispatch({
          type: 'ADD_TASK',
          payload: {
            name: taskName,
            detail: content,
            status: isSensitive ? 'pending' : 'running',
            progress: isSensitive ? 0 : 15,
            step: 1,
            stepLabel: '调用失败',
            perms: skill?.perms || [],
          },
        })
      }
    },
    [attachments, dispatch, modelOptions, selectedModel, state.permissions]
  )

  const handleSend = useCallback(() => {
    const typedContent = input.trim()
    if (!typedContent && attachments.length === 0) return
    const content = typedContent || describeAttachmentPrompt(attachments)
    setInput('')
    setShowSlashMenu(false)
    triggerSendFlow(content)
  }, [attachments, input, triggerSendFlow])

  const handleExampleClick = (label) => {
    triggerSendFlow(label)
  }

  const handleRetry = () => {
    if (!lastFailedPrompt) return
    triggerSendFlow(lastFailedPrompt)
  }

  const handleExportSession = () => {
    if (!activeSession) return
    downloadJson(`session-${activeSession.id}.json`, activeSession)
    setWorkbenchMessage('当前会话已导出。')
  }

  const handleCompressContext = () => {
    if (messages.length <= 8) {
      setWorkbenchMessage('当前上下文还不长，暂时不需要压缩。')
      return
    }
    dispatch({ type: 'COMPRESS_CURRENT_SESSION' })
    setWorkbenchMessage('已压缩较早上下文，保留最近消息。')
  }

  /* 鈹€鈹€ keyboard 鈹€鈹€ */
  const handleKeyDown = (e) => {
    if (showSlashMenu && filteredSkills.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((i) => (i + 1) % filteredSkills.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex(
          (i) => (i - 1 + filteredSkills.length) % filteredSkills.length
        )
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        const skill = filteredSkills[selectedIndex]
        if (skill) {
          setInput(`/${skill.id} `)
          setShowSlashMenu(false)
          setTimeout(() => textareaRef.current?.focus(), 0)
        }
        return
      }
      if (e.key === 'Escape') {
        setShowSlashMenu(false)
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  /* 鈹€鈹€ quick skills 鈹€鈹€ */
  const handleQuickSkillClick = (skill) => {
    if (skill.solid) {
      navigate('/skills')
      return
    }
    setInput(skill.command + ' ')
    textareaRef.current?.focus()
  }

  /* 鈹€鈹€ attachment / voice / context 鈹€鈹€ */
  const [voiceState, setVoiceState] = useState('idle') // 'idle' | 'listening' | 'unsupported'
  const [showContextPanel, setShowContextPanel] = useState(false)
  const [tasksExpanded, setTasksExpanded] = useState(true)
  const recognitionRef = useRef(null)

  const handleAttachment = () => {
    fileInputRef.current?.click()
  }
  const handleFileChange = async (e) => {
    const selectedFiles = Array.from(e.target.files || [])
    e.target.value = ''
    if (!selectedFiles.length) return

    const nextAttachments = []
    for (const file of selectedFiles) {
      const sizeKB = (file.size / 1024).toFixed(1)
      const id = crypto.randomUUID?.() ?? `${Date.now()}-${file.name}`
      try {
        if (file.type.startsWith('image/')) {
          if (file.size > MAX_IMAGE_BYTES) {
            nextAttachments.push({ id, name: file.name, sizeKB, type: file.type, kind: 'file', error: '图片超过 4MB，已只附加文件信息' })
          } else {
            nextAttachments.push({ id, name: file.name, sizeKB, type: file.type, kind: 'image', dataUrl: await readFileAsDataUrl(file) })
          }
        } else if (isTextLikeFile(file) && file.size <= MAX_TEXT_BYTES) {
          nextAttachments.push({ id, name: file.name, sizeKB, type: file.type, kind: 'text', text: await file.text() })
        } else {
          nextAttachments.push({ id, name: file.name, sizeKB, type: file.type, kind: 'file' })
        }
      } catch (err) {
        nextAttachments.push({ id, name: file.name, sizeKB, type: file.type, kind: 'file', error: err.message || '读取失败' })
      }
    }

    setAttachments((current) => [...current, ...nextAttachments].slice(0, 8))
    setWorkbenchMessage(`已添加 ${nextAttachments.length} 个附件。图片会发送给支持视觉的模型；文本文件会作为上下文发送。`)
    setTimeout(() => textareaRef.current?.focus(), 30)
  }
  const handleVoice = () => {
    const micPerm = state.permissions.find((p) => p.id === 'mic')
    if (!micPerm?.enabled) {
      setWorkbenchMessage('请在权限中心开启麦克风输入权限。')
      return
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) {
      setVoiceState('unsupported')
      setTimeout(() => setVoiceState('idle'), 2000)
      return
    }
    if (voiceState === 'listening') {
      recognitionRef.current?.stop()
      return
    }
    try {
      const rec = new SR()
      rec.lang = 'zh-CN'
      rec.continuous = false
      rec.interimResults = true
      rec.onresult = (event) => {
        const transcript = Array.from(event.results)
          .map((r) => r[0]?.transcript || '')
          .join('')
        setInput((prev) => {
          // 保留原内容，把识别中的文本放在末尾
          const base = prev.replace(/\s*\[识别中：[^\]]*\]\s*$/, '')
          return event.results[0]?.isFinal
            ? `${base}${base ? ' ' : ''}${transcript}`
            : `${base} [识别中：${transcript}]`
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
  const handleContext = () => {
    setShowContextPanel((v) => !v)
  }

  /* 鈹€鈹€ permission card 鈹€鈹€ */
  const handlePermAllow = () => {
    dispatch({ type: 'SET_PERM_REQUEST', payload: null })
    // 把最近的 pending 任务改为 running
    const pendingTask = [...state.tasks].reverse().find((t) => t.status === 'pending')
    if (pendingTask) {
      dispatch({
        type: 'UPDATE_TASK',
        payload: {
          id: pendingTask.id,
          updates: { status: 'running', progress: 20, stepLabel: '权限已获取，继续执行' },
        },
      })
    }
    dispatch({ type: 'RECEIVE_MESSAGE', payload: '✅ 已授权，继续执行中。' })
  }

  const handlePermDeny = () => {
    dispatch({ type: 'SET_PERM_REQUEST', payload: null })
    dispatch({ type: 'RECEIVE_MESSAGE', payload: '已拒绝该操作。' })
  }

  /* 鈹€鈹€ task actions 鈹€鈹€ */
  const handlePauseTask = (taskId) => {
    dispatch({
      type: 'UPDATE_TASK',
      payload: { id: taskId, updates: { status: 'paused' } },
    })
  }
  const handleStopTask = (taskId) => {
    dispatch({
      type: 'UPDATE_TASK',
      payload: { id: taskId, updates: { status: 'stopped' } },
    })
  }

  return (
    <div className="h-screen flex bg-paper overflow-hidden">
      <LeftRail />

      {/* Center Chat */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-dashed border-ink-fade/50">
          <div>
            <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">
              SESSION · {activeSession?.title || '新对话'}
            </span>
            <h2 className="font-hand text-lg text-ink mt-1">
              {activeSession?.title || '新对话'}
            </h2>
          </div>
          <div className="flex gap-2 items-center">
            <button
              onClick={handleExportSession}
              disabled={!activeSession}
              className="inline-flex items-center h-7 px-2 rounded-full text-xs border border-ink-fade/60 text-ink-soft hover:border-ink-fade transition-colors gap-1 disabled:opacity-50"
              title="导出当前会话"
            >
              <Download className="w-3.5 h-3.5" />
              导出
            </button>
            <button
              onClick={handleCompressContext}
              disabled={messages.length <= 8}
              className="inline-flex items-center h-7 px-2 rounded-full text-xs border border-ink-fade/60 text-ink-soft hover:border-ink-fade transition-colors gap-1 disabled:opacity-50"
              title="压缩较早上下文"
            >
              <Minimize2 className="w-3.5 h-3.5" />
              压缩
            </button>
            {lastFailedPrompt && (
              <button
                onClick={handleRetry}
                className="inline-flex items-center h-7 px-2 rounded-full text-xs border border-ember-line text-ember bg-ember-soft hover:bg-ember-soft/70 transition-colors gap-1"
                title="重试上一条失败消息"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                重试
              </button>
            )}
            {modelOptions.length > 0 && (
              <select
                value={selectedModel}
                onChange={(e) => {
                  setSelectedModel(e.target.value)
                  writeStoredModel(e.target.value)
                }}
                className="h-7 px-2 rounded-full text-xs border border-ink-fade/60 bg-paper text-ink-soft outline-none hover:border-ink-fade"
                title="选择后端允许的模型"
              >
                {modelOptions.map((model) => (
                  <option key={model.name} value={model.name}>
                    {model.name} · x{model.multiplier}
                  </option>
                ))}
              </select>
            )}
            {hasTasks && (
              <button
                onClick={() => navigate('/task')}
                className="inline-flex items-center h-7 px-3 rounded-full text-xs border border-ember-line text-ember bg-ember-soft gap-1.5 hover:bg-ember-soft/70 transition-colors"
              >
                <LayoutList className="w-3.5 h-3.5" />
                任务进行中              </button>
            )}
            <button
              onClick={() => navigate('/task')}
              className="inline-flex items-center h-7 px-3 rounded-full text-xs border border-ink-fade/60 text-ink-soft hover:border-ink-fade transition-colors gap-1.5"
            >
              <LayoutList className="w-3.5 h-3.5" />
              任务面板
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-7 py-6">
          <div className="w-full max-w-[1080px] ml-0 mr-auto flex flex-col gap-5">
            {workbenchMessage && (
              <div className="p-3 border border-ink-fade/40 rounded-md bg-paper-2 text-xs text-ink-soft">
                {workbenchMessage}
              </div>
            )}
            {showContextPanel && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="border border-dashed border-ember/40 bg-ember-soft/40 rounded-md p-3 text-xs text-ink-soft"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ember">
                    CONTEXT · 当前会话上下文                  </span>
                  <button
                    onClick={() => setShowContextPanel(false)}
                    className="text-ink-fade hover:text-ink"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
                <div className="grid grid-cols-3 gap-2 text-[11px]">
                  <div>
                    <span className="text-ink-fade">消息数</span>
                    <div className="font-hand text-base text-ink">{messages.length}</div>
                  </div>
                  <div>
                    <span className="text-ink-fade">字符数</span>
                    <div className="font-hand text-base text-ink">
                      {messages.reduce((sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0), 0)}
                    </div>
                  </div>
                  <div>
                    <span className="text-ink-fade">模型</span>
                    <div className="font-hand text-base text-ink">
                      {selectedModel || '后端默认'}
                    </div>
                  </div>
                </div>
                <div className="mt-2 pt-2 border-t border-dashed border-ember/30 text-[11px]">
                  <span className="text-ink-fade">提供商：</span>
                  <span className="text-ink">由后端 .env 统一配置</span>
                  <span className="ml-3 text-ink-fade">API Key 不进入浏览器</span>
                </div>
              </motion.div>
            )}
            {hasMessages ? (
              <>
                {messages.map((msg, i) => (
                  <motion.div
                    key={msg.id ?? i}
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.05, duration: 0.35 }}
                    className="flex gap-3 items-start w-full"
                  >
                    {msg.role === 'user' ? (
                      <div className="w-7 h-7 rounded-full border border-ink flex items-center justify-center bg-paper shrink-0">
                        <span className="font-hand text-xs text-ink">
                          {state.user.avatar || '?'}
                        </span>
                      </div>
                    ) : (
                      <div className="w-7 h-7 rounded-full border border-ember flex items-center justify-center bg-ember-soft shrink-0">
                        <SparklesIcon />
                      </div>
                    )}
                    <div
                      className={
                        'p-3 rounded-md text-sm leading-relaxed max-w-[920px] ' +
                        (msg.role === 'assistant' ? 'bg-paper-2 border border-ink/10' : 'pt-1.5')
                      }
                    >
                      {msg.content}
                      {msg.role === 'assistant' && msg.meta?.type === 'model_reply' && (
                        <div className="mt-3 pt-2 border-t border-dashed border-ink-fade/40 flex flex-wrap gap-2 text-[11px] text-ink-fade">
                          <span>模型：{msg.meta.modelName}</span>
                          <span>消耗：{msg.meta.creditsCharged} 积分</span>
                          {msg.meta.balance !== undefined && <span>余额：{msg.meta.balance}</span>}
                          {msg.meta.latency !== undefined && <span>延迟：{msg.meta.latency} ms</span>}
                        </div>
                      )}
                      {msg.role === 'assistant' && msg.meta?.type === 'context_summary' && (
                        <div className="mt-3 pt-2 border-t border-dashed border-ink-fade/40 text-[11px] text-ink-fade">
                          已压缩{msg.meta.compressedCount} 条较早消息                        </div>
                      )}
                    </div>
                  </motion.div>
                ))}

                {/* Inline permission card */}
                <AnimatePresence>
                  {state.permRequest && (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.96 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.96 }}
                      className="ml-10 p-4 border border-ember rounded-md bg-ember-soft animate-pulse-ember"
                    >
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[9px] tracking-wider text-ember">
                            ● 请求授权 · {state.permRequest.skillName}
                          </span>
                        </div>
                      </div>
                      <div className="flex flex-col gap-1.5 mb-4">
                        {state.permRequest.perms.map((p, pi) => (
                          <div
                            key={pi}
                            className="flex items-center gap-2 text-sm text-ink-soft"
                          >
                            <span className="font-mono text-ink-fade">–</span>
                            {p.name} · {p.detail}
                          </div>
                        ))}
                      </div>
                      <div className="flex gap-2 items-center">
                        <button
                          onClick={handlePermAllow}
                          className="h-9 px-4 bg-ember text-paper rounded-md font-hand text-sm hover:bg-ember/90 transition-colors"
                        >
                          允许并继续                        </button>
                        <button
                          onClick={handlePermDeny}
                          className="h-9 px-4 border border-ink/70 rounded-md font-hand text-sm hover:bg-paper-2 transition-colors"
                        >
                          拒绝
                        </button>
                        <button
                          onClick={() => navigate('/permissions')}
                          className="h-9 px-4 border border-dashed border-ink-fade/60 rounded-md font-hand text-sm hover:border-ink-fade transition-colors"
                        >
                          细化范围                        </button>
                        <div className="flex-1" />
                        <span className="text-xs text-ink-soft flex items-center gap-1">
                          <LayoutList className="w-3.5 h-3.5" />
                          权限请求已在本页处理
                        </span>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </>
            ) : (
              /* Welcome empty state */
              <motion.div
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5 }}
                className="flex-1 flex flex-col items-center justify-center min-h-[360px] gap-8"
              >
                <div className="text-center">
                  <h1 className="font-hand text-[32px] text-ink">
                    有什么可以帮你的？                  </h1>
                  <p className="text-sm text-ink-soft mt-2">
                    输入问题，或直接点击下方的示例开始                  </p>
                </div>
                <div className="flex flex-wrap justify-center gap-3">
                  {EXAMPLE_QUESTIONS.map((q, i) => (
                    <motion.button
                      key={i}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.15 + i * 0.08 }}
                      onClick={() => handleExampleClick(q.label)}
                      className="flex items-center gap-2 px-4 py-2.5 border border-ink-fade/50 rounded-md text-sm text-ink-soft hover:border-ink-fade hover:bg-paper-2 transition-colors"
                    >
                      <q.icon className="w-4 h-4 text-ink-fade" />
                      {q.label}
                    </motion.button>
                  ))}
                </div>
              </motion.div>
            )}
          </div>
        </div>

        {/* Composer */}
        <div className="px-6 pb-6 pt-3 border-t border-dashed border-ink-fade/50 relative">
          {/* Slash menu overlay */}
          <AnimatePresence>
            {showSlashMenu && filteredSkills.length > 0 && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-50 flex items-start justify-center pt-[30vh] bg-black/20"
                onClick={() => setShowSlashMenu(false)}
              >
                <motion.div
                  initial={{ opacity: 0, y: 8, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 8, scale: 0.98 }}
                  transition={{ duration: 0.2 }}
                  className="w-[480px] max-h-[360px] overflow-y-auto rounded-xl shadow-2xl border border-ink-fade/50 bg-paper p-2"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="px-2 py-1.5 font-mono text-[9px] tracking-wider text-ink-fade uppercase">
                    选择技能
                  </div>
                  {filteredSkills.map((skill, i) => (
                    <button
                      key={skill.id}
                      onClick={() => {
                        setInput('/' + skill.id + ' ')
                        setShowSlashMenu(false)
                        setTimeout(() => textareaRef.current?.focus(), 0)
                      }}
                      onMouseEnter={() => setSelectedIndex(i)}
                      className={
                        'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors ' +
                        (i === selectedIndex ? 'bg-ember-soft' : 'hover:bg-paper-2')
                      }
                    >
                      <span className="text-lg">{skill.icon}</span>
                      <div className="flex-1 min-w-0">
                        <div
                          className={
                            'text-sm font-medium ' +
                            (i === selectedIndex ? 'text-ember' : 'text-ink')
                          }
                        >
                          {skill.name}
                        </div>
                        <div className="text-xs text-ink-fade truncate">
                          {skill.desc}
                        </div>
                      </div>
                      {skill.recommended && (
                        <span className="font-mono text-[9px] text-ember bg-ember-soft px-1.5 py-0.5 rounded">
                          推荐
                        </span>
                      )}
                    </button>
                  ))}
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="flex flex-col gap-2.5">
            {/* Quick skills */}
            <div className="flex gap-1.5 flex-wrap">
              {QUICK_SKILLS.map((s, i) => {
                const isActive = s.command && input.startsWith(s.command + ' ')
                return (
                  <button
                    key={i}
                    onClick={() => handleQuickSkillClick(s)}
                    className={
                      'inline-flex items-center h-[22px] px-2.5 rounded-full text-xs border transition-colors ' +
                      (s.solid
                        ? 'bg-ink text-paper border-ink'
                        : isActive
                        ? 'border-ember-line text-ember bg-ember-soft'
                        : 'border-ink-fade/60 text-ink-soft hover:border-ink-fade')
                    }
                  >
                    {s.label}
                  </button>
                )
              })}
            </div>

            <div className="border border-ink/70 rounded-md bg-paper flex flex-col justify-between min-h-[80px] p-3.5">
              {attachments.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-3">
                  {attachments.map((item) => (
                    <div key={item.id} className="flex items-center gap-2 px-2 py-1.5 rounded-md border border-ink-fade/40 bg-paper-2 text-xs text-ink-soft max-w-[240px]">
                      {item.kind === 'image' && item.dataUrl ? (
                        <img src={item.dataUrl} alt={item.name} className="w-7 h-7 object-cover rounded border border-ink-fade/30" />
                      ) : (
                        <FileText className="w-4 h-4 text-ink-fade shrink-0" />
                      )}
                      <span className="truncate">{item.name} · {item.sizeKB}KB</span>
                      {item.error && <span className="text-ember">!</span>}
                      <button
                        type="button"
                        onClick={() => setAttachments((current) => current.filter((a) => a.id !== item.id))}
                        className="text-ink-fade hover:text-ink"
                        title="移除附件"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => setAttachments([])}
                    className="px-2 py-1.5 rounded-md border border-dashed border-ink-fade/50 text-xs text-ink-fade hover:text-ink"
                  >
                    清空附件
                  </button>
                </div>
              )}
              <textarea
                ref={textareaRef}
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                placeholder="输入指令，或 / 调用技能…"
                className="w-full bg-transparent outline-none text-sm text-ink placeholder:text-ink-soft/80 resize-none flex-1"
                rows={1}
              />
              <div className="flex justify-between items-center mt-2">
                <div className="flex gap-1.5">
                  <input
                    type="file"
                    multiple
                    accept="image/*,.txt,.md,.json,.csv,.xml,.yml,.yaml,.log,.js,.jsx,.ts,.tsx,.css,.html"
                    ref={fileInputRef}
                    className="hidden"
                    onChange={handleFileChange}
                  />
                  <button
                    onClick={handleAttachment}
                    className="inline-flex items-center h-7 px-2 rounded-full text-xs border border-ink-fade/60 text-ink-soft hover:border-ink-fade transition-colors"
                  >
                    <Paperclip className="w-3.5 h-3.5 mr-1" />
                    附件
                  </button>
                  <button
                    onClick={handleVoice}
                    className={
                      'inline-flex items-center h-7 px-2 rounded-full text-xs border transition-colors ' +
                      (voiceState === 'listening'
                        ? 'border-ember text-ember bg-ember-soft animate-pulse'
                        : voiceState === 'unsupported'
                        ? 'border-ink-fade/60 text-ink-fade'
                        : 'border-ink-fade/60 text-ink-soft hover:border-ink-fade')
                    }
                  >
                    <Mic className="w-3.5 h-3.5 mr-1" />
                    {voiceState === 'listening' ? '聆听中' : voiceState === 'unsupported' ? '浏览器不支持' : '语音'}
                  </button>
                  <button
                    onClick={handleContext}
                    className={
                      'inline-flex items-center h-7 px-2 rounded-full text-xs border transition-colors ' +
                      (showContextPanel
                        ? 'border-ember text-ember bg-ember-soft'
                        : 'border-ink-fade/60 text-ink-soft hover:border-ink-fade')
                    }
                  >
                    <FolderOpen className="w-3.5 h-3.5 mr-1" />
                    上下文 · {messages.length}
                  </button>
                </div>
                <div className="flex items-center gap-2.5">
                  <span className="font-mono text-[9px] tracking-wider text-ink-fade">
                    Enter
                  </span>
                  <button
                    onClick={handleSend}
                    className="w-8 h-8 rounded-full bg-ink flex items-center justify-center hover:bg-ink-soft transition-colors"
                  >
                    <Send className="w-3.5 h-3.5 text-paper" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Right Task Panel */}
      <div className="w-[360px] bg-paper-2 p-5 flex flex-col gap-4 border-l border-dashed border-ink-fade/50 overflow-y-auto">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">
            LIVE TASKS · {tasks.length}
          </span>
          {hasTasks && (
            <button
              onClick={() => setTasksExpanded((v) => !v)}
              className="inline-flex items-center h-6 px-2 rounded-full text-xs border border-ink-fade/60 text-ink-soft hover:border-ink-fade transition-colors"
            >
              {tasksExpanded ? '折叠' : '展开'}
              <ChevronDown className={`w-3 h-3 ml-1 transition-transform ${tasksExpanded ? '' : '-rotate-90'}`} />
            </button>
          )}
        </div>

        {hasTasks && !tasksExpanded && (
          <div className="text-xs text-ink-soft py-2">
            {tasks.length} 个任务进行中（已折叠）          </div>
        )}

        {hasTasks && tasksExpanded ? (
          <>
            {tasks.map((task, i) => (
              <div
                key={task.id ?? i}
                className={`p-3 border rounded-md flex flex-col gap-2 ${
                  task.status === 'running'
                    ? 'border-ink/40 bg-paper'
                    : 'border-dashed border-ink-fade/50'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div
                      className={`w-5 h-5 rounded flex items-center justify-center text-xs ${
                        task.status === 'running'
                          ? 'bg-ember-soft text-ember'
                          : 'bg-ink-ghost/30 text-ink-fade'
                      }`}
                    >
                      {task.status === 'running' ? (
                        <Check className="w-3 h-3" />
                      ) : (
                        <Circle className="w-3 h-3" />
                      )}
                    </div>
                    <span className="text-[13px] text-ink">{task.name}</span>
                  </div>
                  <span
                    className={`font-mono text-[9px] tracking-wider ${
                      task.status === 'running'
                        ? 'text-ember'
                        : 'text-ink-fade'
                    }`}
                  >
                    {task.status === 'running'
                      ? '●' + task.progress + '%'
                      : task.step}
                  </span>
                </div>

                {task.status === 'running' && (
                  <>
                    <div className="h-1.5 bg-ink-ghost/40 rounded-full overflow-hidden">
                      <motion.div
                        className="h-full bg-ember rounded-full"
                        initial={{ width: 0 }}
                        animate={{ width: `${task.progress}%` }}
                        transition={{ duration: 1.2, ease: 'easeOut' }}
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="font-mono text-[9px] tracking-wider text-ink-fade">
                        STEP · {task.step} –{task.stepLabel}
                      </span>
                      {task.perms?.map((p, pi) => (
                        <span
                          key={pi}
                          className="font-mono text-[9px] tracking-wider text-ink-fade"
                        >
                          ●已使用· {p}
                        </span>
                      ))}
                    </div>
                  </>
                )}
              </div>
            ))}

            <div className="border-t border-dashed border-ink-fade/50 pt-3">
              <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">
                SKILL CHAIN
              </span>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {skillChain.map((s, i) => (
                  <span
                    key={i}
                    className={`inline-flex items-center h-[22px] px-2.5 rounded-full text-xs border ${
                      i === skillChain.length - 1
                        ? 'border-ember-line text-ember bg-ember-soft'
                        : 'border-ink-fade/60 text-ink-soft'
                    }`}
                  >
                    {s}
                  </span>
                ))}
              </div>
            </div>

            {/* Quick actions */}
            <div className="mt-auto pt-4 flex gap-2">
              {activeTask && (
                <>
                  <button
                    onClick={() => handlePauseTask(activeTask.id)}
                    className="h-8 px-3 border border-dashed border-ink-fade/60 rounded-md text-xs text-ink-soft hover:border-ink-fade transition-colors flex items-center gap-1"
                  >
                    <Pause className="w-3.5 h-3.5" />
                    暂停
                  </button>
                  <button
                    onClick={() => handleStopTask(activeTask.id)}
                    className="h-8 px-3 border border-ink/70 rounded-md text-xs text-ink hover:bg-paper-2 transition-colors flex items-center gap-1"
                  >
                    <X className="w-3.5 h-3.5" />
                    中断
                  </button>
                </>
              )}
              <button
                onClick={() => navigate('/task')}
                className="h-8 px-3 bg-ember text-paper rounded-md text-xs hover:bg-ember/90 transition-colors flex items-center gap-1 ml-auto"
              >
                <ArrowUpRight className="w-3.5 h-3.5" />
                详情
              </button>
            </div>
          </>
        ) : !hasTasks ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center gap-3 py-10">
            <div className="w-10 h-10 rounded-full border border-dashed border-ink-fade/60 flex items-center justify-center">
              <LayoutList className="w-4 h-4 text-ink-fade" />
            </div>
            <div>
              <p className="text-sm text-ink-soft">暂无进行中的任务</p>
              <p className="text-xs text-ink-fade mt-1">
                发送消息即可开始新任务
              </p>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function SparklesIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-ember"
    >
      <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
    </svg>
  )
}
