/**
 * Read-only Git history tools: recent commits, and per-line authorship.
 *
 * A separate module because `gitWorkbench.js` sits at the implementation size
 * ceiling, and it reuses that file's workspace authorization instead of growing
 * a second one.
 *
 * These tools are deliberately **not** listed in that file's `VERIFICATION_TOOLS`:
 * a commit log or a blame line reports history, not the state of the change
 * under verification, so neither may stand in for a post-mutation check. They are
 * read-only, so they need no approval and create no mutation debt.
 */
import { parseLocalDateTime } from '../../shared/localDateTime.js'
import { redactSensitiveText } from '../../shared/sensitiveText.js'
import { getRuntimeEnv } from '../utils/runtimeEnv.js'
import { clip, getRoot, normalizeRepoPath, requireGitEnabled, runGit } from './gitWorkbench.js'

const DEFAULT_LOG_LIMIT = 20
const MAX_LOG_LIMIT = 100
const MAX_BLAME_LINES = 200
const DEFAULT_BLAME_LINES = 40
const FIELD_LIMIT = 500
const AUTHOR_DATE_LIMIT = 40

/** A provided but invalid bound clamps to the nearest valid value; only a
 * missing bound takes the default, so `0` and `-5` cannot disagree. */
function boundedCount(value, fallback, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(Math.floor(parsed), 1), max)
}

function historyFailure(result, { notRepositoryCopy, failureCopy }) {
  const diagnostic = String(result?.stderr || '')
  const notRepository = /not a git repository|outside a working tree/i.test(diagnostic)
  const detail = redactSensitiveText(diagnostic).split(/\r?\n/).find((line) => line.trim())?.slice(0, 1_000)
  return {
    ok: false,
    code: notRepository ? 'GIT_NOT_REPOSITORY' : result?.timedOut ? 'GIT_HISTORY_TIMEOUT' : 'GIT_HISTORY_FAILED',
    error: notRepository
      ? '当前目录不是 Git 工作树，无法读取 Git 历史。'
      : result?.timedOut ? 'Git 历史查询未能在截止时间内完成。' : detail || failureCopy,
    hint: notRepository ? notRepositoryCopy : '检查仓库路径与 Git 状态后重试；此失败不代表仓库没有历史。',
    retryable: false,
  }
}

function boundedField(value) {
  return redactSensitiveText(String(value || '').trim()).slice(0, FIELD_LIMIT)
}

/** Parse one `--pretty=format:%h|%ad|%an|%s` line without splitting the subject. */
function parseLogLine(line) {
  const text = String(line || '')
  const first = text.indexOf('|')
  const second = first >= 0 ? text.indexOf('|', first + 1) : -1
  const third = second >= 0 ? text.indexOf('|', second + 1) : -1
  if (first < 0 || second < 0 || third < 0) return null
  const commit = text.slice(0, first).trim()
  if (!/^[0-9a-f]{4,40}$/iu.test(commit)) return null
  return {
    commit,
    date: boundedField(text.slice(first + 1, second)).slice(0, AUTHOR_DATE_LIMIT),
    author: boundedField(text.slice(second + 1, third)),
    subject: boundedField(text.slice(third + 1)),
  }
}

export async function gitLogTool({ path: rawPath, limit = DEFAULT_LOG_LIMIT, since = '', cwd: rawCwd, userId = null } = {}) {
  const env = getRuntimeEnv()
  requireGitEnabled(env)
  const root = getRoot({ userId, cwd: rawCwd, env })
  const repoPath = normalizeRepoPath(rawPath)
  const count = boundedCount(limit, DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT)
  const sinceValue = String(since || '').trim()
  if (sinceValue && !parseLocalDateTime(sinceValue).ok) {
    return {
      ok: false,
      code: 'GIT_LOG_SINCE_INVALID',
      error: 'since 需要 yyyy-mm-dd 或 yyyy-mm-ddTHH:mm。',
      hint: '省略 since 可读取全部历史。',
      retryable: false,
    }
  }
  const args = ['log', '--no-color', '--date=short', '--pretty=format:%h|%ad|%an|%s', '-n', String(count)]
  if (sinceValue) args.push(`--since=${sinceValue}`)
  if (repoPath) args.push('--', repoPath)
  const result = await runGit(args, { cwd: root, rejectOnError: false })
  if (!result.ok) {
    return {
      ok: false,
      ...historyFailure(result, {
        notRepositoryCopy: '可以继续用 read_file 与 grep_code 检查当前文件；若需要既有仓库的历史，请选择授权的仓库目录。',
        failureCopy: 'Git log failed.',
      }),
      commits: [],
    }
  }
  const commits = String(result.stdout || '')
    .split('\n')
    .map(parseLogLine)
    .filter(Boolean)
  return {
    ok: true,
    root,
    path: repoPath || null,
    limit: count,
    since: sinceValue || null,
    commits,
    text: clip(redactSensitiveText(result.stdout), 80_000),
  }
}

