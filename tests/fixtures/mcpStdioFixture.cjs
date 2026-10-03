const readline = require('node:readline')
const input = readline.createInterface({ input: process.stdin })
const waiting = new Set()
const send = (message, callback) => process.stdout.write(`${JSON.stringify(message)}\n`, callback)
const result = (id, value) => send({ jsonrpc: '2.0', id, result: value })

input.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'notifications/cancelled') {
    const removed = waiting.delete(message.params.requestId)
    send({ jsonrpc: '2.0', method: 'fixture/cancelled', params: { requestId: message.params.requestId, removed } })
    return
  }
  if (message.id == null) return
  if (message.method === 'initialize') {
    result(message.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'isolated-stdio', version: '1.0.0' } })
  } else if (message.method === 'tools/list') {
    result(message.id, { tools: [{ name: 'echo', inputSchema: { type: 'object' } }, { name: 'wait', inputSchema: { type: 'object' } }] })
  } else if (message.method === 'tools/call' && message.params.name === 'wait') {
    waiting.add(message.id)
    send({ jsonrpc: '2.0', method: 'fixture/waiting', params: { requestId: message.id } })
  } else if (message.method === 'tools/call') {
    result(message.id, { content: [{ type: 'text', text: JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), arguments: message.params.arguments }) }] })
  } else if (message.method === 'fixture/exit') {
    send({ jsonrpc: '2.0', id: message.id, result: { ok: true } }, () => { input.close(); process.stdin.destroy() })
  } else {
    result(message.id, {})
  }
})
