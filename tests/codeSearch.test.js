import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { grepCodeTool, findSymbolTool, listImportsTool } from '../server/utils/codeSearch.js'

let tmpRoot
let savedWsRoot

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-codesearch-'))
  savedWsRoot = process.env.WORKSPACE_ROOT
  process.env.WORKSPACE_ROOT = tmpRoot

  // 准备测试 fixture
  fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true })
  fs.writeFileSync(path.join(tmpRoot, 'src', 'auth.ts'), `import { db } from './db'
import type { User } from '../types'

export function loginUser(email: string) {
  return db.users.findOne({ email })
}

export async function logoutUser(id: string) {
  return db.sessions.deleteOne({ userId: id })
}

export class AuthError extends Error {
  constructor(msg: string) { super(msg) }
}

export const AUTH_TIMEOUT = 3600
`)
  fs.writeFileSync(path.join(tmpRoot, 'src', 'pay.py'), `from typing import Optional
import requests

def charge(user_id: str, amount: int) -> Optional[str]:
    return None

class PaymentError(Exception):
    pass

API_BASE = "https://api.example.com"
`)
  fs.writeFileSync(path.join(tmpRoot, 'src', 'main.rs'), `use std::collections::HashMap;
use crate::types::User;

pub fn parse_user(s: &str) -> User {
    todo!()
}

pub struct Config {
    pub port: u16,
}

pub const MAX_RETRIES: u32 = 5;
`)
  // 排除目录:不该被搜到
  fs.mkdirSync(path.join(tmpRoot, 'node_modules', 'evil'), { recursive: true })
  fs.writeFileSync(path.join(tmpRoot, 'node_modules', 'evil', 'a.js'), 'function loginUser() {}\n')
  fs.mkdirSync(path.join(tmpRoot, '.git'), { recursive: true })
  fs.writeFileSync(path.join(tmpRoot, '.git', 'config'), 'loginUser=secret\n')
})

after(() => {
  if (savedWsRoot == null) delete process.env.WORKSPACE_ROOT
  else process.env.WORKSPACE_ROOT = savedWsRoot
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true })
})

test('grepCodeTool: 基础搜索找到正确文件 + 行号', async () => {
  const r = await grepCodeTool({ pattern: 'loginUser' })
  assert.equal(r.ok, true)
  assert.ok(r.matches.length >= 1)
  const m = r.matches.find((x) => x.file.endsWith('auth.ts'))
  assert.ok(m, 'should match auth.ts')
  assert.equal(m.line, 4)
  assert.ok(m.text.includes('loginUser'))
})

test('grepCodeTool: 排除 node_modules / .git', async () => {
  const r = await grepCodeTool({ pattern: 'loginUser' })
  assert.equal(r.ok, true)
  for (const m of r.matches) {
    assert.ok(!m.file.includes('node_modules'), `should skip node_modules, got ${m.file}`)
    assert.ok(!m.file.includes('.git/'), `should skip .git, got ${m.file}`)
  }
})

test('grepCodeTool: file_type 过滤', async () => {
  const r = await grepCodeTool({ pattern: '.', file_type: 'py' })
  assert.equal(r.ok, true)
  for (const m of r.matches) {
    assert.ok(m.file.endsWith('.py'), `expect .py, got ${m.file}`)
  }
})

test('grepCodeTool: glob 过滤', async () => {
  const r = await grepCodeTool({ pattern: '.', glob: '*.rs' })
  assert.equal(r.ok, true)
  for (const m of r.matches) {
    assert.ok(m.file.endsWith('.rs'), `expect .rs, got ${m.file}`)
  }
})

test('grepCodeTool: 路径越界拒绝', async () => {
  await assert.rejects(
    () => grepCodeTool({ pattern: 'x', path: '/etc' }),
    /路径越界/
  )
})

test('grepCodeTool: pattern 必填', async () => {
  await assert.rejects(() => grepCodeTool({}), /pattern 必填/)
  await assert.rejects(() => grepCodeTool({ pattern: '' }), /pattern 必填/)
})

test('grepCodeTool: max_results 截断', async () => {
  // 用 . 匹配每行,人为多结果
  const r = await grepCodeTool({ pattern: '.', max_results: 2 })
  assert.equal(r.ok, true)
  assert.ok(r.matches.length <= 2)
  if (r.matches.length === 2) assert.equal(r.truncated, true)
})

