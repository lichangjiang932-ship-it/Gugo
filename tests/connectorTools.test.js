import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-connector-tools-tests', String(process.pid))

import {
  CONNECTOR_TOOL_NAMES,
  executeConnectorTool,
  registerConnectorTools,
} from '../server/services/connectorTools.js'
import { listAllSpecs, unregisterByOrigin } from '../server/services/toolRegistry.js'
import { upsertIntegration } from '../server/services/integrationsStore.js'
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
