import { getEnabledIntegrationCredentials } from './integrationsStore.js'
import { fetchConnectorJson } from './connectorHttp.js'

function connectorError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode })
}

function clean(value, max = 1000) {
  return String(value ?? '').trim().slice(0, max)
}

function required(value, label, max = 1000) {
  const normalized = clean(value, max)
  if (!normalized) throw connectorError(`${label} is required`)
  return normalized
}

function credentials(userId, provider) {
  const value = getEnabledIntegrationCredentials({ userId, provider })
  if (!value) throw connectorError(`${provider} is not connected or is disabled`, 409)
  return value
}

async function apiJson(url, init = {}, fetchImpl = fetch) {
  const { response, data } = await fetchConnectorJson(url, init, { fetchImpl })
  if (!response.ok) {
    const message = data?.error?.message || data?.errorMessages?.join?.('; ') || data?.message || `HTTP ${response.status}`
    throw connectorError(message, response.status)
  }
  return data
}

function jiraContext(userId) {
  const { config, secret } = credentials(userId, 'jira')
  const siteUrl = required(config.siteUrl, 'Jira site URL', 500).replace(/\/+$/, '')
  if (!/^https:\/\//i.test(siteUrl)) throw connectorError('Jira site URL must use HTTPS')
  const email = required(config.email, 'Jira account email', 320)
  const token = required(secret.token, 'Jira API token', 2000)
  return {
    siteUrl,
    headers: { Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`, 'Content-Type': 'application/json', Accept: 'application/json' },
  }
}

export async function createJiraIssue({ userId, projectKey, issueType = 'Task', summary, description = '', fetchImpl = fetch } = {}) {
  const { siteUrl, headers } = jiraContext(userId)
  const data = await apiJson(`${siteUrl}/rest/api/3/issue`, {
    method: 'POST', headers, body: JSON.stringify({ fields: {
      project: { key: required(projectKey, 'projectKey', 80) },
      issuetype: { name: clean(issueType, 80) || 'Task' },
      summary: required(summary, 'summary', 255),
      ...(description ? { description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: clean(description, 20_000) }] }] } } : {}),
    } }),
  }, fetchImpl)
  return { issue: { id: data.id, key: data.key, url: data.self || `${siteUrl}/browse/${data.key}` } }
}

export async function updateJiraIssue({ userId, issueKey, summary, description, fetchImpl = fetch } = {}) {
  const { siteUrl, headers } = jiraContext(userId)
  const fields = {}
  if (summary != null) fields.summary = required(summary, 'summary', 255)
  if (description != null) fields.description = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: clean(description, 20_000) }] }] }
  if (!Object.keys(fields).length) throw connectorError('summary or description is required')
  await apiJson(`${siteUrl}/rest/api/3/issue/${encodeURIComponent(required(issueKey, 'issueKey', 100))}`, {
    method: 'PUT', headers, body: JSON.stringify({ fields }),
  }, fetchImpl)
  return { issue: { key: clean(issueKey, 100), updated: true, url: `${siteUrl}/browse/${encodeURIComponent(clean(issueKey, 100))}` } }
}

export async function searchJiraIssues({ userId, jql = 'order by updated DESC', limit = 20, fetchImpl = fetch } = {}) {
  const { siteUrl, headers } = jiraContext(userId)
  const url = new URL(`${siteUrl}/rest/api/3/search/jql`)
  url.searchParams.set('jql', clean(jql, 2000) || 'order by updated DESC')
  url.searchParams.set('maxResults', String(Math.max(1, Math.min(50, Number(limit) || 20))))
  url.searchParams.set('fields', 'summary,status,assignee,priority,updated')
  const data = await apiJson(url, { headers }, fetchImpl)
  return { issues: (data.issues || []).map((issue) => ({
    id: issue.id,
    key: issue.key,
    summary: issue.fields?.summary || '',
    status: issue.fields?.status?.name || '',
    assignee: issue.fields?.assignee?.displayName || null,
    priority: issue.fields?.priority?.name || null,
    updated: issue.fields?.updated || null,
    url: `${siteUrl}/browse/${encodeURIComponent(issue.key)}`,
  })), nextPageToken: data.nextPageToken || null }
}

function bearerContext(userId, provider) {
  const { config, secret } = credentials(userId, provider)
  return { config, token: required(secret.token, `${provider} token`, 2000) }
}

async function linearGraphql(userId, query, variables, fetchImpl) {
  const { token } = bearerContext(userId, 'linear')
  const data = await apiJson('https://api.linear.app/graphql', {
    method: 'POST', headers: { Authorization: token, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }),
  }, fetchImpl)
  if (data?.errors?.length) throw connectorError(data.errors.map((item) => item.message).join('; '))
  return data?.data
}

export async function createLinearIssue({ userId, teamId, title, description = '', priority, fetchImpl = fetch } = {}) {
  const input = { teamId: required(teamId, 'teamId', 100), title: required(title, 'title', 255) }
  if (description) input.description = clean(description, 20_000)
  if (priority != null) input.priority = Math.max(0, Math.min(4, Number(priority) || 0))
  const data = await linearGraphql(userId, 'mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier title url } } }', { input }, fetchImpl)
  if (!data?.issueCreate?.success) throw connectorError('Linear issue creation failed')
  return { issue: data.issueCreate.issue }
}

export async function updateLinearIssue({ userId, issueId, title, description, priority, fetchImpl = fetch } = {}) {
  const input = {}
  if (title != null) input.title = required(title, 'title', 255)
  if (description != null) input.description = clean(description, 20_000)
  if (priority != null) input.priority = Math.max(0, Math.min(4, Number(priority) || 0))
  if (!Object.keys(input).length) throw connectorError('title, description, or priority is required')
  const data = await linearGraphql(userId, 'mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id identifier title url } } }', { id: required(issueId, 'issueId', 100), input }, fetchImpl)
  if (!data?.issueUpdate?.success) throw connectorError('Linear issue update failed')
  return { issue: data.issueUpdate.issue }
}

export async function searchLinearIssues({ userId, query, limit = 20, fetchImpl = fetch } = {}) {
  const first = Math.max(1, Math.min(50, Number(limit) || 20))
  const term = required(query, 'query', 500)
  const data = await linearGraphql(userId, 'query($query: String!, $first: Int!) { issues(first: $first, filter: { title: { containsIgnoreCase: $query } }) { nodes { id identifier title priority url updatedAt state { name } assignee { name } } } }', { query: term, first }, fetchImpl)
  return { issues: data?.issues?.nodes || [] }
}

function trelloContext(userId) {
  const { config, secret } = credentials(userId, 'trello')
  return { key: required(config.apiKey, 'Trello API key', 200), token: required(secret.token, 'Trello token', 2000) }
}

function trelloUrl(path, context, params = {}) {
  const url = new URL(`https://api.trello.com/1/${path}`)
  url.searchParams.set('key', context.key)
  url.searchParams.set('token', context.token)
  for (const [key, value] of Object.entries(params)) if (value != null && value !== '') url.searchParams.set(key, String(value))
  return url
}

export async function createTrelloCard({ userId, listId, name, description = '', due, fetchImpl = fetch } = {}) {
  const context = trelloContext(userId)
  const data = await apiJson(trelloUrl('cards', context, { idList: required(listId, 'listId', 100), name: required(name, 'name', 255), desc: clean(description, 20_000), due }), { method: 'POST' }, fetchImpl)
  return { card: { id: data.id, name: data.name, url: data.url, due: data.due || null } }
}

export async function updateTrelloCard({ userId, cardId, name, description, due, closed, fetchImpl = fetch } = {}) {
  const context = trelloContext(userId)
  const params = { name: name == null ? undefined : required(name, 'name', 255), desc: description == null ? undefined : clean(description, 20_000), due, closed }
  if (!Object.values(params).some((value) => value != null)) throw connectorError('at least one card field is required')
  const data = await apiJson(trelloUrl(`cards/${encodeURIComponent(required(cardId, 'cardId', 100))}`, context, params), { method: 'PUT' }, fetchImpl)
  return { card: { id: data.id, name: data.name, url: data.url, closed: !!data.closed } }
}

export async function listTrelloCards({ userId, listId, limit = 50, fetchImpl = fetch } = {}) {
  const context = trelloContext(userId)
  const data = await apiJson(trelloUrl(`lists/${encodeURIComponent(required(listId, 'listId', 100))}/cards`, context, {
    limit: Math.max(1, Math.min(100, Number(limit) || 50)),
    fields: 'id,name,desc,due,closed,url,idList',
  }), {}, fetchImpl)
  return { cards: (Array.isArray(data) ? data : []).map((card) => ({
    id: card.id, name: card.name, description: card.desc || '', due: card.due || null,
    closed: !!card.closed, url: card.url, listId: card.idList,
  })) }
}

function calendarContext(userId) {
  return bearerContext(userId, 'google_calendar')
}

export async function createGoogleCalendarEvent({ userId, calendarId = 'primary', summary, description = '', start, end, timeZone, attendees = [], fetchImpl = fetch } = {}) {
  const { token } = calendarContext(userId)
  const body = {
    summary: required(summary, 'summary', 255), description: clean(description, 20_000),
    start: { dateTime: required(start, 'start', 100), ...(timeZone ? { timeZone: clean(timeZone, 100) } : {}) },
    end: { dateTime: required(end, 'end', 100), ...(timeZone ? { timeZone: clean(timeZone, 100) } : {}) },
    attendees: (Array.isArray(attendees) ? attendees : [attendees]).filter(Boolean).slice(0, 100).map((email) => ({ email: clean(email, 320) })),
  }
  const data = await apiJson(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(clean(calendarId, 300) || 'primary')}/events?sendUpdates=all`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, fetchImpl)
  return { event: { id: data.id, summary: data.summary, status: data.status, url: data.htmlLink, start: data.start, end: data.end } }
}

export async function updateGoogleCalendarEvent({ userId, calendarId = 'primary', eventId, summary, description, start, end, timeZone, fetchImpl = fetch } = {}) {
  const { token } = calendarContext(userId)
  const body = {}
  if (summary != null) body.summary = required(summary, 'summary', 255)
  if (description != null) body.description = clean(description, 20_000)
  if (start != null) body.start = { dateTime: required(start, 'start', 100), ...(timeZone ? { timeZone: clean(timeZone, 100) } : {}) }
  if (end != null) body.end = { dateTime: required(end, 'end', 100), ...(timeZone ? { timeZone: clean(timeZone, 100) } : {}) }
  if (!Object.keys(body).length) throw connectorError('at least one event field is required')
  const data = await apiJson(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(clean(calendarId, 300) || 'primary')}/events/${encodeURIComponent(required(eventId, 'eventId', 300))}?sendUpdates=all`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, fetchImpl)
  return { event: { id: data.id, summary: data.summary, status: data.status, url: data.htmlLink, start: data.start, end: data.end } }
}

export async function listGoogleCalendarEvents({ userId, calendarId = 'primary', timeMin, timeMax, query, limit = 25, fetchImpl = fetch } = {}) {
  const { token } = calendarContext(userId)
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(clean(calendarId, 300) || 'primary')}/events`)
  url.searchParams.set('singleEvents', 'true')
  url.searchParams.set('orderBy', 'startTime')
  url.searchParams.set('maxResults', String(Math.max(1, Math.min(100, Number(limit) || 25))))
  if (timeMin) url.searchParams.set('timeMin', required(timeMin, 'timeMin', 100))
  if (timeMax) url.searchParams.set('timeMax', required(timeMax, 'timeMax', 100))
  if (query) url.searchParams.set('q', clean(query, 500))
  const data = await apiJson(url, { headers: { Authorization: `Bearer ${token}` } }, fetchImpl)
  return { events: (data.items || []).map((event) => ({
    id: event.id, summary: event.summary || '', description: event.description || '', status: event.status,
    start: event.start, end: event.end, attendees: (event.attendees || []).slice(0, 50), url: event.htmlLink,
  })), nextPageToken: data.nextPageToken || null }
}
