import assert from 'node:assert/strict'
import test from 'node:test'
import { offlineVerificationHttpGuard } from '../scripts/file-delivery-verification/offlineHttpGuard.mjs'

function request(method, url, dispatch = () => {}) {
  let nextCalls = 0
  let bodyReads = 0
  const req = {
    method, url,
    get body() { bodyReads += 1; throw new Error('Request body must not be read') },
    [Symbol.asyncIterator]() { bodyReads += 1; throw new Error('Request stream must not be read') },
  }
  const res = {
    status: null, headers: null, body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(body = '') { this.body += body },
  }
  offlineVerificationHttpGuard(req, res, () => { nextCalls += 1; dispatch(req) })
  return { nextCalls, bodyReads, ...res }
}

test('offline UI preserves static assets, local settings reads and only local auth bootstrap', () => {
  for (const url of [
    '/', '/src/main.jsx', '/@vite/client', '/fonts/AtkinsonHyperlegible-Regular.woff2',
    '/api/health', '/api/account/me', '/api/llm/providers', '/api/llm/catalog',
    '/api/model/status', '/api/model/providers', '/api/model/catalog',
    '/api/model/catalog?providers=1&q=local+model', '/api/model/catalog/openai',
    '/api/system/runtime-config', '/api/system/network-policy', '/api/tool-permissions',
  ]) {
    const result = request('GET', url)
    assert.equal(result.nextCalls, 1, url)
    assert.equal(result.status, null, url)
  }
  assert.equal(request('HEAD', '/fonts/local.woff2').nextCalls, 1)
  assert.equal(request('POST', '/api/auth/bootstrap').nextCalls, 1)
  assert.equal(request('POST', '/api/auth/bootstrap?check=1').nextCalls, 0)
})

test('provider credentials cannot reach a persistence consumer or be echoed by the offline host', () => {
  const persisted = []
  for (const [method, url] of [
    ['POST', '/api/llm/providers'], ['PUT', '/api/llm/providers/fixture/credential'],
    ['POST', '/api/model/providers'], ['PUT', '/api/llm/default-model'],
    ['POST', '/api/llm/import'], ['POST', '/api/llm/open-config'],
  ]) {
    const result = request(method, url, () => persisted.push('synthetic-secret'))
    assert.equal(result.nextCalls, 0, url)
    assert.equal(result.bodyReads, 0, url)
    assert.equal(result.status, 403, url)
    assert.equal(JSON.parse(result.body).error.code, 'FILE_DELIVERY_OFFLINE_HTTP_DENIED')
    assert.ok(!result.body.includes('synthetic-secret'))
    assert.equal(result.headers['Cache-Control'], 'no-store')
  }
  assert.deepEqual(persisted, [])
})

test('all probes, model generation and network-triggering reads stop before the consumer', () => {
  let probes = 0
  for (const url of [
    '/api/llm/probe', '/api/llm/providers/fixture/probe', '/api/llm/models-dev',
    '/api/model/providers/discover', '/api/model/providers/fixture/test',
    '/api/model/catalog/refresh', '/api/model/test', '/api/model/chat',
    '/api/system/diagnostics', '/api/system/diagnostics?check=1',
    '/api/bridge/wechat/qrcode', '/api/browser', '/api/tools/fs/read',
    '/api/system/user-data/export', '/api/unknown-future-route',
  ]) {
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const result = request(method, url, () => { probes += 1 })
      assert.equal(result.nextCalls, 0, `${method} ${url}`)
      assert.equal(result.status, 403)
      assert.equal(result.bodyReads, 0)
    }
  }
  assert.equal(probes, 0)
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'get']) {
    assert.equal(request(method, '/api/llm/providers').nextCalls, 0, method)
  }
})

test('encoded paths, ambiguous request targets and query tricks do not bypass the offline guard', () => {
  for (const url of [
    '/%61pi/llm/probe', '/api/%6clm/probe', '/api%2fllm%2fprobe',
    '/%2561pi/llm/probe', '/api/llm/%70roviders', '/api/llm/providers%2f..%2fprobe',
    '/api/llm/providers/../probe', '/other/../api/llm/providers',
    '//localhost/api/llm/providers', 'http://localhost/api/llm/providers',
    '/api\\llm\\providers', '/api//llm/providers', '/API/llm/providers',
    '/api/llm/providers#ignored', '/api/llm/providers\n', '/api/%zz',
    '/api/llm/providers?check=1', '/api/model/status?check=1',
    '/api/model/catalog?%63heck=1', '/api/model/catalog?providers=1&check=1',
    '/api/model/catalog?providers=1&providers=0', '/api/model/catalog?providers=1&q=a&q=b',
    '/api/model/catalog?providers=1%26check%3d1', '/api/model/catalog?providers=false',
    '/api/model/catalog/openai?refresh=1', '/api/auth/bootstrap?%63heck=1',
  ]) {
    const result = request('GET', url)
    assert.equal(result.nextCalls, 0, url)
    assert.equal(result.status, 403, url)
  }
})