/** Parse `--line-porcelain` records; the first line carries the commit hash. */
function parseBlamePorcelain(stdout) {
  const lines = []
  let record = null
  for (const raw of String(stdout || '').split('\n')) {
    if (/^[0-9a-f]{4,40} \d+ \d+(?: \d+)?$/iu.test(raw)) {
      if (record) lines.push(record)
      record = { commit: raw.split(' ')[0], author: '', date: '', content: '' }
      continue
    }
    if (!record) continue
    if (raw.startsWith('author ')) record.author = boundedField(raw.slice(7))
    else if (raw.startsWith('author-time ')) {
      const seconds = Number(raw.slice(12))
      record.date = Number.isFinite(seconds)
        ? new Date(seconds * 1_000).toISOString().slice(0, 10)
        : ''
    } else if (raw.startsWith('\t')) record.content = boundedField(raw.slice(1))
  }
  if (record) lines.push(record)
  return lines
}

export async function gitBlameTool({
  path: rawPath,
  start_line: startLine = 1,
  line_count: lineCount = DEFAULT_BLAME_LINES,
  cwd: rawCwd,
  userId = null,
} = {}) {
  const env = getRuntimeEnv()
  requireGitEnabled(env)
  const root = getRoot({ userId, cwd: rawCwd, env })
  const repoPath = normalizeRepoPath(rawPath)
  if (!repoPath) {
    return {
      ok: false,
      code: 'GIT_BLAME_PATH_REQUIRED',
      error: 'git_blame 需要 file 路径。',
      hint: '先用 git_status 或 grep_code 确认要查看的文件。',
      retryable: false,
    }
  }
  const start = boundedCount(startLine, 1, Number.MAX_SAFE_INTEGER)
  const count = boundedCount(lineCount, DEFAULT_BLAME_LINES, MAX_BLAME_LINES)
  // `git blame` has no `--no-color` (it offers --no-color-lines/--no-color-by-age
  // and rejects the bare flag as ambiguous); porcelain is already plain text.
  const result = await runGit([
    'blame', '--line-porcelain', '-L', `${start},+${count}`, '--', repoPath,
  ], { cwd: root, rejectOnError: false })
  if (!result.ok) {
    return {
      ok: false,
      ...historyFailure(result, {
        notRepositoryCopy: '可以继续用 read_file 检查文件内容；若需要既有仓库的逐行归属，请选择授权的仓库目录。',
        failureCopy: 'Git blame failed.',
      }),
      path: repoPath,
      lines: [],
    }
  }
  const lines = parseBlamePorcelain(result.stdout).slice(0, MAX_BLAME_LINES)
    .map((line, index) => ({ ...line, line: start + index }))
  return { ok: true, root, path: repoPath, startLine: start, lineCount: count, lines }
}

export function dispatchGitHistoryTool(name, args = {}, options = {}) {
  switch (name) {
    case 'git_log': return gitLogTool({ ...args, ...options })
    case 'git_blame': return gitBlameTool({ ...args, ...options })
    default: throw new Error(`unknown git history tool: ${name}`)
  }
}

export function isGitHistoryTool(name) {
  return name === 'git_log' || name === 'git_blame'
}

export const GIT_HISTORY_TOOL_NAMES = Object.freeze(['git_log', 'git_blame'])

export const GIT_HISTORY_TOOL_SPECS = [
  {
    type: 'function',
    function: {
      name: 'git_log',
      description: 'Read recent commit history (hash, date, author, subject) for the repository or one path. Read-only. Use it to see what changed before reviewing or editing code.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional repository-relative file or directory to limit history to.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LOG_LIMIT, description: `Maximum commits to return (default ${DEFAULT_LOG_LIMIT}).` },
          since: { type: 'string', description: 'Optional lower bound: yyyy-mm-dd or yyyy-mm-ddTHH:mm.' },
          cwd: { type: 'string', description: 'Optional workspace-relative or authorized absolute repository path.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_blame',
      description: 'Read which commit and author last touched each line of a file, over a bounded line range. Read-only. Use it to explain why a line looks the way it does.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Repository-relative file to blame. Required.' },
          start_line: { type: 'integer', minimum: 1, description: 'First line to blame (default 1).' },
          line_count: { type: 'integer', minimum: 1, maximum: MAX_BLAME_LINES, description: `How many lines to blame (default ${DEFAULT_BLAME_LINES}, maximum ${MAX_BLAME_LINES}).` },
          cwd: { type: 'string', description: 'Optional workspace-relative or authorized absolute repository path.' },
        },
        required: ['path'],
      },
    },
  },
]
