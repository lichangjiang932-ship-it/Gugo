/**
 * Interactive terminal session (`gugo chat`).
 *
 * Why this exists: the other CLI forms are one-shot. `gugo run` executes a
 * single Turn and exits, so a multi-turn conversation needs `--resume <turnId>`
 * bookkeeping or the web UI. This keeps a session alive in one terminal:
 * continuous turns, mutable model/mode/workspace, live tool activity, and a
 * Ctrl-C that cancels the running turn instead of killing the session.
 *
 * Two deliberate rules:
 *   - It refuses to start without a TTY. Piping into it would hang forever with
 *     no way to know the prompt never came; `gugo run` is the piped form.
 *   - Only one readline owns stdin at a time. The session reader is closed for
 *     the duration of a turn so approval/recovery prompts can use stdin safely.
 */
import { resolveInteractiveHistoryPath } from './interactiveHistory.js'
import { createInteractiveInputEditor } from './input/createInputEditor.js'
export {
  INTERACTIVE_HISTORY_FILE_NAME, INTERACTIVE_HISTORY_LIMIT, isRecordableHistoryLine,
  parseInteractiveHistory, appendInteractiveHistory, readInteractiveHistory,
  writeInteractiveHistory, resolveInteractiveHistoryPath,
} from './interactiveHistory.js'
import { CliError, CliUsageError } from './errors.js'
import { stylerForStream } from './terminalTheme.js'
import { createInteractiveModelCatalog } from './interactiveModelCatalog.js'
import { assertModelCatalog } from './cliContracts.js'
import { chooseModelInteractively } from './interactiveModelSelection.js'
import { createAttachmentQueue } from './interactiveAttachmentQueue.js'
import { formatSearchMatches, parseSearchArgs, searchTurnEvents } from './sessionSearch.js'

import { runInteractiveTurn } from './interactiveTurn.js'
import { loadBuiltinHeadlessRuntime, headlessRuntimeEnvironment } from './headlessRuntimeLoader.js'

export const INTERACTIVE_MODES = Object.freeze(['normal', 'acceptEdits', 'plan', 'bypass'])

export const INTERACTIVE_COMMANDS = Object.freeze([
  { name: '/help', args: '', description: 'Show this help' },
  { name: '/draft', args: '', description: 'Compose multiline input: /send, /undo, /discard; // escapes a slash' },
  { name: '/new', args: '', description: 'Start a fresh session' },
  { name: '/session', args: '[id]', description: 'Show or switch the session id' },
  { name: '/sessions', args: '[offset]', description: 'List local sessions (20 per page, including archived)' },
  { name: '/resume', args: '<session-id>', description: 'Continue an existing local session, not a turn' },
  { name: '/search', args: '<query> [--limit n] [--offset n] [--cursor token]', description: 'Search the messages of this session' },
  { name: '/attach', args: '<path>', description: 'Attach one file to the next turn (quoted paths are supported)' },
  { name: '/attachments', args: '', description: 'List pending attachments' },
  { name: '/detach', args: '<index|all>', description: 'Remove a pending attachment without deleting its file' },
  { name: '/model', args: '[name]', description: 'Show or set the model' },
  { name: '/mode', args: `[${INTERACTIVE_MODES.join('|')}]`, description: 'Show or set the permission mode' },
  { name: '/cwd', args: '[dir]', description: 'Show or set the workspace directory' },
  { name: '/plan', args: '', description: 'Show this session’s host-verified goal plan' },
  { name: '/approve', args: '[planId]', description: 'Approve the session’s goal plan' },
  { name: '/exit', args: '', description: 'Leave the session (alias: /quit)' },
])

/** Parse one REPL line. Pure: no side effects, no state. */
export function parseInteractiveLine(line) {
  const text = String(line ?? '').trim()
  if (!text) return Object.freeze({ kind: 'empty' })
  if (!text.startsWith('/')) return Object.freeze({ kind: 'prompt', prompt: text })
  const spaceAt = text.search(/\s/u)
  const name = (spaceAt === -1 ? text : text.slice(0, spaceAt)).toLowerCase()
  const args = spaceAt === -1 ? '' : text.slice(spaceAt + 1).trim()
  return Object.freeze({ kind: 'command', name, args })
}

/**
 * Render the command table. `styler` is optional: without one (or with colour off) the
 * output is the plain text every existing test and pipe already expects.
 */
