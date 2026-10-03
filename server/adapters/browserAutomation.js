import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { sanitizeChildEnv } from '../utils/sensitiveEnv.js'
import { assertSafeOutboundUrl } from '../utils/outboundNetworkGuard.js'
import { startBrowserOutboundProxy } from './browserOutboundProxy.js'
import { ACTION_TIMEOUT_MS, START_TIMEOUT_MS, CdpClient, abortableDelay, abortError, throwIfAborted } from './browserCdpClient.js'
import { browserSnapshotExpression, elementExpression, elementObjectExpression } from './browserDomAutomation.js'
import { keyEventParams } from './browserKeyboard.js'
import { downloadFromBrowserElement } from './browserDownloadAutomation.js'
import { bindBrowserFileInput } from './browserUploadAutomation.js'
import {
  activeBrowserFrameEvaluationParams,
  activeBrowserFrameSessionId,
  listBrowserFrames,
  resetBrowserFrameContext,
  switchBrowserFrameContext,
  validateBrowserFrameUrl,
} from './browserFrameAutomation.js'

const sessions = new Map()

function findBrowserExecutable(env = process.env) {
  const configured = String(env.BROWSER_EXECUTABLE_PATH || '').trim()
  const candidates = [
    configured,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ].filter(Boolean)
  return candidates.find((candidate) => fs.existsSync(candidate)) || ''
}

function assertEnabled() {
  if (process.env.BROWSER_ENABLED === '0') throw new Error('Browser 工具已禁用（BROWSER_ENABLED=0）')
}

async function validateUrl(raw) {
  let url
  try { url = new URL(String(raw || '')) } catch { throw new Error('请输入有效 URL') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Browser 仅允许 http/https URL')
  await assertSafeOutboundUrl(url.href)
  return url.href
}

function profileDirectoryForUser(userId, env = process.env) {
  const dataRoot = path.resolve(String(env.APP_DATA_DIR || path.join(process.cwd(), 'server-data')))
  const userKey = crypto.createHash('sha256').update(String(userId || '')).digest('hex').slice(0, 32)
  const profileDir = path.join(dataRoot, 'browser-profiles', userKey)
  fs.mkdirSync(profileDir, { recursive: true })
  return profileDir
}

function isReusableSession(session, { headed = false } = {}) {
  return !!session
    && session.child?.exitCode === null
    && session.client?.isOpen?.() === true
    && (!headed || session.headless === false)
}

function browserLaunchArgs(profileDir, { headless = true, proxyUrl = '' } = {}) {
  return [
    ...(headless ? ['--headless=new'] : ['--start-maximized']),
    '--disable-gpu',
    '--disable-extensions',
    '--disable-gpu-shader-disk-cache',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-quic',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    ...(proxyUrl ? [`--proxy-server=${proxyUrl}`, '--proxy-bypass-list=<-loopback>'] : []),
    ...(process.env.BROWSER_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ]
}

function launchProcess(executable, profileDir, { headless = true, proxyUrl = '', signal = null } = {}) {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const args = browserLaunchArgs(profileDir, { headless, proxyUrl })
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: sanitizeChildEnv(),
    })
    let stderr = ''
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      callback(value)
    }
    const onAbort = () => {
      try { child.kill() } catch { /* best effort */ }
      finish(reject, abortError(signal))
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      finish(reject, new Error('启动本机浏览器超时'))
    }, START_TIMEOUT_MS)
    signal?.addEventListener?.('abort', onAbort, { once: true })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-20000)
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)
      if (!match) return
      finish(resolve, { child, websocketUrl: match[1] })
    })
    child.once('error', (error) => finish(reject, error))
    child.once('exit', (code) => {
      if (!/DevTools listening on/.test(stderr)) finish(reject, new Error(`浏览器启动失败（exit ${code}）`))
    })
  })
}