test('findSymbolTool: TS function 定义', async () => {
  const r = await findSymbolTool({ name: 'loginUser', kind: 'function' })
  assert.equal(r.ok, true)
  assert.ok(r.symbols.length >= 1)
  const s = r.symbols.find((x) => x.file.endsWith('auth.ts'))
  assert.ok(s, 'should find loginUser in auth.ts')
  assert.equal(s.line, 4)
})

test('findSymbolTool: TS class 定义', async () => {
  const r = await findSymbolTool({ name: 'AuthError', kind: 'class' })
  assert.equal(r.ok, true)
  const s = r.symbols.find((x) => x.file.endsWith('auth.ts'))
  assert.ok(s)
  assert.ok(/class\s+AuthError/.test(s.definition))
})

test('findSymbolTool: TS const 定义', async () => {
  const r = await findSymbolTool({ name: 'AUTH_TIMEOUT', kind: 'const' })
  assert.equal(r.ok, true)
  assert.ok(r.symbols.find((x) => x.file.endsWith('auth.ts')))
})

test('findSymbolTool: Python def', async () => {
  const r = await findSymbolTool({ name: 'charge', kind: 'function' })
  assert.equal(r.ok, true)
  const s = r.symbols.find((x) => x.file.endsWith('pay.py'))
  assert.ok(s, 'should find charge in pay.py')
})

test('findSymbolTool: Python class', async () => {
  const r = await findSymbolTool({ name: 'PaymentError', kind: 'class' })
  assert.equal(r.ok, true)
  assert.ok(r.symbols.find((x) => x.file.endsWith('pay.py')))
})

test('findSymbolTool: Rust struct + fn + const', async () => {
  const fnR = await findSymbolTool({ name: 'parse_user', kind: 'function' })
  assert.equal(fnR.ok, true)
  assert.ok(fnR.symbols.find((x) => x.file.endsWith('main.rs')))

  const stR = await findSymbolTool({ name: 'Config', kind: 'class' })
  assert.equal(stR.ok, true)
  assert.ok(stR.symbols.find((x) => x.file.endsWith('main.rs')))

  const cR = await findSymbolTool({ name: 'MAX_RETRIES', kind: 'const' })
  assert.equal(cR.ok, true)
  assert.ok(cR.symbols.find((x) => x.file.endsWith('main.rs')))
})

test('findSymbolTool: 不合法标识符拒绝', async () => {
  await assert.rejects(() => findSymbolTool({ name: '../etc' }), /合法标识符/)
  await assert.rejects(() => findSymbolTool({ name: '123abc' }), /合法标识符/)
  await assert.rejects(() => findSymbolTool({ name: '' }), /必填/)
})

test('findSymbolTool: kind 非法拒绝', async () => {
  await assert.rejects(() => findSymbolTool({ name: 'x', kind: 'evil' }), /kind 必须/)
})

test('listImportsTool: ESM imports', async () => {
  const r = await listImportsTool({ file: 'src/auth.ts' })
  assert.equal(r.ok, true)
  const sources = r.imports.map((i) => i.source)
  assert.ok(sources.includes('./db'))
  assert.ok(sources.includes('../types'))
  // 全部 esm kind
  for (const imp of r.imports) {
    assert.ok(['esm', 'cjs'].includes(imp.kind))
  }
})

test('listImportsTool: Python imports', async () => {
  const r = await listImportsTool({ file: 'src/pay.py' })
  assert.equal(r.ok, true)
  const sources = r.imports.map((i) => i.source)
  // from typing import Optional → source = 'typing'
  assert.ok(sources.some((s) => s === 'typing'))
  assert.ok(sources.some((s) => s === 'requests'))
})

test('listImportsTool: Rust use', async () => {
  const r = await listImportsTool({ file: 'src/main.rs' })
  assert.equal(r.ok, true)
  const sources = r.imports.map((i) => i.source)
  assert.ok(sources.some((s) => s.startsWith('std::collections')))
  assert.ok(sources.some((s) => s.startsWith('crate::types')))
})

test('listImportsTool: 文件不存在抛错', async () => {
  await assert.rejects(() => listImportsTool({ file: 'nonexistent.js' }))
})

test('listImportsTool: 路径越界', async () => {
  await assert.rejects(() => listImportsTool({ file: '/etc/passwd' }), /路径越界/)
})