export function renderInteractiveHelp(styler) {
  const stylish = styler?.enabled === true
  const width = Math.max(...INTERACTIVE_COMMANDS.map((entry) => entry.name.length + entry.args.length + 1))
  const rows = INTERACTIVE_COMMANDS.map((entry) => {
    const signature = `${entry.name}${entry.args ? ` ${entry.args}` : ''}`
    // Pad before painting: escape sequences would otherwise count towards the width.
    const label = stylish
      ? `${styler.cyan(signature)}${' '.repeat(width + 2 - signature.length)}`
      : signature.padEnd(width + 2)
    return `  ${label}${stylish ? styler.dim(entry.description) : entry.description}`
  })
  const hint = 'Anything else is sent to the agent as the next turn prompt.'
  return [
    stylish ? styler.bold('Commands:') : 'Commands:',
    ...rows,
    '',
    stylish ? styler.dim(hint) : hint,
  ].join('\n')
}

/**
 * Argument sources for Tab completion, keyed by slash command.
 *
 * Every source must be synchronous: readline's completer cannot await. Sources for
 * data the CLI does not hold yet (models, sessions, directories) are injected by the
 * caller from whatever it has already loaded, and default to no candidates rather
 * than blocking or guessing.
 */
const COMMAND_ARGUMENT_SOURCES = Object.freeze({
  '/mode': () => INTERACTIVE_MODES,
  '/model': (sources) => sources.listModels?.() ?? [],
  '/session': (sources) => sources.listSessions?.() ?? [],
  '/resume': (sources) => sources.listSessions?.() ?? [],
  '/cwd': (sources) => sources.listDirectories?.() ?? [],
})

/**
 * Tab completion for the interactive REPL.
 *
 * Pure: given the same line and sources it always returns the same pair, so every
 * branch is pinned by tests without a TTY. Returns the readline `[hits, replaceWith]`
 * contract, where `replaceWith` is the tail of the line that hits must replace.
 *
 * Completion is intentionally narrow: the command name, or the first argument of a
 * command that declares an argument source. Anything past the first argument is left
 * alone so a partially typed multi-argument line is never rewritten.
 */
export function completeInteractiveLine(line, sources = {}) {
  const text = String(line ?? '')
  if (text.length === 0) return [[], '']

  const spaceAt = text.search(/\s/u)
  if (spaceAt !== -1) {
    const name = text.slice(0, spaceAt).toLowerCase()
    const args = text.slice(spaceAt + 1)
    const source = COMMAND_ARGUMENT_SOURCES[name]
    if (!source || args.includes(' ')) return [[], '']
    // A failing source must never take the prompt down with it; completion is an
    // affordance, so a broken source degrades to "no candidates".
    let candidates
    try {
      candidates = source(sources) || []
    } catch {
      candidates = []
    }
    const prefix = args.toLowerCase()
    const hits = candidates.filter((candidate) => String(candidate).toLowerCase().startsWith(prefix))
    return [hits, args]
  }

  if (!text.startsWith('/')) return [[], '']
  const prefix = text.toLowerCase()
  const hits = INTERACTIVE_COMMANDS.map((entry) => entry.name).filter((name) => name.startsWith(prefix))
  return [hits, text]
}

export function sessionStatusLine(state) {
  const parts = [
    `session ${String(state.sessionId || '').slice(0, 8) || '(new)'}`,
    `mode ${state.mode}`,
  ]
  if (state.model) parts.push(`model ${state.model}`)
  parts.push(`cwd ${state.cwd}`)
  return parts.join(' | ')
}

function write(stream, text) {
  try { stream.write(`${text}\n`) } catch { /* a closed terminal is not fatal */ }
}

/** Queue-backed reader used by tests (and any non-TTY embedding). */
function createScriptedReader(lines) {
  const queue = [...lines]
  return {
    async question() {
      return queue.length > 0 ? queue.shift() : null
    },
    clear() {},
    suspend() {},
    close() {},
  }
}

function createDraftEditor(stdout) {
  let lines = null
  const discard = () => { lines = null }
  return {
    get active() { return lines !== null },
    discard,
    consume(raw) {
      if (lines === null) {
        const parsed = parseInteractiveLine(raw)
        if (parsed.kind !== 'command' || parsed.name !== '/draft') return parsed
        lines = []
        write(stdout, 'Draft: /send submits, /undo removes the last line, /discard cancels; // escapes a slash.')
        return null
      }
      if (raw === '/discard') {
        discard()
        write(stdout, 'Draft discarded.')
      } else if (raw === '/undo') {
        lines.pop()
      } else if (raw === '/send') {
        const prompt = lines.join('\n')
        if (prompt.trim()) {
          discard()
          return { kind: 'prompt', prompt }
        }
        write(stdout, 'Draft is empty; add text or /discard.')
      } else {
        lines.push(raw.startsWith('//') ? raw.slice(1) : raw)
      }
      return null
    },
  }
}

