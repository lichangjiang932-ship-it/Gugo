import { getEnabledIntegrationCredentials } from './integrationsStore.js'
import { fetchConnectorJson } from './connectorHttp.js'

function connectorError(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }) }
function clean(value, max = 1000) { return String(value ?? '').trim().slice(0, max) }
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
  if (!response.ok) throw connectorError(data?.errors?.[0]?.message || data?.error?.message || data?.message || data?.description || `HTTP ${response.status}`, response.status)
  return data
}
function bearer(userId, provider) {
  const { config, secret } = credentials(userId, provider)
  return { config, token: required(secret.token, `${provider} token`, 4000), headers: { Authorization: `Bearer ${required(secret.token, `${provider} token`, 4000)}`, 'Content-Type': 'application/json' } }
}

export async function createHubspotTicket({ userId, subject, content = '', pipeline = '0', stage = '1', priority, fetchImpl = fetch } = {}) {
  const { headers } = bearer(userId, 'hubspot')
  const properties = { subject: required(subject, 'subject', 255), content: clean(content, 20_000), hs_pipeline: clean(pipeline, 100), hs_pipeline_stage: clean(stage, 100) }
  if (priority) properties.hs_ticket_priority = clean(priority, 30)
  const data = await apiJson('https://api.hubapi.com/crm/v3/objects/tickets', { method: 'POST', headers, body: JSON.stringify({ properties }) }, fetchImpl)
  return { ticket: { id: data.id, properties: data.properties, createdAt: data.createdAt } }
}

export async function updateHubspotTicket({ userId, ticketId, subject, content, stage, priority, fetchImpl = fetch } = {}) {
  const { headers } = bearer(userId, 'hubspot')
  const properties = {}
  if (subject != null) properties.subject = required(subject, 'subject', 255)
  if (content != null) properties.content = clean(content, 20_000)
  if (stage != null) properties.hs_pipeline_stage = clean(stage, 100)
  if (priority != null) properties.hs_ticket_priority = clean(priority, 30)
  if (!Object.keys(properties).length) throw connectorError('at least one ticket field is required')
  const data = await apiJson(`https://api.hubapi.com/crm/v3/objects/tickets/${encodeURIComponent(required(ticketId, 'ticketId', 100))}`, { method: 'PATCH', headers, body: JSON.stringify({ properties }) }, fetchImpl)
  return { ticket: { id: data.id, properties: data.properties, updatedAt: data.updatedAt } }
}

export async function listHubspotTickets({ userId, limit = 25, after, fetchImpl = fetch } = {}) {
  const { headers } = bearer(userId, 'hubspot')
  const url = new URL('https://api.hubapi.com/crm/v3/objects/tickets')
  url.searchParams.set('limit', String(Math.max(1, Math.min(100, Number(limit) || 25))))
  url.searchParams.set('properties', 'subject,content,hs_pipeline,hs_pipeline_stage,hs_ticket_priority,createdate,hs_lastmodifieddate')
  if (after) url.searchParams.set('after', clean(after, 500))
  const data = await apiJson(url, { headers }, fetchImpl)
  return { tickets: (data.results || []).map((ticket) => ({ id: ticket.id, properties: ticket.properties || {}, createdAt: ticket.createdAt, updatedAt: ticket.updatedAt, archived: !!ticket.archived })), after: data.paging?.next?.after || null }
}

function zendeskContext(userId) {
  const { config, secret } = credentials(userId, 'zendesk')
  const subdomain = required(config.subdomain, 'subdomain', 100).replace(/[^a-z0-9-]/gi, '')
  const email = required(config.email, 'email', 320)
  const token = required(secret.token, 'Zendesk API token', 2000)
  return { baseUrl: `https://${subdomain}.zendesk.com/api/v2`, headers: { Authorization: `Basic ${Buffer.from(`${email}/token:${token}`).toString('base64')}`, 'Content-Type': 'application/json' } }
}

export async function createZendeskTicket({ userId, subject, comment, priority, type, fetchImpl = fetch } = {}) {
  const { baseUrl, headers } = zendeskContext(userId)
  const ticket = { subject: required(subject, 'subject', 255), comment: { body: required(comment, 'comment', 20_000) } }
  if (priority) ticket.priority = clean(priority, 30)
  if (type) ticket.type = clean(type, 30)
  const data = await apiJson(`${baseUrl}/tickets.json`, { method: 'POST', headers, body: JSON.stringify({ ticket }) }, fetchImpl)
  return { ticket: { id: data.ticket?.id, subject: data.ticket?.subject, status: data.ticket?.status, url: data.ticket?.url } }
}

