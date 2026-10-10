const TRANSITIONS = {
  placed: { pay: 'paid', cancel: 'cancelled' },
  paid: { ship: 'shipped', refund: 'refunded' },
  shipped: { deliver: 'delivered', refund: 'refunded' },
}

export function nextStatus(status, event) {
  const row = TRANSITIONS[status]
  if (!row) return 'unknown'
  return row[event] || status
}
