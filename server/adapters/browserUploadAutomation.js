import { ACTION_TIMEOUT_MS } from './browserCdpClient.js'
import { elementExpression, elementObjectExpression } from './browserDomAutomation.js'
import { activeBrowserFrameEvaluationParams, activeBrowserFrameSessionId } from './browserFrameAutomation.js'

/** Bind a previously authorized file in the selected frame's protocol session. */
export async function bindBrowserFileInput(session, { target, filePath, signal = null }, evaluate) {
  const protocolSessionId = activeBrowserFrameSessionId(session)
  const evaluated = await session.client.request('Runtime.evaluate', {
    expression: elementObjectExpression(target),
    returnByValue: false,
    userGesture: true,
    ...activeBrowserFrameEvaluationParams(session),
  }, protocolSessionId, ACTION_TIMEOUT_MS, signal)
  if (evaluated.exceptionDetails) {
    throw new Error(evaluated.exceptionDetails.exception?.description
      || evaluated.exceptionDetails.text || '文件输入元素不可用')
  }
  const objectId = evaluated.result?.objectId
  if (!objectId) throw new Error('文件输入元素不可用')
  try {
    await session.client.request('DOM.setFileInputFiles', {
      files: [String(filePath)], objectId,
    }, protocolSessionId, ACTION_TIMEOUT_MS, signal)
    const result = await evaluate(session, elementExpression(target, `
      el.dispatchEvent(new Event('input', {bubbles:true}));
      el.dispatchEvent(new Event('change', {bubbles:true}));
      return {ok:true,count:el.files?.length || 0}
    `), signal)
    if (!result?.ok || result.count !== 1) throw new Error('文件没有绑定到输入元素')
    return result
  } finally {
    try {
      await session.client.request('Runtime.releaseObject', { objectId }, protocolSessionId, ACTION_TIMEOUT_MS, signal)
    } catch { /* object cleanup is best effort */ }
  }
}
