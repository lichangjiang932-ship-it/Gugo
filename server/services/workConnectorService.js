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
  if (!response.ok) throw connectorError(data?.errors?.[0]?.message || data?.error?.message || data?.err || data?.message || `HTTP ${response.status}`, response.status)
  return data
}

function tokenContext(userId, provider, scheme = 'Bearer') {
  const { config, secret } = credentials(userId, provider)
  const token = required(secret.token, `${provider} token`, 2000)
  return { config, token, headers: { Authorization: scheme ? `${scheme} ${token}` : token, 'Content-Type': 'application/json' } }
}

function gitlabContext(userId) {
  const { config, token } = tokenContext(userId, 'gitlab', '')
  const baseUrl = clean(config.baseUrl || 'https://gitlab.com/api/v4', 500).replace(/\/+$/, '')
  if (!/^https:\/\//i.test(baseUrl)) throw connectorError('GitLab API URL must use HTTPS')
  return { baseUrl, headers: { 'PRIVATE-TOKEN': token, 'Content-Type': 'application/json' } }
}

export async function createGitlabIssue({ userId, projectId, title, description = '', labels = [], fetchImpl = fetch } = {}) {
  const { baseUrl, headers } = gitlabContext(userId)
  const data = await apiJson(`${baseUrl}/projects/${encodeURIComponent(required(projectId, 'projectId', 300))}/issues`, {
    method: 'POST', headers, body: JSON.stringify({ title: required(title, 'title', 255), description: clean(description, 20_000), labels: (Array.isArray(labels) ? labels : [labels]).filter(Boolean).join(',') }),
  }, fetchImpl)
  return { issue: { id: data.id, iid: data.iid, title: data.title, state: data.state, url: data.web_url } }
}

export async function updateGitlabIssue({ userId, projectId, issueIid, title, description, stateEvent, fetchImpl = fetch } = {}) {
  const { baseUrl, headers } = gitlabContext(userId)
  const body = {}
  if (title != null) body.title = required(title, 'title', 255)
  if (description != null) body.description = clean(description, 20_000)
  if (stateEvent != null) body.state_event = clean(stateEvent, 20)
  if (!Object.keys(body).length) throw connectorError('at least one issue field is required')
  const data = await apiJson(`${baseUrl}/projects/${encodeURIComponent(required(projectId, 'projectId', 300))}/issues/${encodeURIComponent(required(issueIid, 'issueIid', 40))}`, { method: 'PUT', headers, body: JSON.stringify(body) }, fetchImpl)
  return { issue: { id: data.id, iid: data.iid, title: data.title, state: data.state, url: data.web_url } }
}

export async function listGitlabIssues({ userId, projectId, state = 'opened', search, limit = 20, fetchImpl = fetch } = {}) {
  const { baseUrl, headers } = gitlabContext(userId)
  const url = new URL(`${baseUrl}/projects/${encodeURIComponent(required(projectId, 'projectId', 300))}/issues`)
  url.searchParams.set('state', clean(state, 20) || 'opened')
  url.searchParams.set('per_page', String(Math.max(1, Math.min(100, Number(limit) || 20))))
  url.searchParams.set('order_by', 'updated_at')
  url.searchParams.set('sort', 'desc')
  if (search) url.searchParams.set('search', clean(search, 500))
  const data = await apiJson(url, { headers }, fetchImpl)
  return { issues: (Array.isArray(data) ? data : []).map((issue) => ({
    id: issue.id, iid: issue.iid, title: issue.title, description: issue.description || '', state: issue.state,
    labels: issue.labels || [], assignees: issue.assignees || [], updatedAt: issue.updated_at, url: issue.web_url,
  })) }
}

export async function createAsanaTask({ userId, workspaceId, projectId, name, notes = '', dueOn, assignee, fetchImpl = fetch } = {}) {
  const { headers } = tokenContext(userId, 'asana')
  const input = { workspace: required(workspaceId, 'workspaceId', 100), name: required(name, 'name', 255), notes: clean(notes, 20_000) }
  if (projectId) input.projects = [clean(projectId, 100)]
  if (dueOn) input.due_on = clean(dueOn, 30)
  if (assignee) input.assignee = clean(assignee, 320)
  const data = await apiJson('https://app.asana.com/api/1.0/tasks', { method: 'POST', headers, body: JSON.stringify({ data: input }) }, fetchImpl)
  return { task: { id: data.data?.gid, name: data.data?.name, url: data.data?.permalink_url } }
}

export async function updateAsanaTask({ userId, taskId, name, notes, completed, dueOn, fetchImpl = fetch } = {}) {
  const { headers } = tokenContext(userId, 'asana')
  const input = {}
  if (name != null) input.name = required(name, 'name', 255)
  if (notes != null) input.notes = clean(notes, 20_000)
  if (completed != null) input.completed = !!completed
  if (dueOn != null) input.due_on = clean(dueOn, 30) || null
  if (!Object.keys(input).length) throw connectorError('at least one task field is required')
  const data = await apiJson(`https://app.asana.com/api/1.0/tasks/${encodeURIComponent(required(taskId, 'taskId', 100))}`, { method: 'PUT', headers, body: JSON.stringify({ data: input }) }, fetchImpl)
  return { task: { id: data.data?.gid, name: data.data?.name, completed: !!data.data?.completed, url: data.data?.permalink_url } }
}

export async function listAsanaProjectTasks({ userId, projectId, limit = 50, fetchImpl = fetch } = {}) {
  const { headers } = tokenContext(userId, 'asana')
  const url = new URL(`https://app.asana.com/api/1.0/projects/${encodeURIComponent(required(projectId, 'projectId', 100))}/tasks`)
  url.searchParams.set('limit', String(Math.max(1, Math.min(100, Number(limit) || 50))))
  url.searchParams.set('opt_fields', 'name,completed,due_on,assignee.name,permalink_url,modified_at')
  const data = await apiJson(url, { headers }, fetchImpl)
  return { tasks: (data.data || []).map((task) => ({
    id: task.gid, name: task.name, completed: !!task.completed, dueOn: task.due_on || null,
    assignee: task.assignee?.name || null, modifiedAt: task.modified_at || null, url: task.permalink_url,
  })), nextPage: data.next_page || null }
}

export async function createClickupTask({ userId, listId, name, description = '', assignees = [], dueDate, priority, fetchImpl = fetch } = {}) {
  const { headers } = tokenContext(userId, 'clickup', '')
  const body = { name: required(name, 'name', 255), description: clean(description, 20_000), assignees: (Array.isArray(assignees) ? assignees : [assignees]).filter(Boolean) }
  if (dueDate != null) body.due_date = Number(dueDate)
  if (priority != null) body.priority = Number(priority)
  const data = await apiJson(`https://api.clickup.com/api/v2/list/${encodeURIComponent(required(listId, 'listId', 100))}/task`, { method: 'POST', headers, body: JSON.stringify(body) }, fetchImpl)
  return { task: { id: data.id, name: data.name, status: data.status?.status, url: data.url } }
}

export async function updateClickupTask({ userId, taskId, name, description, status, priority, fetchImpl = fetch } = {}) {
  const { headers } = tokenContext(userId, 'clickup', '')
  const body = {}
  for (const [key, value] of Object.entries({ name, description, status, priority })) if (value != null) body[key] = key === 'priority' ? Number(value) : clean(value, key === 'description' ? 20_000 : 255)
  if (!Object.keys(body).length) throw connectorError('at least one task field is required')
  const data = await apiJson(`https://api.clickup.com/api/v2/task/${encodeURIComponent(required(taskId, 'taskId', 100))}`, { method: 'PUT', headers, body: JSON.stringify(body) }, fetchImpl)
  return { task: { id: data.id, name: data.name, status: data.status?.status, url: data.url } }
}

export async function listClickupTasks({ userId, listId, includeClosed = false, page = 0, fetchImpl = fetch } = {}) {
  const { headers } = tokenContext(userId, 'clickup', '')
  const url = new URL(`https://api.clickup.com/api/v2/list/${encodeURIComponent(required(listId, 'listId', 100))}/task`)
  url.searchParams.set('archived', 'false')
  url.searchParams.set('include_closed', String(!!includeClosed))
  url.searchParams.set('page', String(Math.max(0, Math.min(1000, Number(page) || 0))))
  const data = await apiJson(url, { headers }, fetchImpl)
  return { tasks: (data.tasks || []).map((task) => ({
    id: task.id, name: task.name, description: task.description || '', status: task.status?.status || '',
    priority: task.priority?.priority || null, dueDate: task.due_date || null, url: task.url,
  })), lastPage: !!data.last_page }
}

function airtableUrl(baseId, tableId, recordId = '') {
  const suffix = recordId ? `/${encodeURIComponent(recordId)}` : ''
  return `https://api.airtable.com/v0/${encodeURIComponent(required(baseId, 'baseId', 100))}/${encodeURIComponent(required(tableId, 'tableId', 100))}${suffix}`
}

export async function createAirtableRecord({ userId, baseId, tableId, fields, typecast = false, fetchImpl = fetch } = {}) {
  const { headers } = tokenContext(userId, 'airtable')
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw connectorError('fields must be an object')
  const data = await apiJson(airtableUrl(baseId, tableId), { method: 'POST', headers, body: JSON.stringify({ fields, typecast: !!typecast }) }, fetchImpl)
  return { record: { id: data.id, fields: data.fields, createdTime: data.createdTime } }
}

export async function updateAirtableRecord({ userId, baseId, tableId, recordId, fields, typecast = false, fetchImpl = fetch } = {}) {
  const { headers } = tokenContext(userId, 'airtable')
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw connectorError('fields must be an object')
  const data = await apiJson(airtableUrl(baseId, tableId, required(recordId, 'recordId', 100)), { method: 'PATCH', headers, body: JSON.stringify({ fields, typecast: !!typecast }) }, fetchImpl)
  return { record: { id: data.id, fields: data.fields, createdTime: data.createdTime } }
}

export async function listAirtableRecords({ userId, baseId, tableId, view, filterByFormula, limit = 50, offset, fetchImpl = fetch } = {}) {
  const { headers } = tokenContext(userId, 'airtable')
  const url = new URL(airtableUrl(baseId, tableId))
  url.searchParams.set('pageSize', String(Math.max(1, Math.min(100, Number(limit) || 50))))
  if (view) url.searchParams.set('view', clean(view, 255))
  if (filterByFormula) url.searchParams.set('filterByFormula', clean(filterByFormula, 2000))
  if (offset) url.searchParams.set('offset', clean(offset, 500))
  const data = await apiJson(url, { headers }, fetchImpl)
  return { records: (data.records || []).map((record) => ({ id: record.id, fields: record.fields || {}, createdTime: record.createdTime })), offset: data.offset || null }
}

async function mondayGraphql(userId, query, variables, fetchImpl) {
  const { token } = tokenContext(userId, 'monday', '')
  const data = await apiJson('https://api.monday.com/v2', { method: 'POST', headers: { Authorization: token, 'Content-Type': 'application/json', 'API-Version': '2025-04' }, body: JSON.stringify({ query, variables }) }, fetchImpl)
  if (data?.errors?.length) throw connectorError(data.errors.map((item) => item.message).join('; '))
  return data.data
}

export async function createMondayItem({ userId, boardId, groupId, itemName, columnValues = {}, fetchImpl = fetch } = {}) {
  const data = await mondayGraphql(userId, 'mutation($board: ID!, $group: String, $name: String!, $columns: JSON!) { create_item(board_id: $board, group_id: $group, item_name: $name, column_values: $columns) { id name url } }', { board: required(boardId, 'boardId', 100), group: clean(groupId, 100) || null, name: required(itemName, 'itemName', 255), columns: JSON.stringify(columnValues || {}) }, fetchImpl)
  return { item: data.create_item }
}

export async function updateMondayItem({ userId, boardId, itemId, columnValues, fetchImpl = fetch } = {}) {
  if (!columnValues || typeof columnValues !== 'object' || Array.isArray(columnValues)) throw connectorError('columnValues must be an object')
  const data = await mondayGraphql(userId, 'mutation($board: ID!, $item: ID!, $columns: JSON!) { change_multiple_column_values(board_id: $board, item_id: $item, column_values: $columns) { id name url } }', { board: required(boardId, 'boardId', 100), item: required(itemId, 'itemId', 100), columns: JSON.stringify(columnValues) }, fetchImpl)
  return { item: data.change_multiple_column_values }
}

export async function listMondayItems({ userId, boardId, limit = 25, cursor, fetchImpl = fetch } = {}) {
  const pageLimit = Math.max(1, Math.min(100, Number(limit) || 25))
  const data = await mondayGraphql(userId, 'query($boards: [ID!]!, $limit: Int!, $cursor: String) { boards(ids: $boards) { id name items_page(limit: $limit, cursor: $cursor) { cursor items { id name url group { id title } column_values { id text value } } } } }', {
    boards: [required(boardId, 'boardId', 100)], limit: pageLimit, cursor: clean(cursor, 1000) || null,
  }, fetchImpl)
  const board = data?.boards?.[0]
  return { board: board ? { id: board.id, name: board.name } : null, items: board?.items_page?.items || [], cursor: board?.items_page?.cursor || null }
}
