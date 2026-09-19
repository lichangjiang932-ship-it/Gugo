import { CliUsageError } from './errors.js'
import { parseDoctorArgs } from './headlessDoctor.js'
import { parseConfigArgs } from './configCommand.js'
import { GOAL_BOOLEAN_FLAGS, parseGoalArgs } from './goalCommand.js'
import { MEMORY_BOOLEAN_FLAGS, parseMemoryArgs } from './memoryCommand.js'
import { TRACE_BOOLEAN_FLAGS, parseTraceArgs } from './traceCommand.js'
import { parseCommandFlags, sessionShowArgs } from './serverCommands.js'

const HELP_FLAGS = new Set(['--help', '-h'])
const GROUPS = new Set(['session', 'model', 'agent', 'skill', 'goal', 'memory'])
const ALIASES = new Map([['i', 'chat']])

// The server routes and their help preflight use the same option declarations.
export const SERVER_COMMAND_OPTIONS = Object.freeze(Object.fromEntries([
  ['login', ['email']], ['verify', ['email', 'code']],
  ['session list', ['archived', 'limit', 'offset']],
  ['session search', ['query', 'session-id', 'limit', 'offset']],
  ['model list', ['provider', 'search']], ['agent list', []], ['skill list', []], ['status', []],
].map(([command, valueFlags]) => [command, Object.freeze({ command, valueFlags: Object.freeze(valueFlags) })])))

const COMMANDS = {
  login: {
    description: 'Request an email code from the configured server (optional multi-user mode).',
    usage: ['login --email <email>'],
    notes: ['Default local mode does not require login.'],
  },
  verify: {
    description: 'Verify an email code and save a token for the configured server.',
    usage: ['verify --email <email> --code <code>'],
  },
  'session list': {
    description: 'List conversations on the configured server.',
    usage: ['session list [--archived true|false|all] [--limit <n>] [--offset <n>]'],
    notes: ['Defaults: archived=false, limit=100, offset=0. Maximum limit: 200.'],
  },
  'session search': {
    description: 'Search conversation messages on the configured server.',
    usage: ['session search --query <text> [--session-id <id>] [--limit <n>] [--offset <n>]'],
    notes: ['Defaults: limit=20, offset=0. Maximum limit: 100.'],
  },
  'session show': {
    description: 'Read a conversation snapshot from the configured server.',
    usage: ['session show <session-id> [--limit <n>] [--offset <n>]'],
    notes: ['Defaults: limit=2000, offset=0. Maximum limit: 2000; use --offset for later events.'],
  },
  'model list': {
    description: 'List configured server models, optionally filtered by provider and text.',
    usage: ['model list [--provider <id>] [--search <text>]'],
  },
  'agent list': { description: 'List agents on the configured server.', usage: ['agent list'] },
  'skill list': { description: 'List skills on the configured server.', usage: ['skill list'] },
  status: { description: 'Read public server health.', usage: ['status'] },
  config: {
    description: 'Inspect local runtime configuration sources without opening databases or credentials.',
    usage: ['config [--json]'],
    notes: ['Select an existing installation explicitly: gugo --runtime-dir <dir> config --json.',
      'The web settings URL is a link only; no server or browser is started and no remote token is used locally.'],
  },
  doctor: {
    description: 'Check server health or the local headless runtime.',
    usage: [
      'doctor [--json]',
      'doctor --headless [--model <name>] [--provider <id>] [--cwd <dir>] [--probe] [--integrity] [--json]',
    ],
    notes: ['--probe explicitly permits a model probe; the other headless checks do not contact a model.'],
  },
  trace: {
    description: 'Read a local persisted Turn trace.',
    usage: ['trace <turnId> [--session-id <id>] [--limit <n>] [--export text|json|otel] [--json]'],
    notes: ['--json is shorthand for --export json. It cannot be combined with another export format.'],
  },
  'goal create': {
    description: 'Create a local goal plan with explicit steps.',
    usage: ['goal create ("<objective>" | --objective <text>) (--steps <json> | --steps-file <path>) [--session-id <id>] [--no-approval]'],
    notes: ['Choose one objective source and one steps source. Steps must be a non-empty JSON array.',
      'Plans require approval by default; --no-approval only changes plan approval, not tool permissions.'],
  },
  'goal list': {
    description: 'List local goal plans for the current user.',
    usage: ['goal list [--status <status>] [--session-id <id>] [--limit <n>]'],
  },
  'goal show': { description: 'Show a local goal plan and its events.', usage: ['goal show <planId>'] },
  'goal approve': {
    description: 'Approve a local goal plan.',
    usage: ['goal approve <planId> [--expect-version <n>]'],
  },
  'goal step': {
    description: 'Update a goal step with host-verifiable evidence.',
    usage: [
      'goal step <planId> <stepId> --status pending|in_progress|done|blocked|skipped',
      '          [--turn <turnId>] [--tool-call <id>] [--note <text>]',
      '          [--manual-confirm] [--confirmed-by <who>] [--expect-version <n>]',
    ],
    notes: ['Completion requires matching persisted evidence; a status flag alone is not proof of completion.'],
  },
  'goal rewrite': {
    description: 'Replace the steps of a local goal plan.',
    usage: ['goal rewrite <planId> (--steps <json> | --steps-file <path>) [--objective <text>] [--no-approval] [--expect-version <n>]'],
  },
  'goal prune': {
    description: 'Prune older goal-plan events while keeping the requested recent history.',
    usage: ['goal prune [<planId>] [--keep <n>]'],
  },
  'memory reindex': {
    description: 'Process the local memory-embedding backlog.',
    usage: ['memory reindex [--limit <n>] [--batch <n>] [--all-agents | --agent <agentId>]'],
    notes: ['The default scope is global memories only. --all-agents includes agent-scoped memories.',
      'Embedding requests require explicitly enabled and configured memory embeddings.'],
  },
  run: {
    description: 'Execute one durable local Turn without the web server.',
    usage: [
      'run "<prompt>" [--model <name>] [--provider <id>] [--mode normal|acceptEdits|plan|bypass]',
      '    [--cwd <dir>] [--session-id <id>] [--timeout <ms>] [--output jsonl|text] [--progress]',
      '    [--file <path>] [--image <path>]',
      'run --resume <turnId> [--session-id <id>] [--cwd <dir>] [--timeout <ms>] [--output jsonl|text] [--progress]',
      'run [options] -- <prompt>',
    ],
    notes: ['A prompt may also arrive on stdin: echo "<prompt>" | gugo run [options].',
      'Without --mode, normal is narrowed by a saved plan policy; saved acceptEdits/bypass never silently widen it.',
      '--file and --image are repeatable (8 attachments total). JSONL is the default output.',
      '--resume recovers the persisted turn; it cannot be combined with a new prompt, attachments, mode or model selection.',
      'Use -- before a literal prompt such as --help. A value following an option is never a help flag.'],
  },
  chat: {
    description: 'Start an interactive local agent session (a terminal is required).',
    usage: [
      'chat [--model <name>] [--provider <id>] [--mode normal|acceptEdits|plan|bypass]',
      '     [--cwd <dir>] [--session-id <id>] [--timeout <ms>] [--file <path>] [--image <path>]',
    ],
    notes: ['Alias: gugo i. Type prompts inside the session; use gugo run for piped input.',
      '--timeout applies per turn; attachments apply to the next turn only.',
      'The default mode respects a saved plan restriction. Use --mode or /mode for an explicit per-turn choice.',
      '/sessions lists local history; /resume <session-id> selects a conversation, not a persisted turn.',
      'GUGO_CLI_INPUT=readline is the default; optional ink requires Node 22+.'],
  },
}

