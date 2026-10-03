import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { isIntegrationEnabled } from './integrationsStore.js'
import { assertBrowserAppUrlAccess, assertBrowserSessionAppAccess, listConnectedBrowserApps } from './connectorService.js'
import { resolveAuthorizedLocalPath } from './localFileAccessService.js'
import {
  browserClick,
  browserConsole,
  browserDownload,
  browserFrames,
  browserOpenUrl,
  browserPress,
  browserScreenshot,
  browserSelect,
  browserSnapshot,
  browserSwitchFrame,
  browserSwitchTab,
  browserTabs,
  browserType,
  browserUploadFile,
  browserWait,
} from '../adapters/browserAutomation.js'
import {
  DEFAULT_BROWSER_DOWNLOAD_MAX_BYTES,
  DEFAULT_BROWSER_DOWNLOAD_TIMEOUT_MS,
  publishBrowserDownload,
} from '../adapters/browserDownloadAutomation.js'

const MAX_BROWSER_UPLOAD_BYTES = 100 * 1024 * 1024
const FRAME_CONTEXT_TOOLS = new Set([
  'browser_snapshot', 'browser_click', 'browser_type',
  'browser_select', 'browser_press', 'browser_wait',
])

export function resolveBrowserUploadFile({ userId, rawPath } = {}) {
  const resolved = resolveAuthorizedLocalPath({ userId, rawPath, write: false })
  const stat = fs.statSync(resolved.fullPath)
  if (!stat.isFile()) {
    throw Object.assign(new Error('Browser upload requires a regular file.'), {
      code: 'BROWSER_UPLOAD_FILE_REQUIRED', statusCode: 400, retryable: false,
    })
  }
  if (stat.size > MAX_BROWSER_UPLOAD_BYTES) {
    throw Object.assign(new Error('Browser upload file exceeds the 100 MiB safety limit.'), {
      code: 'BROWSER_UPLOAD_TOO_LARGE', statusCode: 413, retryable: false,
    })
  }
  return { path: resolved.fullPath, size: stat.size }
}

function browserDownloadStagingDirectory(userId) {
  const dataRoot = path.resolve(String(process.env.APP_DATA_DIR || path.join(process.cwd(), 'server-data')))
  const owner = createHash('sha256').update(String(userId)).digest('hex').slice(0, 32)
  return path.join(
    dataRoot,
    'browser-downloads',
    owner,
    `${Date.now()}-${randomBytes(8).toString('hex')}`,
  )
}

async function executeBrowserDownload(args, { userId, signal, resolved }) {
  const stagingDirectory = browserDownloadStagingDirectory(userId)
  try {
    const staged = await browserDownload({
      userId,
      target: args.target,
      stagingDirectory,
      timeoutMs: args.timeout_ms ?? DEFAULT_BROWSER_DOWNLOAD_TIMEOUT_MS,
      maxBytes: args.max_bytes ?? DEFAULT_BROWSER_DOWNLOAD_MAX_BYTES,
      signal,
    })
    const published = await publishBrowserDownload({
      sourcePath: staged.sourcePath,
      destination: resolved.fullPath,
      overwrite: args.overwrite === true,
    })
    return {
      ok: true,
      path: resolved.displayPath,
      scope: resolved.source,
      sourceFilename: staged.filename,
      bytes: published.bytes,
      sha256: published.sha256,
      changedPaths: [resolved.displayPath],
      verifiedOutputs: [{
        type: 'file',
        path: resolved.displayPath,
        declaredPath: resolved.displayPath,
        size: published.bytes,
        sha256: published.sha256,
      }],
    }
  } finally {
    await fs.promises.rm(stagingDirectory, { recursive: true, force: true }).catch(() => {})
  }
}

function browserUrlAuthorized(userId, url) {
  const value = String(url || '').trim()
  if (!value || value === 'about:blank' || value === 'about:srcdoc') return true
  assertBrowserAppUrlAccess({ userId, url: value })
  return true
}

function projectAuthorizedBrowserFrames(userId, result) {
  return {
    activeFrameId: result?.activeFrameId || null,
    truncated: result?.truncated === true,
    frames: (Array.isArray(result?.frames) ? result.frames : []).map((frame) => {
      try {
        browserUrlAuthorized(userId, frame.url)
        return frame
      } catch {
        return {
          frameId: frame.frameId,
          parentFrameId: frame.parentFrameId || null,
          depth: Math.max(0, Number(frame.depth) || 0),
          main: frame.main === true,
          active: frame.active === true,
          restricted: true,
          name: 'Restricted connected-app frame',
          url: '',
          securityOrigin: '',
          mimeType: '',
        }
      }
    }),
  }
}

async function assertActiveBrowserFrameAccess(
  userId,
  executionContext,
  { framesImpl = browserFrames } = {},
) {
  const current = await framesImpl({ userId, ...executionContext })
  const active = current.frames.find((frame) => frame.frameId === current.activeFrameId)
  if (!active) return current
  browserUrlAuthorized(userId, active.url)
  if (!active.main && current.frameContextActive !== true) {
    throw Object.assign(
      new Error('Browser Frame navigated; call browser_frames and browser_switch_frame again.'),
      { code: 'BROWSER_FRAME_CONTEXT_STALE', statusCode: 409, retryable: true },
    )
  }
  return current
}

function projectAuthorizedBrowserTabs(userId, result) {
  return {
    activeTargetId: result?.activeTargetId || null,
    tabs: (Array.isArray(result?.tabs) ? result.tabs : []).map((tab) => {
      if (tab.url === 'about:blank') return tab
      try {
        assertBrowserAppUrlAccess({ userId, url: tab.url })
        return tab
      } catch {
        return {
          targetId: tab.targetId,
          active: tab.active === true,
          restricted: true,
          title: 'Restricted connected app',
          url: '',
        }
      }
    }),
  }
}

