async function currentHead(runGit, cwd) {
  const result = await runGit(['rev-parse', 'HEAD'], { cwd })
  return result.stdout.trim()
}

export async function changedPathsBetweenGitRevisions(runGit, cwd, before, after) {
  if (!before || !after || before === after) return []
  const result = await runGit(
    ['diff', '--name-only', '-z', '--no-ext-diff', before, after, '--'],
    { cwd, rejectOnError: false },
  )
  if (!result.ok) return ['<workspace>']
  return [...new Set(String(result.stdout || '').split('\0').filter(Boolean))]
}

async function runWorkspaceMutation(runGit, args, cwd) {
  const before = await currentHead(runGit, cwd)
  const result = await runGit(args, { cwd, rejectOnError: false })
  if (!result.ok) return { result, changedPaths: [] }
  const after = await currentHead(runGit, cwd)
  return {
    result,
    changedPaths: await changedPathsBetweenGitRevisions(runGit, cwd, before, after),
  }
}

export async function runGitWorkspaceChange({
  operation,
  branch,
  root,
  runGit,
  requireCleanWorkingTree,
  validateBranchName,
  currentBranch,
  badReq,
}) {
  if (operation === 'checkout') {
    await requireCleanWorkingTree(root, 'checkout')
    const target = await validateBranchName(branch, root)
    const exists = await runGit(['show-ref', '--verify', '--quiet', `refs/heads/${target}`], {
      cwd: root,
      rejectOnError: false,
    })
    if (!exists.ok) throw badReq(`local branch does not exist: ${target}`)
    const { result, changedPaths } = await runWorkspaceMutation(
      runGit,
      ['switch', target],
      root,
    )
    if (!result.ok) {
      throw badReq(String(result.stderr || result.stdout || 'git checkout failed').trim(), 500)
    }
    return {
      ok: true,
      action: operation,
      branch: target,
      changedPaths,
      stdout: result.stdout,
      stderr: result.stderr,
    }
  }

  if (operation !== 'pull') return null
  await requireCleanWorkingTree(root, 'pull')
  const current = await currentBranch(root)
  if (!current || current === 'HEAD') throw badReq('cannot pull from detached HEAD')
  if (branch) {
    const expected = await validateBranchName(branch, root)
    if (expected !== current) {
      throw badReq(`requested branch ${expected} is not the current branch ${current}`)
    }
  }
  const { result, changedPaths } = await runWorkspaceMutation(
    runGit,
    ['pull', '--ff-only', 'origin', current],
    root,
  )
  if (!result.ok) {
    throw badReq(String(result.stderr || result.stdout || 'git pull --ff-only failed').trim(), 500)
  }
  return {
    ok: true,
    action: operation,
    branch: current,
    remote: 'origin',
    changedPaths,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}
