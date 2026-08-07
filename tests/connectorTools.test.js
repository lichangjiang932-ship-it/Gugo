import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-connector-tools-tests', String(process.pid))

import {
  CONNECTOR_TOOL_NAMES,
  CONNECTOR_WRITE_TOOL_NAMES,
  executeConnectorTool,
  registerConnectorTools,
} from '../server/services/connectorTools.js'
import { listAllSpecs, unregisterByOrigin } from '../server/services/toolRegistry.js'
import { listProviderRegistry, upsertIntegration } from '../server/services/integrationsStore.js'
import { issueTestSession } from './helpers/testAuth.js'

test.afterEach(() => unregisterByOrigin('connector'))

test('connector tool catalog exposes native read operations', () => {
  registerConnectorTools()
  const names = new Set(listAllSpecs().filter((entry) => entry.origin === 'connector').map((entry) => entry.name))
  assert.ok(names.has('notion_search'))
  assert.ok(names.has('notion_fetch_page'))
  assert.ok(names.has('github_search_repositories'))
  assert.ok(names.has('github_get_file'))
  assert.ok(names.has('slack_list_channels'))
  assert.ok(names.has('slack_read_channel'))
  assert.ok(names.has('google_drive_search'))
  assert.ok(names.has('google_drive_get_file'))
  assert.ok(names.has('qq_mail_list_recent'))
  assert.ok(names.has('qq_mail_read'))
  assert.ok(names.has('qq_mail_send'))
  assert.ok(names.has('connected_app_list'))
  assert.ok(names.has('connected_app_open'))
})

test('every provider capability tool is backed by a registered connector tool', () => {
  const registered = new Set(CONNECTOR_TOOL_NAMES)
  const nativeProviders = listProviderRegistry().filter((provider) => provider.capabilityLevel === 'native_api')
  const missing = nativeProviders.flatMap((provider) => provider.providerSpecificTools
    .filter((name) => !registered.has(name))
    .map((name) => `${provider.provider}:${name}`))
  assert.deepEqual(missing, [])
  assert.ok(nativeProviders.find((provider) => provider.provider === 'jira').providerSpecificTools.includes('jira_search_issues'))
  assert.ok(nativeProviders.find((provider) => provider.provider === 'salesforce').providerSpecificTools.includes('salesforce_query_records'))
  assert.ok(nativeProviders.find((provider) => provider.provider === 'onedrive').providerSpecificTools.includes('onedrive_list_files'))
  assert.equal(CONNECTOR_WRITE_TOOL_NAMES.length, 42)
})

test('connector writes reuse completed results for the same user and idempotency key', async () => {
  const { userId } = issueTestSession({ email: 'connector-idempotency-replay@example.com' })
  upsertIntegration({ userId, provider: 'github', name: 'GitHub', enabled: true, config: {}, secret: { token: 'gh-replay' } })
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return new Response(JSON.stringify({ number: 9, title: 'Once', state: 'open', html_url: 'https://github.com/o/r/issues/9' }), { status: 201 })
  }
  const context = { userId, fetchImpl, idempotencyKey: 'job:replay:tool:1' }
  const first = await executeConnectorTool('github_create_issue', { owner: 'o', repo: 'r', title: 'Once' }, context)
  const replay = await executeConnectorTool('github_create_issue', { title: 'Once', repo: 'r', owner: 'o' }, context)
  assert.equal(first.issue.number, 9)
  assert.equal(replay.issue.number, 9)
  assert.equal(replay.idempotencyReplay, true)
  assert.equal(calls, 1)
})

test('connector idempotency rejects argument conflicts and isolates users', async () => {
  const firstUser = issueTestSession({ email: 'connector-idempotency-a@example.com' }).userId
  const secondUser = issueTestSession({ email: 'connector-idempotency-b@example.com' }).userId
  for (const userId of [firstUser, secondUser]) {
    upsertIntegration({ userId, provider: 'github', name: 'GitHub', enabled: true, config: {}, secret: { token: `gh-${userId}` } })
  }
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return new Response(JSON.stringify({ number: calls, title: 'Issue', state: 'open', html_url: 'https://github.com/o/r/issues/1' }), { status: 201 })
  }
  const key = 'job:isolated:tool:1'
  await executeConnectorTool('github_create_issue', { owner: 'o', repo: 'r', title: 'A' }, { userId: firstUser, fetchImpl, idempotencyKey: key })
  const conflict = await executeConnectorTool('github_create_issue', { owner: 'o', repo: 'r', title: 'Changed' }, { userId: firstUser, fetchImpl, idempotencyKey: key })
  const otherUser = await executeConnectorTool('github_create_issue', { owner: 'o', repo: 'r', title: 'A' }, { userId: secondUser, fetchImpl, idempotencyKey: key })
  assert.equal(conflict.code, 'connector_idempotency_conflict')
  assert.equal(otherUser.issue.number, 2)
  assert.equal(calls, 2)
})