async function applySessionContinuation(parsed, { state, stdout, userId, rememberSessions }) {
  const { listSessions, getSession } = await import('../../server/services/sessionStore.js')
  if (parsed.name === '/sessions') {
    const offset = parsed.args ? Number(parsed.args) : 0
    if (!/^\d*$/u.test(parsed.args) || !Number.isSafeInteger(offset) || offset < 0) {
      throw new CliUsageError('CLI_SESSION_OFFSET_INVALID', '/sessions offset must be a non-negative integer')
    }
    const sessions = listSessions({ userId, archived: 'all', limit: 20, offset })
    // Tab completion reads what this command already loaded, so listing sessions is the
    // point where the ids become completable.
    rememberSessions?.(sessions.map((session) => String(session.id)))
    if (!sessions.length) write(stdout, 'No local sessions on this page.')
    for (const session of sessions) {
      const title = String(session.title || 'Untitled').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
      write(stdout, `${session.id}  ${title}${session.archivedAt ? ' [archived]' : ''}`)
    }
    if (sessions.length === 20) write(stdout, `Next page: /sessions ${offset + 20}`)
    write(stdout, 'Continue with /resume <session-id>. Current model, mode and cwd stay unchanged.')
    return null
  }
  if (!parsed.args) throw new CliUsageError('CLI_SESSION_ID_REQUIRED', '/resume requires a session id; use /sessions to list local sessions')
  const session = getSession({ userId, sessionId: parsed.args })
  if (!session) throw new CliUsageError('CLI_SESSION_NOT_FOUND', 'Session not found in the local runtime for this user.')
  state.sessionId = session.id
  state.attachments.clear()
  write(stdout, `Continuing session ${state.sessionId}. Type a prompt to start a new turn; model, mode and cwd are unchanged.`)
  return null
}

async function loadGoalPlanService() {
  return import('../../server/services/goalPlanService.js')
}

async function showPlan({ userId, sessionId, stdout }) {
  const { listGoalPlans, getGoalPlan } = await loadGoalPlanService()
  const plans = listGoalPlans({ userId, sessionId, limit: 1 })
  if (plans.length === 0) {
    write(stdout, 'No goal plan for this session. Create one with `gugo goal create ... --session-id ' + sessionId + '`.')
    return
  }
  const detail = getGoalPlan({ userId, planId: plans[0].id })
  write(stdout, `Plan ${detail.id} (${detail.status}, revision ${detail.revision}, version ${detail.version})`)
  write(stdout, `Objective: ${detail.objective}`)
  for (const step of detail.steps) {
    const mark = step.evidenceVerified ? '✓' : '·'
    write(stdout, `  ${mark} ${step.ordinal}. [${step.status}] ${step.title}`)
  }
  write(stdout, 'A step only completes with host-verified evidence; the agent must cite a tool call.')
}

async function approvePlan({ userId, sessionId, planId, stdout }) {
  const { approveGoalPlan, listGoalPlans } = await loadGoalPlanService()
  let target = String(planId || '').trim()
  if (!target) {
    const active = listGoalPlans({ userId, sessionId, status: 'awaiting_approval', limit: 1 })[0]
    target = active?.id || ''
  }
  if (!target) throw new CliUsageError('CLI_GOAL_PLAN_NOT_FOUND', 'no plan awaiting approval for this session')
  const plan = approveGoalPlan({ userId, planId: target })
  write(stdout, `Approved ${plan.id} (status ${plan.status}). The agent can now advance its steps.`)
}

/**
 * Apply a slash command. Returns `'exit'` when the session should end, or
 * `null` to continue. Throws CliUsageError for bad input (shown, not fatal).
 */
