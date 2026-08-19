import assert from 'node:assert/strict'
import test from 'node:test'

import { gracefulShutdown } from '../server/core/lifecycle.js'
import { registerPlugin } from '../server/plugins/pluginRegistry.js'
import { getDynamicTool } from '../server/utils/toolSchemaCatalog.js'

test('graceful shutdown waits for runtime plugin disposal before resolving', async () => {
  const order = []
  let releaseDisposer
  const disposerGate = new Promise((resolve) => { releaseDisposer = resolve })
  await registerPlugin({
    id: 'shutdown-plugin',
    name: 'Shutdown Plugin',
    version: '1.0.0',
  }, (ctx) => {
    ctx.tools.register({
      name: 'shutdown_probe',
      spec: {
        type: 'function',
        function: {
          name: 'shutdown_probe',
          description: 'Probe graceful plugin shutdown.',
          parameters: { type: 'object', properties: {} },
        },
      },
      exec: async () => ({ ok: true }),
    })
    return async () => {
      order.push('dispose:start')
      await disposerGate
      order.push('dispose:end')
    }
  })

  const server = {
    close(callback) {
      order.push('http:closed')
      callback()
    },
  }
  const shutdown = gracefulShutdown(server, { silent: true, exit: false })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(order, ['http:closed', 'dispose:start'])
  assert.equal(getDynamicTool('shutdown_probe'), null)

  releaseDisposer()
  assert.equal(await shutdown, 0)
  assert.deepEqual(order, ['http:closed', 'dispose:start', 'dispose:end'])
  assert.equal(getDynamicTool('shutdown_probe'), null)
})