test('concurrent connector writes never execute the same idempotency key twice', async () => {
  const { userId } = issueTestSession({ email: 'connector-idempotency-concurrent@example.com' })
  upsertIntegration({ userId, provider: 'github', name: 'GitHub', enabled: true, config: {}, secret: { token: 'gh-concurrent' } })
  let release
  let markStarted
  const gate = new Promise((resolve) => { release = resolve })
  const started = new Promise((resolve) => { markStarted = resolve })
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    markStarted()
    await gate
    return new Response(JSON.stringify({ number: 1, title: 'Once', state: 'open', html_url: 'https://github.com/o/r/issues/1' }), { status: 201 })
  }
  const context = { userId, fetchImpl, idempotencyKey: 'job:concurrent:tool:1' }
  const firstPromise = executeConnectorTool('github_create_issue', { owner: 'o', repo: 'r', title: 'Once' }, context)
  await started
  const concurrent = await executeConnectorTool('github_create_issue', { owner: 'o', repo: 'r', title: 'Once' }, context)
  assert.equal(concurrent.code, 'connector_write_in_progress')
  assert.equal(concurrent.requiresUserVerification, true)
  release()
  const first = await firstPromise
  assert.equal(first.issue.number, 1)
  assert.equal(calls, 1)
})

test('failed connector writes are cached for the same key and retry only with a new key', async () => {
  const { userId } = issueTestSession({ email: 'connector-idempotency-failure@example.com' })
  upsertIntegration({ userId, provider: 'github', name: 'GitHub', enabled: true, config: {}, secret: { token: 'gh-failure' } })
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return new Response(JSON.stringify({ message: 'temporary failure' }), { status: 503 })
  }
  const args = { owner: 'o', repo: 'r', title: 'Fail once' }
  const first = await executeConnectorTool('github_create_issue', args, { userId, fetchImpl, idempotencyKey: 'job:failure:tool:1' })
  const replay = await executeConnectorTool('github_create_issue', args, { userId, fetchImpl, idempotencyKey: 'job:failure:tool:1' })
  await executeConnectorTool('github_create_issue', args, { userId, fetchImpl, idempotencyKey: 'job:failure:tool:2' })
  assert.equal(first.ok, false)
  assert.equal(first.code, 'connector_write_outcome_unknown')
  assert.equal(first.requiresUserVerification, true)
  assert.equal(first.retryable, false)
  assert.equal(replay.idempotencyReplay, true)
  assert.equal(calls, 2)
})

test('connector errors preserve response limits and protect uncertain write outcomes', async () => {
  const { userId } = issueTestSession({ email: 'connector-structured-errors@example.com' })
  upsertIntegration({
    userId,
    provider: 'jira',
    name: 'Jira',
    enabled: true,
    config: { siteUrl: 'https://team.atlassian.net', email: 'dev@example.com' },
    secret: { token: 'jira-token' },
  })
  let calls = 0
  const oversizedFetch = async () => {
    calls += 1
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => name.toLowerCase() === 'content-length' ? String(3 * 1024 * 1024) : null },
      text: async () => '{}',
    }
  }
  const read = await executeConnectorTool('jira_search_issues', { jql: 'project = GUGO' }, { userId, fetchImpl: oversizedFetch })
  const context = { userId, fetchImpl: oversizedFetch, idempotencyKey: 'job:oversized-write:tool:1' }
  const args = { projectKey: 'GUGO', summary: 'Maybe' }
  const write = await executeConnectorTool('jira_create_issue', args, context)
  const replay = await executeConnectorTool('jira_create_issue', args, context)
  assert.equal(read.code, 'connector_response_too_large', JSON.stringify(read))
  assert.equal(read.statusCode, 502)
  assert.equal(write.code, 'connector_write_outcome_unknown')
  assert.equal(write.originalCode, 'connector_response_too_large')
  assert.equal(write.requiresUserVerification, true)
  assert.equal(write.retryable, false)
  assert.equal(replay.idempotencyReplay, true)
  assert.equal(calls, 2)
})

test('connector tool executor returns enabled apps and rejects missing identity', async () => {
  const { userId } = issueTestSession()
  upsertIntegration({ userId, provider: 'web_gmail', name: 'Gmail', enabled: true, config: {}, secret: {} })

  const listed = await executeConnectorTool('connected_app_list', {}, { userId })
  assert.equal(listed.ok, true)
  assert.deepEqual(listed.apps.map((app) => app.provider), ['web_gmail'])

  const denied = await executeConnectorTool('connected_app_list', {})
  assert.equal(denied.ok, false)
  assert.match(denied.error, /userId/)
  assert.ok(CONNECTOR_TOOL_NAMES.includes('github_get_file'))
})

