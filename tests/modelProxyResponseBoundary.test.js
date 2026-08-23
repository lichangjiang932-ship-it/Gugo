import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import * as modelProxy from '../server/adapters/modelProxy.js'
import * as proxyErrors from '../server/adapters/modelProxyErrors.js'
import * as responseCoordinator from '../server/adapters/modelProxyResponseCoordinator.js'

const proxySourceUrl = new URL('../server/adapters/modelProxy.js', import.meta.url)
const httpSourceUrl = new URL('../server/adapters/modelProxyHttp.js', import.meta.url)
const coordinatorSourceUrl = new URL('../server/adapters/modelProxyResponseCoordinator.js', import.meta.url)
const transportSourceUrl = new URL('../server/adapters/modelRequestTransport.js', import.meta.url)

test('modelProxy keeps response and error exports as identity-preserving compatibility aliases', () => {
  assert.equal(modelProxy.streamOpenAICompatible, responseCoordinator.streamOpenAICompatible)
  assert.equal(modelProxy.shouldScheduleStreamAutoMemory, responseCoordinator.shouldScheduleStreamAutoMemory)
  assert.equal(modelProxy.formatProxyError, proxyErrors.formatProxyError)
  assert.equal(modelProxy.isContextLengthError, proxyErrors.isContextLengthError)
})

test('modelProxy HTTP leaf delegates response policy while the facade remains composition-only', async () => {
  const [proxySource, httpSource, coordinatorSource] = await Promise.all([
    readFile(proxySourceUrl, 'utf8'),
    readFile(httpSourceUrl, 'utf8'),
    readFile(coordinatorSourceUrl, 'utf8'),
  ])
  for (const protocolToken of [
    "'Content-Type': 'text/event-stream'",
    "'X-Accel-Buffering': 'no'",
    "phase: 'connecting'",
    "': keepalive\\n\\n'",
    'scheduleAutoMemoryExtraction({',
  ]) {
    const tokenPattern = new RegExp(protocolToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    assert.doesNotMatch(proxySource, tokenPattern)
    assert.doesNotMatch(httpSource, tokenPattern)
    assert.match(coordinatorSource, tokenPattern)
  }
  assert.match(proxySource, /createModelProxyHttpAdapter\(\{/)
  assert.match(proxySource, /modelProxyHttpAdapter\.handleModelProxyRequest/)
  assert.doesNotMatch(proxySource, /handle(?:Streaming|NonStreaming)ModelProxyResponse\(\{/)
  assert.match(httpSource, /handleStreamingModelProxyResponse\(\{/)
  assert.match(httpSource, /handleNonStreamingModelProxyResponse\(\{/)
  assert.doesNotMatch(httpSource, /from ['"]\.\/modelProxy\.js['"]/)
})

test('attempt-local request transport remains a leaf and never imports the proxy facade', async () => {
  const source = await readFile(transportSourceUrl, 'utf8')
  assert.doesNotMatch(source, /modelProxy(?:ResponseCoordinator)?\.js/)
  assert.match(source, /throwIfModelRequestAbortedBeforeSend/)
  assert.match(source, /fetchModelOutbound/)
})
