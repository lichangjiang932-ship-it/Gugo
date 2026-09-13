const BRANCH_ACTIONS = new Set(['changed', 'created', 'deleted', 'modified'])

function branchFileOperationDto(value, label, fail, helpers) {
  const { record, own, text } = helpers
  const source = record(value, label, fail)
  const action = text(own(source, 'action', label, fail), `${label}.action`, fail, {
    max: 32,
    empty: false,
  })
  if (!BRANCH_ACTIONS.has(action)) fail(`${label}.action is invalid`)
  return Object.freeze({
    path: text(own(source, 'path', label, fail), `${label}.path`, fail, {
      max: 4096,
      empty: false,
    }),
    action,
    toolName: text(own(source, 'toolName', label, fail), `${label}.toolName`, fail, {
      max: 256,
      empty: false,
    }),
  })
}

function optionalBranchFileOperations(branch, label, fail, helpers) {
  const { own, array } = helpers
  const raw = own(branch, 'fileOperations', label, fail, { optional: true })
  if (raw === undefined) return undefined
  return array(
    raw,
    `${label}.fileOperations`,
    fail,
    (operation, index) => branchFileOperationDto(
      operation,
      `${label}.fileOperations[${index}]`,
      fail,
      helpers,
    ),
    { max: 8 },
  )
}

function projectBranch(branch, index, fail, helpers) {
  const { own, text, integer, boolean, sessionDto } = helpers
  const label = `result.branches[${index}]`
  const projected = sessionDto(branch, label, fail)
  const depth = integer(own(branch, 'depth', label, fail), `${label}.depth`, fail, { max: 5 })
  const rawSummary = own(branch, 'branchSummary', label, fail, { optional: true })
  const rawTipRole = own(branch, 'branchTipRole', label, fail, { optional: true })
  const rawMessageCount = own(branch, 'messageCount', label, fail, { optional: true })
  const rawTruncated = own(branch, 'fileOperationsTruncated', label, fail, { optional: true })
  const branchSummary = rawSummary === undefined
    ? undefined
    : text(rawSummary, `${label}.branchSummary`, fail, { max: 500 })
  const branchTipRole = rawTipRole === undefined
    ? undefined
    : text(rawTipRole, `${label}.branchTipRole`, fail, {
        max: 32,
        empty: false,
        nullable: true,
      })
  if (branchTipRole != null && !['user', 'assistant'].includes(branchTipRole)) {
    fail(`${label}.branchTipRole is invalid`)
  }
  const messageCount = rawMessageCount === undefined
    ? undefined
    : integer(rawMessageCount, `${label}.messageCount`, fail, { max: 50_000 })
  const fileOperations = optionalBranchFileOperations(branch, label, fail, helpers)
  const fileOperationsTruncated = rawTruncated === undefined
    ? undefined
    : boolean(rawTruncated, `${label}.fileOperationsTruncated`, fail)
  return Object.freeze({
    ...projected,
    depth,
    ...(branchSummary === undefined ? {} : { branchSummary }),
    ...(branchTipRole === undefined ? {} : { branchTipRole }),
    ...(messageCount === undefined ? {} : { messageCount }),
    ...(fileOperations === undefined ? {} : { fileOperations }),
    ...(fileOperationsTruncated === undefined ? {} : { fileOperationsTruncated }),
  })
}

function validateBranchLineage(branches, rootSessionId, fail) {
  if (!branches.length || branches[0].id !== rootSessionId || branches[0].depth !== 0) {
    fail('result.branches must begin with the root session at depth 0')
  }
  const byId = new Map()
  let previousDepth = -1
  for (const branch of branches) {
    if (byId.has(branch.id)) fail(`duplicate branch id: ${branch.id}`)
    if (branch.depth < previousDepth) fail('result.branches must be ordered by non-decreasing depth')
    if (branch.depth === 0) {
      if (branch.id !== rootSessionId || branch.parentSessionId !== null) {
        fail('result root branch is inconsistent')
      }
    } else {
      const parent = byId.get(branch.parentSessionId)
      if (!parent || parent.depth + 1 !== branch.depth) {
        fail(`branch ${branch.id} has an invalid parent or depth`)
      }
    }
    byId.set(branch.id, branch)
    previousDepth = branch.depth
  }
}

export function projectSessionBranchesDto(value, fail, helpers) {
  const { record, own, text, array, boolean } = helpers
  const source = record(value, 'result', fail)
  const rootSessionId = text(
    own(source, 'rootSessionId', 'result', fail),
    'result.rootSessionId',
    fail,
    { max: 512, empty: false },
  )
  const branches = array(
    own(source, 'branches', 'result', fail),
    'result.branches',
    fail,
    (branch, index) => projectBranch(branch, index, fail, helpers),
    { max: 1000 },
  )
  validateBranchLineage(branches, rootSessionId, fail)
  const truncated = boolean(own(source, 'truncated', 'result', fail), 'result.truncated', fail)
  return Object.freeze({ rootSessionId, branches, truncated })
}