test('Slack tools use the connected bot token and return bounded channel data', async () => {
  const { userId } = issueTestSession({ email: 'connector-slack@example.com' })
  upsertIntegration({
    userId,
    provider: 'slack',
    name: 'Slack',
    enabled: true,
    config: { workspace: 'Atelier' },
    secret: { botToken: 'xoxb-read-token' },
  })
  const requests = []
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), init })
    if (String(url).includes('conversations.list')) {
      return new Response(JSON.stringify({
        ok: true,
        channels: [{ id: 'C12345678', name: 'general', is_private: false, topic: { value: 'News' } }],
      }), { status: 200 })
    }
    return new Response(JSON.stringify({
      ok: true,
      messages: [{ ts: '1.2', user: 'U123', text: 'hello', reply_count: 2 }],
      has_more: false,
    }), { status: 200 })
  }

  const channels = await executeConnectorTool('slack_list_channels', { limit: 20 }, { userId, fetchImpl })
  const messages = await executeConnectorTool(
    'slack_read_channel',
    { channelId: 'C12345678', limit: 10 },
    { userId, fetchImpl },
  )
  assert.equal(channels.channels[0].name, 'general')
  assert.equal(messages.messages[0].text, 'hello')
  assert.equal(requests[0].init.headers.Authorization, 'Bearer xoxb-read-token')
  assert.equal(new URL(requests[1].url).searchParams.get('channel'), 'C12345678')
})

test('Google Drive tools search and export text with a read-only token', async () => {
  const { userId } = issueTestSession({ email: 'connector-drive@example.com' })
  upsertIntegration({
    userId,
    provider: 'google_drive',
    name: 'Google Drive',
    enabled: true,
    config: { account: 'reader@example.com' },
    secret: { token: 'drive-read-token' },
  })
  const requests = []
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), init })
    const value = String(url)
    if (value.includes('/files?')) {
      return new Response(JSON.stringify({
        files: [{ id: 'file_12345', name: 'Plan', mimeType: 'application/vnd.google-apps.document' }],
      }), { status: 200 })
    }
    if (value.includes('/export?')) return new Response('launch plan', { status: 200 })
    return new Response(JSON.stringify({
      id: 'file_12345',
      name: 'Plan',
      mimeType: 'application/vnd.google-apps.document',
      webViewLink: 'https://docs.google.com/document/d/file_12345',
    }), { status: 200 })
  }

  const searched = await executeConnectorTool('google_drive_search', { query: "Q3's plan" }, { userId, fetchImpl })
  const fetched = await executeConnectorTool('google_drive_get_file', { fileId: 'file_12345' }, { userId, fetchImpl })
  assert.equal(searched.files[0].name, 'Plan')
  assert.equal(fetched.content, 'launch plan')
  assert.equal(fetched.binary, undefined)
  assert.equal(requests.every((request) => request.init.headers.Authorization === 'Bearer drive-read-token'), true)
  assert.match(new URL(requests[0].url).searchParams.get('q'), /name contains/)
  assert.match(requests.at(-1).url, /mimeType=text%2Fplain/)
})

test('native connector write tools call provider APIs and remain user scoped', async () => {
  const { userId } = issueTestSession({ email: 'connector-write@example.com' })
  upsertIntegration({ userId, provider: 'slack', name: 'Slack', enabled: true, config: {}, secret: { botToken: 'xoxb-write' } })
  upsertIntegration({ userId, provider: 'github', name: 'GitHub', enabled: true, config: {}, secret: { token: 'gh-write' } })
  const requests = []
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), init })
    if (String(url).includes('slack.com')) return new Response(JSON.stringify({ ok: true, channel: 'C12345678', ts: '1.2', message: { text: 'sent' } }), { status: 200 })
    return new Response(JSON.stringify({ number: 7, title: 'Bug', state: 'open', html_url: 'https://github.com/o/r/issues/7' }), { status: 201 })
  }
  const slack = await executeConnectorTool('slack_send_message', { channelId: 'C12345678', text: 'sent' }, { userId, fetchImpl })
  const issue = await executeConnectorTool('github_create_issue', { owner: 'o', repo: 'r', title: 'Bug' }, { userId, fetchImpl })
  assert.equal(slack.message.text, 'sent')
  assert.equal(issue.issue.number, 7)
  assert.equal(requests[0].init.method, 'POST')
  assert.equal(requests[1].init.method, 'POST')
})