async function createSession(userId, { headless = process.env.BROWSER_HEADLESS !== '0', signal = null } = {}) {
  throwIfAborted(signal)
  assertEnabled()
  const executable = findBrowserExecutable()
  if (!executable) throw new Error('未找到 Edge/Chrome；可用 BROWSER_EXECUTABLE_PATH 指定路径')
  const profileDir = profileDirectoryForUser(userId)
  let child
  let client
  let outboundProxy
  try {
    outboundProxy = await startBrowserOutboundProxy({ signal })
    const launched = await launchProcess(executable, profileDir, {
      headless,
      proxyUrl: outboundProxy.url,
      signal,
    })
    child = launched.child
    const debuggerBase = launched.websocketUrl
      .replace(/^ws:/, 'http:')
      .replace(/\/devtools\/browser\/.*$/, '')
    const targetsResponse = await fetch(`${debuggerBase}/json/list`, { signal })
    if (!targetsResponse.ok) throw new Error(`读取浏览器 Target 失败: HTTP ${targetsResponse.status}`)
    const targets = await targetsResponse.json()
    const pageTarget = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
    if (!pageTarget) throw new Error('浏览器未创建 Page Target')
    client = new CdpClient(pageTarget.webSocketDebuggerUrl)
    await client.connect({ signal })
    const session = {
      userId, executable, profileDir, child, client, outboundProxy, debuggerBase,
      targetId: pageTarget.id, sessionId: null, headless, createdAt: Date.now(),
      activeFrameId: null, activeFrameContextId: null, activeFrameUrl: '', mainFrameId: null,
      activeFrameSessionId: null, discoverFrameTargets: true, frameTargetSessions: new Map(),
    }
    child.once('exit', () => {
      sessions.delete(userId)
      void outboundProxy.close()
    })
    await enablePageDomains(session, signal)
    sessions.set(userId, session)
    return session
  } catch (error) {
    try { client?.close() } catch { /* ignore */ }
    try { child?.kill() } catch { /* ignore */ }
    try { await outboundProxy?.close?.() } catch { /* ignore */ }
    throw error
  }
}

async function getSession(userId, { headed = false, signal = null } = {}) {
  throwIfAborted(signal)
  if (!userId) throw new Error('userId required')
  const existing = sessions.get(userId)
  if (isReusableSession(existing, { headed })) return existing
  if (existing) closeBrowserSession(userId)
  return createSession(userId, { headless: headed ? false : process.env.BROWSER_HEADLESS !== '0', signal })
}

async function enablePageDomains(session, signal = null) {
  await Promise.all([
    session.client.request('Page.enable', {}, session.sessionId, ACTION_TIMEOUT_MS, signal),
    session.client.request('Runtime.enable', {}, session.sessionId, ACTION_TIMEOUT_MS, signal),
    session.client.request('Log.enable', {}, session.sessionId, ACTION_TIMEOUT_MS, signal),
    session.client.request('Network.enable', {}, session.sessionId, ACTION_TIMEOUT_MS, signal),
  ])
}

async function pageTargets(session, signal = null) {
  throwIfAborted(signal)
  if (!session?.debuggerBase) return []
  const response = await fetch(`${session.debuggerBase}/json/list`, { signal })
  if (!response.ok) throw new Error(`读取浏览器 Tab 失败: HTTP ${response.status}`)
  const targets = await response.json()
  const pages = (Array.isArray(targets) ? targets : [])
    .filter((target) => target?.type === 'page' && target.id && target.webSocketDebuggerUrl)
  const active = pages.find((target) => target.id === session.targetId)
  return [active, ...pages.filter((target) => target !== active)].filter(Boolean).slice(0, 50)
}

async function validateSwitchTargetUrl(rawUrl) {
  const value = String(rawUrl || '').trim()
  if (value === 'about:blank') return value
  return validateUrl(value)
}

async function evaluate(session, expression, signal = null, { mainFrame = false } = {}) {
  const result = await session.client.request('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
    ...activeBrowserFrameEvaluationParams(session, { mainFrame }),
  }, activeBrowserFrameSessionId(session, { mainFrame }), ACTION_TIMEOUT_MS, signal)
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || '页面脚本执行失败')
  return result.result?.value
}

async function waitForReady(session, timeoutMs = ACTION_TIMEOUT_MS, signal = null) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ready = await evaluate(session, 'document.readyState', signal)
    if (ready === 'complete' || ready === 'interactive') return
    await abortableDelay(100, signal)
  }
  throw new Error('等待页面加载超时')
}

