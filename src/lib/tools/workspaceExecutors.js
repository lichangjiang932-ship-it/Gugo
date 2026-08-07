import { getAuthToken } from '../accountClient.js'
import { callJson, callWorkspaceJson } from './toolHttpClient.js'

async function execWebSearch(args) {
  const query = String(args?.query || '').trim()
  if (!query) throw new Error('query \u4e0d\u80fd\u4e3a\u7a7a')
  const max_results = Number(args?.max_results) || 6
  const data = await callJson('/api/tools/search', { query, maxResults: max_results })
  // \u8fd4\u7ed9\u6a21\u578b\u7684\u5185\u5bb9\u5c3d\u91cf\u7cbe\u7b80
  return {
    content: JSON.stringify({
      query,
      results: (data.results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })),
    }),
  }
}

async function execFetchUrl(args) {
  const url = String(args?.url || '').trim()
  if (!url) throw new Error('url \u4e0d\u80fd\u4e3a\u7a7a')
  const data = await callJson('/api/tools/fetch', { url })
  return {
    content: JSON.stringify({
      url: data.url || url,
      title: data.title || '',
      truncated: !!data.truncated,
      markdown: data.markdown || '',
    }),
  }
}

// \u2500\u2500 G1: \u6587\u4ef6\u751f\u6210\u5de5\u5177 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// \u8fd9\u4e09\u4e2a\u5de5\u5177\u4e0d\u8d70\u540e\u7aef \u2014 \u76f4\u63a5\u5728\u524d\u7aef\u7528 pptxgenjs / docx / xlsx \u751f\u6210,
// \u8fd4\u56de\u5e26 artifact \u63cf\u8ff0\u7b26\u7684\u7ed3\u679c.executor \u628a artifact \u900f\u5230 callsite,
// callsite \u518d\u5199\u5230 last message meta(artifactType + artifactSource),
// ChatMessages \u770b\u5230 explicit artifact \u5c31\u76f4\u63a5\u6e32\u67d3\u5361\u7247 + \u5f39\u53f3\u680f\u9884\u89c8.
//
// \u6a21\u578b\u62ff\u5230\u7684\u5de5\u5177 content \u53ea\u662f\u7b80\u77ed ack(\u907f\u514d markdown \u5168\u6587\u56de\u704c\u5360\u7528\u4e0a\u4e0b\u6587).


async function execReadFile(args) {
  const data = await callWorkspaceJson('/api/tools/fs/read', args)
  return { content: JSON.stringify(data) }
}

async function execListDirectory(args) {
  const data = await callWorkspaceJson('/api/tools/fs/list', args)
  return { content: JSON.stringify(data) }
}

async function execWriteFile(args) {
  const data = await callWorkspaceJson('/api/tools/fs/write', args)
  return { content: JSON.stringify(data) }
}

async function execEditFile(args) {
  const data = await callWorkspaceJson('/api/tools/fs/edit', args)
  return { content: JSON.stringify(data) }
}

async function execBashExec(args) {
  const data = await callWorkspaceJson('/api/tools/shell/exec', args)
  return { content: JSON.stringify(data) }
}

async function execGitStatus(args) {
  const data = await callWorkspaceJson('/api/tools/git/status', args || {})
  return { content: JSON.stringify(data) }
}

async function execGitDiff(args) {
  const data = await callWorkspaceJson('/api/tools/git/diff', args || {})
  return { content: JSON.stringify(data) }
}

async function execRunProjectCheck(args) {
  const data = await callWorkspaceJson('/api/tools/check/run', args || {})
  return { content: JSON.stringify(data) }
}

// \u2605 M1: \u4ee3\u7801\u641c\u7d22\u4e09\u4ef6\u5957
async function execGrepCode(args) {
  const data = await callWorkspaceJson('/api/tools/code/grep', args)
  return { content: JSON.stringify(data) }
}
async function execFindSymbol(args) {
  const data = await callWorkspaceJson('/api/tools/code/find-symbol', args)
  return { content: JSON.stringify(data) }
}
async function execListImports(args) {
  const data = await callWorkspaceJson('/api/tools/code/list-imports', args)
  return { content: JSON.stringify(data) }
}
async function execApplyPatch(args) {
  // \u5ba2\u6237\u7aef\u53ea\u83b7\u53d6\u9884\u89c8\u5e76\u8f6c\u53d1\u6267\u884c\u8bf7\u6c42\u3002\u98ce\u9669\u88c1\u51b3\u3001\u6388\u6743\u8303\u56f4\u4e0e\u5ba1\u8ba1\u5747\u7531\u670d\u52a1\u7aef\u5904\u7406\u3002
  const preview = await callWorkspaceJson('/api/tools/code/apply-patch', { ...args, dry_run: true })
  if (preview?.ok === false) {
    return { ok: false, content: JSON.stringify(preview) }
  }
  const data = await callWorkspaceJson('/api/tools/code/apply-patch', { ...args, dry_run: false })
  return { ok: data?.ok !== false, content: JSON.stringify(data) }
}
async function execReflect(args) {
  const data = await callWorkspaceJson('/api/tools/agent/reflect', args)
  return { content: JSON.stringify(data) }
}
async function execRemember(args) {
  const data = await callWorkspaceJson('/api/tools/agent/remember', args)
  return { ok: data?.ok !== false, content: JSON.stringify(data) }
}

