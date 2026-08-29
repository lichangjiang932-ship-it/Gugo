import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import {
  CODEX_APP_SERVER_REASON,
  closeCodexAppServerRuntime,
  startCodexAppServerRuntime,
} from '../../server/services/codexAppServerRuntime.js'
import {
  CODEX_APP_SERVER_TOOL_SPECS,
  dispatchCodexAppServerTool,
} from '../../server/services/codexAppServerTool.js'
import { runToolsLoop } from '../../server/services/jobTools.js'
import { defineOfflineEvalCase, defineOfflineEvalSuite } from '../helpers/offlineEvalHarness.js'

function fakeChild(onMessage = () => {}) {
  const child = new EventEmitter()
  child.pid = 4242
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => true
  let pending = ''
  let exited = false
  child.emitExit = (code = 0, signal = null) => {
    if (exited) return
    exited = true
    child.emit('exit', code, signal)
  }
  child.stdin.on('data', (chunk) => {
    pending += chunk.toString('utf8')
    for (;;) {
      const newline = pending.indexOf('\n')
      if (newline < 0) break
      const line = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      if (!line) continue
      Promise.resolve(onMessage(JSON.parse(line), child))
        .catch((error) => child.emit('error', error))
    }
  })
  return child
}

function enabledOptions(overrides = {}) {
  return {
    cwd: 'D:\\workspace',
    env: { CODEX_APP_SERVER_ENABLED: '1' },
    platform: 'win32',
    resolveExecutable: () => ({
      configured: false,
      found: true,
      path: 'C:\\Codex\\codex.exe',
      source: 'desktop-install',
      reasonCode: null,
    }),
    snapshotExecutable: (executable) => ({ path: executable, cleanup() {} }),
    verifySignature: async () => true,
    readVersion: async () => '0.150.0-offline',
    spawnImpl: () => fakeChild((message, child) => {
      if (message.method !== 'initialize') return
      child.stdout.write(`${JSON.stringify({
        id: message.id,
        result: { userAgent: 'codex-offline-eval', platformFamily: 'windows' },
      })}\n`)
    }),
    terminate: async ({ child }) => {
      child.emitExit()
      return true
    },
    handshakeTimeoutMs: 500,
    signatureTimeoutMs: 500,
    versionTimeoutMs: 500,
    exitTimeoutMs: 100,
    ...overrides,
  }
}

function closeRuntime() {
  return closeCodexAppServerRuntime({
    terminate: async ({ child }) => {
      child?.emitExit?.()
      return true
    },
    exitTimeoutMs: 100,
  })
}

