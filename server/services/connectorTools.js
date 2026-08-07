import { registerDynamicTool, unregisterByOrigin } from './toolRegistry.js'
import { CONNECTOR_WRITE_TOOL_NAMES } from '../../shared/connectorWriteTools.js'
export { CONNECTOR_WRITE_TOOL_NAMES } from '../../shared/connectorWriteTools.js'
import { runConnectorWriteOnce } from './connectorIdempotencyService.js'
import {
  appendNotionParagraphs,
  createGithubIssue,
  createGoogleDriveTextFile,
  fetchNotionPage,
  getGoogleDriveFile,
  getGithubFile,
  listSlackChannels,
  listConnectedBrowserApps,
  listMailMessages,
  listQqMailMessages,
  openConnectedBrowserApp,
  readQqMailMessage,
  readMailMessage,
  readSlackChannel,
  searchGoogleDrive,
  searchGithubRepositories,
  searchNotion,
  sendSlackMessage,
  sendQqMailMessage,
  sendMailMessage,
} from './connectorService.js'
import {
  createGoogleCalendarEvent,
  createJiraIssue,
  createLinearIssue,
  createTrelloCard,
  listTrelloCards,
  listGoogleCalendarEvents,
  searchJiraIssues,
  searchLinearIssues,
  updateGoogleCalendarEvent,
  updateJiraIssue,
  updateLinearIssue,
  updateTrelloCard,
} from './projectConnectorService.js'
import {
  createAirtableRecord,
  createAsanaTask,
  createClickupTask,
  createGitlabIssue,
  createMondayItem,
  listAsanaProjectTasks,
  listClickupTasks,
  listAirtableRecords,
  listGitlabIssues,
  listMondayItems,
  updateAirtableRecord,
  updateAsanaTask,
  updateClickupTask,
  updateGitlabIssue,
  updateMondayItem,
} from './workConnectorService.js'
import {
  createConfluencePage,
  createDropboxTextFile,
  createHubspotTicket,
  createOneDriveTextFile,
  createSalesforceRecord,
  createTodoistTask,
  createZendeskTicket,
  listDropboxFiles,
  listHubspotTickets,
  listOneDriveFiles,
  querySalesforceRecords,
  searchConfluencePages,
  searchZendeskTickets,
  updateConfluencePage,
  updateDropboxTextFile,
  updateHubspotTicket,
  updateOneDriveTextFile,
  updateSalesforceRecord,
  updateTodoistTask,
  listTodoistTasks,
  updateZendeskTicket,
} from './businessConnectorService.js'
import {
  appendGoogleSheetRows,
  listDiscordChannels,
  listTeamsChannels,
  readDiscordMessages,
  readGoogleSheetRange,
  readTeamsChannelMessages,
  sendDiscordMessage,
  sendTeamsChannelMessage,
  updateGoogleSheetRange,
} from './collaborationConnectorService.js'

