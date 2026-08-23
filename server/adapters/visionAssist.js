/**
 * 视觉辅助副驾（vision-assist）
 *
 * 用途：当主对话模型（如 deepseek-chat）不支持视觉、但用户在消息里塞了图片时，
 * 先调用配置的"视觉副驾"把图片转描述文本，把图片块替换成文本块再交给主模型。
 *
 * 配置来源（按优先级降序）：
 *   1) DB integrations 表（kind='vision_assist'，enabled=true） — 通过 setVisionAssistResolver 注入
 *   2) 环境变量 VISION_ASSIST_BASE_URL / VISION_ASSIST_MODEL / VISION_ASSIST_API_KEY
 *
 * 失败策略：副驾调用失败时，把图片块替换成 [图片描述失败:reason] 占位文本，
 * 不让整条对话挂掉 —— 让主模型在缺图情况下尽量回答。
 */

const DEFAULT_PROMPT = '请用一段简洁的中文描述这张图片，包括主体、场景、文字、配色和明显细节，便于纯文本模型理解。'

let userResolver = null

/**
 * 注入 per-userId 的副驾配置查询函数。由 modelProxy 在初始化时挂上。
 * resolver(userId) => { config, secret } | null
 */
export function setVisionAssistResolver(fn) {
  userResolver = typeof fn === 'function' ? fn : null
}

function envVisionAssist(env = process.env) {
  const baseUrl = (env.VISION_ASSIST_BASE_URL || '').trim().replace(/\/+$/, '')
  const modelName = (env.VISION_ASSIST_MODEL || '').trim()
  const apiKey = (env.VISION_ASSIST_API_KEY || '').trim()
  if (!baseUrl || !modelName) return null
  return {
    config: {
      baseUrl,
      modelName,
      language: env.VISION_ASSIST_LANGUAGE || 'zh',
      maxImages: Number(env.VISION_ASSIST_MAX_IMAGES) || 4,
    },
    secret: { apiKey },
  }
}

export function resolveVisionAssistConfig({ userId, env = process.env } = {}) {
  if (userId && userResolver) {
    try {
      const fromDb = userResolver(userId)
      if (fromDb && fromDb.config?.baseUrl && fromDb.config?.modelName) {
        return {
          ...fromDb,
          secret: {
            ...(fromDb.secret || {}),
            apiKey: String(fromDb.secret?.apiKey || '').trim(),
          },
        }
      }
    } catch {
      // 退回 env
    }
  }
  return envVisionAssist(env)
}

export function hasVisionAssistConfigured({ userId, env = process.env } = {}) {
  return !!resolveVisionAssistConfig({ userId, env })
}

function isImagePart(part) {
  return !!(part && (
    part.type === 'image_url' ||
    part.type === 'input_image' ||
    part.image_url
  ))
}

function extractImageParts(message) {
  if (!Array.isArray(message?.content)) return []
  return message.content.filter(isImagePart)
}