async function applyInteractiveCommand(parsed, context) {
  const { state, stdout, userId } = context
  if (state.attachments.handle(parsed, { cwd: state.cwd, stdout })) return null
  switch (parsed.name) {
    case '/help':
      write(stdout, renderInteractiveHelp(context.style))
      return null
    case '/new':
      state.attachments.clear()
      state.sessionId = context.newSessionId()
      write(stdout, `Started a new session: ${state.sessionId}`)
      return null
    case '/session':
      if (parsed.args) { state.sessionId = parsed.args; state.attachments.clear() }
      write(stdout, `session ${state.sessionId}`)
      return null
    case '/sessions':
    case '/resume':
      return applySessionContinuation(parsed, context)
    case '/search': {
      const { query, limit, offset, cursor } = parseSearchArgs(parsed.args)
      if (!query) throw new CliUsageError('CLI_SEARCH_QUERY_REQUIRED', '/search requires a query; try /search deploy')
      const matches = await searchTurnEvents({ userId, sessionId: state.sessionId, query, limit, offset, cursor, signal: context.signal })
      write(stdout, formatSearchMatches(matches, { query, styler: context.style }))
      return null
    }
    case '/model': {
      const picked = parsed.args
        ? await context.modelCatalog.select(parsed.args, { currentProviderId: state.modelProviderId })
        : await chooseModelInteractively({
          catalog: context.modelCatalog, current: state, stdout, stdin: context.stdin,
          reader: context.reader, signal: context.signal, scripted: context.scripted, selectModel: context.selectModel,
        })
      if (picked) {
        state.model = picked.modelName
        state.modelProviderId = picked.providerId || null
      }
      write(stdout, `model ${state.model || '(provider default)'}${state.modelProviderId ? ' | provider ' + state.modelProviderId : ''}`)
      return null
    }
    case '/mode':
      if (parsed.args) {
        if (!INTERACTIVE_MODES.includes(parsed.args)) {
          throw new CliUsageError('CLI_MODE_INVALID', `mode must be one of ${INTERACTIVE_MODES.join(', ')}`)
        }
        state.mode = parsed.args
      }
      write(stdout, `mode ${state.mode}`)
      return null
    case '/cwd':
      if (parsed.args) state.cwd = parsed.args
      write(stdout, `cwd ${state.cwd}`)
      return null
    case '/plan':
      await showPlan({ userId, sessionId: state.sessionId, stdout })
      return null
    case '/approve':
      await approvePlan({ userId, sessionId: state.sessionId, planId: parsed.args, stdout })
      return null
    case '/exit':
    case '/quit':
      return 'exit'
    default:
      write(stdout, `Unknown command ${parsed.name}. Try /help.`)
      return null
  }
}

/**
 * Run the REPL until `/exit`, EOF, or a fatal error.
 *
 * @returns {Promise<number>} process exit code
 */
