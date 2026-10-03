/**
 * Feature 1: MCP stdio transport
 *
 * 协议：stdin/stdout 用 NDJSON（一行一条 JSON-RPC 消息，UTF-8）。
 * 子进程 stderr 进 server 日志，不当协议消息。
 *
 * Windows 适配：
 *   - 原生 node / python / uvx 解析到可信本机 .exe，不追加 .cmd。
 *   - npm/npx 用本机 Node + npm-cli.js/npx-cli.js 启动，绝不通过 cmd.exe。
 *   - 进程终止: child.kill() 在 Windows 对部分 Node 子进程无效 → 3s 后 taskkill /T /F /PID
 *
 * 安全：
 *   - 命令白名单 (mcpManager 校验)
 *   - 不走 shell（shell:false 永远）
 *   - 净化宿主 env；只向 MCP 进程注入该连接显式配置的 env
 *   - 即使显式配置也拒绝 NODE_OPTIONS / LD_PRELOAD 等启动时注入变量
 *   - 子进程 stdout 缓冲超过 1MB 强制断开（防止恶意 server 灌爆内存）
 */

import { spawn } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { terminateProcessTree } from '../utils/processGroup.js'
import { resolveMcpStdioCommand } from './mcpStdioCommand.js'

const STDOUT_BUFFER_LIMIT = 1024 * 1024 // 1MB
const WINDOWS_FORCE_KILL_DELAY_MS = 3_000
const STOP_WAIT_MS = 18_000

// ★ P0:与 fsShellTools / gitWorkbench 共用统一规则(覆盖所有 *_API_KEY / *_TOKEN / *_SECRET / *_PASSWORD)
import { sanitizeChildEnv } from '../utils/sensitiveEnv.js'

function sanitizeEnv(extra = {}, options = {}) {
  const explicitKeys = extra && typeof extra === 'object' ? Object.keys(extra) : []
  return sanitizeChildEnv(extra, { ...options, allowExtraKeys: explicitKeys })
}

function startupError(error) {
  if (String(error?.code || '').startsWith('MCP_STDIO_')) return error
  const systemCode = /^[A-Z0-9_]+$/u.test(String(error?.code || '')) ? String(error.code) : 'UNKNOWN'
  return Object.assign(new Error(`MCP stdio could not start (${systemCode}); check the executable, working directory and local installation.`), {
    code: 'MCP_STDIO_START_FAILED', systemCode, retryable: false,
  })
}

function hasChildExited(child) {
  return child?.exitCode != null || child?.signalCode != null
}

export class StdioTransport {
  constructor(
    { command, args = [], cwd = process.cwd(), env = {}, label = 'mcp' },
    {
      platform = process.platform,
      spawnFn = spawn,
      resolveCommandFn = resolveMcpStdioCommand,
      sourceEnv = process.env,
      executablePath = process.execPath,
      terminateProcessTreeFn = terminateProcessTree,
      forceKillDelayMs = WINDOWS_FORCE_KILL_DELAY_MS,
      stopWaitMs = STOP_WAIT_MS,
    } = {},
  ) {
    this.command = command
    this.args = args
    this.cwd = cwd
    this.env = env
    this.label = label
    this.child = null
    this.buffer = ''
    this.bufferBytes = 0
    this.pending = new Map() // requestId → { resolve, reject, timer }
    this.notificationHandlers = new Set()
    this.errorHandlers = new Set()
    this.closeHandlers = new Set()
    this.exitHandlers = new Set()
    this.stderr = ''
    this.closed = false
    this.intentionalStop = false
    this.closeEmitted = false
    this.exitEmitted = false
    this.platform = platform
    this.spawnFn = spawnFn
    this.resolveCommandFn = resolveCommandFn
    this.sourceEnv = sourceEnv
    this.executablePath = executablePath
    this.spawned = false
    this.startError = null
    this.terminateProcessTreeFn = terminateProcessTreeFn
    this.forceKillDelayMs = forceKillDelayMs
    this.stopWaitMs = stopWaitMs
    this.forceKillTimer = null
    this.stopPromise = null
  }

