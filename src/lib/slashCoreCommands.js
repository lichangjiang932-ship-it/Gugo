import { normalizeUiLanguage, SLASH_ACTION_COPY } from '../i18n/translations.js'

export const CORE_SLASH_COMMANDS = [
  'mcp', 'side', 'init', 'compact', 'feedback', 'continue', 'pet', 'new', 'status', 'goals', 'plan',
]

function localeCopy(lang) {
  return SLASH_ACTION_COPY[normalizeUiLanguage(lang)] || SLASH_ACTION_COPY.en
}

function localized(lang) {
  const local = localeCopy(lang)
  return {
    ...local,
    notices: { ...SLASH_ACTION_COPY.en.notices, ...(local.notices || {}) },
    prompts: { ...SLASH_ACTION_COPY.en.prompts, ...(local.prompts || {}) },
    statusPanel: { ...SLASH_ACTION_COPY.en.statusPanel, ...(local.statusPanel || {}) },
    mcpPanel: { ...SLASH_ACTION_COPY.en.mcpPanel, ...(local.mcpPanel || {}) },
    feedbackPanel: { ...SLASH_ACTION_COPY.en.feedbackPanel, ...(local.feedbackPanel || {}) },
    goalsPanel: { ...SLASH_ACTION_COPY.en.goalsPanel, ...(local.goalsPanel || {}) },
    petGreeting: local.petGreeting || SLASH_ACTION_COPY.en.petGreeting,
  }
}

function textArg(args) {
  return typeof args === 'string' ? args.trim() : String(args?.text || '').trim()
}

function currentSession(ctx) {
  const state = ctx.getState?.() || ctx.state || {}
  return (state.sessions || []).find((session) => session.id === state.activeSessionId) || null
}

function command(name, copy, handler, extra = {}) {
  return { name, description: copy[name][1], handler, meta: { displayName: copy[name][0] }, ...extra }
}

function createId(ctx) {
  return ctx.createId?.() || globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function buildCoreSlashCommands(_t, lang = 'en') {
  const copy = localized(lang)
  const commands = [
    command('mcp', copy, async (_args, ctx = {}) => {
      ctx.openMcp?.()
      return ''
    }),
    command('side', copy, async (_args, ctx = {}) => {
      ctx.openSideChat?.()
      return copy.notices.side
    }),
    command('init', copy, async (_args, ctx = {}) => {
      await ctx.triggerSendFlow?.(copy.prompts.init)
      return copy.notices.init
    }, { requiresModel: true }),
    command('compact', copy, async (_args, ctx = {}) => {
      const session = currentSession(ctx)
      if (!session || (session.messages || []).length <= 8) return copy.notices.compactEmpty
      if (typeof ctx.compactSession === 'function') {
        const result = await ctx.compactSession({
          sessionId: session.id,
          messages: session.messages,
          keepMessages: 6,
          semantic: true,
        })
        const messages = Array.isArray(result?.messages)
          ? result.messages
          : result?.outboundMessages
        if (result?.ok !== true || !Array.isArray(messages)) {
          throw new Error(result?.error || 'Context compaction failed.')
        }
        ctx.dispatch?.({ type: 'COMPACT_SESSION', payload: { sessionId: session.id, messages } })
        return result.compacted === false ? copy.notices.compactEmpty : copy.notices.compact
      }
      ctx.dispatch?.({ type: 'COMPRESS_CURRENT_SESSION' })
      return copy.notices.compact
    }),
    command('feedback', copy, async (args, ctx = {}) => {
      const value = textArg(args)
      if (!value) {
        ctx.openFeedback?.()
        return ''
      }
      const saved = await ctx.recordFeedback?.(value)
      if (saved === false) throw new Error(copy.feedbackPanel.failed)
      return copy.notices.feedback
    }, { hint: '<feedback>' }),
    command('continue', copy, async (_args, ctx = {}) => {
      const session = currentSession(ctx)
      if (!session) return copy.notices.noSession
      const id = createId(ctx)
      const carried = (session.messages || []).slice(-8).map((message) => {
        const role = message.role === 'user' ? 'User' : 'Assistant'
        return `${role}: ${String(message.content || '').slice(0, 1200)}`
      }).join('\n\n')
      ctx.dispatch?.({ type: 'NEW_SESSION', payload: { id, title: `${session.title || copy.new[0]} · ${copy.continue[0]}` } })
      ctx.dispatch?.({ type: 'SET_SESSION_DRAFT', payload: { sessionId: id, text: `Continue from this prior context:\n\n${carried}\n\n` } })
      ctx.navigate?.('/chat')
      return copy.notices.continue
    }),
    command('pet', copy, async (_args, ctx = {}) => {
      ctx.togglePet?.()
      return ''
    }),
    command('new', copy, async (_args, ctx = {}) => {
      ctx.dispatch?.({ type: 'START_NEW_DRAFT' })
      ctx.navigate?.('/chat')
      return copy.notices.new
    }),
    command('status', copy, async (_args, ctx = {}) => {
      ctx.openStatus?.()
      return ''
    }),
    command('goals', copy, async (args, ctx = {}) => {
      const goal = textArg(args)
      if (!goal) {
        ctx.openGoals?.()
        return ''
      }
      // The durable Goal execution path is the existing JobRuntime. It owns
      // plan proposal, approval, checkpoints, verification, and recovery.
      // Keep the legacy session todo fallback for non-chat/embedded callers.
      if (typeof ctx.createGoalJob === 'function') {
        const created = await ctx.createGoalJob(goal, { requirePlanApproval: true })
        const jobId = String(created?.job?.id || '').trim()
        if (jobId) ctx.navigate?.(`/tasks?job=${encodeURIComponent(jobId)}`)
        return copy.notices.goal.replace('{goal}', goal)
      }
      let session = currentSession(ctx)
      if (!session) {
        const id = createId(ctx)
        ctx.dispatch?.({ type: 'NEW_SESSION', payload: { id, title: copy.goals[0] } })
        session = { id, todos: [] }
      }
      const todos = [...(session.todos || []), { id: createId(ctx), text: goal, done: false }]
      ctx.dispatch?.({ type: 'SET_TODOS', payload: { sessionId: session.id, todos } })
      return copy.notices.goal.replace('{goal}', goal)
    }, { hint: '<goal>' }),
    command('plan', copy, async (_args, ctx = {}) => {
      await ctx.setApprovalMode?.('plan')
      return copy.notices.plan
    }),
  ]
  return commands.map((entry, order) => ({ ...entry, meta: { ...entry.meta, order } }))
}

export function registerCoreSlashCommands(registry, { t, lang } = {}) {
  for (const entry of buildCoreSlashCommands(t, lang)) registry.register(entry, 'core')
  return registry
}

export function getSlashActionCopy(lang) {
  return localized(lang)
}
