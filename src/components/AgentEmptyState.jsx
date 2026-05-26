/**
 * AgentEmptyState · P0 中栏空状态
 *
 * 对标 openhanako 桌面 app:
 *   - 头像
 *   - "<agent 名> 随时都在"
 *   - 工作台路径
 *   - "◆ 记忆 N 条"
 *   - 居中输入框(由外层传 children 渲染,这里不复刻 ChatComposer)
 *   - 上方一行小字:操作前询问模式说明
 *
 * 注意:这是**展示组件**,不绑 store。所有数据从 prop 传。
 */
export default function AgentEmptyState({
  agentName = '默认 Agent',
  agentAvatar = null,
  workbenchPath = '/projects/yma',
  memoryCount = 0,
  askBeforeAction = true,
  children,
}) {
  return (
    <div
      className="flex-1 flex flex-col items-center justify-center min-h-0"
      style={{
        padding: 'var(--p0-gap-xl) var(--p0-gap-lg)',
        fontFamily: 'var(--p0-font-sans)',
      }}
      data-testid="agent-empty-state"
    >
      {/* 头像 */}
      <div
        className="inline-flex items-center justify-center"
        style={{
          width: 72,
          height: 72,
          borderRadius: '50%',
          background: 'var(--p0-card)',
          border: '1px solid var(--p0-border)',
          fontSize: 28,
          color: 'var(--p0-accent)',
          marginBottom: 'var(--p0-gap-md)',
        }}
      >
        {agentAvatar || (agentName?.[0] || 'A')}
      </div>

      {/* 标题 */}
      <h1
        style={{
          fontSize: 22,
          color: 'var(--p0-text-primary)',
          fontWeight: 500,
          margin: 0,
          marginBottom: 'var(--p0-gap-xs)',
        }}
      >
        {agentName} 随时都在
      </h1>

      {/* 工作台 + 记忆 */}
      <div
        className="flex items-center"
        style={{
          gap: 'var(--p0-gap-md)',
          color: 'var(--p0-text-secondary)',
          fontSize: 12,
          marginBottom: 'var(--p0-gap-lg)',
        }}
      >
        <span title="工作台">
          <span style={{ color: 'var(--p0-text-tertiary)' }}>工作台</span>
          <span style={{ marginLeft: 6, fontFamily: 'var(--p0-font-mono)' }}>{workbenchPath}</span>
        </span>
        <span style={{ color: 'var(--p0-border-strong)' }}>·</span>
        <span title="项目记忆">
          <span style={{ color: 'var(--p0-accent)' }}>◆</span>
          <span style={{ marginLeft: 6 }}>记忆 {memoryCount} 条</span>
        </span>
      </div>

      {/* 操作前询问提示 */}
      {askBeforeAction && (
        <div
          style={{
            fontSize: 11,
            color: 'var(--p0-text-tertiary)',
            marginBottom: 'var(--p0-gap-sm)',
            textAlign: 'center',
            maxWidth: 520,
          }}
        >
          「操作前询问」模式让助手在动手前先征求你同意
        </div>
      )}

      {/* 输入框槽位(外层塞 ChatComposer / 任何 input) */}
      <div
        style={{
          width: '100%',
          maxWidth: 720,
        }}
      >
        {children}
      </div>
    </div>
  )
}
