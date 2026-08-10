import { withRetry } from './modelRetry.js'

/**
 * 在首个流事件到达前重试或切换 provider。
 * 一旦已经向下游发出事件，任何错误都会原样抛出，避免重复输出。
 */
export async function* streamWithProviderFallback(configs, createStream, {
  signal,
  maxAttemptsPerProvider = 2,
  retryBaseMs = 250,
  retryMaxMs = 2_000,
  retrySleepImpl,
  isFailoverError = () => false,
  onRetry,
  onFailover,
} = {}) {
  for (let index = 0; index < configs.length; index += 1) {
    const config = configs[index]
    let emitted = false
    let opened = null
    let iteratorFinished = false
    try {
      opened = await withRetry(async () => {
        const iterator = createStream(config)?.[Symbol.asyncIterator]?.()
        if (!iterator) throw new Error('模型流不是有效的异步迭代器')
        try {
          const first = await iterator.next()
          return { iterator, first }
        } catch (error) {
          try { await iterator.return?.() } catch { /* best effort */ }
          throw error
        }
      }, {
        maxAttempts: maxAttemptsPerProvider,
        baseMs: retryBaseMs,
        maxMs: retryMaxMs,
        signal,
        ...(typeof retrySleepImpl === 'function' ? { sleepImpl: retrySleepImpl } : {}),
        onRetry: (info) => onRetry?.({ ...info, config }),
      })
      if (opened.first.done) {
        iteratorFinished = true
        return
      }
      emitted = true
      yield { event: opened.first.value, config }
      while (true) {
        const next = await opened.iterator.next()
        if (next.done) {
          iteratorFinished = true
          break
        }
        emitted = true
        yield { event: next.value, config }
      }
      return
    } catch (error) {
      const nextConfig = configs[index + 1]
      if (emitted || !nextConfig || signal?.aborted || !isFailoverError(error)) throw error
      onFailover?.({ error, config, nextConfig })
    } finally {
      // The provider iterator is driven manually. If the outer consumer
      // breaks or cancels, close the inner iterator so its socket/reader does
      // not remain alive after this wrapper has stopped yielding.
      if (opened?.iterator && !iteratorFinished) {
        try { await opened.iterator.return?.() } catch { /* best effort cleanup */ }
      }
    }
  }
}
