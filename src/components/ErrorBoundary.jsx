import { Component } from 'react'

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null, errorInfo: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, errorInfo) {
    this.setState({ error, errorInfo })
    console.error('ErrorBoundary caught:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center p-8" style={{ background: 'var(--color-paper)' }}>
          <div className="max-w-[600px] w-full">
            <div className="mb-4">
              <span className="font-mono text-[9px] tracking-[0.2em] uppercase" style={{ color: '#A55B5B' }}>Runtime Error</span>
              <h1 className="font-display text-2xl mt-1" style={{ color: 'var(--color-ink)' }}>页面渲染异常</h1>
            </div>
            <div className="p-4 rounded-xl border mb-3" style={{ background: 'rgba(165,91,91,0.05)', borderColor: 'rgba(165,91,91,0.2)', color: '#7F1D1D' }}>
              <p className="font-semibold text-sm">{this.state.error?.toString()}</p>
            </div>
            {this.state.errorInfo && (
              <pre className="p-4 rounded-xl border text-xs font-mono overflow-auto" style={{ background: 'var(--color-paper-2)', borderColor: 'var(--color-ink-fade)', color: 'var(--color-ink-soft)', maxHeight: '400px' }}>
                {this.state.errorInfo.componentStack}
              </pre>
            )}
            <button
              onClick={() => window.location.reload()}
              className="mt-4 h-10 px-5 rounded-xl text-sm font-medium"
              style={{ background: 'var(--color-ember)', color: 'var(--color-paper)' }}
            >
              刷新页面
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
