import { getAuthToken } from '../accountClient.js'

function responseErrorMessage(data, fallback) {
  if (typeof data?.error === 'string' && data.error) return data.error
  if (typeof data?.error?.message === 'string' && data.error.message) return data.error.message
  return fallback
}

export async function callJson(url, body, { method = 'POST' } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  const token = getAuthToken?.()
  if (token) headers.Authorization = `Bearer ${token}`
  const resp = await fetch(url, {
    method,
    headers,
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  })
  const text = await resp.text()
  let data
  try { data = text ? JSON.parse(text) : {} } catch { data = { raw: text } }
  if (!resp.ok || data?.ok === false) {
    const err = new Error(responseErrorMessage(data, `HTTP ${resp.status}`))
    err.status = resp.status
    err.code = data?.error?.code || data?.code
    err.retryable = data?.retryable
    err.path = data?.path
    err.hint = data?.hint
    throw err
  }
  return data
}


export async function callWorkspaceJson(url, body) {
  const headers = { 'Content-Type': 'application/json' }
  const token = getAuthToken?.()
  if (token) headers.Authorization = `Bearer ${token}`
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const text = await resp.text()
  let data
  try { data = text ? JSON.parse(text) : {} } catch { data = { raw: text } }
  if (!resp.ok) {
    let message = responseErrorMessage(data, `HTTP ${resp.status}`)
    // \u2605 404 \u4e14\u54cd\u5e94\u4f53\u4e0d\u662f JSON \u2192 \u662f**\u8def\u7531\u672c\u8eab\u6ca1\u6ce8\u518c**,\u4e0d\u662f\u8d44\u6e90\u4e0d\u5b58\u5728\u3002
    //
    // \u771f\u5b9e\u4e8b\u6545:dev server \u6f0f\u6ce8\u518c /api/tools/code/,\u6a21\u578b\u6bcf\u6b21\u8c03 grep_code
    // \u90fd\u53ea\u770b\u5230\u88f8\u7684 "HTTP 404",\u4e8e\u662f\u5b83\u4ee5\u4e3a\u662f\u8def\u5f84\u5199\u9519\u4e86,\u8fde\u7740\u6362\u4e86 5 \u79cd
    // \u8def\u5f84\u5199\u6cd5\u53cd\u590d\u91cd\u8bd5,\u5168\u5931\u8d25,\u6700\u540e\u7ed5\u9053\u7528 read_file \u786c\u5543\u6574\u4e2a\u6587\u4ef6\u3002
    // \u8bf4\u6e05\u695a\u300c\u8fd9\u662f\u540e\u7aef\u6ca1\u63a5\u4e0a,\u6362\u8def\u5f84\u6ca1\u7528\u300d,\u5b83\u624d\u80fd\u7acb\u523b\u6539\u7528\u522b\u7684\u5de5\u5177\u3002
    if (resp.status === 404 && !data?.error) {
      message = `\u63a5\u53e3 ${url} \u672a\u6ce8\u518c\uff08HTTP 404\uff09\u3002\u8fd9\u662f\u540e\u7aef\u8def\u7531\u7f3a\u5931\uff0c\u4e0d\u662f\u6587\u4ef6\u6216\u8d44\u6e90\u4e0d\u5b58\u5728\u2014\u2014`
        + '\u6362\u8def\u5f84\u91cd\u8bd5\u6ca1\u6709\u7528\uff0c\u8bf7\u6539\u7528\u5176\u4ed6\u5de5\u5177\uff08\u5982 read_file / list_directory\uff09\u5b8c\u6210\u4efb\u52a1\uff0c'
        + '\u5e76\u5728\u6700\u7ec8\u56de\u590d\u91cc\u544a\u8bc9\u7528\u6237\u8fd9\u4e2a\u63a5\u53e3\u4e0d\u53ef\u7528\u3002'
    }
    const err = new Error(message)
    err.status = resp.status
    err.code = data?.error?.code || data?.code
    err.retryable = data?.retryable
    err.path = data?.path
    err.hint = data?.hint
    err.suggestGrantPath = data?.suggestGrantPath
    err.requiredAccessMode = data?.requiredAccessMode
    throw err
  }
  return data
}