export async function browserOpenUrl({ userId, url, headed = false, signal = null }) {
  const targetUrl = await validateUrl(url)
  throwIfAborted(signal)
  const session = await getSession(userId, { headed, signal })
  resetBrowserFrameContext(session)
  const result = await session.client.request('Page.navigate', { url: targetUrl }, session.sessionId, ACTION_TIMEOUT_MS, signal)
  if (result.errorText) throw new Error(result.errorText)
  await waitForReady(session, ACTION_TIMEOUT_MS, signal)
  return browserState({ userId, signal })
}

export async function browserConnectApp({ userId, url, signal = null }) {
  const targetUrl = await validateUrl(url)
  throwIfAborted(signal)
  const session = await getSession(userId, { headed: true, signal })
  resetBrowserFrameContext(session)
  const result = await session.client.request('Page.navigate', { url: targetUrl }, session.sessionId, ACTION_TIMEOUT_MS, signal)
  if (result.errorText) throw new Error(result.errorText)
  await waitForReady(session, ACTION_TIMEOUT_MS, signal)
  return browserState({ userId, signal })
}

export async function browserState({ userId, signal = null }) {
  throwIfAborted(signal)
  const session = sessions.get(userId)
  if (!isReusableSession(session)) return { connected: false }
  const page = await evaluate(session, `({
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    rootChildren: document.getElementById('root')?.childElementCount ?? null,
    scripts: [...document.scripts].map((script) => ({ src: script.src, type: script.type })),
    resources: performance.getEntriesByType('resource').map((entry) => entry.name).slice(-100),
  })`, signal, { mainFrame: true })
  return {
    connected: true,
    headless: session.headless,
    ...page,
    activeFrameId: session.activeFrameId || session.mainFrameId || null,
    activeFrameUrl: session.activeFrameUrl || page.url,
    frameContextActive: Object.hasOwn(
      activeBrowserFrameEvaluationParams(session),
      'contextId',
    ),
    createdAt: session.createdAt,
  }
}

export async function browserTabs({ userId, signal = null } = {}) {
  const session = await getSession(userId, { signal })
  const targets = await pageTargets(session, signal)
  return {
    activeTargetId: session.targetId,
    tabs: targets.map((target) => ({
      targetId: String(target.id),
      title: String(target.title || '').slice(0, 500),
      url: String(target.url || '').slice(0, 16_384),
      active: target.id === session.targetId,
    })),
  }
}

async function switchPageTarget(session, target, {
  signal = null,
  createClient = (url) => new CdpClient(url),
} = {}) {
  const nextClient = createClient(target.webSocketDebuggerUrl)
  try {
    await nextClient.connect({ signal })
  } catch (error) {
    nextClient.close()
    throw error
  }
  const previous = {
    client: session.client,
    sessionId: session.sessionId,
    targetId: session.targetId,
    activeFrameId: session.activeFrameId,
    activeFrameContextId: session.activeFrameContextId,
    activeFrameSessionId: session.activeFrameSessionId,
    frameTargetSessions: session.frameTargetSessions,
    activeFrameUrl: session.activeFrameUrl,
    mainFrameId: session.mainFrameId,
  }
  try {
    session.client = nextClient
    session.sessionId = null
    session.targetId = target.id
    session.frameTargetSessions = new Map()
    resetBrowserFrameContext(session)
    await enablePageDomains(session, signal)
    await waitForReady(session, ACTION_TIMEOUT_MS, signal)
  } catch (error) {
    Object.assign(session, previous)
    nextClient.close()
    throw error
  }
  previous.client.close()
}

export async function browserSwitchTab({ userId, targetId, signal = null } = {}) {
  const requestedTargetId = String(targetId || '').trim()
  if (!requestedTargetId || requestedTargetId.length > 512) throw new Error('请输入有效 Browser Tab ID')
  const session = await getSession(userId, { signal })
  const targets = await pageTargets(session, signal)
  const target = targets.find((candidate) => candidate.id === requestedTargetId)
  if (!target) throw new Error(`Browser Tab 不存在: ${requestedTargetId}`)
  await validateSwitchTargetUrl(target.url)
  if (target.id !== session.targetId) await switchPageTarget(session, target, { signal })
  return browserState({ userId, signal })
}

export async function browserFrames({ userId, signal = null } = {}) {
  const session = await getSession(userId, { signal })
  return listBrowserFrames(session, { signal })
}

