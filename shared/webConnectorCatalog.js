const BROWSER_SHORTCUT_CAPABILITY = 'Opens this service in the managed browser; no provider-specific API or tools are included.'
const NO_PROVIDER_TOOLS = Object.freeze([])

const app = (provider, label, brandColor, webUrl, category, searchTerms, intendedCapability) => Object.freeze({
  provider,
  label,
  brandColor,
  webUrl,
  category,
  searchTerms,
  capability: BROWSER_SHORTCUT_CAPABILITY,
  intendedCapability,
  capabilityLevel: 'browser_shortcut',
  integrationDepth: 'browser_navigation_only',
  providerSpecificTools: NO_PROVIDER_TOOLS,
})

export const WEB_CONNECTOR_CATALOG = Object.freeze([
  app('web_gmail', 'Gmail', '#EA4335', 'https://mail.google.com/', 'communication', 'google mail 邮箱 邮件', 'Read and work with email, threads, and attachments'),
  app('web_outlook', 'Outlook', '#0078D4', 'https://outlook.office.com/mail/', 'communication', 'microsoft mail 邮箱 邮件', 'Read and work with Microsoft email and calendar'),
  app('web_slack', 'Slack', '#611F69', 'https://app.slack.com/', 'communication', 'chat message 通讯', 'Search channels and assist with team messages'),
  app('web_whatsapp', 'WhatsApp', '#25D366', 'https://web.whatsapp.com/', 'communication', 'whatsapp qr scan chat message 扫码 通讯', 'Scan once to keep a managed WhatsApp Web session available to the model'),
  app('web_dingtalk', '钉钉 / DingTalk', '#0089FF', 'https://im.dingtalk.com/', 'communication', 'chat message 通讯 办公', 'Assist with DingTalk messages and workplace tasks'),
  app('web_discord', 'Discord', '#5865F2', 'https://discord.com/app', 'communication', 'chat community 通讯', 'Search servers and assist with community messages'),
  app('web_telegram', 'Telegram', '#229ED9', 'https://web.telegram.org/', 'communication', 'chat message 通讯', 'Assist with Telegram conversations and channels'),

  app('web_google_drive', 'Google Drive', '#0F9D58', 'https://drive.google.com/', 'productivity', 'google cloud files 云盘 文件', 'Find and work with files stored in Google Drive'),
  app('web_calendar', 'Google Calendar', '#4285F4', 'https://calendar.google.com/', 'productivity', 'schedule 日历 日程', 'Review schedules and assist with calendar planning'),
  app('web_google_docs', 'Google Docs', '#4285F4', 'https://docs.google.com/document/', 'productivity', 'document 文档', 'Read and edit documents in the browser'),
  app('web_google_sheets', 'Google Sheets', '#0F9D58', 'https://docs.google.com/spreadsheets/', 'productivity', 'spreadsheet 表格', 'Read and edit spreadsheets in the browser'),
  app('web_onedrive', 'OneDrive', '#0078D4', 'https://onedrive.live.com/', 'productivity', 'microsoft cloud files 云盘 文件', 'Find and work with files stored in OneDrive'),
  app('web_dropbox', 'Dropbox', '#0061FF', 'https://www.dropbox.com/home', 'productivity', 'cloud files 云盘 文件', 'Find and work with files stored in Dropbox'),
  app('web_tencent_docs', '腾讯文档', '#20A0FF', 'https://docs.qq.com/desktop/', 'productivity', 'tencent document sheet 文档 表格', 'Read and edit Tencent documents and sheets'),
  app('web_baidu_netdisk', '百度网盘', '#06A7FF', 'https://pan.baidu.com/disk/main', 'productivity', 'baidu cloud files 云盘 文件', 'Find and organize files in Baidu Netdisk'),
  app('web_alipan', '阿里云盘', '#7457FF', 'https://www.alipan.com/drive/', 'productivity', 'aliyun cloud files 云盘 文件', 'Find and organize files in Aliyun Drive'),

  app('web_figma', 'Figma', '#A259FF', 'https://www.figma.com/files/', 'creative', 'design 设计', 'Review design files and assist with design work'),
  app('web_canva', 'Canva', '#00C4CC', 'https://www.canva.com/', 'creative', 'design presentation 设计 演示', 'Assist with Canva designs and presentations'),
])

const BY_PROVIDER = new Map(WEB_CONNECTOR_CATALOG.map((connector) => [connector.provider, connector]))

const DOMAIN_ALIASES = Object.freeze({
  web_slack: ['slack.com'],
  web_dingtalk: ['dingtalk.com'],
  web_discord: ['discord.com'],
  web_telegram: ['web.telegram.org'],
  web_gmail: ['accounts.google.com'],
  web_google_drive: ['drive.google.com', 'accounts.google.com'],
  web_calendar: ['calendar.google.com', 'accounts.google.com'],
  web_google_docs: ['docs.google.com', 'accounts.google.com'],
  web_google_sheets: ['docs.google.com', 'accounts.google.com'],
  web_outlook: ['login.microsoftonline.com', 'login.live.com'],
  web_whatsapp: ['web.whatsapp.com'],
  web_onedrive: ['onedrive.live.com', 'login.live.com', 'login.microsoftonline.com'],
  web_dropbox: ['dropbox.com'],
  web_tencent_docs: ['docs.qq.com'],
  web_baidu_netdisk: ['pan.baidu.com'],
  web_alipan: ['alipan.com'],
  web_figma: ['figma.com'],
  web_canva: ['canva.com'],
})

const PATH_PREFIXES = Object.freeze({
  web_google_docs: ['/document'],
  web_google_sheets: ['/spreadsheets'],
})

const SHARED_AUTH_DOMAINS = new Set([
  'accounts.google.com',
  'login.microsoftonline.com',
  'login.live.com',
])

export function getWebConnector(provider) {
  return BY_PROVIDER.get(String(provider || '')) || null
}

export function isWebConnectorProvider(provider) {
  return BY_PROVIDER.has(String(provider || ''))
}

export function findWebConnectorsForUrl(rawUrl) {
  let target
  try { target = new URL(String(rawUrl || '')) } catch { return [] }
  const hostname = target.hostname.toLowerCase()
  return WEB_CONNECTOR_CATALOG.filter((connector) => {
    const canonical = new URL(connector.webUrl).hostname.toLowerCase()
    const domains = [canonical, ...(DOMAIN_ALIASES[connector.provider] || [])]
    if (!domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) return false
    const prefixes = PATH_PREFIXES[connector.provider]
    if (!prefixes || hostname === 'start.atlassian.com' || SHARED_AUTH_DOMAINS.has(hostname)) return true
    return prefixes.some((prefix) => target.pathname === prefix || target.pathname.startsWith(`${prefix}/`))
  })
}
