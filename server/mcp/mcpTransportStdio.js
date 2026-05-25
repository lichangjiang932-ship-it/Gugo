/**
 * Feature 1: MCP stdio transport
 *
 * 协议：stdin/stdout 用 NDJSON（一行一条 JSON-RPC 消息，UTF-8）。
 * 子进程 stderr 进 server 日志，不当协议消息。
 *
 * Windows 适配：
 *   - npx / npm 是 .cmd shim, spawn(.cmd, {shell:false}) 直接报 ENOENT
 *   - 解决: detect win32 + 命令无扩展时，让 spawn 走 .cmd（execFile/spawn 都接受）
 *   - 进程终止: child.kill() 在 Windows 对部分 Node 子进程无效 → 3s 后 taskkill /T /F /PID
 *
 * 安全：
 *   - 命令白名单 (mcpManager 校验)
 *   - 不走 shell（shell:false 永远）
 *   - 净化 env（剥 MODEL_API_KEY / APP_SECRET）
 *   - 子进程 stdout 缓冲超过 1MB 强制断开（防止恶意 server 灌爆内存）
 */

import { spawn, execFile } from 'node:child_process'
import { Buffer } from 'node:buffer'

const STDOUT_BUFFER_LIMIT = 1024 * 1024 // 1MB

// ★ P0:与 fsShellTools / gitWorkbench 共用统一规则(覆盖所有 *_API_KEY / *_TOKEN / *_SECRET / *_PASSWORD)
import { sanitizeChildEnv } from '../utils/sensitiveEnv.js'

function sanitizeEnv(extra = {}) {
  return sanitizeChildEnv(extra)
}

export class StdioTransport {
  constructor({ command, args = [], cwd = process.cwd(), env = {}, label = 'mcp' }) {
    this.command = command
    this.args = Array.isArray(args) ? args : []
    this.cwd = cwd
    this.env = env
    this.label = label
    this.child = null
    this.buffer = ''
    this.bufferBytes = 0
    this.pending = new Map() // requestId → { resolve, reject, timer }
    this.notificationHandlers = new Set()
    this.errorHandlers = new Set()
    this.stderr = ''
    this.closed = false
  }

  start() {
    if (this.child) return
    const useWindowsShim = process.platform === 'win32' && /^(npx|npm|node|uvx|python|python3)$/i.test(this.command)
    // 关键: 即便有 .cmd shim 也用 shell:false。
    // Node spawn 在 Windows 上看到 .cmd 自动用 cmd.exe /d /s /c 包装，但参数仍是数组——不会走 shell 解析。
    const finalCommand = useWindowsShim && !/\.[a-z]+$/i.test(this.command)
      ? `${this.command}.cmd`
      : this.command
    this.child = spawn(finalCommand, this.args, {
      cwd: this.cwd,
      env: sanitizeEnv(this.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    })

    this.child.on('error', (err) => {
      this._emitError(err)
      this._rejectAll(err)
    })
    this.child.on('exit', (code, signal) => {
      this.closed = true
      const reason = new Error(`MCP server "${this.label}" 已退出 (code=${code}, signal=${signal})`)
      this._rejectAll(reason)
      this._emitError(reason)
    })

    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk) => this._handleStdout(chunk))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk
      // 限制 stderr 缓冲
      if (this.stderr.length > 16 * 1024) this.stderr = this.stderr.slice(-16 * 1024)
    })
  }

  _handleStdout(chunk) {
    this.buffer += chunk
    this.bufferBytes += Buffer.byteLength(chunk)
    if (this.bufferBytes > STDOUT_BUFFER_LIMIT) {
      const err = new Error(`MCP server "${this.label}" stdout 超过 ${STDOUT_BUFFER_LIMIT} 字节, 强制断开`)
      this._emitError(err)
      this.stop()
      return
    }
    let idx
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
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
  }

  _dispatch(msg) {
    if (msg && typeof msg === 'object') {
      if (msg.id !== undefined && msg.id !== null && this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        clearTimeout(entry.timer)
        if (msg.error) {
          entry.reject(new Error(msg.error.message || 'MCP error'))
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

  _emitError(err) {
    for (const fn of this.errorHandlers) {
      try { fn(err) } catch { /* ignore */ }
    }
  }

  _rejectAll(err) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      try { entry.reject(err) } catch { /* ignore */ }
    }
    this.pending.clear()
  }

  send(message) {
    if (!this.child || this.closed) {
      return Promise.reject(new Error(`MCP "${this.label}" 已关闭`))
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
  request(message, { timeoutMs = 30000 } = {}) {
    if (message.id === undefined) {
      return this.send(message)
    }
    const id = message.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`MCP "${this.label}" 请求超时 (${message.method})`))
        }
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.send(message).catch((err) => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          clearTimeout(timer)
          reject(err)
        }
      })
    })
  }

  /**
   * 优雅关闭。Windows 上 SIGTERM 对某些进程无效 → 3s 后 taskkill。
   */
  stop() {
    if (!this.child || this.closed) return
    this.closed = true
    const child = this.child
    try { child.stdin.end() } catch { /* ignore */ }
    try { child.kill() } catch { /* ignore */ }
    if (process.platform === 'win32' && child.pid) {
      setTimeout(() => {
        try {
          execFile('taskkill', ['/T', '/F', '/PID', String(child.pid)], () => {})
        } catch { /* best effort */ }
      }, 3000)
    }
    this._rejectAll(new Error(`MCP "${this.label}" 主动关闭`))
  }

  isAlive() {
    return !!this.child && !this.closed
  }

  getStderrSample(limit = 2048) {
    return this.stderr.slice(-limit)
  }
}