export async function browserSwitchFrame({
  userId,
  frameId,
  authorizeFrame = null,
  signal = null,
} = {}) {
  const session = await getSession(userId, { signal })
  const frame = await switchBrowserFrameContext(session, {
    frameId,
    signal,
    authorizeFrame: async (candidate) => {
      await validateBrowserFrameUrl(candidate, validateUrl)
      if (typeof authorizeFrame === 'function') await authorizeFrame(candidate)
    },
  })
  return { frame, ...(await browserState({ userId, signal })) }
}

export async function browserSnapshot({ userId, maxText = 12000, signal = null } = {}) {
  const session = await getSession(userId, { signal })
  const limit = Math.max(1000, Math.min(50000, Number(maxText) || 12000))
  return evaluate(session, browserSnapshotExpression(limit), signal)
}

export async function browserConsole({ userId, clear = false, signal = null } = {}) {
  const session = await getSession(userId, { signal })
  throwIfAborted(signal)
  const entries = session.client.events.map((event) => {
    if (event.method === 'Network.loadingFailed') {
      const params = event.params || {}
      return {
        type: 'network-error',
        text: params.errorText || params.blockedReason || 'Network loading failed',
        url: session.client.requests.get(params.requestId) || '',
      }
    }
    if (event.method === 'Network.responseReceived') {
      const response = event.params?.response || {}
      return { type: 'http-error', text: `HTTP ${response.status}`, url: response.url || '' }
    }
    if (event.method === 'Runtime.consoleAPICalled') {
      const params = event.params || {}
      return {
        type: params.type || 'log',
        text: (params.args || []).map((arg) => String(arg.value ?? arg.description ?? '')).join(' '),
        timestamp: params.timestamp || null,
      }
    }
    if (event.method === 'Runtime.exceptionThrown') {
      const details = event.params?.exceptionDetails || {}
      return {
        type: 'error',
        text: details.exception?.description || details.text || 'Uncaught exception',
        url: details.url || '',
        lineNumber: details.lineNumber ?? null,
        columnNumber: details.columnNumber ?? null,
        timestamp: event.params?.timestamp || null,
      }
    }
    const entry = event.params?.entry || {}
    return { type: entry.level || 'log', text: entry.text || '', url: entry.url || '', timestamp: entry.timestamp || null }
  })
  if (clear) session.client.events.length = 0
  return { entries }
}

export async function browserClick({ userId, target, signal = null }) {
  const session = await getSession(userId, { signal })
  const result = await evaluate(session, elementExpression(target, `el.scrollIntoView({block:'center'}); el.click(); return {ok:true}`), signal)
  if (!result?.ok) throw new Error(result?.error || '点击失败')
  await abortableDelay(250, signal)
  return browserState({ userId, signal })
}

export async function browserType({ userId, target, text, submit = false, signal = null }) {
  const session = await getSession(userId, { signal })
  const value = JSON.stringify(String(text ?? ''))
  const result = await evaluate(session, elementExpression(target, `
    el.focus(); const value = ${value};
    if ('value' in el) { const setter = Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set; setter ? setter.call(el, value) : (el.value = value) }
    else el.textContent = value
    el.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:value})); el.dispatchEvent(new Event('change', {bubbles:true}));
    ${submit ? "el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true})); el.form?.requestSubmit?.()" : ''}
    return {ok:true}
  `), signal)
  if (!result?.ok) throw new Error(result?.error || '输入失败')
  return { ok: true }
}

async function setBrowserFileInput(session, options) {
  return bindBrowserFileInput(session, options, evaluate)
}

export async function browserUploadFile({ userId, target, filePath, signal = null }) {
  const session = await getSession(userId, { signal })
  throwIfAborted(signal)
  await setBrowserFileInput(session, { target, filePath, signal })
  return { ok: true, filename: path.basename(String(filePath)), ...(await browserState({ userId, signal })) }
}

export async function browserDownload({
  userId, target, stagingDirectory, timeoutMs, maxBytes, signal = null,
}) {
  const session = await getSession(userId, { signal })
  try {
    return await downloadFromBrowserElement(session, {
      target, stagingDirectory, timeoutMs, maxBytes, signal,
    })
  } catch (error) {
    // A timed-out/oversized download may still hold its staging file open.
    // Stop the isolated browser before the service removes that directory so
    // sensitive authenticated partial content cannot continue writing later.
    closeBrowserSession(userId)
    throw error
  }
}