export async function startInteractiveSession({
  options = {},
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  runTurn = null,
  env = process.env,
  runtimeCwd = process.cwd(),
  signal = null,
  lines = null,
  newSessionId = null,
  resolveUserId = null,
  readModelProviders = undefined,
  modelCatalogFactory = createInteractiveModelCatalog,
  selectModel = undefined,
} = {}) {
  const scripted = Array.isArray(lines)
  if (!scripted && (stdin.isTTY !== true || stdout.isTTY !== true)) {
    throw new CliError(
      'CLI_INTERACTIVE_REQUIRES_TTY',
      'gugo chat needs an interactive terminal. For scripts and pipes use `gugo run --output jsonl -- <prompt>`.',
    )
  }
  const runtime = runTurn || await loadBuiltinHeadlessRuntime({ runtimeCwd, env })
  env = headlessRuntimeEnvironment(runtime, env)
  const { resolveLocalUserId } = resolveUserId
    ? { resolveLocalUserId: resolveUserId }
    : await import('./localIdentity.js')
  const userId = await resolveLocalUserId({ cwd: runtimeCwd, env })
  const nextSessionId = newSessionId || (await import('node:crypto')).randomUUID
  const state = {
    sessionId: String(options.sessionId || '') || nextSessionId(),
    model: options.model || null,
    modelProviderId: options.modelProviderId || null,
    mode: options.mode || 'normal',
    cwd: options.cwd || runtimeCwd,
    attachments: createAttachmentQueue({ files: options.files, images: options.images, cwd: options.cwd || runtimeCwd }),
  }
  if (!state.sessionId) {
    const { randomUUID } = await import('node:crypto')
    state.sessionId = randomUUID()
  }
  const draft = createDraftEditor(stdout)
  let interrupted = false
  let activeController = null
  let reader = null
  const onSigint = () => {
    if (activeController) {
      if (!activeController.signal.aborted) {
        write(stderr, '\n[turn cancellation requested]')
        activeController.abort(Object.assign(new Error('cancelled by user'), { code: 'CLI_INTERACTIVE_CANCELLED' }))
      } else {
        write(stderr, '[turn cancellation pending; waiting for runtime cleanup]')
      }
      return
    }
    if (draft.active) {
      draft.discard()
      state.attachments.clear()
      reader.clear()
      write(stderr, 'Draft discarded.')
      return
    }
    if (interrupted) {
      reader.close()
      return
    }
    interrupted = true
    state.attachments.clear()
    write(stderr, 'Press Ctrl-C again to leave, or use /exit.')
  }
  // Tab completion must be synchronous and must not add any work to session startup, so
  // it reads a cache that `/sessions` fills in. Before the first `/sessions` the source
  // reports no candidates rather than importing the store (which would pull the runtime
  // database into a bare CLI start).
  let knownSessionIds = []
  const modelCatalog = assertModelCatalog(modelCatalogFactory({ userId, env, readProviders: readModelProviders }))
  const stopInput = () => reader?.close()
  try {
    if (signal?.aborted) throw signal.reason || new CliError('CLI_SESSION_CANCELLED', 'session cancelled', 130)
    const completionSources = {
      listSessions: () => knownSessionIds,
      // The active model remains completable on a cold start without a server.
      listModels: () => (state.model
        ? [state.model, ...modelCatalog.list().filter((name) => name !== state.model)]
        : modelCatalog.list()),
    }
    // Styling is resolved once; non-TTY output stays byte-identical.
    const style = stylerForStream(stdout)
    // Scripted runs never touch the user's history file.
    const historyFile = scripted || env.GUGO_CLI_HISTORY === '0' ? null : resolveInteractiveHistoryPath(env.APP_DATA_DIR, { userId })
    reader = scripted
      ? createScriptedReader(lines)
      : createInteractiveInputEditor({ stdin, stdout, stderr, signal, onSigint,
        completeLine: (line) => completeInteractiveLine(line, completionSources), historyFile }, { env })
    signal?.addEventListener('abort', stopInput, { once: true })
    process.on('SIGINT', onSigint)
    write(stdout, `Gugo interactive session. ${sessionStatusLine(state)}`)
    write(stdout, 'Type /help for commands, /exit to leave.')
    if (signal?.aborted) throw signal.reason || new CliError('CLI_SESSION_CANCELLED', 'session cancelled', 130)
    // Only start provider/cache work once input configuration and setup succeed.
    void modelCatalog.refresh()
    for (;;) {
      if (signal?.aborted) throw signal.reason || new CliError('CLI_SESSION_CANCELLED', 'session cancelled', 130)
      interrupted = false
      const raw = await reader.question(draft.active ? 'draft> ' : `${String(state.sessionId).slice(0, 8)}> `)
      if (signal?.aborted) throw signal.reason || new CliError('CLI_SESSION_CANCELLED', 'session cancelled', 130)
      if (raw === null) {
        if (draft.active) write(stdout, 'Draft discarded at EOF.')
        write(stdout, '')
        return 0
      }
      const wasDraft = draft.active
      let parsed = draft.consume(raw)
      if (wasDraft && raw === '/discard') state.attachments.clear()
      if (!wasDraft && parsed?.kind === 'empty' && state.attachments.list().length) parsed = { kind: 'prompt', prompt: '' }
      if (!parsed || parsed.kind === 'empty') continue
      if (parsed.kind === 'command') {
        try {
          if (await applyInteractiveCommand(parsed, {
            state, stdout, userId, newSessionId: nextSessionId, style,
            modelCatalog, reader, stdin, signal, scripted, selectModel,
            rememberSessions: (ids) => { knownSessionIds = ids },
            listModels: () => completionSources.listModels(),
          }) === 'exit') return 0
        } catch (error) {
          // Domain errors (goal service, CLI usage) are reported and the session
          // continues. Anything without a code is a programming error and must
          // not be swallowed.
          const domainCode = typeof error?.code === 'string' ? error.code : ''
          if (error instanceof CliUsageError || domainCode) {
            write(stderr, style.red(`error: ${error.message}`))
            continue
          }
          throw error
        }
        continue
      }
      await runInteractiveTurn({
        parsed, state, runtime, stdin, stdout, stderr, env, signal, reader,
        timeoutMs: options.timeoutMs,
        setController: (controller) => { activeController = controller },
      })
    }
  } finally {
    process.removeListener('SIGINT', onSigint)
    signal?.removeEventListener('abort', stopInput)
    // Without this the process keeps its stdin reader alive after the loop
    // returns and the CLI does not exit until stdin closes.
    try { reader?.close() }
    finally {
      try { modelCatalog.close() }
      finally { state.attachments.clear() }
    }
  }
}
