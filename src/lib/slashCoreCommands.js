export const CORE_SLASH_COMMANDS = [
  'clear', 'context', 'help', 'model', 'permissions', 'status',
]

function textArg(args) {
  return typeof args === 'string' ? args.trim() : String(args?.text || '').trim()
}

function currentSession(ctx) {
  const state = ctx.getState?.() || ctx.state || {}
  return (state.sessions || []).find((session) => session.id === state.activeSessionId) || null
}

function dispatchResult(ctx, message) {
  if (message && ctx.dispatch) {
    ctx.dispatch({ type: 'RECEIVE_MESSAGE', payload: message })
  }
  return message
}

function modelName(option) {
  return typeof option === 'string' ? option : option?.name
}

export function buildCoreSlashCommands(t) {
  const tr = typeof t === 'function' ? t : (key) => key
  return [
    {
      name: 'clear',
      description: tr('slash.commands.clear.description'),
      handler: async (_args, ctx = {}) => {
        const confirm = ctx.confirm || ((message) => (typeof window === 'undefined' ? true : window.confirm(message)))
        if (!confirm(tr('slash.confirmClear'))) return ''
        ctx.dispatch?.({ type: 'CLEAR_CURRENT_SESSION' })
        return tr('slash.commands.clear.done')
      },
    },
    {
      name: 'context',
      description: tr('slash.commands.context.description'),
      hint: '[show|hide|toggle]',
      handler: async (args, ctx = {}) => {
        const mode = textArg(args).toLowerCase() || 'toggle'
        if (!['show', 'hide', 'toggle'].includes(mode)) {
          return tr('slash.commands.context.invalid')
        }
        const visible = mode === 'show'
          ? true
          : mode === 'hide'
            ? false
            : !ctx.contextUsageVisible
        ctx.setContextUsage?.(visible)
        return tr(visible ? 'slash.commands.context.shown' : 'slash.commands.context.hidden')
      },
    },
    {
      name: 'model',
      description: tr('slash.commands.model.description'),
      hint: '[name]',
      handler: async (args, ctx = {}) => {
        const requested = textArg(args)
        if (!requested) {
          ctx.openModelPicker?.()
          return ''
        }
        const available = (ctx.modelOptions || []).map(modelName).filter(Boolean)
        const match = available.find((name) => name.toLowerCase() === requested.toLowerCase())
        if (!match) return tr('slash.commands.model.unknown').replace('{model}', requested)
        ctx.setModel?.(match)
        return tr('slash.commands.model.done').replace('{model}', match)
      },
    },
    {
      name: 'permissions',
      description: tr('slash.commands.permissions.description'),
      handler: async (_args, ctx = {}) => {
        ctx.navigate?.('/permissions')
        return tr('slash.commands.permissions.done')
      },
    },
    {
      name: 'status',
      description: tr('slash.commands.status.description'),
      handler: async (_args, ctx = {}) => {
        const state = ctx.getState?.() || ctx.state || {}
        const session = currentSession(ctx)
        const running = (state.tasks || []).filter((task) => task.status === 'running').length
        return tr('slash.commands.status.done')
          .replace('{model}', ctx.selectedModel || tr('slash.commands.status.noModel'))
          .replace('{messages}', String(session?.messages?.length || 0))
          .replace('{running}', String(running))
      },
    },
    {
      name: 'help',
      description: tr('slash.commands.help.description'),
      handler: async (_args, ctx = {}) => {
        const commands = ctx.registry?.listCommands?.() || []
        const lines = commands.map((cmd) => {
          const hint = cmd.hint ? ` ${cmd.hint}` : ''
          return `/${cmd.name}${hint} - ${cmd.description}`
        })
        return dispatchResult(ctx, `${tr('slash.helpTitle')}\n\n${lines.join('\n')}`)
      },
    },
  ]
}

export function registerCoreSlashCommands(registry, { t } = {}) {
  for (const cmd of buildCoreSlashCommands(t)) {
    registry.register(cmd, 'core')
  }
  return registry
}
