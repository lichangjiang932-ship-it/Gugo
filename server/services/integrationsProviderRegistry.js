import { WEB_CONNECTOR_CATALOG } from '../../shared/webConnectorCatalog.js'
import { testMailCredentials, testQqMailCredentials } from './mailProtocolClient.js'
import {
  testAirtable,
  testAsana,
  testBrowser,
  testBrowserApp,
  testClickup,
  testConfluence,
  testDingtalk,
  testDiscord,
  testDropbox,
  testFeishu,
  testGithub,
  testGitlab,
  testGoogleCalendar,
  testGoogleDrive,
  testHubspot,
  testJira,
  testLinear,
  testMonday,
  testNotion,
  testOneDrive,
  testQQ,
  testSalesforce,
  testSlack,
  testTelegram,
  testTodoist,
  testTrello,
  testVisionAssist,
  testWechatOfficial,
  testWechatPersonal,
  testWechatWork,
  testWebhook,
  testZendesk,
} from './integrationsProviderTests.js'

export const NATIVE_CONNECTOR_TOOLS = Object.freeze({
  notion: Object.freeze(['notion_search', 'notion_fetch_page', 'notion_append_paragraphs']),
  github: Object.freeze(['github_search_repositories', 'github_get_file', 'github_create_issue']),
  google_drive: Object.freeze(['google_drive_search', 'google_drive_get_file', 'google_drive_create_text_file', 'google_sheets_read_range', 'google_sheets_append_rows', 'google_sheets_update_range']),
  slack: Object.freeze(['slack_list_channels', 'slack_read_channel', 'slack_send_message']),
  jira: Object.freeze(['jira_search_issues', 'jira_create_issue', 'jira_update_issue']),
  linear: Object.freeze(['linear_search_issues', 'linear_create_issue', 'linear_update_issue']),
  trello: Object.freeze(['trello_list_cards', 'trello_create_card', 'trello_update_card']),
  google_calendar: Object.freeze(['google_calendar_list_events', 'google_calendar_create_event', 'google_calendar_update_event']),
  gitlab: Object.freeze(['gitlab_list_issues', 'gitlab_create_issue', 'gitlab_update_issue']),
  asana: Object.freeze(['asana_list_project_tasks', 'asana_create_task', 'asana_update_task']),
  clickup: Object.freeze(['clickup_list_tasks', 'clickup_create_task', 'clickup_update_task']),
  airtable: Object.freeze(['airtable_list_records', 'airtable_create_record', 'airtable_update_record']),
  monday: Object.freeze(['monday_list_items', 'monday_create_item', 'monday_update_item']),
  hubspot: Object.freeze(['hubspot_list_tickets', 'hubspot_create_ticket', 'hubspot_update_ticket']),
  zendesk: Object.freeze(['zendesk_search_tickets', 'zendesk_create_ticket', 'zendesk_update_ticket']),
  todoist: Object.freeze(['todoist_list_tasks', 'todoist_create_task', 'todoist_update_task']),
  dropbox: Object.freeze(['dropbox_list_files', 'dropbox_create_text_file', 'dropbox_update_text_file']),
  onedrive: Object.freeze(['onedrive_list_files', 'onedrive_create_text_file', 'onedrive_update_text_file', 'microsoft_teams_list_channels', 'microsoft_teams_read_channel_messages', 'microsoft_teams_send_channel_message']),
  confluence: Object.freeze(['confluence_search_pages', 'confluence_create_page', 'confluence_update_page']),
  salesforce: Object.freeze(['salesforce_query_records', 'salesforce_create_record', 'salesforce_update_record']),
  qq_mail: Object.freeze(['qq_mail_list_recent', 'qq_mail_read', 'qq_mail_send']),
  gmail: Object.freeze(['mail_list_recent', 'mail_read', 'mail_send']),
  outlook: Object.freeze(['mail_list_recent', 'mail_read', 'mail_send']),
  exchange: Object.freeze(['mail_list_recent', 'mail_read', 'mail_send']),
  custom_mail: Object.freeze(['mail_list_recent', 'mail_read', 'mail_send']),
  discord: Object.freeze(['discord_list_channels', 'discord_read_messages', 'discord_send_message']),
})
export const BROWSER_CONNECTOR_TOOLS = Object.freeze(['connected_app_list', 'connected_app_open'])

const WEB_PROVIDER_REGISTRY = Object.fromEntries(WEB_CONNECTOR_CATALOG.map((connector) => [
  connector.provider,
  {
    kind: 'browser_app',
    label: connector.label,
    fields: [],
    test: testBrowserApp,
  },
]))