const CASES = [
  defineOfflineEvalCase({
    id: 'APP-01',
    category: 'privacy-default',
    title: 'an ordinary local startup performs no Codex discovery or process launch without explicit opt-in',
    async run(ctx) {
      ctx.defer(closeRuntime)
      let discoveries = 0
      let spawns = 0
      const status = await startCodexAppServerRuntime({
        cwd: 'D:\\workspace',
        env: {},
        explicitPath: 'C:\\Codex\\codex.exe',
        platform: 'win32',
        resolveExecutable: () => {
          discoveries += 1
          throw new Error('disabled runtime must not discover executables')
        },
        spawnImpl: () => {
          spawns += 1
          throw new Error('disabled runtime must not spawn')
        },
      })

      assert.equal(status.enabled, false)
      assert.equal(status.ready, false)
      assert.equal(status.reasonCode, CODEX_APP_SERVER_REASON.DISABLED)
      assert.equal(discoveries, 0)
      assert.equal(spawns, 0)
      ctx.metric('implicit_discoveries', discoveries)
      ctx.metric('implicit_spawns', spawns)
      ctx.metric('privacy_default_score', 1)
    },
  }),
  defineOfflineEvalCase({
    id: 'APP-02',
    category: 'task-completion',
    title: 'an explicitly enabled bridge becomes ready only after initialize and initialized complete',
    async run(ctx) {
      let child = null
      const messages = []
      ctx.defer(() => closeCodexAppServerRuntime({
        terminate: async ({ child: target }) => {
          target?.emitExit?.()
          return true
        },
        exitTimeoutMs: 100,
      }))
      const status = await startCodexAppServerRuntime(enabledOptions({
        spawnImpl(executable, args, options) {
          assert.equal(executable, 'C:\\Codex\\codex.exe')
          assert.deepEqual(args, ['app-server'])
          assert.equal(options.shell, false)
          assert.equal(options.windowsHide, true)
          child = fakeChild((message, runningChild) => {
            messages.push(message)
            if (message.method !== 'initialize') return
            runningChild.stdout.write(`${JSON.stringify({
              id: message.id,
              result: { userAgent: 'codex-offline-eval', platformFamily: 'windows' },
            })}\n`)
          })
          return child
        },
      }))

      assert.equal(status.ready, true)
      assert.equal(status.reasonCode, CODEX_APP_SERVER_REASON.READY)
      assert.equal(messages[0].method, 'initialize')
      assert.equal(messages[0].params.clientInfo.name, 'gugo')
      assert.equal(messages[1].method, 'initialized')
      assert.ok(child)
      ctx.metric('protocol_messages', messages.length)
      ctx.metric('handshake_completed', 1)
      ctx.metric('task_score', 1)
    },
  }),
  defineOfflineEvalCase({
    id: 'APP-03',
    category: 'trust-boundary',
    title: 'a failed executable signature stops before version probing and child creation',
    async run(ctx) {
      ctx.defer(closeRuntime)
      const stages = []
      const status = await startCodexAppServerRuntime(enabledOptions({
        verifySignature: async () => {
          stages.push('signature')
          return false
        },
        readVersion: async () => {
          stages.push('version')
          return 'must-not-run'
        },
        spawnImpl: () => {
          stages.push('spawn')
          return fakeChild()
        },
      }))

      assert.deepEqual(stages, ['signature'])
      assert.equal(status.ready, false)
      assert.equal(status.failureStage, 'signature')
      assert.equal(status.reasonCode, CODEX_APP_SERVER_REASON.CLI_SIGNATURE_INVALID)
      ctx.metric('blocked_pre_spawn', 1)
      ctx.metric('untrusted_processes_spawned', 0)
      ctx.metric('trust_boundary_score', 1)
    },
  }),
  defineOfflineEvalCase({
    id: 'APP-04',
    category: 'agent-loop-consumer',
    title: 'an approved Agent Loop call consumes only model/list and feeds its sanitized result back to the model',
    async run(ctx) {
      const protocolMessages = []
      const approvals = []
      ctx.defer(closeRuntime)
      await startCodexAppServerRuntime(enabledOptions({
        spawnImpl: () => fakeChild((message, child) => {
          protocolMessages.push(message)
          if (message.method === 'initialize') {
            child.stdout.write(`${JSON.stringify({
              id: message.id,
              result: { userAgent: 'codex-offline-eval' },
            })}\n`)
          } else if (message.method === 'model/list') {
            child.stdout.write(`${JSON.stringify({
              id: message.id,
              result: {
                data: [{
                  id: 'codex-eval-model',
                  model: 'codex-eval-model',
                  displayName: 'Codex Eval',
                  description: 'Offline fixture',
                  hidden: false,
                  supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'hidden detail' }],
                  inputModalities: ['text'],
                  supportsPersonality: false,
                  isDefault: true,
                  privateState: 'must-not-reach-model',
                }],
                nextCursor: null,
              },
            })}\n`)
          }
        }),
      }))

      let modelCall = 0
      let toolPayload = null
      const result = await runToolsLoop({
        job: {
          id: 'offline-codex-agent-loop',
          userId: 'offline-codex-agent-loop-user',
          origin: 'chat',
          prompt: 'List the available Codex models',
          userPrompt: 'List the available Codex models',
        },
        step: { id: 'offline-codex-agent-loop-step', kind: 'chat' },
        messages: [{ role: 'user', content: 'List the available Codex models' }],
        toolSpecs: CODEX_APP_SERVER_TOOL_SPECS,
        maxIters: 3,
        enableToolHooks: false,
        requestToolApproval: async (request) => {
          approvals.push(request.toolName)
          return { proceed: true, args: request.args, approvalId: 'offline-codex-approved' }
        },
        executeTool: ({ name, args, signal }) => dispatchCodexAppServerTool(name, args, {
          userId: 'offline-codex-agent-loop-user',
          signal,
          audit: false,
        }),
        runModel: async ({ messages }) => {
          modelCall += 1
          if (modelCall === 1) {
            return {
              content: '',
              toolCalls: [{
                id: 'offline-codex-model-list',
                type: 'function',
                function: { name: 'codex_models', arguments: '{"limit":1}' },
              }],
            }
          }
          const toolMessage = messages.find((message) => message.role === 'tool')
          toolPayload = JSON.parse(toolMessage.content)
          return { content: 'Codex model catalog received.', toolCalls: [] }
        },
      })

      assert.equal(result.text, 'Codex model catalog received.')
      assert.deepEqual(approvals, ['codex_models'])
      assert.equal(toolPayload.ok, true)
      assert.equal(toolPayload.models[0].id, 'codex-eval-model')
      assert.equal(JSON.stringify(toolPayload).includes('privateState'), false)
      assert.deepEqual(
        protocolMessages.filter((message) => message.id === 'offline-codex-model-list'),
        [],
        'model-provided call ids must not become app-server request ids',
      )
      assert.deepEqual(
        protocolMessages.filter((message) => message.method === 'model/list').map((message) => message.method),
        ['model/list'],
      )
      assert.equal(protocolMessages.some((message) => (
        !['initialize', 'initialized', 'model/list'].includes(message.method)
      )), false)
      ctx.metric('approval_prompts', approvals.length)
      ctx.metric('model_list_requests', 1)
      ctx.metric('agent_loop_consumer_score', 1)
    },
  }),
]

export default defineOfflineEvalSuite({
  id: 'codex-app-server',
  title: 'Codex app-server opt-in, trust boundary, and approved Agent Loop consumer',
  version: 2,
  cases: CASES,
})
