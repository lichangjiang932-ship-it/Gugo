/**
 * The terminal interaction ports a headless Turn needs: approval, directory
 * authorization and unknown-side-effect recovery.
 *
 * Both CLI entry points (`gugo run` and `gugo chat`) must supply the same three
 * callbacks. They previously did not: `run` wired all three while `chat` wired
 * none, so a chat turn that needed a command approval, an extra directory, or a
 * side-effect decision was silently denied by the runtime's fail-closed
 * default. Building them from one factory is what keeps the two entry points
 * from drifting again.
 *
 * 交互端口工厂：`gugo run` 与 `gugo chat` 必须传入同一组回调（审批 / 目录授权 /
 * 副作用恢复）。以前 run 传了、chat 没传，于是 chat 里一旦需要审批就被运行时
 * 的 fail-closed 默认拒绝。
 */
import { createInterface } from 'node:readline'
import { createRunRecoveryPrompts } from './runRecoveryPrompts.js'

/**
 * Ask one yes/no approval question on the terminal.
 *
 * Creates its own readline because it is called from inside a turn, at a point
 * where no other reader owns stdin.
 */
export function createApprovalPrompt(input, diagnostics, signal = null) {
  return async (event) => {
    if (signal?.aborted) return { decision: 'deny' }
    const tool = event?.payload?.toolName || 'unknown'
    const args = JSON.stringify(event?.payload?.args || {})
    const rl = createInterface({ input, output: diagnostics })
    try {
      const answer = await new Promise((done) => {
        let settled = false
        const finish = (value = '') => {
          if (settled) return
          settled = true
          signal?.removeEventListener('abort', abort)
          done(value)
        }
        const abort = () => {
          finish('')
          rl.close()
        }
        signal?.addEventListener('abort', abort, { once: true })
        rl.once('close', () => finish(''))
        rl.question(`[approval] tool=${tool} args=${args} [y/N] `, finish)
      })
      return { decision: /^y(?:es)?$/i.test(String(answer).trim()) ? 'approve' : 'deny' }
    } finally {
      rl.close()
    }
  }
}

/**
 * @returns {{onApproval: Function, onDirectoryRequest: Function, onSideEffectRecovery: Function}}
 */
export function createRunInteractionPorts({
  stdin = process.stdin,
  diagnostics = process.stderr,
  signal = null,
  createInterfaceImpl = createInterface,
} = {}) {
  const recovery = createRunRecoveryPrompts(stdin, diagnostics, { signal, createInterfaceImpl })
  return {
    onApproval: createApprovalPrompt(stdin, diagnostics, signal),
    onDirectoryRequest: recovery.onDirectoryRequest,
    onSideEffectRecovery: recovery.onSideEffectRecovery,
  }
}