test('project connector write tools call Jira, Linear, Trello, and Google Calendar APIs', async () => {
  const { userId } = issueTestSession({ email: 'connector-projects@example.com' })
  upsertIntegration({ userId, provider: 'jira', name: 'Jira', enabled: true, config: { siteUrl: 'https://team.atlassian.net', email: 'dev@example.com' }, secret: { token: 'jira-token' } })
  upsertIntegration({ userId, provider: 'linear', name: 'Linear', enabled: true, config: {}, secret: { token: 'linear-token' } })
  upsertIntegration({ userId, provider: 'trello', name: 'Trello', enabled: true, config: { apiKey: 'trello-key' }, secret: { token: 'trello-token' } })
  upsertIntegration({ userId, provider: 'google_calendar', name: 'Calendar', enabled: true, config: {}, secret: { token: 'calendar-token' } })
  const requests = []
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), init })
    const value = String(url)
    if (value.includes('atlassian.net')) return new Response(JSON.stringify({ id: '10001', key: 'GUGO-1', self: `${value}/10001` }), { status: 201 })
    if (value.includes('linear.app')) return new Response(JSON.stringify({ data: { issueCreate: { success: true, issue: { id: 'lin-1', identifier: 'ENG-1', title: 'Ship', url: 'https://linear.app/i/lin-1' } } } }), { status: 200 })
    if (value.includes('trello.com')) return new Response(JSON.stringify({ id: 'card-1', name: 'Ship', url: 'https://trello.com/c/card-1' }), { status: 200 })
    return new Response(JSON.stringify({ id: 'event-1', summary: 'Launch', status: 'confirmed', htmlLink: 'https://calendar.google.com/event?eid=1', start: {}, end: {} }), { status: 200 })
  }

  const jira = await executeConnectorTool('jira_create_issue', { projectKey: 'GUGO', summary: 'Ship' }, { userId, fetchImpl })
  const linear = await executeConnectorTool('linear_create_issue', { teamId: 'team-1', title: 'Ship' }, { userId, fetchImpl })
  const trello = await executeConnectorTool('trello_create_card', { listId: 'list-1', name: 'Ship' }, { userId, fetchImpl })
  const calendar = await executeConnectorTool('google_calendar_create_event', { summary: 'Launch', start: '2026-08-08T09:00:00+08:00', end: '2026-08-08T10:00:00+08:00' }, { userId, fetchImpl })

  assert.equal(jira.issue.key, 'GUGO-1')
  assert.equal(linear.issue.identifier, 'ENG-1')
  assert.equal(trello.card.id, 'card-1')
  assert.equal(calendar.event.id, 'event-1')
  assert.deepEqual(requests.map((request) => request.init.method), ['POST', 'POST', 'POST', 'POST'])
  assert.match(requests[0].init.headers.Authorization, /^Basic /)
  assert.equal(requests[1].init.headers.Authorization, 'linear-token')
  assert.match(requests[2].url, /key=trello-key/)
  assert.equal(requests[3].init.headers.Authorization, 'Bearer calendar-token')
})

test('work connector write tools call GitLab, Asana, ClickUp, Airtable, and monday.com APIs', async () => {
  const { userId } = issueTestSession({ email: 'connector-work@example.com' })
  for (const provider of ['gitlab', 'asana', 'clickup', 'airtable', 'monday']) {
    upsertIntegration({ userId, provider, name: provider, enabled: true, config: provider === 'gitlab' ? { baseUrl: 'https://gitlab.example.com/api/v4' } : {}, secret: { token: `${provider}-token` } })
  }
  const requests = []
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), init })
    const value = String(url)
    if (value.includes('gitlab')) return new Response(JSON.stringify({ id: 1, iid: 2, title: 'Ship', state: 'opened', web_url: 'https://gitlab/i/2' }), { status: 201 })
    if (value.includes('asana')) return new Response(JSON.stringify({ data: { gid: 'a1', name: 'Ship', permalink_url: 'https://asana/t/a1' } }), { status: 201 })
    if (value.includes('clickup')) return new Response(JSON.stringify({ id: 'c1', name: 'Ship', status: { status: 'open' }, url: 'https://clickup/t/c1' }), { status: 200 })
    if (value.includes('airtable')) return new Response(JSON.stringify({ id: 'rec1', fields: { Name: 'Ship' }, createdTime: '2026-08-07' }), { status: 200 })
    return new Response(JSON.stringify({ data: { create_item: { id: 'm1', name: 'Ship', url: 'https://monday/i/m1' } } }), { status: 200 })
  }
  const gitlab = await executeConnectorTool('gitlab_create_issue', { projectId: 'group/project', title: 'Ship' }, { userId, fetchImpl })
  const asana = await executeConnectorTool('asana_create_task', { workspaceId: 'w1', name: 'Ship' }, { userId, fetchImpl })
  const clickup = await executeConnectorTool('clickup_create_task', { listId: 'l1', name: 'Ship' }, { userId, fetchImpl })
  const airtable = await executeConnectorTool('airtable_create_record', { baseId: 'app1', tableId: 'tbl1', fields: { Name: 'Ship' } }, { userId, fetchImpl })
  const monday = await executeConnectorTool('monday_create_item', { boardId: 'b1', itemName: 'Ship' }, { userId, fetchImpl })
  assert.deepEqual([gitlab.issue.iid, asana.task.id, clickup.task.id, airtable.record.id, monday.item.id], [2, 'a1', 'c1', 'rec1', 'm1'])
  assert.deepEqual(requests.map((request) => request.init.method), ['POST', 'POST', 'POST', 'POST', 'POST'])
  assert.equal(requests[0].init.headers['PRIVATE-TOKEN'], 'gitlab-token')
  assert.equal(requests[2].init.headers.Authorization, 'clickup-token')
  assert.equal(requests[4].init.headers.Authorization, 'monday-token')
})