const ENVIRONMENT_HELP = `Environment:
  GUGO_RUNTIME_CWD  explicit local runtime directory (default: invocation cwd)
  GUGO_SERVER_URL  absolute server URL (overrides SERVER_HOST/SERVER_PORT)
  GUGO_CLI_HTTP_TIMEOUT_MS  API request timeout in milliseconds (default 10000)
  GUGO_CLI_RUN_TIMEOUT_MS   optional Turn execution timeout in milliseconds
  GUGO_CLI_INPUT    readline (default) or optional ink on Node 22+
                   auto is a legacy alias for readline; no automatic selection
  GUGO_CLI_HISTORY  set 0 to disable persisted input history
  SERVER_PORT   server port (default 5173)
  SERVER_HOST   server host (default 127.0.0.1)

Auth tokens are isolated per server under ~/.yma-cli/tokens/ (chmod 0600).
Run defaults to durable TurnEngine JSONL; use --output text for final text only.
Chat: /sessions lists local history; /resume <session-id> selects a conversation.
Use run --resume <turnId> only to recover a persisted turn, not to start a new reply.`

function usageLines(command) {
  return COMMANDS[command].usage.map((line) => line.startsWith(' ') ? `      ${line}` : `  gugo ${line}`)
}

function renderHelp(command) {
  const definition = COMMANDS[command]
  const selected = definition ? [command] : Object.keys(COMMANDS).filter((key) => !command || key.startsWith(`${command} `))
  const title = definition
    ? `gugo ${command} — ${definition.description}`
    : `gugo${command ? ` ${command}` : ''} — local-first Agent CLI (legacy alias: yma-cli)`
  return [
    title, '', 'Usage:', ...selected.flatMap(usageLines),
    ...(!command ? ['  gugo --version'] : []),
    ...(!command ? ['', 'Local runtime selection: gugo --runtime-dir <dir> <command> [options].',
      '--runtime-dir precedes the command; --cwd selects only the task workspace.'] : []),
    '', ...(definition?.notes || []),
    ...(definition?.notes?.length ? [''] : []),
    `Help: gugo ${command ? `${command} ` : ''}--help (or -h); gugo help${command ? ` ${command}` : ' [command [subcommand]]'}`,
    ...(!command ? ['', ENVIRONMENT_HELP] : []), '',
  ].join('\n')
}

