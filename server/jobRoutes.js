import { authenticateRequest } from './middleware.js'
import { readJson, sendJson } from './utils.js'

function unauthorized(res) {
  return sendJson(res, 401, { error: 'Unauthorized' })
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

function routeParts(pathname) {
  return pathname.split('/').filter(Boolean)
}

export async function handleJobRequest(req, res, runtime) {
  const url = new URL(req.url, 'http://localhost')
  const parts = routeParts(url.pathname)

  // SSE 流:走 query token,EventSource 没法带 Authorization 头。
  // 同时兼容已有 Authorization 头(给非浏览器 client/测试)。
  if (req.method === 'GET' && url.pathname === '/api/jobs/stream') {
    let userId = authenticateRequest(req)
    if (!userId) {
      const queryToken = url.searchParams.get('token')
      if (queryToken) {
        req.headers.authorization = `Bearer ${queryToken}`
        userId = authenticateRequest(req)
      }
    }
    if (!userId) return unauthorized(res)
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    sendSse(res, 'ready', { ok: true })
    const unsubscribe = runtime.subscribe(userId, (event) => sendSse(res, 'job_event', event))
    req.on('close', unsubscribe)
    return
  }

  // 其余路由全部要求登录态。
  const userId = authenticateRequest(req)
  if (!userId) return unauthorized(res)

  if (req.method === 'POST' && url.pathname === '/api/jobs') {
    const body = await readJson(req)
    const prompt = String(body.prompt || '').trim()
    if (!prompt) return sendJson(res, 400, { error: 'prompt is required' })
    const job = await runtime.createJob(prompt, { userId })
    return sendJson(res, 201, { job })
  }

  if (req.method === 'GET' && url.pathname === '/api/jobs') {
    return sendJson(res, 200, { jobs: runtime.listJobs({ userId }) })
  }

  if (parts[0] === 'api' && parts[1] === 'jobs' && parts[2]) {
    const jobId = decodeURIComponent(parts[2])

    if (req.method === 'GET' && parts.length === 3) {
      const job = runtime.getJob(jobId, { userId })
      return job
        ? sendJson(res, 200, { job })
        : sendJson(res, 404, { error: 'job not found' })
    }

    if (req.method === 'POST' && parts[3] === 'cancel') {
      const job = runtime.requestCancel(jobId, { userId })
      return job
        ? sendJson(res, 200, { job })
        : sendJson(res, 404, { error: 'job not found' })
    }

    if (req.method === 'POST' && parts[3] === 'retry') {
      const job = runtime.retryJob(jobId, { userId })
      return job
        ? sendJson(res, 200, { job })
        : sendJson(res, 404, { error: 'job not found' })
    }

    if (req.method === 'POST' && parts[3] === 'steps' && parts[4] && parts[5] === 'retry') {
      const job = runtime.retryStep(jobId, decodeURIComponent(parts[4]), { userId })
      return job
        ? sendJson(res, 200, { job })
        : sendJson(res, 404, { error: 'step not found' })
    }

    // ★ 结构化计划: 步骤完成标记 + evidence
    if (req.method === 'POST' && parts[3] === 'steps' && parts[4] && parts[5] === 'complete') {
      const body = await readJson(req)
      const stepId = decodeURIComponent(parts[4])
      const step = runtime.getJob(jobId, { userId })?.steps?.find((s) => s.id === stepId)
      if (!step) return sendJson(res, 404, { error: 'step not found' })
      runtime.completeStep(jobId, stepId, { userId, evidence: body.evidence || [] })
      return sendJson(res, 200, { ok: true })
    }

    // ★ 结构化计划: 创建含风险/目标/验收标准的计划
    if (req.method === 'POST' && parts[3] === 'plan') {
      const body = await readJson(req)
      if (!body.title || !body.steps?.length) {
        return sendJson(res, 400, { error: 'title 和 steps 是必填项' })
      }
      const job = runtime.createPlan({
        userId,
        title: body.title,
        prompt: body.prompt || body.title,
        steps: body.steps,
      })
      return sendJson(res, 201, { job })
    }
  }

  return sendJson(res, 404, { error: 'not found' })
}
