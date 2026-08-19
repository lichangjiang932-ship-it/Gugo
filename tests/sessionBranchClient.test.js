import assert from 'node:assert/strict'
import test from 'node:test'

import {
  forkSessionRemote,
  getSessionBranchesRemote,
} from '../src/lib/sessionClient.js'

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

test('session branch clients encode ids and keep label payloads structured', async () => {
  const requests = []
  const fetchImpl = async (url, options) => {
    requests.push({ url, options })
    return response({ ok: true, session: { id: 'forked' }, branches: [] }, 201)
  }

  await forkSessionRemote('session/one', { label: 'Alternative', fetchImpl })
  await getSessionBranchesRemote('session/one', { fetchImpl })

  assert.equal(requests[0].url, '/api/sessions/session%2Fone/fork')
  assert.equal(requests[0].options.method, 'POST')
  assert.equal(requests[0].options.headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(requests[0].options.body), { label: 'Alternative' })
  assert.equal(requests[1].url, '/api/sessions/session%2Fone/branches')
  assert.equal(requests[1].options.method, undefined)
})

test('fork client preserves the active-session conflict code', async () => {
  await assert.rejects(
    forkSessionRemote('busy', {
      label: 'Nope',
      fetchImpl: async () => response({
        error: { code: 'SESSION_ACTIVE', message: 'session has an active turn' },
      }, 409),
    }),
    (error) => {
      assert.equal(error.name, 'SessionRequestError')
      assert.equal(error.code, 'SESSION_ACTIVE')
      assert.equal(error.status, 409)
      return true
    },
  )
})