async function execRequestClarification(args) {
  const data = await callWorkspaceJson('/api/tools/agent/clarify', args)
  return { content: JSON.stringify(data) }
}

async function execMultiEdit(args) {
  const { edits } = args
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error('multi_edit: edits \u4e0d\u80fd\u4e3a\u7a7a')
  }

  // Phase 1: \u8bfb\u53d6\u6240\u6709\u6587\u4ef6 + \u6821\u9a8c
  const originalContents = []
  for (const edit of edits) {
    const resp = await fetch('/api/tools/fs/read_file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getAuthToken()}` },
      body: JSON.stringify({ path: edit.path }),
    })
    const data = await resp.json()
    if (!data.ok) throw new Error(`multi_edit: \u65e0\u6cd5\u8bfb\u53d6 ${edit.path} \u2014 ${data.error || resp.status}`)

    const content = data.content
    const firstIdx = content.indexOf(edit.oldText)
    const lastIdx = content.lastIndexOf(edit.oldText)

    if (firstIdx === -1) {
      throw new Error(`multi_edit: "${edit.oldText.slice(0, 50)}..." \u5728 ${edit.path} \u4e2d\u4e0d\u5b58\u5728`)
    }
    if (firstIdx !== lastIdx) {
      throw new Error(`multi_edit: "${edit.oldText.slice(0, 50)}..." \u5728 ${edit.path} \u4e2d\u51fa\u73b0\u591a\u6b21\uff0c\u4e0d\u662f\u552f\u4e00`)
    }

    originalContents.push({ path: edit.path, original: content, edit })
  }

  // Phase 2: \u5168\u90e8\u901a\u8fc7 \u2192 \u6267\u884c\u5199\u5165
  const writtenFiles = []
  try {
    for (const item of originalContents) {
      const newContent = item.original.replace(item.edit.oldText, item.edit.newText)
      const resp = await fetch('/api/tools/fs/write_file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getAuthToken()}` },
        body: JSON.stringify({ path: item.path, content: newContent }),
      })
      const data = await resp.json()
      if (!data.ok) throw new Error(`\u5199\u5165 ${item.path} \u5931\u8d25: ${data.error || resp.status}`)
      writtenFiles.push(item)
    }
    return { ok: true, edited: edits.length, files: edits.map((e) => e.path) }
  } catch (err) {
    // Phase 3: \u56de\u6eda\u5df2\u5199\u7684\u6587\u4ef6
    for (const item of writtenFiles) {
      try {
        await fetch('/api/tools/fs/write_file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getAuthToken()}` },
          body: JSON.stringify({ path: item.path, content: item.original }),
        })
      } catch { /* \u56de\u6eda\u5931\u8d25\u9759\u9ed8 */ }
    }
    throw new Error(`multi_edit \u5931\u8d25\uff0c\u5df2\u56de\u6eda ${writtenFiles.length} \u4e2a\u6587\u4ef6: ${err.message}`, { cause: err })
  }
}

export const WORKSPACE_EXECUTORS = {
  web_search: execWebSearch,
  fetch_url: execFetchUrl,
  list_directory: execListDirectory,
  read_file: execReadFile,
  write_file: execWriteFile,
  edit_file: execEditFile,
  bash_exec: execBashExec,
  git_status: execGitStatus,
  git_diff: execGitDiff,
  run_project_check: execRunProjectCheck,
  multi_edit: execMultiEdit,
  grep_code: execGrepCode,
  find_symbol: execFindSymbol,
  list_imports: execListImports,
  apply_patch: execApplyPatch,
  reflect: execReflect,
  request_clarification: execRequestClarification,
  remember: execRemember,
}

