import { Component } from 'react'

/**
 * ★ #33: 全局 ErrorBoundary
 * MarkdownRenderer / ToolCallCard 等子树解析失败时,显示降级 UI 而不是白屏。
 * 用 class component (React 16+ 唯一支持 componentDidCatch 的方式)。
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null, errorInfo: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, errorInfo) {
    this.setState({ errorInfo })
    if (typeof console !== 'undefined') {
      console.error('[ErrorBoundary] 捕获到子树异常:', error, errorInfo?.componentStack)
    }
  }

  handleReset = () => {
    this.setState({ error: null, errorInfo: null })
  }

  handleReload = () => {
    window.location.reload()
  }

  render() {
    if (!this.state.error) return this.props.children

    const message = this.state.error?.message || String(this.state.error)
    const stack = this.state.errorInfo?.componentStack || ''

    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-paper">
        <div className="w-full max-w-xl border border-ink-fade rounded-md p-5 bg-paper-2">
          <div className="flex items-baseline justify-between gap-3 mb-3">
            <h2 className="font-hand text-xl text-ink">出了点问题</h2>
            <span className="font-mono text-[10px] tracking-wider text-ink-fade">RUNTIME ERROR</span>
          </div>
          <p className="text-sm text-ink-soft mb-3">
            页面渲染时发生异常,这通常是因为消息内容中包含异常的 markdown 或工具结果。
            你可以尝试恢复当前视图,或刷新整个页面。
          </p>
          <div className="text-xs font-mono bg-paper border border-ink-fade/40 rounded p-2 mb-3 overflow-auto max-h-24 text-ink-soft">
            {message}
          </div>
          {stack && (
            <details className="mb-3">
              <summary className="text-xs text-ink-fade cursor-pointer hover:text-ink">
                展开调用栈
              </summary>
              <pre className="text-[10px] font-mono text-ink-fade mt-2 overflow-auto max-h-40 whitespace-pre-wrap">
                {stack}
              </pre>
            </details>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={this.handleReset}
              className="h-9 px-4 border border-ink/70 rounded-md text-sm text-ink hover:bg-paper transition-colors"
            >
              恢复视图
            </button>
            <button
              onClick={this.handleReload}
              className="h-9 px-4 bg-ink text-paper rounded-md text-sm hover:bg-ink-soft transition-colors"
            >
              刷新页面
            </button>
          </div>
        </div>
      </div>
    )
  }
}