const definitions = [
  ['connected_app_list', 'List Browser apps connected and enabled by the current user for task assistance.', {}, []],
  ['connected_app_open', 'Use a persistently connected Browser app by provider ID. The visible managed session is restored automatically when needed.', { provider: { type: 'string' } }, ['provider']],
  ['notion_search', 'Search pages and databases shared with the connected Notion integration.', { query: { type: 'string' } }, []],
  ['notion_fetch_page', 'Read a Notion page and its first 100 child blocks by page ID.', { pageId: { type: 'string' } }, ['pageId']],
  ['notion_append_paragraphs', 'Append paragraph blocks to a connected Notion page.', {
    pageId: { type: 'string' }, paragraphs: { type: 'array', items: { type: 'string' } },
  }, ['pageId', 'paragraphs']],
  ['github_search_repositories', 'Search repositories visible to the connected GitHub account.', { query: { type: 'string' } }, ['query']],
  ['github_get_file', 'Read a file or list a directory in a GitHub repository.', {
    owner: { type: 'string' }, repo: { type: 'string' }, path: { type: 'string' }, ref: { type: 'string' },
  }, ['owner', 'repo', 'path']],
  ['github_create_issue', 'Create an issue in a connected GitHub repository.', {
    owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' },
  }, ['owner', 'repo', 'title']],
  ['slack_list_channels', 'List public and private Slack channels visible to the connected app.', {
    limit: { type: 'number' },
  }, []],
  ['slack_read_channel', 'Read recent messages from a Slack channel by channel ID.', {
    channelId: { type: 'string' }, limit: { type: 'number' },
  }, ['channelId']],
  ['slack_send_message', 'Send a message to a Slack channel, optionally in a thread.', {
    channelId: { type: 'string' }, text: { type: 'string' }, threadTs: { type: 'string' },
  }, ['channelId', 'text']],
  ['google_drive_search', 'Search files visible to the connected Google Drive account.', {
    query: { type: 'string' }, limit: { type: 'number' },
  }, []],
  ['google_drive_get_file', 'Read metadata and text content from a Google Drive file by ID.', {
    fileId: { type: 'string' },
  }, ['fileId']],
  ['google_drive_create_text_file', 'Create a text file in connected Google Drive.', {
    name: { type: 'string' }, content: { type: 'string' }, mimeType: { type: 'string' },
  }, ['name', 'content']],
  ['qq_mail_list_recent', 'List recent messages from the connected QQ Mail inbox.', {
    limit: { type: 'number' },
  }, []],
  ['qq_mail_read', 'Read one QQ Mail message by its IMAP UID.', {
    uid: { type: 'string' },
  }, ['uid']],
  ['qq_mail_send', 'Send an email through the connected QQ Mail account.', {
    to: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
    subject: { type: 'string' },
    text: { type: 'string' },
    html: { type: 'string' },
  }, ['to', 'subject']],
  ['mail_list_recent', 'List recent messages from a connected Gmail, Outlook, Exchange, QQ, or custom IMAP account.', {
    provider: { type: 'string', enum: ['gmail', 'outlook', 'exchange', 'qq_mail', 'custom_mail'] },
    limit: { type: 'number' },
  }, ['provider']],
  ['mail_read', 'Read one message from a connected mail account by IMAP UID.', {
    provider: { type: 'string', enum: ['gmail', 'outlook', 'exchange', 'qq_mail', 'custom_mail'] },
    uid: { type: 'string' },
  }, ['provider', 'uid']],
  ['mail_send', 'Send an email through a connected Gmail, Outlook, Exchange, QQ, or custom SMTP account.', {
    provider: { type: 'string', enum: ['gmail', 'outlook', 'exchange', 'qq_mail', 'custom_mail'] },
    to: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
    subject: { type: 'string' }, text: { type: 'string' }, html: { type: 'string' },
  }, ['provider', 'to', 'subject']],
  ['jira_create_issue', 'Create an issue in a connected Jira Cloud project.', {
    projectKey: { type: 'string' }, issueType: { type: 'string' }, summary: { type: 'string' }, description: { type: 'string' },
  }, ['projectKey', 'summary']],
  ['jira_search_issues', 'Search issues in connected Jira Cloud using JQL.', {
    jql: { type: 'string' }, limit: { type: 'number' },
  }, []],
  ['jira_update_issue', 'Update the summary or description of a Jira Cloud issue.', {
    issueKey: { type: 'string' }, summary: { type: 'string' }, description: { type: 'string' },
  }, ['issueKey']],
  ['linear_create_issue', 'Create an issue in a connected Linear team.', {
    teamId: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, priority: { type: 'number' },
  }, ['teamId', 'title']],
  ['linear_search_issues', 'Search connected Linear issues by title.', {
    query: { type: 'string' }, limit: { type: 'number' },
  }, ['query']],
  ['linear_update_issue', 'Update a connected Linear issue.', {
    issueId: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, priority: { type: 'number' },
  }, ['issueId']],
  ['trello_create_card', 'Create a card in a connected Trello list.', {
    listId: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, due: { type: 'string' },
  }, ['listId', 'name']],
  ['trello_list_cards', 'List cards in a connected Trello list.', {
    listId: { type: 'string' }, limit: { type: 'number' },
  }, ['listId']],
  ['trello_update_card', 'Update a connected Trello card.', {
    cardId: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, due: { type: 'string' }, closed: { type: 'boolean' },
  }, ['cardId']],
  ['google_calendar_create_event', 'Create an event in connected Google Calendar and notify attendees.', {
    calendarId: { type: 'string' }, summary: { type: 'string' }, description: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, timeZone: { type: 'string' }, attendees: { type: 'array', items: { type: 'string' } },
  }, ['summary', 'start', 'end']],
  ['google_calendar_list_events', 'List events from a connected Google Calendar.', {
    calendarId: { type: 'string' }, timeMin: { type: 'string' }, timeMax: { type: 'string' }, query: { type: 'string' }, limit: { type: 'number' },
  }, []],
  ['google_calendar_update_event', 'Update an event in connected Google Calendar and notify attendees.', {
    calendarId: { type: 'string' }, eventId: { type: 'string' }, summary: { type: 'string' }, description: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, timeZone: { type: 'string' },
  }, ['eventId']],
  ['gitlab_create_issue', 'Create an issue in a connected GitLab project.', { projectId: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } } }, ['projectId', 'title']],
  ['gitlab_list_issues', 'List issues in a connected GitLab project.', { projectId: { type: 'string' }, state: { type: 'string' }, search: { type: 'string' }, limit: { type: 'number' } }, ['projectId']],
  ['gitlab_update_issue', 'Update a connected GitLab issue.', { projectId: { type: 'string' }, issueIid: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, stateEvent: { type: 'string' } }, ['projectId', 'issueIid']],
  ['asana_create_task', 'Create a task in a connected Asana workspace.', { workspaceId: { type: 'string' }, projectId: { type: 'string' }, name: { type: 'string' }, notes: { type: 'string' }, dueOn: { type: 'string' }, assignee: { type: 'string' } }, ['workspaceId', 'name']],
  ['asana_list_project_tasks', 'List tasks in a connected Asana project.', { projectId: { type: 'string' }, limit: { type: 'number' } }, ['projectId']],
  ['asana_update_task', 'Update a connected Asana task.', { taskId: { type: 'string' }, name: { type: 'string' }, notes: { type: 'string' }, completed: { type: 'boolean' }, dueOn: { type: 'string' } }, ['taskId']],
  ['clickup_create_task', 'Create a task in a connected ClickUp list.', { listId: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, assignees: { type: 'array', items: { type: 'string' } }, dueDate: { type: 'number' }, priority: { type: 'number' } }, ['listId', 'name']],
  ['clickup_list_tasks', 'List tasks in a connected ClickUp list.', { listId: { type: 'string' }, includeClosed: { type: 'boolean' }, page: { type: 'number' } }, ['listId']],
  ['clickup_update_task', 'Update a connected ClickUp task.', { taskId: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, status: { type: 'string' }, priority: { type: 'number' } }, ['taskId']],
  ['airtable_create_record', 'Create a record in a connected Airtable table.', { baseId: { type: 'string' }, tableId: { type: 'string' }, fields: { type: 'object' }, typecast: { type: 'boolean' } }, ['baseId', 'tableId', 'fields']],
  ['airtable_list_records', 'List records from a connected Airtable table.', { baseId: { type: 'string' }, tableId: { type: 'string' }, view: { type: 'string' }, filterByFormula: { type: 'string' }, limit: { type: 'number' }, offset: { type: 'string' } }, ['baseId', 'tableId']],
  ['airtable_update_record', 'Update a record in a connected Airtable table.', { baseId: { type: 'string' }, tableId: { type: 'string' }, recordId: { type: 'string' }, fields: { type: 'object' }, typecast: { type: 'boolean' } }, ['baseId', 'tableId', 'recordId', 'fields']],
  ['monday_create_item', 'Create an item on a connected monday.com board.', { boardId: { type: 'string' }, groupId: { type: 'string' }, itemName: { type: 'string' }, columnValues: { type: 'object' } }, ['boardId', 'itemName']],
  ['monday_list_items', 'List items on a connected monday.com board.', { boardId: { type: 'string' }, limit: { type: 'number' }, cursor: { type: 'string' } }, ['boardId']],
  ['monday_update_item', 'Update column values on a connected monday.com item.', { boardId: { type: 'string' }, itemId: { type: 'string' }, columnValues: { type: 'object' } }, ['boardId', 'itemId', 'columnValues']],
  ['hubspot_create_ticket', 'Create a ticket in connected HubSpot.', { subject: { type: 'string' }, content: { type: 'string' }, pipeline: { type: 'string' }, stage: { type: 'string' }, priority: { type: 'string' } }, ['subject']],
  ['hubspot_list_tickets', 'List tickets from connected HubSpot.', { limit: { type: 'number' }, after: { type: 'string' } }, []],
  ['hubspot_update_ticket', 'Update a connected HubSpot ticket.', { ticketId: { type: 'string' }, subject: { type: 'string' }, content: { type: 'string' }, stage: { type: 'string' }, priority: { type: 'string' } }, ['ticketId']],
  ['zendesk_create_ticket', 'Create a ticket in connected Zendesk.', { subject: { type: 'string' }, comment: { type: 'string' }, priority: { type: 'string' }, type: { type: 'string' } }, ['subject', 'comment']],
  ['zendesk_search_tickets', 'Search tickets in connected Zendesk.', { query: { type: 'string' }, limit: { type: 'number' }, page: { type: 'number' } }, []],
  ['zendesk_update_ticket', 'Update a connected Zendesk ticket.', { ticketId: { type: 'string' }, subject: { type: 'string' }, comment: { type: 'string' }, status: { type: 'string' }, priority: { type: 'string' } }, ['ticketId']],
  ['todoist_create_task', 'Create a task in connected Todoist.', { content: { type: 'string' }, description: { type: 'string' }, projectId: { type: 'string' }, dueString: { type: 'string' }, priority: { type: 'number' } }, ['content']],
  ['todoist_list_tasks', 'List active tasks from connected Todoist.', { projectId: { type: 'string' }, label: { type: 'string' }, filter: { type: 'string' }, limit: { type: 'number' } }, []],
  ['todoist_update_task', 'Update a connected Todoist task.', { taskId: { type: 'string' }, content: { type: 'string' }, description: { type: 'string' }, dueString: { type: 'string' }, priority: { type: 'number' } }, ['taskId']],
  ['dropbox_create_text_file', 'Create a UTF-8 text file in connected Dropbox.', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']],
  ['dropbox_list_files', 'List files and folders in connected Dropbox.', { path: { type: 'string' }, recursive: { type: 'boolean' }, limit: { type: 'number' }, cursor: { type: 'string' } }, []],
  ['dropbox_update_text_file', 'Overwrite a UTF-8 text file in connected Dropbox.', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']],
  ['onedrive_create_text_file', 'Create a UTF-8 text file in connected OneDrive.', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']],
  ['onedrive_list_files', 'List files and folders in connected OneDrive.', { path: { type: 'string' }, limit: { type: 'number' } }, []],
  ['onedrive_update_text_file', 'Overwrite a UTF-8 text file in connected OneDrive.', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']],
  ['confluence_create_page', 'Create a page in connected Confluence Cloud.', { spaceId: { type: 'string' }, parentId: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, ['spaceId', 'title', 'body']],
  ['confluence_search_pages', 'Search pages in connected Confluence Cloud using CQL.', { cql: { type: 'string' }, limit: { type: 'number' }, start: { type: 'number' } }, []],
  ['confluence_update_page', 'Update a connected Confluence Cloud page.', { pageId: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, version: { type: 'number' } }, ['pageId', 'title', 'body', 'version']],
  ['salesforce_create_record', 'Create a record in connected Salesforce.', { objectType: { type: 'string' }, fields: { type: 'object' } }, ['objectType', 'fields']],
  ['salesforce_query_records', 'Run a read-only SOQL SELECT query in connected Salesforce.', { soql: { type: 'string' }, limit: { type: 'number' } }, ['soql']],
  ['salesforce_update_record', 'Update a record in connected Salesforce.', { objectType: { type: 'string' }, recordId: { type: 'string' }, fields: { type: 'object' } }, ['objectType', 'recordId', 'fields']],
  ['discord_send_message', 'Send a message to a connected Discord channel.', { channelId: { type: 'string' }, content: { type: 'string' } }, ['channelId', 'content']],
  ['discord_list_channels', 'List channels in a Discord server visible to the connected bot.', { guildId: { type: 'string' } }, ['guildId']],
  ['discord_read_messages', 'Read recent messages from a Discord channel.', { channelId: { type: 'string' }, limit: { type: 'number' } }, ['channelId']],
  ['microsoft_teams_send_channel_message', 'Send a message to a Microsoft Teams channel through a connected Microsoft Graph token.', { teamId: { type: 'string' }, channelId: { type: 'string' }, content: { type: 'string' } }, ['teamId', 'channelId', 'content']],
  ['microsoft_teams_list_channels', 'List channels in a Microsoft Teams team.', { teamId: { type: 'string' } }, ['teamId']],
  ['microsoft_teams_read_channel_messages', 'Read recent messages from a Microsoft Teams channel.', { teamId: { type: 'string' }, channelId: { type: 'string' }, limit: { type: 'number' } }, ['teamId', 'channelId']],
  ['google_sheets_read_range', 'Read values from a Google Sheets range.', { spreadsheetId: { type: 'string' }, range: { type: 'string' } }, ['spreadsheetId']],
  ['google_sheets_append_rows', 'Append rows to a Google Sheet through the connected Google Drive OAuth token.', { spreadsheetId: { type: 'string' }, range: { type: 'string' }, values: { type: 'array', items: { type: 'array', items: {} } } }, ['spreadsheetId', 'values']],
  ['google_sheets_update_range', 'Replace values in a Google Sheets range.', { spreadsheetId: { type: 'string' }, range: { type: 'string' }, values: { type: 'array', items: { type: 'array', items: {} } } }, ['spreadsheetId', 'range', 'values']],
]

export const CONNECTOR_TOOL_SPECS = Object.freeze(definitions.map(([name, description, properties, required]) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
})))

export const CONNECTOR_TOOL_NAMES = Object.freeze(CONNECTOR_TOOL_SPECS.map((spec) => spec.function.name))

function connectorFailure(error) {
  const statusCode = Number(error?.statusCode) || null
  return {
    ok: false,
    code: error?.code || 'connector_tool_failed',
    error: error?.message || String(error),
    retryable: error?.retryable ?? (!statusCode || statusCode >= 500),
    ...(statusCode ? { statusCode } : {}),
  }
}

function isUncertainWriteOutcome(result) {
  if (result?.ok !== false) return false
  if (['connector_request_timeout', 'connector_request_aborted', 'connector_response_too_large'].includes(result.code)) return true
  return !result.statusCode || result.statusCode >= 500
}

async function executeConnectorToolNow(
  name,
  args = {},
  { userId, fetchImpl, env, mailClient, idempotencyKey, toolCallId } = {},
) {
  if (!userId) return { ok: false, error: 'connector tools require userId' }
  const executionContext = { idempotencyKey, toolCallId }
  try {
    if (name === 'connected_app_list') {
      return { ok: true, apps: listConnectedBrowserApps({ userId, ...executionContext }) }
    }
    if (name === 'connected_app_open') {
      return { ok: true, ...(await openConnectedBrowserApp({ userId, provider: args.provider, ...executionContext })) }
    }
    if (name === 'notion_search') {
      return { ok: true, ...(await searchNotion({ userId, query: args.query, ...executionContext })) }
    }
    if (name === 'notion_fetch_page') {
      return { ok: true, ...(await fetchNotionPage({ userId, pageId: args.pageId, ...executionContext })) }
    }
    if (name === 'notion_append_paragraphs') return { ok: true, ...(await appendNotionParagraphs({ userId, ...args, fetchImpl, ...executionContext })) }
    if (name === 'github_search_repositories') {
      return { ok: true, ...(await searchGithubRepositories({ userId, query: args.query, ...executionContext })) }
    }
    if (name === 'github_get_file') {
      return { ok: true, ...(await getGithubFile({ userId, ...args, fetchImpl, ...executionContext })) }
    }
    if (name === 'github_create_issue') return { ok: true, ...(await createGithubIssue({ userId, ...args, fetchImpl, ...executionContext })) }
    if (name === 'slack_list_channels') {
      return { ok: true, ...(await listSlackChannels({ userId, ...args, fetchImpl, ...executionContext })) }
    }
    if (name === 'slack_read_channel') {
      return { ok: true, ...(await readSlackChannel({ userId, ...args, fetchImpl, ...executionContext })) }
    }
    if (name === 'slack_send_message') return { ok: true, ...(await sendSlackMessage({ userId, ...args, fetchImpl, ...executionContext })) }
    if (name === 'google_drive_search') {
      return { ok: true, ...(await searchGoogleDrive({ userId, ...args, fetchImpl, env, ...executionContext })) }
    }
    if (name === 'google_drive_get_file') {
      return { ok: true, ...(await getGoogleDriveFile({ userId, ...args, fetchImpl, env, ...executionContext })) }
    }
    if (name === 'google_drive_create_text_file') return { ok: true, ...(await createGoogleDriveTextFile({ userId, ...args, fetchImpl, env, ...executionContext })) }
    if (name === 'qq_mail_list_recent') {
      return { ok: true, ...(await listQqMailMessages({ userId, ...args, env, mailClient, ...executionContext })) }
    }
    if (name === 'qq_mail_read') {
      return { ok: true, ...(await readQqMailMessage({ userId, ...args, env, mailClient, ...executionContext })) }
    }
    if (name === 'qq_mail_send') {
      return { ok: true, ...(await sendQqMailMessage({ userId, ...args, env, mailClient, ...executionContext })) }
    }
    if (name === 'mail_list_recent') return { ok: true, ...(await listMailMessages({ userId, ...args, env, mailClient, ...executionContext })) }
    if (name === 'mail_read') return { ok: true, ...(await readMailMessage({ userId, ...args, env, mailClient, ...executionContext })) }
    if (name === 'mail_send') return { ok: true, ...(await sendMailMessage({ userId, ...args, env, mailClient, ...executionContext })) }
    if (name === 'jira_create_issue') return { ok: true, ...(await createJiraIssue({ userId, ...args, fetchImpl })) }
    if (name === 'jira_search_issues') return { ok: true, ...(await searchJiraIssues({ userId, ...args, fetchImpl })) }
    if (name === 'jira_update_issue') return { ok: true, ...(await updateJiraIssue({ userId, ...args, fetchImpl })) }
    if (name === 'linear_create_issue') return { ok: true, ...(await createLinearIssue({ userId, ...args, fetchImpl })) }
    if (name === 'linear_search_issues') return { ok: true, ...(await searchLinearIssues({ userId, ...args, fetchImpl })) }
    if (name === 'linear_update_issue') return { ok: true, ...(await updateLinearIssue({ userId, ...args, fetchImpl })) }
    if (name === 'trello_create_card') return { ok: true, ...(await createTrelloCard({ userId, ...args, fetchImpl })) }
    if (name === 'trello_list_cards') return { ok: true, ...(await listTrelloCards({ userId, ...args, fetchImpl })) }
    if (name === 'trello_update_card') return { ok: true, ...(await updateTrelloCard({ userId, ...args, fetchImpl })) }
    if (name === 'google_calendar_create_event') return { ok: true, ...(await createGoogleCalendarEvent({ userId, ...args, fetchImpl })) }
    if (name === 'google_calendar_list_events') return { ok: true, ...(await listGoogleCalendarEvents({ userId, ...args, fetchImpl })) }
    if (name === 'google_calendar_update_event') return { ok: true, ...(await updateGoogleCalendarEvent({ userId, ...args, fetchImpl })) }
    if (name === 'gitlab_create_issue') return { ok: true, ...(await createGitlabIssue({ userId, ...args, fetchImpl })) }
    if (name === 'gitlab_list_issues') return { ok: true, ...(await listGitlabIssues({ userId, ...args, fetchImpl })) }
    if (name === 'gitlab_update_issue') return { ok: true, ...(await updateGitlabIssue({ userId, ...args, fetchImpl })) }
    if (name === 'asana_create_task') return { ok: true, ...(await createAsanaTask({ userId, ...args, fetchImpl })) }
    if (name === 'asana_list_project_tasks') return { ok: true, ...(await listAsanaProjectTasks({ userId, ...args, fetchImpl })) }
    if (name === 'asana_update_task') return { ok: true, ...(await updateAsanaTask({ userId, ...args, fetchImpl })) }
    if (name === 'clickup_create_task') return { ok: true, ...(await createClickupTask({ userId, ...args, fetchImpl })) }
    if (name === 'clickup_list_tasks') return { ok: true, ...(await listClickupTasks({ userId, ...args, fetchImpl })) }
    if (name === 'clickup_update_task') return { ok: true, ...(await updateClickupTask({ userId, ...args, fetchImpl })) }
    if (name === 'airtable_create_record') return { ok: true, ...(await createAirtableRecord({ userId, ...args, fetchImpl })) }
    if (name === 'airtable_list_records') return { ok: true, ...(await listAirtableRecords({ userId, ...args, fetchImpl })) }
    if (name === 'airtable_update_record') return { ok: true, ...(await updateAirtableRecord({ userId, ...args, fetchImpl })) }
    if (name === 'monday_create_item') return { ok: true, ...(await createMondayItem({ userId, ...args, fetchImpl })) }
    if (name === 'monday_list_items') return { ok: true, ...(await listMondayItems({ userId, ...args, fetchImpl })) }
    if (name === 'monday_update_item') return { ok: true, ...(await updateMondayItem({ userId, ...args, fetchImpl })) }
    if (name === 'hubspot_create_ticket') return { ok: true, ...(await createHubspotTicket({ userId, ...args, fetchImpl })) }
    if (name === 'hubspot_list_tickets') return { ok: true, ...(await listHubspotTickets({ userId, ...args, fetchImpl })) }
    if (name === 'hubspot_update_ticket') return { ok: true, ...(await updateHubspotTicket({ userId, ...args, fetchImpl })) }
    if (name === 'zendesk_create_ticket') return { ok: true, ...(await createZendeskTicket({ userId, ...args, fetchImpl })) }
    if (name === 'zendesk_search_tickets') return { ok: true, ...(await searchZendeskTickets({ userId, ...args, fetchImpl })) }
    if (name === 'zendesk_update_ticket') return { ok: true, ...(await updateZendeskTicket({ userId, ...args, fetchImpl })) }
    if (name === 'todoist_create_task') return { ok: true, ...(await createTodoistTask({ userId, ...args, fetchImpl })) }
    if (name === 'todoist_list_tasks') return { ok: true, ...(await listTodoistTasks({ userId, ...args, fetchImpl })) }
    if (name === 'todoist_update_task') return { ok: true, ...(await updateTodoistTask({ userId, ...args, fetchImpl })) }
    if (name === 'dropbox_create_text_file') return { ok: true, ...(await createDropboxTextFile({ userId, ...args, fetchImpl })) }
    if (name === 'dropbox_list_files') return { ok: true, ...(await listDropboxFiles({ userId, ...args, fetchImpl })) }
    if (name === 'dropbox_update_text_file') return { ok: true, ...(await updateDropboxTextFile({ userId, ...args, fetchImpl })) }
    if (name === 'onedrive_create_text_file') return { ok: true, ...(await createOneDriveTextFile({ userId, ...args, fetchImpl })) }
    if (name === 'onedrive_list_files') return { ok: true, ...(await listOneDriveFiles({ userId, ...args, fetchImpl })) }
    if (name === 'onedrive_update_text_file') return { ok: true, ...(await updateOneDriveTextFile({ userId, ...args, fetchImpl })) }
    if (name === 'confluence_create_page') return { ok: true, ...(await createConfluencePage({ userId, ...args, fetchImpl })) }
    if (name === 'confluence_search_pages') return { ok: true, ...(await searchConfluencePages({ userId, ...args, fetchImpl })) }
    if (name === 'confluence_update_page') return { ok: true, ...(await updateConfluencePage({ userId, ...args, fetchImpl })) }
    if (name === 'salesforce_create_record') return { ok: true, ...(await createSalesforceRecord({ userId, ...args, fetchImpl })) }
    if (name === 'salesforce_query_records') return { ok: true, ...(await querySalesforceRecords({ userId, ...args, fetchImpl })) }
    if (name === 'salesforce_update_record') return { ok: true, ...(await updateSalesforceRecord({ userId, ...args, fetchImpl })) }
    if (name === 'discord_send_message') return { ok: true, ...(await sendDiscordMessage({ userId, ...args, fetchImpl })) }
    if (name === 'discord_list_channels') return { ok: true, ...(await listDiscordChannels({ userId, ...args, fetchImpl })) }
    if (name === 'discord_read_messages') return { ok: true, ...(await readDiscordMessages({ userId, ...args, fetchImpl })) }
    if (name === 'microsoft_teams_send_channel_message') return { ok: true, ...(await sendTeamsChannelMessage({ userId, ...args, fetchImpl })) }
    if (name === 'microsoft_teams_list_channels') return { ok: true, ...(await listTeamsChannels({ userId, ...args, fetchImpl })) }
    if (name === 'microsoft_teams_read_channel_messages') return { ok: true, ...(await readTeamsChannelMessages({ userId, ...args, fetchImpl })) }
    if (name === 'google_sheets_read_range') return { ok: true, ...(await readGoogleSheetRange({ userId, ...args, fetchImpl })) }
    if (name === 'google_sheets_append_rows') return { ok: true, ...(await appendGoogleSheetRows({ userId, ...args, fetchImpl })) }
    if (name === 'google_sheets_update_range') return { ok: true, ...(await updateGoogleSheetRange({ userId, ...args, fetchImpl })) }
    return { ok: false, error: `unknown connector tool: ${name}` }
  } catch (error) {
    return connectorFailure(error)
  }
}

export async function executeConnectorTool(name, args = {}, context = {}) {
  if (!context.userId) return { ok: false, error: 'connector tools require userId' }
  if (!CONNECTOR_WRITE_TOOL_NAMES.includes(name) || !context.idempotencyKey) {
    return executeConnectorToolNow(name, args, context)
  }
  return runConnectorWriteOnce({
    userId: context.userId,
    toolName: name,
    args,
    idempotencyKey: context.idempotencyKey,
    execute: async () => {
      const result = await executeConnectorToolNow(name, args, context)
      if (!isUncertainWriteOutcome(result)) return result
      return {
        ...result,
        code: 'connector_write_outcome_unknown',
        originalCode: result.code,
        retryable: false,
        requiresUserVerification: true,
        hint: 'Verify the provider state before creating a new request or using a new idempotency key.',
      }
    },
  })
}

export function registerConnectorTools() {
  unregisterByOrigin('connector')
  for (const spec of CONNECTOR_TOOL_SPECS) {
    const name = spec.function.name
    registerDynamicTool({
      name,
      origin: 'connector',
      source: name.split('_')[0],
      metadata: { riskClass: CONNECTOR_WRITE_TOOL_NAMES.includes(name) ? 'external' : 'read' },
      spec,
      exec: (args, context) => executeConnectorTool(name, args, context),
    })
  }
}
