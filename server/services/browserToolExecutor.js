import { isIntegrationEnabled } from './integrationsStore.js'
import { assertBrowserAppUrlAccess, assertBrowserSessionAppAccess, listConnectedBrowserApps } from './connectorService.js'
import {
  browserClick,
  browserConsole,
  browserOpenUrl,
  browserScreenshot,
  browserSnapshot,
  browserType,
  browserWait,
} from '../adapters/browserAutomation.js'

export async function executeBrowserTool(name, args = {}, { userId } = {}) {
  if (!String(name || '').startsWith('browser_')) throw new Error(`Unknown browser tool: ${name}`)
  if (!userId) throw new Error('Browser tool requires a userId')
  if (!isIntegrationEnabled({ userId, provider: 'browser', defaultEnabled: true })) {
    throw new Error('Browser is disabled in Access')
  }
  if (name === 'browser_open_url') {
    const connectedApp = assertBrowserAppUrlAccess({ userId, url: args.url })
    const persistent = !!connectedApp || listConnectedBrowserApps({ userId }).length > 0
    return browserOpenUrl({ userId, url: args.url, headed: persistent })
  }
  if (['browser_snapshot', 'browser_console', 'browser_click', 'browser_type', 'browser_wait', 'browser_screenshot'].includes(name)) {
    await assertBrowserSessionAppAccess({ userId })
  }
  if (name === 'browser_snapshot') return browserSnapshot({ userId, maxText: args.maxText })
  if (name === 'browser_state') return assertBrowserSessionAppAccess({ userId })
  if (name === 'browser_console') return browserConsole({ userId, clear: args.clear })
  if (name === 'browser_click') {
    const result = await browserClick({ userId, target: args.target })
    if (result?.url) assertBrowserAppUrlAccess({ userId, url: result.url })
    return result
  }
  if (name === 'browser_type') {
    const result = await browserType({ userId, target: args.target, text: args.text, submit: args.submit })
    await assertBrowserSessionAppAccess({ userId })
    return result
  }
  if (name === 'browser_wait') {
    const result = await browserWait({ userId, ms: args.ms, target: args.target })
    await assertBrowserSessionAppAccess({ userId })
    return result
  }
  if (name === 'browser_screenshot') {
    const image = await browserScreenshot({ userId, fullPage: args.fullPage })
    return { image: { data: image.data, mimeType: image.mimeType } }
  }
  throw new Error(`Unknown browser tool: ${name}`)
}
