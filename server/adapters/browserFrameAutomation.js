import { ACTION_TIMEOUT_MS } from './browserCdpClient.js'

const MAX_BROWSER_FRAMES = 100
const MAX_BROWSER_FRAME_DEPTH = 16
const MAX_FRAME_ID_LENGTH = 512

function frameError(message, code, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode, retryable: false })
}

function bounded(value, limit) {
  return String(value || '').slice(0, limit)
}

export function flattenBrowserFrameTree(frameTree, {
  maxFrames = MAX_BROWSER_FRAMES,
  maxDepth = MAX_BROWSER_FRAME_DEPTH,
} = {}) {
  const frames = []
  let truncated = false
  const visit = (node, depth, parentFrameId = null) => {
    if (!node?.frame) return
    if (depth > maxDepth || frames.length >= maxFrames) {
      truncated = true
      return
    }
    const frame = node.frame
    const frameId = bounded(frame.id, MAX_FRAME_ID_LENGTH)
    if (!frameId) return
    frames.push({
      frameId,
      parentFrameId: parentFrameId ? bounded(parentFrameId, MAX_FRAME_ID_LENGTH) : null,
      name: bounded(frame.name, 500),
      url: bounded(frame.url, 16_384),
      securityOrigin: bounded(frame.securityOrigin, 2_048),
      mimeType: bounded(frame.mimeType, 256),
      depth,
      main: depth === 0,
    })
    for (const child of Array.isArray(node.childFrames) ? node.childFrames : []) {
      visit(child, depth + 1, frameId)
    }
  }
  visit(frameTree, 0)
  return { frames, truncated }
}

export function resetBrowserFrameContext(session) {
  if (!session) return
  session.activeFrameId = null
  session.activeFrameContextId = null
  session.activeFrameSessionId = null
  session.activeFrameUrl = ''
  session.mainFrameId = null
}

export function activeBrowserFrameSessionId(session, { mainFrame = false } = {}) {
  return (!mainFrame && session.activeFrameContextId && session.activeFrameSessionId)
    || session.sessionId || null
}

async function appendRemoteFrames(session, projected, signal) {
  if (!session.discoverFrameTargets) return
  const { targetInfos = [] } = await session.client.request('Target.getTargets', {},
    session.sessionId, ACTION_TIMEOUT_MS, signal)
  const known = new Map(projected.frames.map((frame) => [frame.frameId, frame]))
  const pending = targetInfos.filter((target) => target.type === 'iframe').slice(0, MAX_BROWSER_FRAMES)
  if (targetInfos.filter((target) => target.type === 'iframe').length > MAX_BROWSER_FRAMES) projected.truncated = true
  for (let depth = 1; depth <= MAX_BROWSER_FRAME_DEPTH && pending.length; depth += 1) {
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const target = pending[index]
      const parent = known.get(target.parentFrameId)
      if (!parent || typeof target.targetId !== 'string' || !target.targetId || target.targetId.length > MAX_FRAME_ID_LENGTH) continue
      pending.splice(index, 1)
      let securityOrigin = ''
      try { securityOrigin = new URL(target.url).origin } catch { /* opaque frame */ }
      const existing = known.get(target.targetId)
      if (existing) {
        if (existing.parentFrameId === parent.frameId) {
          existing.targetId = target.targetId
          existing.url = bounded(target.url, 16_384)
          existing.securityOrigin = bounded(securityOrigin, 2048)
        }
        continue
      }
      if (projected.frames.length >= MAX_BROWSER_FRAMES || parent.depth >= MAX_BROWSER_FRAME_DEPTH) {
        projected.truncated = true
        continue
      }
      const frame = {
        frameId: target.targetId, targetId: target.targetId, parentFrameId: parent.frameId,
        name: bounded(target.title, 500), url: bounded(target.url, 16_384),
        securityOrigin: bounded(securityOrigin, 2048), mimeType: '', depth: parent.depth + 1, main: false,
      }
      projected.frames.push(frame)
      known.set(frame.frameId, frame)
    }
  }
}

async function frameProtocolSession(session, frame, signal) {
  if (!frame.targetId) return session.sessionId || null
  const sessions = session.frameTargetSessions || (session.frameTargetSessions = new Map())
  if (sessions.has(frame.targetId)) return sessions.get(frame.targetId)
  if (sessions.size >= MAX_BROWSER_FRAMES) {
    const [targetId, sessionId] = sessions.entries().next().value
    await session.client.request('Target.detachFromTarget', { sessionId }, session.sessionId, ACTION_TIMEOUT_MS, signal)
    sessions.delete(targetId)
  }
  const attached = await session.client.request('Target.attachToTarget', {
    targetId: frame.targetId, flatten: true,
  }, session.sessionId, ACTION_TIMEOUT_MS, signal)
  if (!attached.sessionId) throw frameError('Browser Frame attachment failed', 'BROWSER_FRAME_CONTEXT_UNAVAILABLE', 409)
  sessions.set(frame.targetId, attached.sessionId)
  return attached.sessionId
}