export async function executeBrowserTool(
  name,
  args = {},
  { userId, idempotencyKey, toolCallId, signal = null } = {},
) {
  if (!String(name || '').startsWith('browser_')) throw new Error(`Unknown browser tool: ${name}`)
  if (!userId) throw new Error('Browser tool requires a userId')
  const executionContext = { idempotencyKey, toolCallId, signal }
  if (!isIntegrationEnabled({ userId, provider: 'browser', defaultEnabled: true })) {
    throw new Error('Browser is disabled in Access')
  }
  if (name === 'browser_open_url' || name === 'browser_navigate') {
    const connectedApp = assertBrowserAppUrlAccess({ userId, url: args.url })
    const persistent = !!connectedApp || listConnectedBrowserApps({ userId }).length > 0
    return browserOpenUrl({ userId, url: args.url, headed: persistent, ...executionContext })
  }
  if (['browser_tabs', 'browser_switch_tab', 'browser_frames', 'browser_switch_frame', 'browser_snapshot', 'browser_console', 'browser_click', 'browser_type', 'browser_select', 'browser_press', 'browser_wait', 'browser_screenshot'].includes(name)) {
    await assertBrowserSessionAppAccess({ userId })
  }
  if (FRAME_CONTEXT_TOOLS.has(name)) {
    await assertActiveBrowserFrameAccess(userId, executionContext)
  }
  if (name === 'browser_tabs') {
    return projectAuthorizedBrowserTabs(userId, await browserTabs({ userId, ...executionContext }))
  }
  if (name === 'browser_frames') {
    return projectAuthorizedBrowserFrames(
      userId,
      await browserFrames({ userId, ...executionContext }),
    )
  }
  if (name === 'browser_switch_frame') {
    const result = await browserSwitchFrame({
      userId,
      frameId: args.frameId,
      authorizeFrame: (frame) => browserUrlAuthorized(userId, frame.url),
      ...executionContext,
    })
    browserUrlAuthorized(userId, result?.frame?.url)
    return result
  }
  if (name === 'browser_switch_tab') {
    const current = await browserTabs({ userId, ...executionContext })
    const target = current.tabs.find((tab) => tab.targetId === String(args.targetId || ''))
    if (!target) throw new Error('Browser Tab does not exist.')
    if (target.url !== 'about:blank') assertBrowserAppUrlAccess({ userId, url: target.url })
    const result = await browserSwitchTab({ userId, targetId: args.targetId, ...executionContext })
    if (result?.url && result.url !== 'about:blank') assertBrowserAppUrlAccess({ userId, url: result.url })
    return result
  }
  if (name === 'browser_snapshot') return browserSnapshot({ userId, maxText: args.maxText, ...executionContext })
  if (name === 'browser_state') return assertBrowserSessionAppAccess({ userId })
  if (name === 'browser_console') return browserConsole({ userId, clear: args.clear, ...executionContext })
  if (name === 'browser_click') {
    const result = await browserClick({ userId, target: args.target, ...executionContext })
    if (result?.url) assertBrowserAppUrlAccess({ userId, url: result.url })
    await assertActiveBrowserFrameAccess(userId, executionContext)
    return result
  }
  if (name === 'browser_type') {
    const result = await browserType({ userId, target: args.target, text: args.text, submit: args.submit, ...executionContext })
    await assertBrowserSessionAppAccess({ userId })
    await assertActiveBrowserFrameAccess(userId, executionContext)
    return result
  }
  if (name === 'browser_upload_file') {
    const file = resolveBrowserUploadFile({ userId, rawPath: args.path })
    await assertBrowserSessionAppAccess({ userId })
    await assertActiveBrowserFrameAccess(userId, executionContext)
    const result = await browserUploadFile({
      userId, target: args.target, filePath: file.path, ...executionContext,
    })
    await assertActiveBrowserFrameAccess(userId, executionContext)
    return result
  }
  if (name === 'browser_download') {
    const resolved = resolveAuthorizedLocalPath({
      userId, rawPath: args.path, write: true, allowMissing: true,
    })
    await assertBrowserSessionAppAccess({ userId })
    await assertActiveBrowserFrameAccess(userId, executionContext)
    const result = await executeBrowserDownload(args, { userId, signal, resolved })
    await assertBrowserSessionAppAccess({ userId })
    await assertActiveBrowserFrameAccess(userId, executionContext)
    return result
  }
  if (name === 'browser_select') {
    const result = await browserSelect({ userId, target: args.target, value: args.value, ...executionContext })
    if (result?.url) assertBrowserAppUrlAccess({ userId, url: result.url })
    await assertActiveBrowserFrameAccess(userId, executionContext)
    return result
  }
  if (name === 'browser_press') {
    const result = await browserPress({ userId, target: args.target, key: args.key, ...executionContext })
    if (result?.url) assertBrowserAppUrlAccess({ userId, url: result.url })
    await assertActiveBrowserFrameAccess(userId, executionContext)
    return result
  }
  if (name === 'browser_wait') {
    const result = await browserWait({ userId, ms: args.ms, target: args.target, ...executionContext })
    await assertBrowserSessionAppAccess({ userId })
    await assertActiveBrowserFrameAccess(userId, executionContext)
    return result
  }
  if (name === 'browser_screenshot') {
    const image = await browserScreenshot({ userId, fullPage: args.fullPage, ...executionContext })
    return { image: { data: image.data, mimeType: image.mimeType } }
  }
  throw new Error(`Unknown browser tool: ${name}`)
}

export const _browserToolExecutorInternals = Object.freeze({
  browserUrlAuthorized,
  projectAuthorizedBrowserFrames,
  assertActiveBrowserFrameAccess,
})