test('project connector read tools search Jira and Linear and list Trello, Asana, and ClickUp work', async () => {
  const { userId } = issueTestSession({ email: 'connector-project-reads@example.com' })
  const integrations = [
    ['jira', { siteUrl: 'https://team.atlassian.net', email: 'dev@example.com' }, 'jira-token'],
    ['linear', {}, 'linear-token'],
    ['trello', { apiKey: 'trello-key' }, 'trello-token'],
    ['asana', {}, 'asana-token'],
    ['clickup', {}, 'clickup-token'],
  ]
  for (const [provider, config, token] of integrations) {
    upsertIntegration({ userId, provider, name: provider, enabled: true, config, secret: { token } })
  }
  const requests = []
  const fetchImpl = async (url, init = {}) => {
    const value = String(url)
    requests.push({ url: value, init })
    if (value.includes('atlassian.net')) return new Response(JSON.stringify({ issues: [{ id: '1', key: 'GUGO-1', fields: { summary: 'Ship', status: { name: 'Open' }, updated: 'now' } }] }), { status: 200 })
    if (value.includes('linear.app')) return new Response(JSON.stringify({ data: { issues: { nodes: [{ id: 'lin-1', identifier: 'ENG-1', title: 'Ship', state: { name: 'Open' } }] } } }), { status: 200 })
    if (value.includes('trello.com')) return new Response(JSON.stringify([{ id: 'card-1', name: 'Ship', idList: 'list-1', url: 'https://trello.com/c/card-1' }]), { status: 200 })
    if (value.includes('asana.com')) return new Response(JSON.stringify({ data: [{ gid: 'asana-1', name: 'Ship', completed: false, permalink_url: 'https://asana.com/t/asana-1' }] }), { status: 200 })
    return new Response(JSON.stringify({ tasks: [{ id: 'clickup-1', name: 'Ship', status: { status: 'open' }, url: 'https://clickup.com/t/clickup-1' }], last_page: true }), { status: 200 })
  }

  const results = [
    await executeConnectorTool('jira_search_issues', { jql: 'project = GUGO', limit: 10 }, { userId, fetchImpl }),
    await executeConnectorTool('linear_search_issues', { query: 'Ship' }, { userId, fetchImpl }),
    await executeConnectorTool('trello_list_cards', { listId: 'list-1' }, { userId, fetchImpl }),
    await executeConnectorTool('asana_list_project_tasks', { projectId: 'project-1' }, { userId, fetchImpl }),
    await executeConnectorTool('clickup_list_tasks', { listId: 'list-1' }, { userId, fetchImpl }),
  ]

  assert.deepEqual([results[0].issues[0].key, results[1].issues[0].identifier, results[2].cards[0].id, results[3].tasks[0].id, results[4].tasks[0].id], ['GUGO-1', 'ENG-1', 'card-1', 'asana-1', 'clickup-1'])
  assert.deepEqual(requests.map((request) => request.init.method || 'GET'), ['GET', 'POST', 'GET', 'GET', 'GET'])
  assert.match(requests[0].url, /search\/jql\?/)
  assert.equal(requests[1].init.headers.Authorization, 'linear-token')
  assert.match(requests[2].url, /lists\/list-1\/cards/)
  assert.equal(requests[3].init.headers.Authorization, 'Bearer asana-token')
  assert.equal(requests[4].init.headers.Authorization, 'clickup-token')
})