export function activeBrowserFrameEvaluationParams(session, { mainFrame = false } = {}) {
  const contextId = Number(session?.activeFrameContextId)
  return !mainFrame && Number.isSafeInteger(contextId) && contextId > 0
    ? { contextId }
    : {}
}

export async function listBrowserFrames(session, { signal = null } = {}) {
  const result = await session.client.request(
    'Page.getFrameTree',
    {},
    session.sessionId,
    ACTION_TIMEOUT_MS,
    signal,
  )
  const projected = flattenBrowserFrameTree(result.frameTree)
  await appendRemoteFrames(session, projected, signal)
  const mainFrameId = projected.frames.find((frame) => frame.main)?.frameId || null
  session.mainFrameId = mainFrameId
  if (session.activeFrameId
    && !projected.frames.some((frame) => frame.frameId === session.activeFrameId)) {
    resetBrowserFrameContext(session)
    session.mainFrameId = mainFrameId
  }
  const activeFrameId = session.activeFrameId || mainFrameId
  const activeFrame = projected.frames.find((frame) => frame.frameId === activeFrameId) || null
  if (session.activeFrameId && activeFrame && session.activeFrameUrl
    && activeFrame.url !== session.activeFrameUrl) {
    session.activeFrameContextId = null
    session.activeFrameSessionId = null
    session.activeFrameUrl = activeFrame.url
  }
  return {
    activeFrameId,
    activeFrameUrl: activeFrame?.url || '',
    frameContextActive: Object.hasOwn(activeBrowserFrameEvaluationParams(session), 'contextId'),
    frames: projected.frames.map((frame) => ({
      ...frame,
      active: frame.frameId === activeFrameId,
    })),
    truncated: projected.truncated,
  }
}

export async function validateBrowserFrameUrl(frame, validateUrl) {
  const frameUrl = String(frame?.url || '').trim()
  if (frame?.main || frameUrl === 'about:blank' || frameUrl === 'about:srcdoc') return
  try {
    await validateUrl(frameUrl)
  } catch (error) {
    error.code ||= 'BROWSER_FRAME_URL_DENIED'
    throw error
  }
}

async function authorizeSwitch(frame, authorizeFrame) {
  if (typeof authorizeFrame !== 'function') return
  await authorizeFrame(frame)
}

export async function switchBrowserFrameContext(session, {
  frameId,
  authorizeFrame = null,
  signal = null,
} = {}) {
  const requestedFrameId = String(frameId || '').trim()
  if (!requestedFrameId || requestedFrameId.length > MAX_FRAME_ID_LENGTH) {
    throw frameError('请输入有效 Browser Frame ID', 'BROWSER_FRAME_ID_INVALID')
  }
  const current = await listBrowserFrames(session, { signal })
  const frame = current.frames.find((candidate) => candidate.frameId === requestedFrameId)
  if (!frame) throw frameError(`Browser Frame 不存在: ${requestedFrameId}`, 'BROWSER_FRAME_NOT_FOUND', 404)
  await authorizeSwitch(frame, authorizeFrame)

  let contextId = null
  const protocolSessionId = await frameProtocolSession(session, frame, signal)
  if (!frame.main) {
    let isolated
    try {
      isolated = await session.client.request('Page.createIsolatedWorld', {
        frameId: frame.frameId,
        worldName: 'gugo-browser-authorized-frame-v1',
        grantUniveralAccess: false,
      }, protocolSessionId, ACTION_TIMEOUT_MS, signal)
    } catch (error) {
      if (frame.targetId) {
        session.frameTargetSessions.delete(frame.targetId)
        try { await session.client.request('Target.detachFromTarget', { sessionId: protocolSessionId }, session.sessionId) } catch { /* already detached */ }
      }
      throw error
    }
    contextId = Number(isolated.executionContextId)
    if (!Number.isSafeInteger(contextId) || contextId <= 0) {
      throw frameError(
        'Browser Frame 无法创建隔离执行上下文',
        'BROWSER_FRAME_CONTEXT_UNAVAILABLE',
        409,
      )
    }
  }

  session.activeFrameId = frame.frameId
  session.activeFrameContextId = contextId
  session.activeFrameSessionId = frame.main ? null : protocolSessionId
  session.activeFrameUrl = frame.url
  session.mainFrameId = current.frames.find((candidate) => candidate.main)?.frameId || null
  return { ...frame, active: true, traversalTruncated: current.truncated }
}

export const BROWSER_FRAME_LIMITS = Object.freeze({
  maxFrames: MAX_BROWSER_FRAMES,
  maxDepth: MAX_BROWSER_FRAME_DEPTH,
})
