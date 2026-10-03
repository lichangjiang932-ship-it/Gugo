import { redactSensitiveText } from '../../shared/sensitiveText.js'

/** Git help output is not a diff. Keep failures compact and actionable instead
 * of duplicating the entire usage page into both stat and patch context. */
export function gitDiffFailure(result) {
  const diagnostic = String(result.stderr || '')
  const notRepository = /not a git repository|outside a working tree/i.test(diagnostic)
  const detail = redactSensitiveText(diagnostic).split(/\r?\n/).find((line) => line.trim())?.slice(0, 1000)
  return {
    ok: false,
    code: notRepository ? 'GIT_NOT_REPOSITORY' : result.timedOut ? 'GIT_DIFF_TIMEOUT' : 'GIT_DIFF_FAILED',
    error: notRepository ? '当前目录不是 Git 工作树，无法读取 Git diff。'
      : result.timedOut ? 'Git diff 未能在截止时间内完成。' : detail || 'Git diff failed.',
    hint: notRepository ? '可以继续用 read_file 检查文件并运行项目测试；若需要已有仓库的 diff，请选择授权的仓库目录。'
      : '检查 Git 状态和工作目录；此失败不代表没有文件变化。',
    retryable: false,
    diff: '',
    stat: '',
    exitCode: result.exitCode,
    ...(result.timedOut ? { timedOut: true } : {}),
  }
}