test('calendar, GitLab, Airtable, monday.com, and Todoist expose bounded read operations', async () => {
  const { userId } = issueTestSession({ email: 'connector-secondary-reads@example.com' })
  const integrations = [
    ['google_calendar', {}, 'calendar-token'],
    ['gitlab', { baseUrl: 'https://gitlab.example.com/api/v4' }, 'gitlab-token'],
    ['airtable', {}, 'airtable-token'],
    ['monday', {}, 'monday-token'],
    ['todoist', {}, 'todoist-token'],
  ]
  for (const [provider, config, token] of integrations) {
    upsertIntegration({ userId, provider, name: provider, enabled: true, config, secret: { token } })
  }
  const requests = []
  const fetchImpl = async (url, init = {}) => {
    const value = String(url)
    requests.push({ url: value, init })
    if (value.includes('googleapis.com/calendar')) return new Response(JSON.stringify({ items: [{ id: 'event-1', summary: 'Launch', start: { dateTime: '2026-08-08T09:00:00Z' }, end: { dateTime: '2026-08-08T10:00:00Z' } }] }), { status: 200 })
    if (value.includes('gitlab.example.com')) return new Response(JSON.stringify([{ id: 1, iid: 2, title: 'Ship', state: 'opened', web_url: 'https://gitlab/i/2' }]), { status: 200 })
    if (value.includes('airtable.com')) return new Response(JSON.stringify({ records: [{ id: 'rec1', fields: { Name: 'Ship' }, createdTime: 'now' }], offset: 'next' }), { status: 200 })
    if (value.includes('monday.com')) return new Response(JSON.stringify({ data: { boards: [{ id: 'board-1', name: 'Roadmap', items_page: { cursor: 'next', items: [{ id: 'item-1', name: 'Ship', column_values: [] }] } }] } }), { status: 200 })
    return new Response(JSON.stringify([{ id: 'todo-1', content: 'Ship', project_id: 'project-1', priority: 2, labels: [], url: 'https://todoist/t/todo-1' }]), { status: 200 })
  }

  const results = [
    await executeConnectorTool('google_calendar_list_events', { query: 'Launch', limit: 10 }, { userId, fetchImpl }),
    await executeConnectorTool('gitlab_list_issues', { projectId: 'group/project', search: 'Ship' }, { userId, fetchImpl }),
    await executeConnectorTool('airtable_list_records', { baseId: 'app1', tableId: 'tbl1', limit: 10 }, { userId, fetchImpl }),
    await executeConnectorTool('monday_list_items', { boardId: 'board-1' }, { userId, fetchImpl }),
    await executeConnectorTool('todoist_list_tasks', { projectId: 'project-1' }, { userId, fetchImpl }),
  ]

  assert.deepEqual([results[0].events[0].id, results[1].issues[0].iid, results[2].records[0].id, results[3].items[0].id, results[4].tasks[0].id], ['event-1', 2, 'rec1', 'item-1', 'todo-1'])
  assert.deepEqual(requests.map((request) => request.init.method || 'GET'), ['GET', 'GET', 'GET', 'POST', 'GET'])
  assert.equal(requests[0].init.headers.Authorization, 'Bearer calendar-token')
  assert.equal(requests[1].init.headers['PRIVATE-TOKEN'], 'gitlab-token')
  assert.match(requests[2].url, /pageSize=10/)
  assert.equal(requests[3].init.headers.Authorization, 'monday-token')
  assert.equal(requests[4].init.headers.Authorization, 'Bearer todoist-token')
})

test('business connector write tools call HubSpot, Zendesk, Todoist, Dropbox, OneDrive, Confluence, and Salesforce APIs', async () => {
  const { userId } = issueTestSession({ email: 'connector-business@example.com' })
  const configs = {
    zendesk: { subdomain: 'gugo', email: 'agent@example.com' },
    confluence: { siteUrl: 'https://gugo.atlassian.net', email: 'agent@example.com' },
    salesforce: { instanceUrl: 'https://gugo.my.salesforce.com' },
  }
  for (const provider of ['hubspot', 'zendesk', 'todoist', 'dropbox', 'onedrive', 'confluence', 'salesforce']) {
    upsertIntegration({ userId, provider, name: provider, enabled: true, config: configs[provider] || {}, secret: { token: `${provider}-token` } })
  }
  const requests = []
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), init })
    const value = String(url)
    if (value.includes('hubapi')) return new Response(JSON.stringify({ id: 'h1', properties: { subject: 'Ship' }, createdAt: 'now' }), { status: 201 })
    if (value.includes('zendesk')) return new Response(JSON.stringify({ ticket: { id: 2, subject: 'Ship', status: 'new', url: value } }), { status: 201 })
    if (value.includes('todoist')) return new Response(JSON.stringify({ id: 't1', content: 'Ship', url: 'https://todoist/t/t1' }), { status: 200 })
    if (value.includes('dropbox')) return new Response(JSON.stringify({ id: 'd1', name: 'ship.txt', path_display: '/ship.txt', rev: '1' }), { status: 200 })
    if (value.includes('graph.microsoft')) return new Response(JSON.stringify({ id: 'o1', name: 'ship.txt', size: 4, webUrl: 'https://onedrive/ship.txt' }), { status: 201 })
    if (value.includes('atlassian')) return new Response(JSON.stringify({ id: 'p1', title: 'Ship', status: 'current', _links: { webui: '/spaces/G/pages/p1' } }), { status: 201 })
    return new Response(JSON.stringify({ id: 's1', success: true, errors: [] }), { status: 201 })
  }
  const values = [
    await executeConnectorTool('hubspot_create_ticket', { subject: 'Ship' }, { userId, fetchImpl }),
    await executeConnectorTool('zendesk_create_ticket', { subject: 'Ship', comment: 'Now' }, { userId, fetchImpl }),
    await executeConnectorTool('todoist_create_task', { content: 'Ship' }, { userId, fetchImpl }),
    await executeConnectorTool('dropbox_create_text_file', { path: '/ship.txt', content: 'ship' }, { userId, fetchImpl }),
    await executeConnectorTool('onedrive_create_text_file', { path: '/ship.txt', content: 'ship' }, { userId, fetchImpl }),
    await executeConnectorTool('confluence_create_page', { spaceId: 'S', title: 'Ship', body: '<p>Now</p>' }, { userId, fetchImpl }),
    await executeConnectorTool('salesforce_create_record', { objectType: 'Task', fields: { Subject: 'Ship' } }, { userId, fetchImpl }),
  ]
  assert.deepEqual([values[0].ticket.id, values[1].ticket.id, values[2].task.id, values[3].file.id, values[4].file.id, values[5].page.id, values[6].record.id], ['h1', 2, 't1', 'd1', 'o1', 'p1', 's1'])
  assert.equal(requests.every((request) => ['POST', 'PUT'].includes(request.init.method)), true)
  assert.match(requests[1].init.headers.Authorization, /^Basic /)
  assert.equal(requests[3].init.headers['Dropbox-API-Arg'].includes('/ship.txt'), true)
  assert.equal(requests[6].init.headers.Authorization, 'Bearer salesforce-token')
})

