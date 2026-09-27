/**
 * The vocabulary the execution timeline is read in.
 *
 * The timeline is meant to read as *the agent's work*, not as a tool log: every
 * call is labelled with what the agent was doing (终端 / 编辑 / 搜索 …) and
 * consecutive calls of one family collapse into a single group row —
 * "查阅 · 2 搜索, 2 文件" — the way Claude Code presents its own trajectory.
 *
 * Only the recorded tool name decides a kind. Nothing here infers intent from
 * arguments, output or prose: a `bash_exec` that happens to contain `grep` is a
 * 终端 step, because that is the tool the runtime actually ran. (Models with a
 * dedicated search tool get 搜索 for it; this app has one.)
 *
 * Pure: no IO, no i18n lookups, no React. Labels are resolved by the renderer.
 */

export const STEP_KIND = Object.freeze({
  CONSULT: 'consult',
  SEARCH: 'search',
  COMMAND: 'command',
  EDIT: 'edit',
  WRITE: 'write',
  CREATE: 'create',
  DELEGATE: 'delegate',
  OTHER: 'other',
})

/** A group row is labelled by family; a lone call by its kind. */
export const STEP_FAMILY = Object.freeze({
  RETRIEVAL: 'retrieval',
  COMMAND: 'command',
  MUTATION: 'mutation',
  CREATE: 'create',
  DELEGATE: 'delegate',
  OTHER: 'other',
})

const KIND_BY_TOOL = Object.freeze({
  read_file: STEP_KIND.CONSULT,
  read_artifact_source: STEP_KIND.CONSULT,
  list_directory: STEP_KIND.CONSULT,
  find_symbol: STEP_KIND.CONSULT,
  list_imports: STEP_KIND.CONSULT,
  git_status: STEP_KIND.CONSULT,
  git_diff: STEP_KIND.CONSULT,
  git_log: STEP_KIND.CONSULT,
  git_blame: STEP_KIND.CONSULT,
  process_list: STEP_KIND.CONSULT,
  web_search: STEP_KIND.SEARCH,
  fetch_url: STEP_KIND.SEARCH,
  grep_code: STEP_KIND.SEARCH,
  bash_exec: STEP_KIND.COMMAND,
  run_command: STEP_KIND.COMMAND,
  run_test: STEP_KIND.COMMAND,
  run_project_check: STEP_KIND.COMMAND,
  docker_exec: STEP_KIND.COMMAND,
  bash_background: STEP_KIND.COMMAND,
  process_kill: STEP_KIND.COMMAND,
  edit_file: STEP_KIND.EDIT,
  multi_edit: STEP_KIND.EDIT,
  apply_patch: STEP_KIND.EDIT,
  rewind_files: STEP_KIND.EDIT,
  write_file: STEP_KIND.WRITE,
  render_pdf_pages: STEP_KIND.CREATE,
  Agent: STEP_KIND.DELEGATE,
  load_skill: STEP_KIND.OTHER,
  manage_todos: STEP_KIND.OTHER,
  request_directory: STEP_KIND.OTHER,
  request_clarification: STEP_KIND.OTHER,
  set_deliverables: STEP_KIND.OTHER,
  reflect: STEP_KIND.OTHER,
})

const FAMILY_BY_KIND = Object.freeze({
  [STEP_KIND.CONSULT]: STEP_FAMILY.RETRIEVAL,
  [STEP_KIND.SEARCH]: STEP_FAMILY.RETRIEVAL,
  [STEP_KIND.COMMAND]: STEP_FAMILY.COMMAND,
  [STEP_KIND.EDIT]: STEP_FAMILY.MUTATION,
  [STEP_KIND.WRITE]: STEP_FAMILY.MUTATION,
  [STEP_KIND.CREATE]: STEP_FAMILY.CREATE,
  [STEP_KIND.DELEGATE]: STEP_FAMILY.DELEGATE,
  [STEP_KIND.OTHER]: STEP_FAMILY.OTHER,
})

export function stepKindForTool(name) {
  const key = String(name || '').trim()
  if (!key) return STEP_KIND.OTHER
  // Artifact writers share one verb; the naming is `create_<format>` plus the
  // renderer, and new formats should not need a new row label.
  if (key.startsWith('create_')) return STEP_KIND.CREATE
  return KIND_BY_TOOL[key] || STEP_KIND.OTHER
}

export function stepFamilyForKind(kind) {
  return FAMILY_BY_KIND[kind] || STEP_FAMILY.OTHER
}

/**
 * The tools whose row label *is* the verb (读取 / 搜索 / 终端 / 编辑 / 写入) —
 * the everyday ones, where 读取 beats 读取文件.
 *
 * Everything else keeps its own name, because those names carry information the
 * verb would throw away: "Read editable source" and "Create PDF" say more than
 * 读取 and 生成 do. `stepKindForTool` still classifies them, so they group and
 * count correctly; only the label differs.
 */
export const STEP_VERB_TOOLS = Object.freeze(new Set([
  'read_file',
  'list_directory',
  'grep_code',
  'web_search',
  'bash_exec',
  'run_command',
  'run_test',
  'edit_file',
  'multi_edit',
  'apply_patch',
  'write_file',
]))

export function stepUsesVerbLabel(name) {
  return STEP_VERB_TOOLS.has(String(name || '').trim())
}

/**
 * Group a run of calls into consecutive same-family groups, preserving order.
 *
 * Runs are consecutive on purpose: work that returns to retrieval after a
 * command forms a second 查阅 group, which is how the timeline reads as a
 * sequence of phases rather than one merged pile.
 *
 * @param {Array<object>} calls
 * @returns {Array<{family: string, calls: Array<{call: object, index: number, kind: string}>}>}
 */
export function groupToolCalls(calls = []) {
  const list = Array.isArray(calls) ? calls : []
  const groups = []
  list.forEach((call, index) => {
    const kind = stepKindForTool(call?.name)
    const family = stepFamilyForKind(kind)
    const previous = groups[groups.length - 1]
    if (previous && previous.family === family) {
      previous.calls.push({ call, index, kind })
      return
    }
    groups.push({ family, calls: [{ call, index, kind }] })
  })
  return groups
}

/**
 * Counts per kind inside a group, in first-appearance order, for the group row's
 * summary ("2 搜索, 2 文件").
 */
export function groupKindCounts(group) {
  const counts = new Map()
  for (const entry of group?.calls || []) {
    counts.set(entry.kind, (counts.get(entry.kind) || 0) + 1)
  }
  return [...counts.entries()].map(([kind, count]) => ({ kind, count }))
}
