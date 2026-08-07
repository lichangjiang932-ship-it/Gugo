import { getEnabledIntegrationCredentials } from './integrationsStore.js'
import { fetchConnectorJson } from './connectorHttp.js'

function connectorError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode })
}

function required(value, label, max = 500) {
  const normalized = String(value ?? '').trim().slice(0, max)
  if (!normalized) throw connectorError(`${label} is required`)
  return normalized
}

function credentials(userId, provider) {
  const value = getEnabledIntegrationCredentials({ userId, provider })
  if (!value) throw connectorError(`${provider} is not connected or is disabled`, 409)
  return value
}

async function apiJson(url, init, fetchImpl) {
  const { response, data } = await fetchConnectorJson(url, init, { fetchImpl })
  if (!response.ok) throw connectorError(data?.error?.message || data?.message || `HTTP ${response.status}`, response.status)
  return data
}

function discordToken(userId) {
  return required(credentials(userId, 'discord').secret?.botToken, 'Discord bot token', 4000)
}

function graphToken(userId) {
  return required(credentials(userId, 'onedrive').secret?.token, 'Microsoft Graph access token', 8000)
}

function googleToken(userId) {
  return required(credentials(userId, 'google_drive').secret?.token, 'Google OAuth access token', 8000)
}

function bearer(token) {
  return { Authorization: `Bearer ${token}` }
}

export async function listDiscordChannels({ userId, guildId, fetchImpl = fetch }) {
  const token = discordToken(userId)
  const guild = encodeURIComponent(required(guildId, 'guildId', 100))
  const data = await apiJson(`https://discord.com/api/v10/guilds/${guild}/channels`, { headers: { Authorization: `Bot ${token}` } }, fetchImpl)
  return { channels: (Array.isArray(data) ? data : []).slice(0, 250).map((channel) => ({ id: channel.id, name: channel.name, type: channel.type, parentId: channel.parent_id || null })) }
}

export async function readDiscordMessages({ userId, channelId, limit = 25, fetchImpl = fetch }) {
  const token = discordToken(userId)
  const channel = encodeURIComponent(required(channelId, 'channelId', 100))
  const size = Math.max(1, Math.min(Number(limit) || 25, 100))
  const data = await apiJson(`https://discord.com/api/v10/channels/${channel}/messages?limit=${size}`, { headers: { Authorization: `Bot ${token}` } }, fetchImpl)
  return { messages: (Array.isArray(data) ? data : []).map((message) => ({ id: message.id, content: String(message.content || '').slice(0, 20_000), author: message.author?.global_name || message.author?.username || '', timestamp: message.timestamp || '' })) }
}

export async function sendDiscordMessage({ userId, channelId, content, fetchImpl = fetch }) {
  const token = discordToken(userId)
  const body = { content: required(content, 'content', 2000) }
  const data = await apiJson(`https://discord.com/api/v10/channels/${encodeURIComponent(required(channelId, 'channelId', 100))}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, fetchImpl)
  return { message: { id: data.id, channelId: data.channel_id, content: data.content } }
}

export async function listTeamsChannels({ userId, teamId, fetchImpl = fetch }) {
  const token = graphToken(userId)
  const team = encodeURIComponent(required(teamId, 'teamId', 160))
  const data = await apiJson(`https://graph.microsoft.com/v1.0/teams/${team}/channels`, { headers: bearer(token) }, fetchImpl)
  return { channels: (data.value || []).slice(0, 200).map((channel) => ({ id: channel.id, displayName: channel.displayName, description: channel.description || '', membershipType: channel.membershipType || '' })) }
}

export async function readTeamsChannelMessages({ userId, teamId, channelId, limit = 25, fetchImpl = fetch }) {
  const token = graphToken(userId)
  const team = encodeURIComponent(required(teamId, 'teamId', 160))
  const channel = encodeURIComponent(required(channelId, 'channelId', 160))
  const size = Math.max(1, Math.min(Number(limit) || 25, 50))
  const data = await apiJson(`https://graph.microsoft.com/v1.0/teams/${team}/channels/${channel}/messages?$top=${size}`, { headers: bearer(token) }, fetchImpl)
  return { messages: (data.value || []).map((message) => ({ id: message.id, createdDateTime: message.createdDateTime || '', from: message.from?.user?.displayName || '', content: String(message.body?.content || '').slice(0, 20_000), webUrl: message.webUrl || '' })) }
}

export async function sendTeamsChannelMessage({ userId, teamId, channelId, content, fetchImpl = fetch }) {
  const token = graphToken(userId)
  const team = encodeURIComponent(required(teamId, 'teamId', 160))
  const channel = encodeURIComponent(required(channelId, 'channelId', 160))
  const data = await apiJson(`https://graph.microsoft.com/v1.0/teams/${team}/channels/${channel}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: { contentType: 'text', content: required(content, 'content', 20_000) } }),
  }, fetchImpl)
  return { message: { id: data.id, createdDateTime: data.createdDateTime, webUrl: data.webUrl } }
}

export async function readGoogleSheetRange({ userId, spreadsheetId, range = 'Sheet1!A1:Z100', fetchImpl = fetch }) {
  const token = googleToken(userId)
  const sheet = encodeURIComponent(required(spreadsheetId, 'spreadsheetId', 300))
  const targetRange = encodeURIComponent(required(range, 'range', 500))
  const data = await apiJson(`https://sheets.googleapis.com/v4/spreadsheets/${sheet}/values/${targetRange}`, { headers: bearer(token) }, fetchImpl)
  return { range: data.range || range, majorDimension: data.majorDimension || 'ROWS', values: Array.isArray(data.values) ? data.values.slice(0, 1000) : [] }
}

export async function updateGoogleSheetRange({ userId, spreadsheetId, range, values, fetchImpl = fetch }) {
  const token = googleToken(userId)
  const rows = normalizeRows(values)
  const sheet = encodeURIComponent(required(spreadsheetId, 'spreadsheetId', 300))
  const targetRange = encodeURIComponent(required(range, 'range', 500))
  const data = await apiJson(`https://sheets.googleapis.com/v4/spreadsheets/${sheet}/values/${targetRange}?valueInputOption=USER_ENTERED`, {
    method: 'PUT', headers: { ...bearer(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ majorDimension: 'ROWS', values: rows }),
  }, fetchImpl)
  return { updatedRange: data.updatedRange || range, updatedRows: data.updatedRows || rows.length, updatedCells: data.updatedCells || 0 }
}

function normalizeRows(values) {
  if (!Array.isArray(values) || values.length === 0 || values.some((row) => !Array.isArray(row))) throw connectorError('values must be a non-empty array of rows')
  return values.slice(0, 1000).map((row) => row.slice(0, 100).map((cell) => String(cell ?? '').slice(0, 20_000)))
}

export async function appendGoogleSheetRows({ userId, spreadsheetId, range = 'Sheet1!A1', values, fetchImpl = fetch }) {
  const token = googleToken(userId)
  const rows = normalizeRows(values)
  const sheet = encodeURIComponent(required(spreadsheetId, 'spreadsheetId', 300))
  const targetRange = encodeURIComponent(required(range, 'range', 500))
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheet}/values/${targetRange}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`
  const data = await apiJson(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ majorDimension: 'ROWS', values: rows }),
  }, fetchImpl)
  return { updates: data.updates || {}, spreadsheetId: data.spreadsheetId || spreadsheetId }
}