test('business connectors expose bounded ticket, file, page, and CRM reads', async () => {
  const { userId } = issueTestSession({ email: 'connector-business-reads@example.com' })
  const configs = {
    zendesk: { subdomain: 'gugo', email: 'agent@example.com' },
    confluence: { siteUrl: 'https://gugo.atlassian.net', email: 'agent@example.com' },
    salesforce: { instanceUrl: 'https://gugo.my.salesforce.com' },
  }
  for (const provider of ['hubspot', 'zendesk', 'dropbox', 'onedrive', 'confluence', 'salesforce']) {
    upsertIntegration({ userId, provider, name: provider, enabled: true, config: configs[provider] || {}, secret: { token: `${provider}-token` } })
  }
  const requests = []
  const fetchImpl = async (url, init = {}) => {
    const value = String(url)
    requests.push({ url: value, init })
    if (value.includes('hubapi')) return new Response(JSON.stringify({ results: [{ id: 'h1', properties: { subject: 'Ship' } }], paging: { next: { after: '2' } } }), { status: 200 })
    if (value.includes('zendesk')) return new Response(JSON.stringify({ results: [{ id: 2, subject: 'Ship', status: 'open', url: value }], count: 1 }), { status: 200 })
    if (value.includes('dropboxapi')) return new Response(JSON.stringify({ entries: [{ '.tag': 'file', id: 'd1', name: 'ship.txt', path_display: '/ship.txt', size: 4 }], cursor: 'next', has_more: false }), { status: 200 })
    if (value.includes('graph.microsoft')) return new Response(JSON.stringify({ value: [{ id: 'o1', name: 'ship.txt', size: 4, webUrl: 'https://onedrive/ship.txt', file: { mimeType: 'text/plain' } }] }), { status: 200 })
    if (value.includes('atlassian')) return new Response(JSON.stringify({ results: [{ content: { id: 'p1', title: 'Ship', type: 'page' }, excerpt: 'Now', url: '/wiki/spaces/G/pages/p1' }], totalSize: 1 }), { status: 200 })
    return new Response(JSON.stringify({ records: [{ Id: 's1', Subject: 'Ship' }], totalSize: 1, done: true }), { status: 200 })
  }

  const results = [
    await executeConnectorTool('hubspot_list_tickets', { limit: 10 }, { userId, fetchImpl }),
    await executeConnectorTool('zendesk_search_tickets', { query: 'status:open' }, { userId, fetchImpl }),
    await executeConnectorTool('dropbox_list_files', { path: '' }, { userId, fetchImpl }),
    await executeConnectorTool('onedrive_list_files', { path: 'Docs' }, { userId, fetchImpl }),
    await executeConnectorTool('confluence_search_pages', { cql: 'type = page' }, { userId, fetchImpl }),
    await executeConnectorTool('salesforce_query_records', { soql: 'SELECT Id, Subject FROM Task', limit: 10 }, { userId, fetchImpl }),
  ]

  assert.deepEqual([results[0].tickets[0].id, results[1].tickets[0].id, results[2].entries[0].id, results[3].entries[0].id, results[4].pages[0].id, results[5].records[0].Id], ['h1', 2, 'd1', 'o1', 'p1', 's1'])
  assert.deepEqual(requests.map((request) => request.init.method || 'GET'), ['GET', 'GET', 'POST', 'GET', 'GET', 'GET'])
  assert.equal(requests[0].init.headers.Authorization, 'Bearer hubspot-token')
  assert.match(new URL(requests[1].url).searchParams.get('query'), /^type:ticket /)
  assert.equal(requests[2].init.headers.Authorization, 'Bearer dropbox-token')
  assert.match(requests[3].url, /root:\/Docs:\/children/)
  assert.match(requests[4].url, /wiki\/rest\/api\/search/)
  assert.match(new URL(requests[5].url).searchParams.get('q'), /LIMIT 10$/)
})

