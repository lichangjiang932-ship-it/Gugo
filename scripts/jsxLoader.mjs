/**
 * node:test 的 .jsx 加载器。
 *
 * 背景:tests/unit/ 下的 React 测试是 .jsx,但 scripts/run-tests.js 只收 .test.js,
 * 而且 node 本身不认 .jsx —— 结果这些测试从来没在 npm test 里跑过。
 * 一个渲染期就会炸的组件(比如 import 了 lucide 里不存在的图标)能一路绿灯合进去。
 *
 * 用纯 JavaScript 的 sucrase 把 JSX 编成 JS，避免 Windows 下
 * rolldown 原生 binding 在测试进程退出阶段偶发访问冲突。
 */
import { transform } from 'sucrase'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * 补扩展名。源码里大量 `import LeftRail from '../components/LeftRail'`,
 * Vite 会自动补 .jsx/.js,node 不会 —— 不补的话根本 import 不进来。
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (err) {
    if (!specifier.startsWith('.') || !context.parentURL) throw err
    const base = new URL(specifier, context.parentURL)
    for (const ext of ['.jsx', '.js', '/index.jsx', '/index.js']) {
      const candidate = new URL(base.href + ext)
      if (existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, format: 'module', shortCircuit: true }
      }
    }
    throw err
  }
}

export async function load(url, context, nextLoad) {
  if (!url.endsWith('.jsx')) return nextLoad(url, context)
  const source = await readFile(fileURLToPath(url), 'utf8')
  const result = transform(source, {
    transforms: ['jsx'],
    jsxRuntime: 'automatic',
    production: true,
    filePath: fileURLToPath(url),
  })
  return { format: 'module', shortCircuit: true, source: result.code }
}
