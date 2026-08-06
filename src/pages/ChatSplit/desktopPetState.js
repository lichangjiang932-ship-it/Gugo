import { TASK_STATUS, TOOL_CALL_STATUS } from '../../store/taskStatus.js'

export const DESKTOP_PET_POSITION_KEY = 'yma:chat:desktop-pet-position'

const EDGE_GAP = 16
const PET_SIZE = 72

export function desktopPetViewport() {
  if (typeof window === 'undefined') return { width: 1024, height: 768 }
  return { width: window.innerWidth, height: window.innerHeight }
}

export function clampDesktopPetPosition(position, viewport = desktopPetViewport()) {
  const width = Math.max(PET_SIZE + EDGE_GAP * 2, Number(viewport?.width) || 0)
  const height = Math.max(PET_SIZE + EDGE_GAP * 2, Number(viewport?.height) || 0)
  const x = Number(position?.x)
  const y = Number(position?.y)
  return {
    x: Math.round(Math.min(Math.max(Number.isFinite(x) ? x : EDGE_GAP, EDGE_GAP), width - PET_SIZE - EDGE_GAP)),
    y: Math.round(Math.min(Math.max(Number.isFinite(y) ? y : EDGE_GAP, EDGE_GAP), height - PET_SIZE - EDGE_GAP)),
  }
}

function defaultPosition(viewport = desktopPetViewport()) {
  return clampDesktopPetPosition({
    x: viewport.width - PET_SIZE - 28,
    y: viewport.height - PET_SIZE - 112,
  }, viewport)
}

function resolvedStorage(storage) {
  if (storage !== undefined) return storage
  try {
    return globalThis.localStorage
  } catch {
    return null
  }
}

export function readDesktopPetPosition(storage, viewport = desktopPetViewport()) {
  try {
    const stored = JSON.parse(resolvedStorage(storage)?.getItem(DESKTOP_PET_POSITION_KEY) || 'null')
    if (Number.isFinite(stored?.x) && Number.isFinite(stored?.y)) {
      return clampDesktopPetPosition(stored, viewport)
    }
  } catch {
    // Invalid or unavailable storage falls back to a safe visible position.
  }
  return defaultPosition(viewport)
}

export function persistDesktopPetPosition(position, storage) {
  try {
    resolvedStorage(storage)?.setItem(DESKTOP_PET_POSITION_KEY, JSON.stringify(position))
  } catch {
    // Dragging remains available when storage is blocked or full.
  }
}

function latestAssistant(messages = []) {
  const list = Array.isArray(messages) ? messages : []
  return [...list].reverse().find((message) => message?.role === 'assistant') || null
}

export function deriveDesktopPetStatus({ isGenerating = false, messages = [], tasks = [], toolApproval } = {}) {
  const taskList = Array.isArray(tasks) ? tasks : []
  const task = taskList.at?.(-1) || taskList[taskList.length - 1] || null
  const assistant = latestAssistant(messages)
  const calls = Array.isArray(assistant?.meta?.toolCalls) ? assistant.meta.toolCalls : []
  const activeCall = [...calls].reverse().find((call) => call?.status === TOOL_CALL_STATUS.RUNNING)
  const failedCall = [...calls].reverse().find((call) => call?.status === TOOL_CALL_STATUS.ERROR)
  const activelyWorking = isGenerating || task?.status === TASK_STATUS.RUNNING

  if (task?.status === TASK_STATUS.FAILED || assistant?.meta?.failed || (!activelyWorking && failedCall)) {
    return { kind: 'failed' }
  }
  if (task?.status === TASK_STATUS.CANCELLED) return { kind: 'idle' }
  if (activelyWorking && (toolApproval?.open || activeCall)) {
    return {
      kind: 'tool',
      tool: toolApproval?.request?.name || toolApproval?.request?.toolName || activeCall?.name || '',
    }
  }
  if (activelyWorking) return { kind: 'thinking' }
  if (task?.status === TASK_STATUS.COMPLETED || (assistant && assistant.meta?.streaming === false)) {
    return { kind: 'completed' }
  }
  return { kind: 'idle' }
}