function unknownCommand(command, args) {
  if (command === 'goal') parseGoalArgs(args, { help: true })
  if (command === 'memory') parseMemoryArgs(args, { help: true })
  throw new CliUsageError('CLI_COMMAND_UNKNOWN', `Unknown command: ${[command, ...args].filter(Boolean).join(' ')}`)
}

function helpTarget(argv) {
  const args = argv.map(String)
  let requested = args.length === 0
  while (args[0] === 'help' || HELP_FLAGS.has(args[0])) {
    requested = true
    args.shift()
  }
  if (!args.length || (requested && args[0].startsWith('-'))) return { command: '', args, requested }
  const rawCommand = args.shift()
  let command = ALIASES.get(rawCommand) || rawCommand
  if (GROUPS.has(command)) {
    while (args[0] === 'help' || HELP_FLAGS.has(args[0])) {
      requested = true
      args.shift()
    }
    if (args.length && !args[0].startsWith('-')) {
      const subcommand = args.shift()
      if (!Object.hasOwn(COMMANDS, `${command} ${subcommand}`)) {
        if (requested) unknownCommand(command, [subcommand, ...args])
        return null
      }
      command = `${command} ${subcommand}`
    }
  } else if (!Object.hasOwn(COMMANDS, command)) {
    if (requested) unknownCommand(rawCommand, args)
    return null
  }
  return { command, args, requested }
}

function booleanFlags(command) {
  if (command.startsWith('goal')) return GOAL_BOOLEAN_FLAGS
  if (command.startsWith('memory')) return MEMORY_BOOLEAN_FLAGS
  if (command === 'trace') return TRACE_BOOLEAN_FLAGS
  if (command === 'doctor') return ['--headless', '--probe', '--integrity', '--json']
  if (command === 'config') return ['--json']
  if (command === 'run' || command === 'chat') return ['--progress']
  return []
}

function takeHelpFlags(target) {
  const boolean = new Set(booleanFlags(target.command))
  const args = []
  let requested = target.requested
  for (let index = 0; index < target.args.length; index += 1) {
    const raw = target.args[index]
    if (raw === '--') {
      args.push(...target.args.slice(index))
      break
    }
    if (HELP_FLAGS.has(raw)) {
      requested = true
      continue
    }
    args.push(raw)
    // Unknown long options also consume a possible value here. The real parser
    // still rejects them; guessing that their value is help must not execute I/O.
    if (raw.startsWith('--') && !raw.includes('=') && !boolean.has(raw) && index + 1 < target.args.length) {
      args.push(target.args[++index])
    }
  }
  return { ...target, args, requested }
}

function validateHelpArgs({ command, args }, parseRunArgs) {
  if (command === 'run' || command === 'chat') return parseRunArgs(args)
  if (command === 'doctor') return parseDoctorArgs(args)
  if (command === 'config') return parseConfigArgs(args)
  if (command === 'trace') return parseTraceArgs(args, { help: true })
  if (command.startsWith('goal ')) return parseGoalArgs([command.slice(5), ...args], { help: true })
  if (command.startsWith('memory ')) return parseMemoryArgs([command.slice(7), ...args], { help: true })
  if (command === 'session show') {
    // Keep its real positional/flag parser, only allowing the required id to be
    // absent when asking for help. Nothing is looked up on the server here.
    return sessionShowArgs(!args.length || args[0].startsWith('--') ? ['<session-id>', ...args] : args)
  }
  return parseCommandFlags(args, SERVER_COMMAND_OPTIONS[command] || { command: command || 'help' })
}

/** Pure help fast path. Ordinary invocations remain owned by their real parser. */
export function resolveCommandHelp(argv, { parseRunArgs }) {
  const target = helpTarget(argv)
  if (!target) return null
  const request = takeHelpFlags(target)
  if (!request.requested) return null
  validateHelpArgs(request, parseRunArgs)
  return renderHelp(request.command)
}
