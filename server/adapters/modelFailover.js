import { logWarn } from '../utils/logger.js'
import { streamWithProviderFallback } from '../utils/modelStreamFailover.js'

/**
 * provider 故障转移适配层(单一来源)。
 *
 * 从 modelProxy.js 抽出 —— 那文件已经压着 codeDebt 阈值,而「什么错误该转移、
 * 转移/重试怎么执行、怎么通知观察者」是一组内聚的职责,理应与请求构建解耦。
 *
 * isProviderFailoverError / runWithProviderFailover / streamWithProviderFailover
 * 都从这里出,modelProxy.js 只 re-export 保持对测试与调用方的兼容。
 */

export function isProviderFailoverError(error) {
  if (error?.name === 'AbortError') return false
  // ★ 我们自己造的超时**绝不**触发故障转移。
  // 原来超时被转成 status 504,而 504 >= 500 判定为可转移 —— 于是
  // 「本地模型首 token 慢」不应触发静默切云端。AbortError 那道守卫
  // 因为错误已经被改写成 504 而完全失效。
  if (error?.code === 'MODEL_TIMEOUT') return false
  // ★ 思考失控同理:换个 provider 重来一遍只会重复消耗资源,
  // 而且大概率同样停不下来(问题在任务本身,不在这个 provider)。
  if (error?.code === 'REASONING_RUNAWAY') return false
  const status = Number(error?.status ?? error?.statusCode)
  if (!Number.isFinite(status) || status <= 0) return true
  return status === 408 || status === 429 || status >= 500
}

export async function runWithProviderFailover(configs, operation, { signal } = {}) {
  let lastError = null
  const attempted = []
  for (let index = 0; index < configs.length; index += 1) {
    const config = configs[index]
    attempted.push(config.providerId || config.baseUrl)
    try {
      return await operation(config)
    } catch (error) {
      lastError = error
      const hasNext = index + 1 < configs.length
      if (!hasNext || signal?.aborted || !isProviderFailoverError(error)) throw error
      logWarn('model.provider_failover', error, {
        from: config.providerId || config.baseUrl,
        to: configs[index + 1].providerId || configs[index + 1].baseUrl,
        model: config.modelName,
      })
    }
  }
  if (lastError) {
    lastError.attemptedProviders = attempted
    throw lastError
  }
  throw new Error('没有可用的模型 provider')
}

export async function* streamWithProviderFailover(configs, createStream, {
  onFailover,
  onRetry,
  ...options
} = {}) {
  // 观测回调(给 turn 事件流用的降级可视化)抛错绝不打断故障转移/重试本身。
  const observe = (callback) => (payload) => {
    if (typeof callback === 'function') {
      try { callback(payload) } catch { /* noop */ }
    }
  }
  const emitFailover = observe(onFailover)
  const emitRetry = observe(onRetry)
  yield* streamWithProviderFallback(configs, createStream, {
    ...options,
    isFailoverError: isProviderFailoverError,
    onRetry: ({ attempt, delayMs, error, config }) => {
      logWarn('model.stream_retry', error, {
        attempt, delayMs, provider: config.providerId || config.baseUrl, model: config.modelName,
      })
      emitRetry({ kind: 'retry', attempt, delayMs, from: config.providerId || config.baseUrl, modelName: config.modelName })
    },
    onFailover: ({ error, config, nextConfig }) => {
      logWarn('model.provider_failover', error, {
        from: config.providerId || config.baseUrl,
        to: nextConfig.providerId || nextConfig.baseUrl,
        model: config.modelName,
        stream: true,
      })
      emitFailover({ kind: 'failover', from: config.providerId || config.baseUrl, to: nextConfig.providerId || nextConfig.baseUrl, modelName: nextConfig.modelName })
    },
  })
}