test('collaboration connector write tools call Discord, Teams, and Google Sheets APIs', async () => {
  const { userId } = issueTestSession({ email: 'connector-collaboration@example.com' })
  upsertIntegration({ userId, provider: 'discord', name: 'Discord', enabled: true, config: {}, secret: { botToken: 'discord-token' } })
  upsertIntegration({ userId, provider: 'onedrive', name: 'Microsoft Graph', enabled: true, config: {}, secret: { token: 'graph-token' } })
  upsertIntegration({ userId, provider: 'google_drive', name: 'Google', enabled: true, config: {}, secret: { token: 'google-token' } })
  const requests = []
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), init })
    if (String(url).includes('discord.com')) return new Response(JSON.stringify({ id: 'd1', channel_id: 'c1', content: 'hello' }), { status: 200 })
    if (String(url).includes('graph.microsoft.com')) return new Response(JSON.stringify({ id: 't1', webUrl: 'https://teams.example/message/t1' }), { status: 201 })
    return new Response(JSON.stringify({ spreadsheetId: 's1', updates: { updatedRows: 2 } }), { status: 200 })
  }

  const discord = await executeConnectorTool('discord_send_message', { channelId: 'c1', content: 'hello' }, { userId, fetchImpl })
  const teams = await executeConnectorTool('microsoft_teams_send_channel_message', { teamId: 'team1', channelId: 'channel1', content: 'status' }, { userId, fetchImpl })
  const sheets = await executeConnectorTool('google_sheets_append_rows', { spreadsheetId: 's1', range: 'Data!A1', values: [['a'], ['b']] }, { userId, fetchImpl })

  assert.equal(discord.message.id, 'd1')
  assert.equal(teams.message.id, 't1')
  assert.equal(sheets.updates.updatedRows, 2)
  assert.equal(requests[0].init.headers.Authorization, 'Bot discord-token')
  assert.equal(requests[1].init.headers.Authorization, 'Bearer graph-token')
  assert.equal(requests[2].init.headers.Authorization, 'Bearer google-token')
  assert.match(requests[2].url, /Data!A1:append/)
  assert.deepEqual(JSON.parse(requests[2].init.body).values, [['a'], ['b']])
})

test('collaboration connectors expose bounded Discord, Teams, and Google Sheets read-write operations', async () => {
  const { userId } = issueTestSession({ email: 'connector-collaboration-rw@example.com' })
  upsertIntegration({ userId, provider: 'discord', name: 'Discord', enabled: true, config: {}, secret: { botToken: 'discord-rw' } })
  upsertIntegration({ userId, provider: 'onedrive', name: 'Microsoft Graph', enabled: true, config: {}, secret: { token: 'graph-rw' } })
  upsertIntegration({ userId, provider: 'google_drive', name: 'Google', enabled: true, config: {}, secret: { token: 'google-rw' } })
  const requests = []
  const fetchImpl = async (url, init = {}) => {
    const value = String(url)
    requests.push({ url: value, init })
    if (value.includes('/guilds/')) return new Response(JSON.stringify([{ id: 'dc1', name: 'general', type: 0 }]), { status: 200 })
    if (value.includes('discord.com') && value.includes('/messages')) return new Response(JSON.stringify([{ id: 'dm1', content: 'hello', author: { username: 'bot' } }]), { status: 200 })
    if (value.includes('graph.microsoft.com') && value.includes('/messages')) return new Response(JSON.stringify({ value: [{ id: 'tm1', body: { content: 'status' }, from: { user: { displayName: 'Ada' } } }] }), { status: 200 })
    if (value.includes('graph.microsoft.com')) return new Response(JSON.stringify({ value: [{ id: 'tc1', displayName: 'General' }] }), { status: 200 })
    if ((init.method || 'GET') === 'PUT') return new Response(JSON.stringify({ updatedRange: 'Data!A1:B1', updatedRows: 1, updatedCells: 2 }), { status: 200 })
    return new Response(JSON.stringify({ range: 'Data!A1:B1', values: [['a', 'b']] }), { status: 200 })
  }

  const discordChannels = await executeConnectorTool('discord_list_channels', { guildId: 'g1' }, { userId, fetchImpl })
  const discordMessages = await executeConnectorTool('discord_read_messages', { channelId: 'dc1', limit: 999 }, { userId, fetchImpl })
  const teamsChannels = await executeConnectorTool('microsoft_teams_list_channels', { teamId: 'team1' }, { userId, fetchImpl })
  const teamsMessages = await executeConnectorTool('microsoft_teams_read_channel_messages', { teamId: 'team1', channelId: 'tc1', limit: 999 }, { userId, fetchImpl })
  const sheet = await executeConnectorTool('google_sheets_read_range', { spreadsheetId: 's1', range: 'Data!A1:B1' }, { userId, fetchImpl })
  const updated = await executeConnectorTool('google_sheets_update_range', { spreadsheetId: 's1', range: 'Data!A1:B1', values: [['x', 'y']] }, { userId, fetchImpl })

  assert.equal(discordChannels.channels[0].name, 'general')
  assert.equal(discordMessages.messages[0].author, 'bot')
  assert.equal(teamsChannels.channels[0].displayName, 'General')
  assert.equal(teamsMessages.messages[0].from, 'Ada')
  assert.deepEqual(sheet.values, [['a', 'b']])
  assert.equal(updated.updatedCells, 2)
  assert.match(requests[1].url, /limit=100/)
  assert.match(requests[3].url, /\$top=50/)
  assert.equal(requests[5].init.method, 'PUT')
  assert.equal(requests[5].init.headers.Authorization, 'Bearer google-rw')
})
