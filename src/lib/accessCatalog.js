import { WEB_CONNECTOR_CATALOG } from '../../shared/webConnectorCatalog.js'
import { MCP_SERVER_PRESETS } from './mcpPresets.js'

export const ACCESS_CAPABILITY_LEVELS = Object.freeze({
  NATIVE_API: 'native_api',
  MCP_SERVER: 'mcp_server',
  SOCIAL_BRIDGE: 'social_bridge',
  BROWSER_SHORTCUT: 'browser_shortcut',
})

const native = (provider, label, brandColor, descriptionKey, hintKey, capabilityLevel, extra = {}) => Object.freeze({
  provider,
  label,
  brandColor,
  descriptionKey,
  hintKey,
  kind: 'native',
  capabilityLevel,
  ...extra,
})

export const NATIVE_ACCESS = Object.freeze([
  native('browser', 'Browser', '#2563EB', 'access.browserDesc', 'access.browserHint', ACCESS_CAPABILITY_LEVELS.BROWSER_SHORTCUT, { connectionMethod: 'built_in' }),
  native('notion', 'Notion', '#111111', 'access.notionDesc', 'access.notionHint', ACCESS_CAPABILITY_LEVELS.NATIVE_API, { oauth: true, connectionMethod: 'oauth', setupUrl: 'https://www.notion.so/profile/integrations' }),
  native('github', 'GitHub', '#24292F', 'access.githubDesc', 'access.githubHint', ACCESS_CAPABILITY_LEVELS.NATIVE_API, { oauth: true, connectionMethod: 'oauth', setupUrl: 'https://github.com/settings/personal-access-tokens/new' }),
  native('google_drive', 'Google Drive', '#4285F4', 'access.googleDriveDesc', 'access.googleDriveHint', ACCESS_CAPABILITY_LEVELS.NATIVE_API, { oauth: true, connectionMethod: 'oauth', setupUrl: 'https://console.cloud.google.com/apis/credentials' }),
  native('slack', 'Slack', '#611F69', 'access.slackDesc', 'access.slackHint', ACCESS_CAPABILITY_LEVELS.NATIVE_API, { oauth: true, connectionMethod: 'oauth', setupUrl: 'https://api.slack.com/apps' }),
  native('feishu', 'Feishu / Lark', '#3370FF', 'access.feishuDesc', 'access.feishuHint', ACCESS_CAPABILITY_LEVELS.SOCIAL_BRIDGE, { connectionMethod: 'app_credentials', setupUrl: 'https://open.feishu.cn/app' }),
  native('wechat_personal', '微信 / WeChat', '#07C160', 'access.wechatDesc', 'access.wechatHint', ACCESS_CAPABILITY_LEVELS.SOCIAL_BRIDGE, { connectionMethod: 'qr' }),
  native('telegram', 'Telegram Bot', '#229ED9', 'access.telegramDesc', 'access.telegramHint', ACCESS_CAPABILITY_LEVELS.SOCIAL_BRIDGE, { connectionMethod: 'bot_token', setupUrl: 'https://t.me/BotFather' }),
  native('qq', 'QQ Bot', '#12B7F5', 'access.qqDesc', 'access.qqHint', ACCESS_CAPABILITY_LEVELS.SOCIAL_BRIDGE, { connectionMethod: 'app_credentials', setupUrl: 'https://q.qq.com/' }),
  native('qq_mail', 'QQ Mail', '#12B7F5', 'access.qqMailDesc', 'access.qqMailHint', ACCESS_CAPABILITY_LEVELS.NATIVE_API, { connectionMethod: 'mail_password', category: 'communication', searchTerms: 'mail email qq smtp imap', setupUrl: 'https://service.mail.qq.com/detail/0/75' }),
])

export const MCP_ACCESS = Object.freeze(MCP_SERVER_PRESETS
  .filter((preset) => preset.showInAccess !== false)
  .map((preset) => Object.freeze({
  provider: preset.provider,
  label: preset.label,
  brandColor: preset.brandColor,
  category: preset.category,
  searchTerms: `${preset.searchTerms} ${preset.publisher}`,
  descriptionKey: preset.descriptionKey,
  hintKey: preset.hintKey,
  kind: 'mcp',
  capabilityLevel: ACCESS_CAPABILITY_LEVELS.MCP_SERVER,
  presetId: preset.id,
  publisher: preset.publisher,
  official: preset.official,
  connectionMethod: 'mcp',
})))

// Dedicated OAuth/API entries take priority over duplicate browser bookmarks.
const NATIVE_WEB_EQUIVALENTS = new Set(['web_google_drive', 'web_slack', 'web_telegram'])

export const WEB_ACCESS = Object.freeze(WEB_CONNECTOR_CATALOG
  .filter((connector) => !NATIVE_WEB_EQUIVALENTS.has(connector.provider))
  .map((connector) => Object.freeze({
  ...connector,
  kind: 'web',
  capabilityLevel: ACCESS_CAPABILITY_LEVELS.BROWSER_SHORTCUT,
  descriptionKey: connector.provider === 'web_whatsapp' ? 'access.whatsappBrowserDesc' : 'access.webAppDesc',
  connectionMethod: connector.provider === 'web_whatsapp' ? 'qr_browser' : 'browser',
})))

export const ACCESS_CATALOG = Object.freeze([...NATIVE_ACCESS, ...MCP_ACCESS, ...WEB_ACCESS])

export function getAccessCatalogCounts() {
  return {
    api: ACCESS_CATALOG.filter((item) => item.capabilityLevel === ACCESS_CAPABILITY_LEVELS.NATIVE_API).length,
    mcp: MCP_ACCESS.length,
    bridges: ACCESS_CATALOG.filter((item) => item.capabilityLevel === ACCESS_CAPABILITY_LEVELS.SOCIAL_BRIDGE).length,
    shortcuts: WEB_ACCESS.length,
  }
}

export function filterAccessCatalog(query) {
  const needle = String(query || '').trim().toLowerCase()
  if (!needle) return ACCESS_CATALOG
  return ACCESS_CATALOG.filter((item) => [item.label, item.provider, item.category, item.searchTerms, item.capabilityLevel]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .includes(needle))
}