export async function updateZendeskTicket({ userId, ticketId, subject, comment, status, priority, fetchImpl = fetch } = {}) {
  const { baseUrl, headers } = zendeskContext(userId)
  const ticket = {}
  if (subject != null) ticket.subject = required(subject, 'subject', 255)
  if (comment != null) ticket.comment = { body: required(comment, 'comment', 20_000) }
  if (status != null) ticket.status = clean(status, 30)
  if (priority != null) ticket.priority = clean(priority, 30)
  if (!Object.keys(ticket).length) throw connectorError('at least one ticket field is required')
  const data = await apiJson(`${baseUrl}/tickets/${encodeURIComponent(required(ticketId, 'ticketId', 100))}.json`, { method: 'PUT', headers, body: JSON.stringify({ ticket }) }, fetchImpl)
  return { ticket: { id: data.ticket?.id, subject: data.ticket?.subject, status: data.ticket?.status, url: data.ticket?.url } }
}

export async function searchZendeskTickets({ userId, query = 'type:ticket', limit = 25, page = 1, fetchImpl = fetch } = {}) {
  const { baseUrl, headers } = zendeskContext(userId)
  const url = new URL(`${baseUrl}/search.json`)
  const normalized = clean(query, 1000) || 'type:ticket'
  url.searchParams.set('query', /(?:^|\s)type:ticket(?:\s|$)/i.test(normalized) ? normalized : `type:ticket ${normalized}`)
  url.searchParams.set('per_page', String(Math.max(1, Math.min(100, Number(limit) || 25))))
  url.searchParams.set('page', String(Math.max(1, Math.min(1000, Number(page) || 1))))
  url.searchParams.set('sort_by', 'updated_at')
  url.searchParams.set('sort_order', 'desc')
  const data = await apiJson(url, { headers }, fetchImpl)
  return { tickets: (data.results || []).map((ticket) => ({
    id: ticket.id, subject: ticket.subject, description: ticket.description || '', status: ticket.status,
    priority: ticket.priority, assigneeId: ticket.assignee_id, createdAt: ticket.created_at, updatedAt: ticket.updated_at, url: ticket.url,
  })), count: Number(data.count) || 0, nextPage: data.next_page || null }
}

export async function createTodoistTask({ userId, content, description = '', projectId, dueString, priority, fetchImpl = fetch } = {}) {
  const { headers } = bearer(userId, 'todoist')
  const body = { content: required(content, 'content', 500), description: clean(description, 20_000) }
  if (projectId) body.project_id = clean(projectId, 100)
  if (dueString) body.due_string = clean(dueString, 500)
  if (priority != null) body.priority = Math.max(1, Math.min(4, Number(priority) || 1))
  const data = await apiJson('https://api.todoist.com/rest/v2/tasks', { method: 'POST', headers, body: JSON.stringify(body) }, fetchImpl)
  return { task: { id: data.id, content: data.content, url: data.url, due: data.due } }
}

export async function updateTodoistTask({ userId, taskId, content, description, dueString, priority, fetchImpl = fetch } = {}) {
  const { headers } = bearer(userId, 'todoist')
  const body = {}
  if (content != null) body.content = required(content, 'content', 500)
  if (description != null) body.description = clean(description, 20_000)
  if (dueString != null) body.due_string = clean(dueString, 500)
  if (priority != null) body.priority = Math.max(1, Math.min(4, Number(priority) || 1))
  if (!Object.keys(body).length) throw connectorError('at least one task field is required')
  const data = await apiJson(`https://api.todoist.com/rest/v2/tasks/${encodeURIComponent(required(taskId, 'taskId', 100))}`, { method: 'POST', headers, body: JSON.stringify(body) }, fetchImpl)
  return { task: { id: data.id, content: data.content, url: data.url, due: data.due } }
}

export async function listTodoistTasks({ userId, projectId, label, filter, limit = 50, fetchImpl = fetch } = {}) {
  const { headers } = bearer(userId, 'todoist')
  const url = new URL('https://api.todoist.com/rest/v2/tasks')
  if (projectId) url.searchParams.set('project_id', clean(projectId, 100))
  if (label) url.searchParams.set('label', clean(label, 255))
  if (filter) url.searchParams.set('filter', clean(filter, 1000))
  const data = await apiJson(url, { headers }, fetchImpl)
  return { tasks: (Array.isArray(data) ? data : []).slice(0, Math.max(1, Math.min(100, Number(limit) || 50))).map((task) => ({
    id: task.id, content: task.content, description: task.description || '', projectId: task.project_id,
    priority: task.priority, due: task.due || null, labels: task.labels || [], url: task.url,
  })) }
}

