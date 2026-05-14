import { useState, useRef, useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import LeftRail from '../../components/LeftRail'
import { useAppContext } from '../../store/AppContext'
import { SKILLS, getSkillSystemPrompt } from '../../data.js'
import { buildUserContentWithAttachments, describeAttachmentPrompt } from '../../lib/attachments.js'
import { callModelThroughProxyStream, getModelStatus } from '../../lib/modelClient.js'
import { readStoredModel, resolveInitialModel, writeStoredModel } from '../../lib/modelSelection.js'
import { isLoggedInLocally } from '../../lib/accountClient.js'
import ChatHeader from './ChatHeader'
import ChatMessages from './ChatMessages'
import ChatComposer from './ChatComposer'
import ChatTaskPanel from './ChatTaskPanel'

const MAX_IMAGE_BYTES = 4 * 1024 * 1024
const MAX_TEXT_BYTES = 256 * 1024

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

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
  const [isGenerating, setIsGenerating] = useState(false)
  const [voiceState, setVoiceState] = useState('idle')
  const [showContextPanel, setShowContextPanel] = useState(false)
  const abortCtrlRef = useRef(null)
  const recognitionRef = useRef(null)

  const activeSession = state.sessions.find((s) => s.id === state.activeSessionId)
  const messages = activeSession?.messages ?? []
  const tasks = state.tasks
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
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (state.draftInput) {
      setInput(state.draftInput)
      dispatch({ type: 'SET_DRAFT_INPUT', payload: '' })
    }
  }, [state.draftInput, dispatch])

  useEffect(() => {
    if (!state.activeSessionId) {
      dispatch({ type: 'NEW_SESSION', payload: '新对话' })
    }
  }, [dispatch, state.activeSessionId])

  const isSlashActive = input.startsWith('/') && !input.includes(' ')
  const slashQuery = isSlashActive ? input.slice(1).toLowerCase() : ''
  const filteredSkills = slashQuery
    ? SKILLS.filter((s) => s.id.toLowerCase().includes(slashQuery) || s.name.toLowerCase().includes(slashQuery))
    : SKILLS

  /* ── send flow ── */
  const triggerSendFlow = useCallback(
    async (content) => {
      dispatch({ type: 'SEND_MESSAGE', payload: content })
      setWorkbenchMessage('')

      const activeSession = state.sessions.find((s) => s.id === state.activeSessionId)
      if (activeSession && (activeSession.title === '新对话' || activeSession.title.startsWith('新会话'))) {
        const title = content.slice(0, 18).trim() || '新对话'
        dispatch({ type: 'UPDATE_SESSION_TITLE', payload: title.length > 15 ? title.slice(0, 15) + '…' : title })
      }

      const skillMatch = content.match(/^\/(\w+)\s*(.*)/)
      const skillId = skillMatch ? skillMatch[1] : null
      const userPrompt = skillMatch ? skillMatch[2] : content
      const skill = skillId ? SKILLS.find((s) => s.id === skillId) : null
      const taskName = skill?.name || (content.toLowerCase().includes('ppt') ? '制作 PPT' : content.toLowerCase().includes('excel') ? '分析表格' : '通用任务')

      if (!isLoggedInLocally()) {
        dispatch({ type: 'RECEIVE_MESSAGE', payload: '请登录账户' })
        return
      }

      try {
        const messages = []
        const systemPrompt = skillId ? getSkillSystemPrompt(skillId) : ''
        if (systemPrompt) messages.push({ role: 'system', content: systemPrompt })
        messages.push({ role: 'user', content: buildUserContentWithAttachments(userPrompt || content, attachments) })

        dispatch({
          type: 'ADD_TASK',
          payload: { name: taskName, detail: content, status: 'running', progress: 10, step: 1, stepLabel: '调用模型中', perms: skill?.perms || [] },
        })

        dispatch({ type: 'RECEIVE_MESSAGE', payload: '' })

        const modelName = selectedModel || resolveInitialModel(modelOptions)
        let latency = 0
        const started = Date.now()
        const controller = new AbortController()
        abortCtrlRef.current = controller
        setIsGenerating(true)

        try {
          for await (const delta of callModelThroughProxyStream({ messages, modelName, signal: controller.signal })) {
            latency = Date.now() - started
            dispatch({ type: 'APPEND_TO_LAST_MESSAGE', payload: delta })
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
        setAttachments([])
        dispatch({
          type: 'UPDATE_LAST_MESSAGE_META',
          payload: { type: 'model_reply', modelName: modelName || 'backend-default', creditsCharged: 0, latency },
        })
        dispatch({
          type: 'ADD_HISTORY',
          payload: { name: taskName, skill: skill?.name || '通用对话', status: 'success', detail: content.length > 60 ? `${content.slice(0, 60)}...` : content, state: '已完成', date: Date.now() },
        })

        const notifyPerm = state.permissions.find((p) => p.id === 'notify')
        if (notifyPerm?.enabled && 'Notification' in window && Notification.permission === 'granted') {
          try { new Notification('模型回复完成', { body: taskName, icon: '/favicon.svg' }) } catch {}
        }
      } catch (err) {
        setIsGenerating(false)
        abortCtrlRef.current = null
        if (err.message === '已停止生成') return
        console.error('Model call failed:', err)
        setLastFailedPrompt(content)
        dispatch({ type: 'APPEND_TO_LAST_MESSAGE', payload: `\n\n模型调用失败：${err.message}\n\n请联系管理员检查后端 .env 中的 MODEL_BASE_URL、MODEL_NAME 和 MODEL_API_KEY。` })
        dispatch({ type: 'ADD_HISTORY', payload: { name: taskName, skill: skill?.name || '通用对话', status: 'failed', detail: content.length > 60 ? `${content.slice(0, 60)}...` : content, state: `失败: ${err.message}`.slice(0, 80), date: Date.now() } })
        dispatch({ type: 'ADD_TASK', payload: { name: taskName, detail: content, status: 'running', progress: 15, step: 1, stepLabel: '调用失败', perms: skill?.perms || [] } })
      }
    },
    [attachments, dispatch, modelOptions, selectedModel, state]
  )

  const handleSend = useCallback(() => {
    const typedContent = input.trim()
    if (!typedContent && attachments.length === 0) return
    const content = typedContent || describeAttachmentPrompt(attachments)
    setInput('')
    setShowSlashMenu(false)
    triggerSendFlow(content)
  }, [attachments, input, triggerSendFlow])

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
    setWorkbenchMessage(`已添加 ${nextAttachments.length} 个附件。`)
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

  const handlePermAllow = () => {
    dispatch({ type: 'SET_PERM_REQUEST', payload: null })
    const pendingTask = [...state.tasks].reverse().find((t) => t.status === 'pending')
    if (pendingTask) {
      dispatch({ type: 'UPDATE_TASK', payload: { id: pendingTask.id, updates: { status: 'running', progress: 20, stepLabel: '权限已获取，继续执行' } } })
    }
    dispatch({ type: 'RECEIVE_MESSAGE', payload: '✅ 已授权，继续执行中。' })
  }

  const handlePermDeny = () => {
    dispatch({ type: 'SET_PERM_REQUEST', payload: null })
    dispatch({ type: 'RECEIVE_MESSAGE', payload: '已拒绝该操作。' })
  }

  const handlePauseTask = (taskId) => dispatch({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { status: 'paused' } } })
  const handleStopTask = (taskId) => dispatch({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { status: 'stopped' } } })

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
          onExport={() => {
            if (!activeSession) return
            downloadJson(`session-${activeSession.id}.json`, activeSession)
            setWorkbenchMessage('当前会话已导出。')
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
          onPermAllow={handlePermAllow}
          onPermDeny={handlePermDeny}
          onNavigatePermissions={() => navigate('/permissions')}
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
          onAbort={() => abortCtrlRef.current?.abort()}
          messages={messages}
          onFileChange={handleFileChange}
          onVoiceClick={handleVoice}
          onContextClick={() => setShowContextPanel((v) => !v)}
          onQuickSkillClick={(skill) => {
            if (skill.solid) { navigate('/skills'); return }
            setInput(skill.command + ' ')
          }}
          handleKeyDown={handleKeyDown}
        />
      </div>

      <ChatTaskPanel
        tasks={tasks}
        skillChain={skillChain}
        onPauseTask={handlePauseTask}
        onStopTask={handleStopTask}
        onNavigateTask={() => navigate('/task')}
        onNavigateDetail={() => navigate('/task')}
      />
    </div>
  )
}
