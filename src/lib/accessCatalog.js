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
  native('google_drive', 'Google Drive + Sheets', '#4285F4', 'access.googleDriveDesc', 'access.googleDriveHint', ACCESS_CAPABILITY_LEVELS.NATIVE_API, { oauth: true, connectionMethod: 'oauth', searchTerms: 'drive sheets spreadsheet append rows', setupUrl: 'https://console.cloud.google.com/apis/credentials' }),
  native('google_calendar', 'Google Calendar', '#4285F4', 'access.googleCalendarDesc', 'access.googleCalendarHint', ACCESS_CAPABILITY_LEVELS.NATIVE_API, { connectionMethod: 'access_token', setupUrl: 'https://console.cloud.google.com/apis/credentials' }),
  native('jira', 'Jira Cloud', '#1868DB', 'access.jiraDesc', 'access.jiraHint', ACCESS_CAPABILITY_LEVELS.NATIVE_API, { connectionMethod: 'api_token', setupUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens' }),
  native('linear', 'Linear', '#5E6AD2', 'access.linearDesc', 'access.linearHint', ACCESS_CAPABILITY_LEVELS.NATIVE_API, { connectionMethod: 'api_token', setupUrl: 'https://linear.app/settings/api' }),
  native('trello', 'Trello', '#0C66E4', 'access.trelloDesc', 'access.trelloHint', ACCESS_CAPABILITY_LEVELS.NATIVE_API, { connectionMethod: 'api_token', setupUrl: 'https://trello.com/power-ups/admin' }),
  native('gitlab', 'GitLab', '#FC6D26', 'access.gitlabDesc', 'access.gitlabHint', ACCESS_CAPABILITY_LEVELS.NATIVE_API, { connectionMethod: 'api_token', setupUrl: 'https://gitlab.com/-/user_settings/personal_access_tokens' }),
  native('asana', 'Asana', '#F06A6A', 'access.asanaDesc', 'access.asanaHint', ACCESS_CAPABILITY_LEVELS.NATIVE_API, { connectionMethod: 'api_token', setupUrl: 'https://app.asana.com/0/my-apps' }),
  native('clickup', 'ClickUp', '#7B68EE', 'access.clickupDesc', 'access.clickupHint', ACCESS_CAPABILITY_LEVELS.NATIVE_API, { connectionMethod: 'api_token', setupUrl: 'https://app.clickup.com/settings/apps' }),
  native('airtable', 'Airtable', '#18BFFF', 'access.airtableDesc', 'access.airtableHint', ACCESS_CAPABILITY_LEVELS.NATIVE_API, { connectionMethod: 'api_token', setupUrl: 'https://airtable.com/create/tokens' }),
  native('monday', 'monday.com', '#6161FF', 'access.mondayDesc', 'access.mondayHint', ACCESS_CAPABILITY_LEVELS.NATIVE_API, { connectionMethod: 'api_token', setupUrl: 'https://developer.monday.com/apps/manage' }),
  native('hubspot', 'HubSpot', '#FF7A59', 'access.hubspotDesc', 'access.hubspotHint', ACCESS_CAPABILITY_LEVELS.NATIVE_API, { connectionMethod: 'api_token', setupUrl: 'https://developers.hubspot.com/docs/api/private-apps' }),
  native('zendesk', 'Zendesk', '#03363D', 'access.zendeskDesc', 'access.zendeskHint', ACCESS_CAPABILITY_LEVELS.NATIVE_API, { connectionMethod: 'api_token', setupUrl: 'https://support.zendesk.com/hc/articles/4408889192858' }),
  native('todoist', 'Todoist', '#E44332', 'access.todoistDesc', 'access.todoistHint', ACCESS_CAPABILITY_LEVELS.NATIVE_API, { connectionMethod: 'api_token', setupUrl: 'https://app.todoist.com/app/settings/integrations/developer' }),
  native('dropbox', 'Dropbox', '#0061FF', 'access.dropboxDesc', 'access.dropboxHint', ACCESS_CAPABILITY_LEVELS.NATIVE_API, { connectionMethod: 'access_token', setupUrl: 'https://www.dropbox.com/developers/apps' }),
  native('onedrive', 'Microsoft 365', '#0078D4', 'access.onedriveDesc', 'access.onedriveHint', ACCESS_CAPABILITY_LEVELS.NATIVE_API, { connectionMethod: 'access_token', searchTerms: 'onedrive teams microsoft graph channel message', setupUrl: 'https://entra.microsoft.com/' }),
  native('confluence', 'Confluence Cloud', '#1868DB', 'access.confluenceDesc', 'access.confluenceHint', ACCESS_CAPABILITY_LEVELS.NATIVE_API, { connectionMethod: 'api_token', setupUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens' }),
  native('salesforce', 'Salesforce', '#00A1E0', 'access.salesforceDesc', 'access.salesforceHint', ACCESS_CAPABILITY_LEVELS.NATIVE_API, { connectionMethod: 'access_token', setupUrl: 'https://help.salesforce.com/s/articleView?id=xcloud.remoteaccess_authenticate.htm' }),
  native('slack', 'Slack', '#611F69', 'access.slackDesc', 'access.slackHint', ACCESS_CAPABILITY_LEVELS.NATIVE_API, { oauth: true, connectionMethod: 'oauth', setupUrl: 'https://api.slack.com/apps' }),
  native('discord', 'Discord', '#5865F2', 'access.discordDesc', 'access.discordHint', ACCESS_CAPABILITY_LEVELS.NATIVE_API, { connectionMethod: 'bot_token', setupUrl: 'https://discord.com/developers/applications' }),
  native('feishu', 'Feishu / Lark', '#3370FF', 'access.feishuDesc', 'access.feishuHint', ACCESS_CAPABILITY_LEVELS.SOCIAL_BRIDGE, { connectionMethod: 'app_credentials', setupUrl: 'https://open.feishu.cn/app' }),
  native('wechat_personal', '微信 / WeChat', '#07C160', 'access.wechatDesc', 'access.wechatHint', ACCESS_CAPABILITY_LEVELS.SOCIAL_BRIDGE, { connectionMethod: 'qr' }),
  native('telegram', 'Telegram Bot', '#229ED9', 'access.telegramDesc', 'access.telegramHint', ACCESS_CAPABILITY_LEVELS.SOCIAL_BRIDGE, { connectionMethod: 'bot_token', setupUrl: 'https://t.me/BotFather' }),
  native('qq', 'QQ Bot', '#12B7F5', 'access.qqDesc', 'access.qqHint', ACCESS_CAPABILITY_LEVELS.SOCIAL_BRIDGE, { connectionMethod: 'app_credentials', setupUrl: 'https://q.qq.com/' }),
  native('qq_mail', 'QQ Mail', '#12B7F5', 'access.qqMailDesc', 'access.qqMailHint', ACCESS_CAPABILITY_LEVELS.NATIVE_API, { connectionMethod: 'mail_password', category: 'communication', searchTerms: 'mail email qq smtp imap', setupUrl: 'https://service.mail.qq.com/detail/0/75' }),
  native('gmail', 'Gmail', '#EA4335', 'access.mailDesc', 'access.mailHint', ACCESS_CAPABILITY_LEVELS.NATIVE_API, { connectionMethod: 'mail_password', category: 'communication', searchTerms: 'mail email google smtp imap', setupUrl: 'https://myaccount.google.com/apppasswords' }),
  native('outlook', 'Outlook', '#0078D4', 'access.mailDesc', 'access.mailHint', ACCESS_CAPABILITY_LEVELS.NATIVE_API, { connectionMethod: 'mail_password', category: 'communication', searchTerms: 'mail email microsoft smtp imap' }),
  native('exchange', 'Exchange', '#0078D4', 'access.mailDesc', 'access.mailHint', ACCESS_CAPABILITY_LEVELS.NATIVE_API, { connectionMethod: 'mail_password', category: 'communication', searchTerms: 'mail email exchange smtp imap' }),
  native('custom_mail', 'Custom Mail', '#64748B', 'access.mailDesc', 'access.mailHint', ACCESS_CAPABILITY_LEVELS.NATIVE_API, { connectionMethod: 'mail_password', category: 'communication', searchTerms: 'mail email custom smtp imap' }),
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
const NATIVE_WEB_EQUIVALENTS = new Set(['web_google_drive', 'web_slack', 'web_discord', 'web_telegram', 'web_gmail', 'web_outlook', 'web_airtable', 'web_asana', 'web_clickup', 'web_monday', 'web_dropbox', 'web_onedrive', 'web_confluence', 'web_hubspot', 'web_salesforce'])

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