async function dropboxUpload(userId, path, content, mode, fetchImpl) {
  const { token } = bearer(userId, 'dropbox')
  const data = await apiJson('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Dropbox-API-Arg': JSON.stringify({ path: required(path, 'path', 1000), mode, autorename: mode === 'add', mute: false }), 'Content-Type': 'application/octet-stream' }, body: String(content ?? '').slice(0, 5_000_000),
  }, fetchImpl)
  return { file: { id: data.id, name: data.name, path: data.path_display, rev: data.rev } }
}
export function createDropboxTextFile({ userId, path, content, fetchImpl = fetch } = {}) { return dropboxUpload(userId, path, content, 'add', fetchImpl) }
export function updateDropboxTextFile({ userId, path, content, fetchImpl = fetch } = {}) { return dropboxUpload(userId, path, content, 'overwrite', fetchImpl) }

export async function listDropboxFiles({ userId, path = '', recursive = false, limit = 50, cursor, fetchImpl = fetch } = {}) {
  const { token } = bearer(userId, 'dropbox')
  const body = cursor
    ? { cursor: required(cursor, 'cursor', 2000) }
    : { path: clean(path, 1000), recursive: !!recursive, include_deleted: false, include_non_downloadable_files: true, limit: Math.max(1, Math.min(2000, Number(limit) || 50)) }
  const endpoint = cursor ? 'continue' : 'list_folder'
  const data = await apiJson(`https://api.dropboxapi.com/2/files/list_folder/${endpoint === 'continue' ? 'continue' : ''}`.replace(/\/$/, ''), {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, fetchImpl)
  return { entries: (data.entries || []).slice(0, Math.max(1, Math.min(200, Number(limit) || 50))).map((entry) => ({
    type: entry['.tag'], id: entry.id, name: entry.name, path: entry.path_display, size: entry.size || null, modifiedAt: entry.server_modified || null,
  })), cursor: data.cursor || null, hasMore: !!data.has_more }
}

async function oneDriveWrite(userId, path, content, fetchImpl) {
  const { token } = bearer(userId, 'onedrive')
  const normalized = required(path, 'path', 1000).replace(/^\/+/, '')
  const data = await apiJson(`https://graph.microsoft.com/v1.0/me/drive/root:/${normalized.split('/').map(encodeURIComponent).join('/') }:/content`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain; charset=utf-8' }, body: String(content ?? '').slice(0, 5_000_000) }, fetchImpl)
  return { file: { id: data.id, name: data.name, size: data.size, url: data.webUrl } }
}
export function createOneDriveTextFile(options = {}) { return oneDriveWrite(options.userId, options.path, options.content, options.fetchImpl || fetch) }
export function updateOneDriveTextFile(options = {}) { return oneDriveWrite(options.userId, options.path, options.content, options.fetchImpl || fetch) }

export async function listOneDriveFiles({ userId, path = '', limit = 50, fetchImpl = fetch } = {}) {
  const { token } = bearer(userId, 'onedrive')
  const normalized = clean(path, 1000).replace(/^\/+|\/+$/g, '')
  const location = normalized ? `root:/${normalized.split('/').map(encodeURIComponent).join('/') }:/children` : 'root/children'
  const url = new URL(`https://graph.microsoft.com/v1.0/me/drive/${location}`)
  url.searchParams.set('$top', String(Math.max(1, Math.min(200, Number(limit) || 50))))
  url.searchParams.set('$select', 'id,name,size,webUrl,lastModifiedDateTime,file,folder,parentReference')
  const data = await apiJson(url, { headers: { Authorization: `Bearer ${token}` } }, fetchImpl)
  return { entries: (data.value || []).map((entry) => ({
    id: entry.id, name: entry.name, size: entry.size, url: entry.webUrl, modifiedAt: entry.lastModifiedDateTime,
    type: entry.folder ? 'folder' : 'file', mimeType: entry.file?.mimeType || null, childCount: entry.folder?.childCount || null,
  })), nextLink: data['@odata.nextLink'] || null }
}

function confluenceContext(userId) {
  const { config, secret } = credentials(userId, 'confluence')
  const siteUrl = required(config.siteUrl, 'siteUrl', 500).replace(/\/+$/, '')
  if (!/^https:\/\//i.test(siteUrl)) throw connectorError('Confluence site URL must use HTTPS')
  const email = required(config.email, 'email', 320)
  const token = required(secret.token, 'Confluence API token', 2000)
  return { siteUrl, headers: { Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`, 'Content-Type': 'application/json', Accept: 'application/json' } }
}

export async function createConfluencePage({ userId, spaceId, parentId, title, body, fetchImpl = fetch } = {}) {
  const { siteUrl, headers } = confluenceContext(userId)
  const payload = { spaceId: required(spaceId, 'spaceId', 100), status: 'current', title: required(title, 'title', 255), body: { representation: 'storage', value: required(body, 'body', 100_000) } }
  if (parentId) payload.parentId = clean(parentId, 100)
  const data = await apiJson(`${siteUrl}/wiki/api/v2/pages`, { method: 'POST', headers, body: JSON.stringify(payload) }, fetchImpl)
  return { page: { id: data.id, title: data.title, status: data.status, url: data._links?.webui ? `${siteUrl}/wiki${data._links.webui}` : '' } }
}

export async function updateConfluencePage({ userId, pageId, title, body, version, fetchImpl = fetch } = {}) {
  const { siteUrl, headers } = confluenceContext(userId)
  const payload = { id: required(pageId, 'pageId', 100), status: 'current', title: required(title, 'title', 255), body: { representation: 'storage', value: required(body, 'body', 100_000) }, version: { number: Number(version) } }
  if (!Number.isInteger(payload.version.number) || payload.version.number < 2) throw connectorError('version must be the next page version number')
  const data = await apiJson(`${siteUrl}/wiki/api/v2/pages/${encodeURIComponent(payload.id)}`, { method: 'PUT', headers, body: JSON.stringify(payload) }, fetchImpl)
  return { page: { id: data.id, title: data.title, status: data.status, url: data._links?.webui ? `${siteUrl}/wiki${data._links.webui}` : '' } }
}

export async function searchConfluencePages({ userId, cql = 'type = page order by lastmodified desc', limit = 25, start = 0, fetchImpl = fetch } = {}) {
  const { siteUrl, headers } = confluenceContext(userId)
  const url = new URL(`${siteUrl}/wiki/rest/api/search`)
  url.searchParams.set('cql', clean(cql, 2000) || 'type = page order by lastmodified desc')
  url.searchParams.set('limit', String(Math.max(1, Math.min(100, Number(limit) || 25))))
  url.searchParams.set('start', String(Math.max(0, Number(start) || 0)))
  const data = await apiJson(url, { headers }, fetchImpl)
  return { pages: (data.results || []).map((result) => ({
    id: result.content?.id, title: result.content?.title, type: result.content?.type,
    excerpt: result.excerpt || '', lastModified: result.lastModified || null,
    url: result.url ? `${siteUrl}${result.url}` : (result.content?._links?.webui ? `${siteUrl}/wiki${result.content._links.webui}` : ''),
  })), totalSize: Number(data.totalSize) || 0, next: data._links?.next || null }
}

function salesforceContext(userId) {
  const { config, headers } = bearer(userId, 'salesforce')
  const instanceUrl = required(config.instanceUrl, 'instanceUrl', 500).replace(/\/+$/, '')
  if (!/^https:\/\//i.test(instanceUrl)) throw connectorError('Salesforce instance URL must use HTTPS')
  return { instanceUrl, headers }
}

export async function createSalesforceRecord({ userId, objectType, fields, fetchImpl = fetch } = {}) {
  const { instanceUrl, headers } = salesforceContext(userId)
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw connectorError('fields must be an object')
  const type = required(objectType, 'objectType', 100).replace(/[^a-z0-9_]/gi, '')
  const data = await apiJson(`${instanceUrl}/services/data/v61.0/sobjects/${type}`, { method: 'POST', headers, body: JSON.stringify(fields) }, fetchImpl)
  return { record: { id: data.id, success: data.success !== false, errors: data.errors || [] } }
}

export async function updateSalesforceRecord({ userId, objectType, recordId, fields, fetchImpl = fetch } = {}) {
  const { instanceUrl, headers } = salesforceContext(userId)
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw connectorError('fields must be an object')
  const type = required(objectType, 'objectType', 100).replace(/[^a-z0-9_]/gi, '')
  await apiJson(`${instanceUrl}/services/data/v61.0/sobjects/${type}/${encodeURIComponent(required(recordId, 'recordId', 100))}`, { method: 'PATCH', headers, body: JSON.stringify(fields) }, fetchImpl)
  return { record: { id: clean(recordId, 100), updated: true } }
}

export async function querySalesforceRecords({ userId, soql, limit = 50, fetchImpl = fetch } = {}) {
  const { instanceUrl, headers } = salesforceContext(userId)
  let query = required(soql, 'soql', 10_000)
  if (!/^select\b/i.test(query)) throw connectorError('soql must be a SELECT query')
  if (!/\blimit\s+\d+\b/i.test(query)) query += ` LIMIT ${Math.max(1, Math.min(200, Number(limit) || 50))}`
  const url = new URL(`${instanceUrl}/services/data/v61.0/query`)
  url.searchParams.set('q', query)
  const data = await apiJson(url, { headers }, fetchImpl)
  return { records: data.records || [], totalSize: Number(data.totalSize) || 0, done: data.done !== false, nextRecordsUrl: data.nextRecordsUrl || null }
}
