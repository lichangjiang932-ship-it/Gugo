import { archiveSessionRemote } from './sessionClient.js'

export const CORE_SLASH_COMMANDS = ['archive', 'clear', 'help', 'retry', 'search', 'title']

function textArg(args) {
  return typeof args === 'string' ? args.trim() : String(args?.text || '').trim()
}

function currentSession(ctx) {
  const state = ctx.getState?.() || ctx.state || {}
  return (state.sessions || []).find((s) => s.id === state.activeSessionId) || null
}

function dispatchResult(ctx, message) {
  if (message && ctx.dispatch) {
    ctx.dispatch({ type: 'RECEIVE_MESSAGE', payload: message })
  }
  return message
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
      name: 'retry',
      description: tr('slash.commands.retry.description'),
      handler: async (_args, ctx = {}) => {
        const session = currentSession(ctx)
        const messages = session?.messages || []
        let userIndex = -1
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          if (messages[i]?.role === 'user') {
            userIndex = i
            break
          }
        }
        if (userIndex < 0) return tr('slash.commands.retry.empty')
        const content = String(messages[userIndex]?.content || '').trim()
        if (!content) return tr('slash.commands.retry.empty')
        ctx.dispatch?.({ type: 'TRUNCATE_MESSAGES', payload: userIndex })
        ctx.triggerSendFlow?.(content)
        return tr('slash.commands.retry.done')
      },
    },
    {
      name: 'title',
      description: tr('slash.commands.title.description'),
      hint: '<new>',
      handler: async (args, ctx = {}) => {
        const title = textArg(args)
        if (!title) return tr('slash.commands.title.missing')
        ctx.dispatch?.({ type: 'UPDATE_SESSION_TITLE', payload: title })
        return tr('slash.commands.title.done').replace('{title}', title)
      },
    },
    {
      name: 'search',
      description: tr('slash.commands.search.description'),
      hint: '<q>',
      handler: async (args, ctx = {}) => {
        const query = textArg(args)
        const openSearch = ctx.openSessionSearch || ((q) => {
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('session-search:open', { detail: { query: q } }))
          }
        })
        openSearch(query)
        return query
          ? tr('slash.commands.search.done').replace('{query}', query)
          : tr('slash.commands.search.opened')
      },
    },
    {
      name: 'archive',
      description: tr('slash.commands.archive.description'),
      handler: async (_args, ctx = {}) => {
        const state = ctx.getState?.() || ctx.state || {}
        const sessionId = state.activeSessionId
        if (!sessionId) return tr('slash.commands.archive.empty')
        ctx.dispatch?.({ type: 'ARCHIVE_SESSION', payload: sessionId })
        try {
          await (ctx.archiveSessionRemote || archiveSessionRemote)(sessionId)
        } catch {
          // Local archive still keeps the UI state coherent when offline/anonymous.
        }
        return tr('slash.commands.archive.done')
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