export const PROVIDER_REGISTRY = {
  // Access connectors
  browser: {
    kind: 'connector',
    label: 'Browser',
    fields: [],
    test: testBrowser,
  },
  notion: {
    kind: 'connector',
    label: 'Notion',
    fields: [
      { key: 'workspace', label: 'Workspace name', location: 'config', optional: true },
      { key: 'token', label: 'Integration token', location: 'secret', type: 'password' },
    ],
    test: testNotion,
  },
  github: {
    kind: 'connector',
    label: 'GitHub',
    fields: [
      { key: 'account', label: 'Account', location: 'config', optional: true },
      { key: 'token', label: 'Fine-grained personal access token', location: 'secret', type: 'password' },
    ],
    test: testGithub,
  },
  google_drive: {
    kind: 'connector',
    label: 'Google Drive',
    fields: [
      { key: 'account', label: 'Account', location: 'config', optional: true },
      { key: 'token', label: 'OAuth access token', location: 'secret', type: 'password' },
      { key: 'refreshToken', label: 'OAuth refresh token', location: 'secret', type: 'password', optional: true },
    ],
    test: testGoogleDrive,
  },
  google_calendar: {
    kind: 'connector',
    label: 'Google Calendar',
    fields: [
      { key: 'account', label: 'Account', location: 'config', optional: true },
      { key: 'token', label: 'OAuth access token', location: 'secret', type: 'password' },
    ],
    test: testGoogleCalendar,
  },
  jira: {
    kind: 'connector',
    label: 'Jira Cloud',
    fields: [
      { key: 'siteUrl', label: 'Jira site URL', location: 'config' },
      { key: 'email', label: 'Atlassian account email', location: 'config' },
      { key: 'token', label: 'Jira API token', location: 'secret', type: 'password' },
    ],
    test: testJira,
  },
  linear: {
    kind: 'connector',
    label: 'Linear',
    fields: [{ key: 'token', label: 'Personal API key', location: 'secret', type: 'password' }],
    test: testLinear,
  },
  trello: {
    kind: 'connector',
    label: 'Trello',
    fields: [
      { key: 'apiKey', label: 'API key', location: 'config' },
      { key: 'token', label: 'User token', location: 'secret', type: 'password' },
    ],
    test: testTrello,
  },
  gitlab: {
    kind: 'connector', label: 'GitLab',
    fields: [{ key: 'baseUrl', label: 'API URL', location: 'config', optional: true }, { key: 'token', label: 'Personal access token', location: 'secret', type: 'password' }],
    test: testGitlab,
  },
  asana: {
    kind: 'connector', label: 'Asana', fields: [{ key: 'token', label: 'Personal access token', location: 'secret', type: 'password' }], test: testAsana,
  },
  clickup: {
    kind: 'connector', label: 'ClickUp', fields: [{ key: 'token', label: 'Personal API token', location: 'secret', type: 'password' }], test: testClickup,
  },
  airtable: {
    kind: 'connector', label: 'Airtable', fields: [{ key: 'token', label: 'Personal access token', location: 'secret', type: 'password' }], test: testAirtable,
  },
  monday: {
    kind: 'connector', label: 'monday.com', fields: [{ key: 'token', label: 'Personal API token', location: 'secret', type: 'password' }], test: testMonday,
  },
  hubspot: {
    kind: 'connector', label: 'HubSpot', fields: [{ key: 'token', label: 'Private app access token', location: 'secret', type: 'password' }], test: testHubspot,
  },
  zendesk: {
    kind: 'connector', label: 'Zendesk', fields: [
      { key: 'subdomain', label: 'Zendesk subdomain', location: 'config' },
      { key: 'email', label: 'Agent email', location: 'config' },
      { key: 'token', label: 'API token', location: 'secret', type: 'password' },
    ], test: testZendesk,
  },
  todoist: {
    kind: 'connector', label: 'Todoist', fields: [{ key: 'token', label: 'API token', location: 'secret', type: 'password' }], test: testTodoist,
  },
  dropbox: {
    kind: 'connector', label: 'Dropbox', fields: [{ key: 'token', label: 'OAuth access token', location: 'secret', type: 'password' }], test: testDropbox,
  },
  onedrive: {
    kind: 'connector', label: 'OneDrive', fields: [{ key: 'token', label: 'Microsoft Graph access token', location: 'secret', type: 'password' }], test: testOneDrive,
  },
  confluence: {
    kind: 'connector', label: 'Confluence Cloud', fields: [
      { key: 'siteUrl', label: 'Atlassian site URL', location: 'config' },
      { key: 'email', label: 'Atlassian account email', location: 'config' },
      { key: 'token', label: 'API token', location: 'secret', type: 'password' },
    ], test: testConfluence,
  },
  salesforce: {
    kind: 'connector', label: 'Salesforce', fields: [
      { key: 'instanceUrl', label: 'Instance URL', location: 'config' },
      { key: 'token', label: 'OAuth access token', location: 'secret', type: 'password' },
    ], test: testSalesforce,
  },
  qq_mail: {
    kind: 'connector',
    label: 'QQ Mail',
    fields: [
      { key: 'user', label: 'QQ email address', location: 'config', optional: true },
      { key: 'from', label: 'Sender address', location: 'config', optional: true },
      { key: 'smtpHost', label: 'SMTP host', location: 'config', optional: true, defaultValue: 'smtp.qq.com' },
      { key: 'smtpPort', label: 'SMTP port', location: 'config', optional: true, type: 'number', defaultValue: 465 },
      { key: 'imapHost', label: 'IMAP host', location: 'config', optional: true, defaultValue: 'imap.qq.com' },
      { key: 'imapPort', label: 'IMAP port', location: 'config', optional: true, type: 'number', defaultValue: 993 },
      { key: 'password', label: 'QQ Mail authorization code', location: 'secret', type: 'password', optional: true },
    ],
    test: testQqMailCredentials,
  },
  ...Object.fromEntries([
    ['gmail', 'Gmail'],
    ['outlook', 'Outlook'],
    ['exchange', 'Exchange'],
    ['custom_mail', 'Custom Mail'],
  ].map(([provider, label]) => [provider, {
    kind: 'connector',
    label,
    fields: [
      { key: 'user', label: 'Email address', location: 'config' },
      { key: 'from', label: 'Sender address', location: 'config', optional: true },
      { key: 'smtpHost', label: 'SMTP host', location: 'config', optional: provider !== 'custom_mail' },
      { key: 'smtpPort', label: 'SMTP port', location: 'config', optional: true, type: 'number' },
      { key: 'imapHost', label: 'IMAP host', location: 'config', optional: provider !== 'custom_mail' },
      { key: 'imapPort', label: 'IMAP port', location: 'config', optional: true, type: 'number' },
      { key: 'password', label: 'App password', location: 'secret', type: 'password' },
    ],
    test: (options) => testMailCredentials({ provider, ...options }),
  }])),
  // === IM / 社交（kind='social'）===
  feishu: {
    kind: 'social',
    label: '飞书 / Lark',
    fields: {
      config: ['appId'],
      secret: ['appSecret'],
      optional: {
        config: ['botName', 'defaultAgentId'],
        secret: ['verificationToken', 'encryptKey'],
      },
    },
    test: testFeishu,
  },
  wechat_official: {
    kind: 'social',
    label: '微信公众号',
    fields: { config: ['appId'], secret: ['appSecret', 'token', 'encodingAesKey'] },
    test: testWechatOfficial,
  },
  wechat_personal: {
    kind: 'social',
    label: '企业微信 / Work',
    fields: { config: ['botId', 'baseUrl', 'defaultAgentId'], secret: ['botToken'] },
    test: testWechatPersonal,
  },
  wechat_work: {
    kind: 'social',
    label: '企业微信 (Work API)',
    fields: { config: ['corpId'], secret: ['corpSecret'] },
    test: testWechatWork,
  },
  dingtalk: {
    kind: 'social',
    label: '钉钉',
    fields: { config: ['appKey'], secret: ['appSecret'] },
    test: testDingtalk,
  },
  qq: {
    kind: 'social',
    label: 'QQ 开放平台',
    fields: { config: ['appId', 'defaultAgentId'], secret: ['appSecret', 'token'] },
    test: testQQ,
  },
  discord: {
    kind: 'social',
    label: 'Discord',
    fields: { config: ['applicationId'], secret: ['botToken'] },
    test: testDiscord,
  },
  telegram: {
    kind: 'social',
    label: 'Telegram',
    fields: {
      config: ['botUsername', 'mode', 'defaultAgentId'],
      secret: ['botToken'],
      optional: { secret: ['webhookSecret'] },
    },
    test: testTelegram,
  },
  slack: {
    kind: 'social',
    label: 'Slack',
    fields: { config: ['workspace'], secret: ['botToken', 'signingSecret'] },
    test: testSlack,
  },
  webhook: {
    kind: 'social',
    label: '自定义 Webhook',
    fields: { config: ['url', 'method'], secret: ['signingSecret'] },
    test: testWebhook,
  },

  // === 视觉辅助副驾（kind='vision_assist'）===
  vision_assist: {
    kind: 'vision_assist',
    label: '视觉辅助副驾（多模态描述模型）',
    fields: {
      config: ['baseUrl', 'modelName', 'language', 'maxImages'],
      secret: ['apiKey'],
    },
    test: testVisionAssist,
  },
  ...WEB_PROVIDER_REGISTRY,
}

export function listProviderRegistry() {
  return Object.entries(PROVIDER_REGISTRY).map(([provider, meta]) => {
    const nativeTools = NATIVE_CONNECTOR_TOOLS[provider]
    const browserShortcut = meta.kind === 'browser_app' || provider === 'browser'
    const capabilityLevel = nativeTools
      ? 'native_api'
      : (browserShortcut ? 'browser_shortcut' : (meta.kind === 'social' ? 'social_bridge' : null))
    return {
      provider,
      kind: meta.kind,
      label: meta.label,
      fields: meta.fields,
      capabilityLevel,
      integrationDepth: nativeTools
        ? 'provider_api'
        : (browserShortcut ? 'browser_navigation_only' : (meta.kind === 'social' ? 'provider_bridge' : null)),
      providerSpecificTools: nativeTools ? [...nativeTools] : [],
      availableTools: nativeTools
        ? [...nativeTools]
        : (meta.kind === 'browser_app'
            ? ['connected_app_open']
            : (provider === 'browser' ? [...BROWSER_CONNECTOR_TOOLS] : [])),
    }
  })
}