  start() {
    if (this.child) return
    if (this.closed) throw this.startError || new Error('MCP stdio transport is closed')
    try {
      const resolved = this.resolveCommandFn({ command: this.command, args: this.args }, {
        platform: this.platform, executablePath: this.executablePath,
        sourceEnv: this.sourceEnv, cwd: this.cwd,
      })
      this.child = this.spawnFn(resolved.command, resolved.args, {
        cwd: this.cwd,
        env: sanitizeEnv(this.env, { sourceEnv: this.sourceEnv, platform: this.platform }),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      })
    } catch (error) {
      const failure = this._failStartup(error)
      throw failure
    }

    this.child.once('spawn', () => { this.spawned = true })
    this.child.on('error', (err) => {
      if (!this.spawned) { this._failStartup(err); return }
      this._emitError(err)
      this._rejectAll(err)
    })
    this.child.on('exit', (code, signal) => {
      this._clearForceKillTimer()
      this.closed = true
      const reason = new Error(`MCP server "${this.label}" 已退出 (code=${code}, signal=${signal})`)
      this._rejectAll(reason)
      const details = { code, signal, reason, intentional: this.intentionalStop }
      this._emitExit(details)
      if (!this.intentionalStop) this._emitError(reason)
    })
    this.child.on('close', (code, signal) => {
      this._clearForceKillTimer()
      this.closed = true
      const reason = this.startError || new Error(`MCP server "${this.label}" 已关闭 (code=${code}, signal=${signal})`)
      this._rejectAll(reason)
      this._emitClose({ code, signal, reason, intentional: this.intentionalStop })
    })

    this.child.stdout.setEncoding('utf8')
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) {
      stream.on('error', (error) => this._handleStreamError(error))
    }
    this.child.stdout.on('data', (chunk) => this._handleStdout(chunk))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk
      // 限制 stderr 缓冲
      if (this.stderr.length > 16 * 1024) this.stderr = this.stderr.slice(-16 * 1024)
    })
  }

  _failStartup(error) {
    if (this.startError) return this.startError
    this.startError = startupError(error)
    this.closed = true
    this._rejectAll(this.startError)
    this._emitError(this.startError)
    this._emitClose({ code: null, signal: null, reason: this.startError, intentional: false })
    return this.startError
  }

  _handleStreamError(error) {
    if (!this.spawned) { this._failStartup(error); return }
    const detail = startupError(error)
    const failure = Object.assign(new Error(`MCP stdio pipe failed (${detail.systemCode || 'UNKNOWN'}).`), {
      code: 'MCP_STDIO_IO_FAILED', systemCode: detail.systemCode,
    })
    this._rejectAll(failure)
    this._emitError(failure)
  }

  _handleStdout(chunk) {
    this.buffer += chunk
    this.bufferBytes += Buffer.byteLength(chunk)
    let consumedLine = false
    let idx
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const rawLine = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 1)
      consumedLine = true
      if (Buffer.byteLength(rawLine) > STDOUT_BUFFER_LIMIT) {
        this._stopForStdoutLimit()
        return
      }
      const line = rawLine.trim()
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch (err) {
        this._emitError(new Error(`MCP "${this.label}" stdout 非 JSON: ${err.message}`))
        continue
      }
      this._dispatch(msg)
    }
    if (consumedLine) this.bufferBytes = Buffer.byteLength(this.buffer)
    if (this.bufferBytes > STDOUT_BUFFER_LIMIT) this._stopForStdoutLimit()
  }

  _stopForStdoutLimit() {
    const err = new Error(`MCP server "${this.label}" stdout 超过 ${STDOUT_BUFFER_LIMIT} 字节, 强制断开`)
    this._emitError(err)
    this.stop()
  }

  _dispatch(msg) {
    if (msg && typeof msg === 'object') {
      if (msg.id !== undefined && msg.id !== null && this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        clearTimeout(entry.timer)
        entry.cleanup?.()
        if (msg.error) {
          entry.reject(Object.assign(new Error(msg.error.message || 'MCP error'), { code: msg.error.code }))
        } else {
          entry.resolve(msg.result)
        }
        return
      }
      // 通知 (无 id)
      if (msg.method && msg.id === undefined) {
        for (const fn of this.notificationHandlers) {
          try { fn(msg) } catch { /* ignore */ }
        }
      }
    }
  }

  onNotification(fn) {
    this.notificationHandlers.add(fn)
    return () => this.notificationHandlers.delete(fn)
  }

  onError(fn) {
    this.errorHandlers.add(fn)
    return () => this.errorHandlers.delete(fn)
  }

  onClose(fn) {
    this.closeHandlers.add(fn)
    return () => this.closeHandlers.delete(fn)
  }

  onExit(fn) {
    this.exitHandlers.add(fn)
    return () => this.exitHandlers.delete(fn)
  }

  _emitError(err) {
    for (const fn of this.errorHandlers) {
      try { fn(err) } catch { /* ignore */ }
    }
  }

  _emitClose(details) {
    if (this.closeEmitted) return
    this.closeEmitted = true
    for (const fn of this.closeHandlers) {
      try { fn(details) } catch { /* ignore */ }
    }
  }

  _emitExit(details) {
    if (this.exitEmitted) return
    this.exitEmitted = true
    for (const fn of this.exitHandlers) {
      try { fn(details) } catch { /* ignore */ }
    }
  }

  _rejectAll(err) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.cleanup?.()
      try { entry.reject(err) } catch { /* ignore */ }
    }
    this.pending.clear()
  }

  send(message) {
    if (!this.child || this.closed) {
      return Promise.reject(this.startError || new Error(`MCP "${this.label}" 已关闭`))
    }
    const line = JSON.stringify(message) + '\n'
    return new Promise((resolve, reject) => {
      this.child.stdin.write(line, 'utf8', (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  /**
   * 发请求 + 等待 id 对应的响应，超时拒绝。
   */
  request(message, { timeoutMs = 30000, signal } = {}) {
    if (message.id === undefined) {
      return this.send(message)
    }
    if (signal?.aborted) return Promise.reject(signal.reason || new DOMException('MCP request cancelled', 'AbortError'))
    const id = message.id
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const entry = this.pending.get(id)
        if (!entry) return
        this.pending.delete(id)
        clearTimeout(entry.timer)
        signal?.removeEventListener?.('abort', onAbort)
        this.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'cancelled' } }).catch(() => {})
        reject(signal.reason || new DOMException('MCP request cancelled', 'AbortError'))
      }
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          signal?.removeEventListener?.('abort', onAbort)
          reject(new Error(`MCP "${this.label}" 请求超时 (${message.method})`))
        }
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, cleanup: () => signal?.removeEventListener?.('abort', onAbort) })
      signal?.addEventListener?.('abort', onAbort, { once: true })
      this.send(message).catch((err) => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          clearTimeout(timer)
          signal?.removeEventListener?.('abort', onAbort)
          reject(err)
        }
      })
    })
  }

  /**
   * 优雅关闭。Windows 上 SIGTERM 对某些进程无效 → 3s 后清理整个进程树。
   */
  stop() {
    if (this.stopPromise) return this.stopPromise
    if (!this.child || this.closed) return Promise.resolve(hasChildExited(this.child))
    this.intentionalStop = true
    this.closed = true
    const child = this.child
    this.stopPromise = this._waitForChildExit(child)
    try { child.stdin.end() } catch { /* ignore */ }
    try { child.kill() } catch { /* ignore */ }
    this._scheduleForceKill(child)
    this._rejectAll(new Error(`MCP "${this.label}" 主动关闭`))
    return this.stopPromise
  }

  _clearForceKillTimer() {
    if (!this.forceKillTimer) return
    clearTimeout(this.forceKillTimer)
    this.forceKillTimer = null
  }

  _scheduleForceKill(child) {
    if (this.platform !== 'win32' || !Number.isInteger(child?.pid) || child.pid <= 0) return
    const pid = child.pid
    const timer = setTimeout(() => {
      if (this.forceKillTimer !== timer) return
      this.forceKillTimer = null
      if (this.child !== child || hasChildExited(child)) return
      try {
        void Promise.resolve(this.terminateProcessTreeFn({ pid, child })).catch(() => {})
      } catch { /* best effort */ }
    }, this.forceKillDelayMs)
    timer.unref?.()
    this.forceKillTimer = timer
  }

  _waitForChildExit(child) {
    if (hasChildExited(child)) return Promise.resolve(true)
    if (typeof child?.once !== 'function') return Promise.resolve(false)
    return new Promise((resolve) => {
      let settled = false
      let waitTimer = null
      const finish = (exited) => {
        if (settled) return
        settled = true
        if (waitTimer) clearTimeout(waitTimer)
        child.off?.('exit', onExit)
        child.off?.('close', onExit)
        if (exited) this._clearForceKillTimer()
        resolve(Boolean(exited))
      }
      const onExit = () => finish(true)
      child.once('exit', onExit)
      child.once('close', onExit)
      waitTimer = setTimeout(() => finish(hasChildExited(child)), this.stopWaitMs)
      waitTimer.unref?.()
    })
  }

  isAlive() {
    return !!this.child && !this.closed
  }

  getStderrSample(limit = 2048) {
    return this.stderr.slice(-limit)
  }
}
