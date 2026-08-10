import { authenticateRequest } from '../middleware.js'
import { readJson, sendJson } from '../utils.js'
import { abortJob as abortJobImpl } from '../services/jobRuntime.js'
import { createStreamTicket, consumeStreamTicket } from '../utils/streamTicket.js'

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

  // 一次性短 TTL ticket(C-P2.1):用 header token 换 60s 一次性 ticket,
  // EventSource 用 ?ticket= 连接,避免把 7 天 session token 放 URL query。
  if (req.method === 'POST' && url.pathname === '/api/jobs/stream-ticket') {
    const userId = authenticateRequest(req)
    if (!userId) return unauthorized(res)
    const ticket = createStreamTicket(userId)
    return sendJson(res, 201, { ticket, expiresIn: 60 })
  }

  // SSE 流:EventSource 没法带 Authorization 头,改用一次性短 TTL ticket(?ticket=)。
  // 仍兼容 Authorization 头(给非浏览器 client/测试)。旧的 ?token= 已移除(避免长效 token 落日志)。
  if (req.method === 'GET' && url.pathname === '/api/jobs/stream') {
    let userId = authenticateRequest(req)
    if (!userId) {
      const ticket = url.searchParams.get('ticket')
      if (ticket) userId = consumeStreamTicket(ticket)
    }
    if (!userId) return unauthorized(res)
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.flushHeaders?.()
    sendSse(res, 'ready', { ok: true })
    const unsubscribe = runtime.subscribe(userId, (event) => sendSse(res, 'job_event', event))
    const heartbeat = setInterval(() => {
      if (!res.destroyed && !res.writableEnded) res.write(': keep-alive\n\n')
    }, 15_000)
    heartbeat.unref?.()
    let cleanedUp = false
    const cleanup = () => {
      if (cleanedUp) return
      cleanedUp = true
      clearInterval(heartbeat)
      unsubscribe()
    }
    req.on('close', cleanup)
    res.on?.('close', cleanup)
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

    if (req.method === 'POST' && parts[3] === 'steer') {
      const body = await readJson(req)
      const content = String(body.content || '').trim()
      if (!content) return sendJson(res, 400, { error: 'content is required' })
      if (content.length > 20_000) {
        return sendJson(res, 400, { error: 'content exceeds 20000 characters' })
      }
      const result = runtime.steerJob(jobId, { userId, content })
      if (!result) return sendJson(res, 404, { error: 'job not found' })
      if (!result.accepted) return sendJson(res, 409, result)
      return sendJson(res, 202, result)
    }

    if (req.method === 'POST' && parts[3] === 'directory-authorization' && parts[4] === 'resume') {
      const body = await readJson(req)
      const result = runtime.resumeDirectoryAuthorization(jobId, {
        userId,
        path: body.path,
        accessMode: body.accessMode,
      })
      if (!result) return sendJson(res, 404, { error: 'job not found' })
      if (!result.resumed) return sendJson(res, 409, result)
      return sendJson(res, 202, result)
    }

    if (req.method === 'POST' && parts[3] === 'plan' && parts[4] === 'approve') {
      const body = String(req.headers['content-type'] || '').includes('application/json')
        ? await readJson(req)
        : {}
      const result = runtime.approvePlan(jobId, { userId, steps: body.steps ?? null })
      if (!result) return sendJson(res, 404, { error: 'job not found' })
      if (!result.approved) return sendJson(res, 409, result)
      return sendJson(res, 200, result)
    }

    // 硬终止:调模块级 abortJob 打 AbortController.signal。
    // 与 /cancel 同义(均走 requestCancel),但返回体更极简。
    if (req.method === 'POST' && parts[3] === 'abort') {
      const result = abortJobImpl(jobId, { userId })
      return result
        ? sendJson(res, 200, { ok: true })
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
      try {
        runtime.completeStep(jobId, stepId, { userId, evidence: body.evidence ?? [] })
        return sendJson(res, 200, { ok: true })
      } catch (error) {
        if (error?.statusCode === 422 && String(error?.code || '').startsWith('JOB_COMPLETION_EVIDENCE_')) {
          return sendJson(res, 422, { error: error.message, code: error.code })
        }
        throw error
      }
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
