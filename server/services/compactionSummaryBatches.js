export const DEFAULT_SUMMARY_INPUT_TOKEN_BUDGET = 64_000
const MIN_SUMMARY_INPUT_TOKEN_BUDGET = 2_048
const SUMMARY_INPUT_OVERHEAD_TOKENS = 768

function textTokens(value) {
  let ascii = 0
  let other = 0
  for (const char of typeof value === 'string' ? value : JSON.stringify(value)) {
    if (char.charCodeAt(0) <= 0x7f) ascii += 1
    else other += 1
  }
  return Math.ceil(ascii / 4) + other
}

function messageText(message) {
  if (typeof message?.content === 'string') return message.content
  if (!Array.isArray(message?.content)) return ''
  return message.content.map((part) => (
    ['text', 'input_text'].includes(part?.type) ? String(part.text || '')
      : ['image_url', 'input_image'].includes(part?.type) ? '[image]' : ''
  )).join('\n')
}

/** Split by the serialized JSON cost, including escapes, without dropping bytes. */
function splitText(value, budget) {
  const chunks = []
  let chunk = ''
  let cost = 0
  for (const char of value) {
    const encoded = JSON.stringify(char).slice(1, -1)
    const next = [...encoded].reduce((total, unit) => total + (unit.charCodeAt(0) <= 0x7f ? 0.25 : 1), 0)
    if (chunk && cost + next > budget) {
      chunks.push(chunk)
      chunk = ''
      cost = 0
    }
    chunk += char
    cost += next
  }
  if (chunk || !chunks.length) chunks.push(chunk)
  return chunks
}

function messageFragments(message, index, maxTokens) {
  const base = { index, role: message?.role, toolCallId: message?.tool_call_id, name: message?.name }
  const fields = { content: messageText(message), ...(message?.tool_calls ? { toolCalls: JSON.stringify(message.tool_calls) } : {}) }
  const whole = { ...base, ...fields }
  if (textTokens(whole) <= maxTokens) return [whole]
  const budget = Math.max(64, maxTokens - textTokens(base) - 96)
  return Object.entries(fields).flatMap(([field, value]) => {
    const chunks = splitText(value, budget)
    return chunks.map((chunk, part) => ({ ...base, [field]: chunk, fragmentField: field, fragment: part + 1, fragments: chunks.length }))
  })
}

export function buildCompactionSummaryBatches({ archivedMessages = [], inputTokenBudget = DEFAULT_SUMMARY_INPUT_TOKEN_BUDGET } = {}) {
  const budget = Math.max(MIN_SUMMARY_INPUT_TOKEN_BUDGET, Math.floor(Number(inputTokenBudget) || DEFAULT_SUMMARY_INPUT_TOKEN_BUDGET))
  const payloadBudget = Math.max(1_024, budget - SUMMARY_INPUT_OVERHEAD_TOKENS)
  const maxMessageTokens = Math.max(512, Math.floor(payloadBudget * 0.45))
  const batches = []
  let values = []
  let tokens = 0
  let splitMessageCount = 0
  for (const [index, message] of archivedMessages.entries()) {
    const fragments = messageFragments(message, index, maxMessageTokens)
    if (fragments.length > 1) splitMessageCount += 1
    for (const fragment of fragments) {
      const entryTokens = textTokens(fragment) + 8
      if (values.length && tokens + entryTokens > payloadBudget) {
        batches.push(values)
        values = []
        tokens = 0
      }
      values.push(fragment)
      tokens += entryTokens
    }
  }
  if (values.length || !batches.length) batches.push(values)
  return { batches, inputTokenBudget: budget, truncatedMessageCount: 0, splitMessageCount }
}
