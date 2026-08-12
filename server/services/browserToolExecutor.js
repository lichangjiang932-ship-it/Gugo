import { isIntegrationEnabled } from './integrationsStore.js'
import { assertBrowserAppUrlAccess, assertBrowserSessionAppAccess, listConnectedBrowserApps } from './connectorService.js'
import {
  browserClick,
  browserConsole,
  browserOpenUrl,
  browserPress,
  browserScreenshot,
  browserSelect,
  browserSnapshot,
  browserType,
  browserWait,
} from '../adapters/browserAutomation.js'

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
  if (['browser_snapshot', 'browser_console', 'browser_click', 'browser_type', 'browser_select', 'browser_press', 'browser_wait', 'browser_screenshot'].includes(name)) {
    await assertBrowserSessionAppAccess({ userId })
  }
  if (name === 'browser_snapshot') return browserSnapshot({ userId, maxText: args.maxText, ...executionContext })
  if (name === 'browser_state') return assertBrowserSessionAppAccess({ userId })
  if (name === 'browser_console') return browserConsole({ userId, clear: args.clear, ...executionContext })
  if (name === 'browser_click') {
    const result = await browserClick({ userId, target: args.target, ...executionContext })
    if (result?.url) assertBrowserAppUrlAccess({ userId, url: result.url })
    return result
  }
  if (name === 'browser_type') {
    const result = await browserType({ userId, target: args.target, text: args.text, submit: args.submit, ...executionContext })
    await assertBrowserSessionAppAccess({ userId })
    return result
  }
  if (name === 'browser_select') {
    const result = await browserSelect({ userId, target: args.target, value: args.value, ...executionContext })
    if (result?.url) assertBrowserAppUrlAccess({ userId, url: result.url })
    return result
  }
  if (name === 'browser_press') {
    const result = await browserPress({ userId, target: args.target, key: args.key, ...executionContext })
    if (result?.url) assertBrowserAppUrlAccess({ userId, url: result.url })
    return result
  }
  if (name === 'browser_wait') {
    const result = await browserWait({ userId, ms: args.ms, target: args.target, ...executionContext })
    await assertBrowserSessionAppAccess({ userId })
    return result
  }
  if (name === 'browser_screenshot') {
    const image = await browserScreenshot({ userId, fullPage: args.fullPage, ...executionContext })
    return { image: { data: image.data, mimeType: image.mimeType } }
  }
  throw new Error(`Unknown browser tool: ${name}`)
}