async function describeOneImage({ imagePart, config, secret, fetchImpl, language }) {
  const url = `${config.baseUrl}/chat/completions`
  const prompt = language === 'en'
    ? 'Describe this image in a concise English paragraph, including main subject, scene, text, colors and notable details, so a text-only model can understand it.'
    : DEFAULT_PROMPT

  const rawImageUrl = typeof imagePart?.image_url === 'string'
    ? imagePart.image_url
    : imagePart?.image_url?.url || imagePart?.url || null
  if (!rawImageUrl) return { ok: false, message: '不支持的图片引用格式' }
  const normalizedImagePart = { type: 'image_url', image_url: { url: rawImageUrl } }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const headers = { 'Content-Type': 'application/json' }
    const apiKey = String(secret?.apiKey || '').trim()
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`
    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.modelName,
        temperature: 0.2,
        max_tokens: 600,
        messages: [
          { role: 'user', content: [
            { type: 'text', text: prompt },
            normalizedImagePart,
          ] },
        ],
      }),
      signal: controller.signal,
    })
    const text = await response.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = null }
    if (!response.ok) {
      return { ok: false, message: data?.error?.message || `HTTP ${response.status}` }
    }
    const desc = data?.choices?.[0]?.message?.content
    if (typeof desc === 'string' && desc.trim()) {
      return { ok: true, description: desc.trim() }
    }
    return { ok: false, message: '副驾返回空描述' }
  } catch (err) {
    return { ok: false, message: err?.message || '副驾调用失败' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 把 messages 中所有 image_url 块替换为文本描述块。
 * 返回 { messages: 新数组, assistCount, failures }
 */
export async function describeImageAttachments({
  attachments = [],
  userId = null,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const assistConfig = resolveVisionAssistConfig({ userId, env })
  if (!assistConfig) return []
  const language = assistConfig.config.language || 'zh'
  const maxImages = Math.max(1, Number(assistConfig.config.maxImages) || 4)
  const results = []
  let processed = 0
  for (const attachment of attachments) {
    if (processed >= maxImages) break
    const url = attachment?.url || attachment?.imageUrl || attachment?.image_url?.url
    if (!url) continue
    const result = await describeOneImage({
      imagePart: { type: 'image_url', image_url: { url } },
      config: assistConfig.config,
      secret: assistConfig.secret,
      fetchImpl,
      language,
    })
    results.push({
      index: processed,
      ok: result.ok,
      description: result.description || '',
      error: result.message || '',
      source: url,
    })
    processed += 1
  }
  return results
}

export async function attachVisionDescriptions({
  messages,
  userId = null,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const assistConfig = resolveVisionAssistConfig({ userId, env })
  if (!assistConfig) {
    return { messages, assistCount: 0, failures: ['no_assist_configured'] }
  }

  const language = assistConfig.config.language || 'zh'
  const maxImages = Math.max(1, Number(assistConfig.config.maxImages) || 4)

  let processed = 0
  const failures = []
  const nextMessages = []

  for (const message of messages) {
    const imageParts = extractImageParts(message)
    if (!imageParts.length) { nextMessages.push(message); continue }

    const newContent = []
    let index = 0
    for (const part of message.content) {
      if (!isImagePart(part)) {
        newContent.push(part)
        continue
      }
      const imagePart = part
      index += 1
      if (processed >= maxImages) {
        newContent.push({ type: 'text', text: `[图片 ${index} 已跳过：超出 vision-assist 单轮上限 ${maxImages}]` })
        continue
      }
      processed += 1
      const result = await describeOneImage({
        imagePart,
        config: assistConfig.config,
        secret: assistConfig.secret,
        fetchImpl,
        language,
      })
      if (result.ok) {
        newContent.push({ type: 'text', text: `[图片 ${index} 描述（由 ${assistConfig.config.modelName} 生成）]\n${result.description}` })
      } else {
        failures.push(result.message)
        newContent.push({ type: 'text', text: `[图片 ${index} 描述失败：${result.message}]` })
      }
    }

    nextMessages.push({ ...message, content: newContent })
  }

  return { messages: nextMessages, assistCount: processed, failures }
}

/**
 * Rewrite only the outbound view for a text-only model. The caller's canonical
 * messages and content arrays are never mutated.
 */
export function replaceUnsupportedVisionContent({ messages = [], modelName = '' } = {}) {
  let replacementCount = 0
  const nextMessages = messages.map((message) => {
    if (!Array.isArray(message?.content) || !message.content.some(isImagePart)) return message
    let imageIndex = 0
    const content = message.content.map((part) => {
      if (!isImagePart(part)) return part
      imageIndex += 1
      replacementCount += 1
      return {
        type: 'text',
        text: `[Image ${imageIndex} omitted: model ${modelName || '(unknown)'} does not accept vision input. Ask the user for a text description or configure Vision Assist if image details are required.]`,
      }
    })
    return { ...message, content }
  })
  return { messages: nextMessages, replacementCount }
}
