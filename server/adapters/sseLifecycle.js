/**
 * Listen only for genuine SSE disconnects. A normal POST request-body close is
 * not a client disconnect, so request-side cancellation uses `aborted` only.
 */
export function bindSseClientDisconnect(req, res, onDisconnect) {
  let disconnected = false
  const notify = () => {
    if (disconnected || res.writableEnded) return
    disconnected = true
    onDisconnect?.()
  }
  const onRequestAborted = () => notify()
  const onResponseClose = () => {
    if (!res.writableEnded) notify()
  }
  req.on('aborted', onRequestAborted)
  res.on('close', onResponseClose)
  return () => {
    req.off('aborted', onRequestAborted)
    res.off('close', onResponseClose)
  }
}

export function createEmptyModelResponseError(finishReason) {
  const outputLimitReached = finishReason === 'length'
  const error = new Error(outputLimitReached
    ? '模型的输出预算已用尽，但没有生成可见回复。请调大 Max Tokens 或关闭深度思考后重试。'
    : '模型返回了空回复。请检查本地模型的聊天模板、上下文长度和 OpenAI 兼容接口。')
  error.code = outputLimitReached ? 'EMPTY_MODEL_RESPONSE_LENGTH' : 'EMPTY_MODEL_RESPONSE'
  return error
}
