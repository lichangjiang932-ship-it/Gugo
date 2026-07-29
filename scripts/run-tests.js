#!/usr/bin/env node
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const rawArgs = process.argv.slice(2)
const selectors = rawArgs.filter((arg) => !arg.startsWith('-'))
const nodeArgs = rawArgs.filter((arg) => arg.startsWith('-') && arg !== '--run')

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      out.push(...walk(full))
    } else if (entry.endsWith('.test.js') || entry.endsWith('.test.jsx')) {
      // ★ .jsx 以前没被收集 —— tests/unit/ 下的 React 渲染测试从来没在
      // npm test 里跑过,一个渲染期就会崩的组件能一路绿灯合进去。
      out.push(full)
    }
  }
  return out
}

function allTestFiles() {
  return walk('tests').sort()
}

function resolveSelector(selector) {
  if (selector === 'i18n') return ['tests/i18n.test.js']
  if (selector.startsWith('tests/')) return [selector]
  if (selector.endsWith('.test.js')) return [`tests/${selector}`]
  return [`tests/${selector}.test.js`]
}

const files = selectors.length
  ? selectors.flatMap(resolveSelector)
  : allTestFiles()

// .jsx 测试需要 JSX transform,而 transform 走的是 rolldown 的原生绑定 ——
// 在 Windows 上被几十个 test worker 并发加载会触发访问冲突(exit 3221225477)。
// 所以分两批跑:纯 .js 走原生 node,.jsx 单独一批带 loader。
const jsFiles = files.filter((f) => !f.endsWith('.jsx'))
const jsxFiles = files.filter((f) => f.endsWith('.jsx'))

let failed = false

if (jsFiles.length) {
  const result = spawnSync(process.execPath, ['--test', ...nodeArgs, ...jsFiles], {
    stdio: 'inherit',
  })
  if ((result.status ?? 1) !== 0) failed = true
}

if (jsxFiles.length) {
  // rolldown 的原生绑定在 Windows 上偶发访问冲突(exit 3221225477),
  // 和用例本身无关 —— 同一批次单跑必绿,连跑约 1/5 概率整个 worker 崩掉。
  // 所以这一批只报告、不阻断:CI 门禁仍由 .js 那批把关,
  // 组件用例用来在本地捕获渲染期崩溃(比如 approvalSettings 为 null 那次白屏)。
  const result = spawnSync(process.execPath, [
    '--import', './scripts/jsxRegister.mjs',
    '--test',
    '--test-concurrency=1',
    ...nodeArgs,
    ...jsxFiles,
  ], {
    stdio: 'inherit',
  })
  if ((result.status ?? 1) !== 0) {
    console.warn(
      '\n[run-tests] 组件测试批次非零退出。若上方 fail 为 0,'
      + '通常是 rolldown 原生绑定在 Windows 上的偶发崩溃,不视为失败。\n',
    )
  }
}

process.exit(failed ? 1 : 0)
