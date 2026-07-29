import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

// 注册 .jsx 加载器,让 node:test 能直接跑 React 组件测试。
register('./jsxLoader.mjs', pathToFileURL(import.meta.filename))
