export const CONNECTOR_WRITE_TOOL_NAMES = Object.freeze([
  'qq_mail_send', 'mail_send', 'notion_append_paragraphs',
  'github_create_issue', 'slack_send_message', 'google_drive_create_text_file',
  'jira_create_issue', 'jira_update_issue', 'linear_create_issue', 'linear_update_issue',
  'trello_create_card', 'trello_update_card', 'google_calendar_create_event', 'google_calendar_update_event',
  'gitlab_create_issue', 'gitlab_update_issue', 'asana_create_task', 'asana_update_task',
  'clickup_create_task', 'clickup_update_task', 'airtable_create_record', 'airtable_update_record',
  'monday_create_item', 'monday_update_item', 'hubspot_create_ticket', 'hubspot_update_ticket',
  'zendesk_create_ticket', 'zendesk_update_ticket', 'todoist_create_task', 'todoist_update_task',
  'dropbox_create_text_file', 'dropbox_update_text_file', 'onedrive_create_text_file', 'onedrive_update_text_file',
  'confluence_create_page', 'confluence_update_page', 'salesforce_create_record', 'salesforce_update_record',
  'discord_send_message', 'microsoft_teams_send_channel_message',
  'google_sheets_append_rows', 'google_sheets_update_range',
])

export const CONNECTOR_WRITE_TOOL_SET = new Set(CONNECTOR_WRITE_TOOL_NAMES)