export async function browserSelect({ userId, target, value, signal = null }) {
  const session = await getSession(userId, { signal })
  const expected = JSON.stringify(String(value ?? ''))
  const result = await evaluate(session, elementExpression(target, `
    if (!(el instanceof HTMLSelectElement)) return {ok:false,error:'target is not a select element'}
    const expected = ${expected}; const clean = (input) => String(input || '').replace(/\\s+/g, ' ').trim()
    const option = [...el.options].find((item) => item.value === expected)
      || [...el.options].find((item) => clean(item.textContent) === clean(expected))
    if (!option) return {ok:false,error:'option not found: ' + expected}
    el.focus(); el.value = option.value; option.selected = true
    el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true}))
    return {ok:true,value:option.value,label:clean(option.textContent)}
  `), signal)
  if (!result?.ok) throw new Error(result?.error || '选择选项失败')
  await abortableDelay(100, signal)
  return { ...result, ...(await browserState({ userId, signal })) }
}

export async function browserPress({ userId, target = '', key, signal = null }) {
  const session = await getSession(userId, { signal })
  if (target) {
    const focused = await evaluate(session, elementExpression(target, `el.scrollIntoView({block:'center'}); el.focus(); return {ok:true}`), signal)
    if (!focused?.ok) throw new Error(focused?.error || '聚焦元素失败')
  }
  const params = keyEventParams(key)
  await session.client.request('Input.dispatchKeyEvent', { type: 'keyDown', ...params }, session.sessionId, ACTION_TIMEOUT_MS, signal)
  const keyUpParams = { ...params }
  delete keyUpParams.text
  delete keyUpParams.unmodifiedText
  await session.client.request('Input.dispatchKeyEvent', { type: 'keyUp', ...keyUpParams }, session.sessionId, ACTION_TIMEOUT_MS, signal)
  await abortableDelay(100, signal)
  return { ok: true, key: String(key), ...(await browserState({ userId, signal })) }
}

export async function browserWait({ userId, ms = 500, target = '', signal = null }) {
  const session = await getSession(userId, { signal })
  const delay = Math.max(0, Math.min(10000, Number(ms) || 0))
  if (!target) {
    await abortableDelay(delay, signal)
    return browserState({ userId, signal })
  }
  const deadline = Date.now() + Math.max(delay, 1000)
  while (Date.now() < deadline) {
    const found = await evaluate(session, elementExpression(target, 'return {ok:true}'), signal)
    if (found?.ok) return { ok: true, target }
    await abortableDelay(100, signal)
  }
  throw new Error(`等待元素超时: ${target}`)
}

export async function browserScreenshot({ userId, fullPage = false, signal = null } = {}) {
  const session = await getSession(userId, { signal })
  let clip
  if (fullPage) {
    const metrics = await session.client.request('Page.getLayoutMetrics', {}, session.sessionId, ACTION_TIMEOUT_MS, signal)
    const size = metrics.cssContentSize || metrics.contentSize
    if (size) clip = { x: 0, y: 0, width: Math.min(size.width, 8000), height: Math.min(size.height, 16000), scale: 1 }
  }
  const result = await session.client.request('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: !!fullPage,
    ...(clip ? { clip } : {}),
  }, session.sessionId, 30000, signal)
  return { mimeType: 'image/png', data: result.data, bytes: Buffer.byteLength(result.data || '', 'base64') }
}

export function closeBrowserSession(userId) {
  const session = sessions.get(userId)
  if (!session) return false
  sessions.delete(userId)
  try { session.client.close() } catch { /* ignore */ }
  try { session.child.kill() } catch { /* ignore */ }
  void session.outboundProxy?.close?.()
  return true
}

export function shutdownBrowsers() {
  for (const userId of [...sessions.keys()]) closeBrowserSession(userId)
}

export const _browserInternals = {
  CdpClient,
  abortableDelay,
  browserLaunchArgs,
  findBrowserExecutable,
  validateUrl,
  profileDirectoryForUser,
  isReusableSession,
  keyEventParams,
  browserSnapshotExpression,
  elementExpression,
  elementObjectExpression,
  setBrowserFileInput,
  enablePageDomains,
  pageTargets,
  validateSwitchTargetUrl,
  switchPageTarget,
  getSession,
  evaluate,
  listBrowserFrames,
  switchBrowserFrameContext,
  resetBrowserFrameContext,
}
