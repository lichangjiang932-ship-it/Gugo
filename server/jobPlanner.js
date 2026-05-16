const CHINESE_DIGITS = Object.freeze({
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
})

function parseRequestedCount(prompt = '') {
  const arabic = String(prompt).match(/(\d+)\s*(?:份|个|条|篇|组|套)/)
  if (arabic) return Number(arabic[1])

  const chinese = String(prompt).match(/([一二两三四五六七八九十]{1,3})\s*(?:份|个|条|篇|组|套)/)
  if (!chinese) return 0
  const token = chinese[1]
  if (token === '十') return 10
  if (token.length === 2 && token.startsWith('十')) return 10 + (CHINESE_DIGITS[token[1]] || 0)
  if (token.length === 2 && token.endsWith('十')) return (CHINESE_DIGITS[token[0]] || 0) * 10
  if (token.length === 3 && token[1] === '十') {
    return (CHINESE_DIGITS[token[0]] || 0) * 10 + (CHINESE_DIGITS[token[2]] || 0)
  }
  return CHINESE_DIGITS[token] || 0
}

function buildStepId(kind, index = 0) {
  return index > 0 ? `${kind}-${index}` : kind
}

export function buildInitialPlan(prompt = '') {
  const trimmed = String(prompt || '').trim()
  const title = trimmed || '未命名任务'
  const count = parseRequestedCount(trimmed)
  const steps = [
    { id: buildStepId('plan'), title: '规划任务', kind: 'plan' },
  ]

  if (count > 1) {
    for (let index = 1; index <= count; index += 1) {
      steps.push({
        id: buildStepId('item', index),
        title: `生成 ${index} / ${count}`,
        kind: 'batch_item',
        input: { index, total: count },
      })
    }
  } else {
    steps.push({ id: buildStepId('execute'), title: '执行任务', kind: 'execute' })
  }

  steps.push({ id: buildStepId('finalize'), title: '汇总结果', kind: 'finalize' })
  return { title, prompt: trimmed, steps }
}

export function getRequestedBatchSize(prompt = '') {
  return parseRequestedCount(prompt)
}

