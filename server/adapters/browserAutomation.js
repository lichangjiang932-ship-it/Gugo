import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { spawn } from 'node:child_process'
import WebSocket from 'ws'
import { sanitizeChildEnv } from '../utils/sensitiveEnv.js'
import { assertSafeOutboundUrl } from '../utils/outboundNetworkGuard.js'
import { startBrowserOutboundProxy } from './browserOutboundProxy.js'

const sessions = new Map()
const START_TIMEOUT_MS = 15000
const ACTION_TIMEOUT_MS = 15000

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason
  return Object.assign(new Error('Browser action cancelled'), { name: 'AbortError' })
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal)
}

function abortableDelay(ms, signal = null) {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    let timer = null
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    }
    const onAbort = () => {
      cleanup()
      reject(abortError(signal))
    }
    timer = setTimeout(() => {
      cleanup()
      resolve()
    }, Math.max(0, Number(ms) || 0))
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

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

class CdpClient {
  constructor(url) {
    this.url = url
    this.ws = null
    this.nextId = 1
    this.pending = new Map()
    this.events = []
    this.requests = new Map()
    this.closing = false
  }

  async connect({ signal = null } = {}) {
    throwIfAborted(signal)
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      let settled = false
      const finish = (callback, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', onAbort)
        this.ws?.removeEventListener?.('open', onOpen)
        this.ws?.removeEventListener?.('error', onError)
        callback(value)
      }
      const onOpen = () => finish(resolve)
      const onError = () => finish(reject, new Error('无法连接浏览器 DevTools'))
      const onAbort = () => {
        try { this.ws?.close() } catch { /* best effort */ }
        finish(reject, abortError(signal))
      }
      const timer = setTimeout(
        () => finish(reject, new Error('连接浏览器 DevTools 超时')),
        START_TIMEOUT_MS,
      )
      this.ws.addEventListener('open', onOpen, { once: true })
      this.ws.addEventListener('error', onError, { once: true })
      signal?.addEventListener?.('abort', onAbort, { once: true })
    })
    this.ws.addEventListener('message', (event) => {
      let message
      try { message = JSON.parse(String(event.data || '')) } catch { return }
      if (!message.id) {
        if (message.method === 'Network.requestWillBeSent') {
          this.requests.set(message.params?.requestId, message.params?.request?.url || '')
          return
        }
        if (message.method === 'Network.responseReceived' && Number(message.params?.response?.status) < 400) return
        if (['Runtime.consoleAPICalled', 'Runtime.exceptionThrown', 'Log.entryAdded', 'Network.loadingFailed', 'Network.responseReceived'].includes(message.method)) {
          this.events.push(message)
          if (this.events.length > 500) this.events.splice(0, this.events.length - 500)
        }
        return
      }
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(message.error.message || 'DevTools 请求失败'))
      else pending.resolve(message.result || {})
    })
    this.ws.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        if (this.closing) pending.resolve({})
        else pending.reject(new Error(`浏览器连接已关闭（等待 ${pending.method}）`))
      }
      this.pending.clear()
    })
  }

  isOpen() {
    return this.ws?.readyState === WebSocket.OPEN
  }

  request(method, params = {}, sessionId = null, timeoutMs = ACTION_TIMEOUT_MS, signal = null) {
    if (signal?.aborted) return Promise.reject(abortError(signal))
    if (!this.isOpen()) return Promise.reject(new Error('浏览器未连接'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener?.('abort', onAbort)
      const resolvePending = (value) => { cleanup(); resolve(value) }
      const rejectPending = (error) => { cleanup(); reject(error) }
      const onAbort = () => {
        this.pending.delete(id)
        clearTimeout(timer)
        rejectPending(abortError(signal))
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectPending(new Error(`Browser action timeout: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolvePending, reject: rejectPending, timer, method })
      signal?.addEventListener?.('abort', onAbort, { once: true })
      try {
        this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        rejectPending(error)
      }
    })
  }

  close() {
    this.closing = true
    try { this.ws?.close() } catch { /* ignore */ }
  }
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
    const session = { userId, executable, profileDir, child, client, outboundProxy, targetId: pageTarget.id, sessionId: null, headless, createdAt: Date.now() }
    child.once('exit', () => {
      sessions.delete(userId)
      void outboundProxy.close()
    })
    await Promise.all([
      client.request('Page.enable', {}, session.sessionId, ACTION_TIMEOUT_MS, signal),
      client.request('Runtime.enable', {}, session.sessionId, ACTION_TIMEOUT_MS, signal),
      client.request('Log.enable', {}, session.sessionId, ACTION_TIMEOUT_MS, signal),
      client.request('Network.enable', {}, session.sessionId, ACTION_TIMEOUT_MS, signal),
    ])
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

async function evaluate(session, expression, signal = null) {
  const result = await session.client.request('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }, session.sessionId, ACTION_TIMEOUT_MS, signal)
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
  const result = await session.client.request('Page.navigate', { url: targetUrl }, session.sessionId, ACTION_TIMEOUT_MS, signal)
  if (result.errorText) throw new Error(result.errorText)
  await waitForReady(session, ACTION_TIMEOUT_MS, signal)
  return browserState({ userId, signal })
}

export async function browserConnectApp({ userId, url, signal = null }) {
  const targetUrl = await validateUrl(url)
  throwIfAborted(signal)
  const session = await getSession(userId, { headed: true, signal })
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
  })`, signal)
  return { connected: true, headless: session.headless, ...page, createdAt: session.createdAt }
}

export async function browserSnapshot({ userId, maxText = 12000, signal = null } = {}) {
  const session = await getSession(userId, { signal })
  const limit = Math.max(1000, Math.min(50000, Number(maxText) || 12000))
  return evaluate(session, `(() => {
    const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim()
    const nodes = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[contenteditable="true"]')]
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
      .slice(0, 200)
      .map((el, index) => {
        const ref = 'e' + (index + 1); el.setAttribute('data-yma-ref', ref)
        const label = clean(el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name)
        return '[ref=' + ref + '] <' + el.tagName.toLowerCase() + '> ' + JSON.stringify(label).slice(0, 240)
      })
    return { url: location.href, title: document.title, text: clean(document.body?.innerText).slice(0, ${limit}), elements: nodes }
  })()`, signal)
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

function elementExpression(refOrSelector, action) {
  const target = JSON.stringify(String(refOrSelector || ''))
  return `(() => {
    const target = ${target}
    let el = document.querySelector('[data-yma-ref="' + CSS.escape(target) + '"]')
    if (!el) { try { el = document.querySelector(target) } catch {} }
    if (!el) return { ok: false, error: 'element not found: ' + target }
    ${action}
  })()`
}

const KEY_DEFINITIONS = Object.freeze({
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Space: { code: 'Space', keyCode: 32, text: ' ' },
})

const KEY_ALIASES = Object.freeze({
  esc: 'Escape',
  return: 'Enter',
  spacebar: 'Space',
  left: 'ArrowLeft',
  up: 'ArrowUp',
  right: 'ArrowRight',
  down: 'ArrowDown',
  del: 'Delete',
})

function keyEventParams(rawKey) {
  const raw = String(rawKey || '').trim()
  if (!raw || raw.length > 64) throw new Error('请输入有效按键（例如 Enter、Tab 或 Control+A）')
  const parts = raw.split('+').map((part) => part.trim()).filter(Boolean)
  const mainRaw = parts.pop()
  let modifiers = 0
  for (const modifier of parts) {
    const normalized = modifier.toLowerCase()
    if (normalized === 'alt') modifiers |= 1
    else if (normalized === 'control' || normalized === 'ctrl') modifiers |= 2
    else if (normalized === 'meta' || normalized === 'command' || normalized === 'cmd') modifiers |= 4
    else if (normalized === 'shift') modifiers |= 8
    else throw new Error(`不支持的组合键修饰符: ${modifier}`)
  }

  const aliased = KEY_ALIASES[String(mainRaw || '').toLowerCase()] || mainRaw
  const definition = KEY_DEFINITIONS[aliased]
  if (definition) {
    return {
      key: aliased === 'Space' ? ' ' : aliased,
      code: definition.code,
      windowsVirtualKeyCode: definition.keyCode,
      nativeVirtualKeyCode: definition.keyCode,
      modifiers,
      ...(definition.text && !(modifiers & 7) ? { text: definition.text, unmodifiedText: definition.text } : {}),
    }
  }

  const characters = [...String(aliased || '')]
  if (characters.length !== 1) throw new Error(`不支持的按键: ${mainRaw}`)
  const character = characters[0]
  const upper = character.toUpperCase()
  const isLetter = /^[A-Za-z]$/.test(character)
  const isDigit = /^[0-9]$/.test(character)
  const keyCode = isLetter || isDigit ? upper.charCodeAt(0) : character.codePointAt(0)
  const eventKey = isLetter && (modifiers & 7) && !(modifiers & 8) ? character.toLowerCase() : character
  const text = modifiers & 7 ? '' : ((modifiers & 8) && isLetter ? upper : eventKey)
  return {
    key: text || eventKey,
    code: isLetter ? `Key${upper}` : isDigit ? `Digit${character}` : '',
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    modifiers,
    ...(text ? { text, unmodifiedText: character } : {}),
  }
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
  getSession,
  evaluate,
}
