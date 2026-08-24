import test from 'node:test'
import assert from 'node:assert/strict'
import {
  activateChatWorkspace,
  chatWorkspaceName,
  createManagedChatProject,
  deriveRecentChatWorkspaces,
  pickNativeChatWorkspaceDirectory,
} from '../src/lib/chatWorkspaceSelection.js'
import { useChatAttachmentActions } from '../src/pages/ChatSplit/chatAttachmentActions.js'
import { reduceSessionLifecycleState } from '../src/store/reducers/sessionLifecycleReducer.js'

test('recent chat workspaces are unique, named, and ordered by latest session use', () => {
  const recent = deriveRecentChatWorkspaces([
    { id: 'old', workspacePath: 'D:\\Work\\alpha', updatedAt: 10 },
    { id: 'new', workspacePath: 'd:\\work\\alpha\\', updatedAt: 30 },
    { id: 'beta', workspacePath: '/work/beta', updatedAt: 20 },
    { id: 'plain', updatedAt: 40 },
  ])
  assert.deepEqual(recent.map(({ name, usedAt }) => ({ name, usedAt })), [
    { name: 'alpha', usedAt: 30 },
    { name: 'beta', usedAt: 20 },
  ])
  assert.equal(chatWorkspaceName('C:\\Projects\\gugo\\'), 'gugo')
})

test('activating a chat workspace grants write access before trusting it', async () => {
  const calls = []
  const result = await activateChatWorkspace('D:\\Projects\\gugo', {
    grantPath: async (input) => {
      calls.push(['grant', input])
      return {
        ok: true,
        grant: { id: 'grant-1', path: 'D:\\Projects\\Gugo Canonical' },
      }
    },
    trustWorkspace: async (input) => {
      calls.push(['trust', input])
      return { trusted: true }
    },
  })
  assert.equal(result.path, 'D:\\Projects\\Gugo Canonical')
  assert.equal(result.grant.id, 'grant-1')
  assert.deepEqual(calls, [
    ['grant', { path: 'D:\\Projects\\gugo', accessMode: 'read_write', scope: 'persistent' }],
    ['trust', { path: 'D:\\Projects\\Gugo Canonical', trusted: true, scope: 'persistent' }],
  ])
})

test('managed chat project creation accepts only the canonical server path', async () => {
  const calls = []
  const result = await createManagedChatProject('  Product site  ', {
    createProject: async (name, options) => {
      calls.push([name, options])
      return { ok: true, project: { path: ' D:\\Managed\\Product-a1b2c3d4 ' } }
    },
  })
  assert.equal(result.path, 'D:\\Managed\\Product-a1b2c3d4')
  assert.equal(calls[0][0], 'Product site')

  await assert.rejects(
    () => createManagedChatProject('Broken', {
      createProject: async () => ({ ok: true, project: {} }),
    }),
    (error) => error?.code === 'MANAGED_PROJECT_PATH_MISSING',
  )
})

test('native project directory selection distinguishes unsupported, selected, and canceled states', async () => {
  assert.deepEqual(await pickNativeChatWorkspaceDirectory('D:\\Projects', {
    desktopBridge: null,
    selectLocalDirectory: async () => ({ supported: false, canceled: false, path: '' }),
  }), {
    supported: false,
    canceled: false,
    path: '',
  })

  const calls = []
  const selected = await pickNativeChatWorkspaceDirectory(' D:\\Projects ', {
    desktopBridge: {
      openDirectory: async (request) => {
        calls.push(request)
        return { canceled: false, path: ' D:\\Projects\\selected ' }
      },
    },
  })
  assert.deepEqual(calls, [{ defaultPath: 'D:\\Projects' }])
  assert.deepEqual(selected, {
    supported: true,
    canceled: false,
    path: 'D:\\Projects\\selected',
  })

  assert.deepEqual(await pickNativeChatWorkspaceDirectory('', {
    desktopBridge: { selectDirectory: async () => ({ canceled: true, path: '' }) },
  }), {
    supported: true,
    canceled: true,
    path: '',
  })
})

test('native project directory selection falls back from the desktop bridge to the local service picker', async () => {
  const calls = []
  const selected = await pickNativeChatWorkspaceDirectory(' D:\\Projects ', {
    desktopBridge: {
      openDirectory: async () => {
        calls.push(['desktop'])
        throw new Error('desktop bridge unavailable')
      },
    },
    selectLocalDirectory: async (defaultPath, options) => {
      calls.push(['local', defaultPath, options])
      return { supported: true, canceled: false, path: ' D:\\Projects\\native-host ' }
    },
  })

  assert.deepEqual(calls, [
    ['desktop'],
    ['local', 'D:\\Projects', { signal: undefined }],
  ])
  assert.deepEqual(selected, {
    supported: true,
    canceled: false,
    path: 'D:\\Projects\\native-host',
  })
})

test('native project directory selection surfaces local picker failures unless explicitly unsupported', async () => {
  await assert.rejects(
    () => pickNativeChatWorkspaceDirectory('', {
      desktopBridge: null,
      selectLocalDirectory: async () => {
        const error = new Error('native picker failed')
        error.code = 'NATIVE_PICKER_FAILED'
        throw error
      },
    }),
    /native picker failed/,
  )

  assert.deepEqual(await pickNativeChatWorkspaceDirectory('', {
    desktopBridge: null,
    selectLocalDirectory: async () => {
      const error = new Error('not supported')
      error.code = 'NATIVE_DIRECTORY_PICKER_UNSUPPORTED'
      throw error
    },
  }), { supported: false, canceled: false, path: '' })
})

test('native project directory selection prefers openDirectory and accepts legacy string results', async () => {
  let legacyCalls = 0
  const calls = []
  const selected = await pickNativeChatWorkspaceDirectory(' C:\\Workspace ', {
    desktopBridge: {
      openDirectory: async (request) => {
        calls.push(request)
        return ' C:\\Workspace\\native '
      },
      selectDirectory: async () => {
        legacyCalls += 1
        return { canceled: false, path: 'C:\\wrong' }
      },
    },
  })

  assert.deepEqual(calls, [{ defaultPath: 'C:\\Workspace' }])
  assert.equal(legacyCalls, 0)
  assert.deepEqual(selected, {
    supported: true,
    canceled: false,
    path: 'C:\\Workspace\\native',
  })
})

test('attaching a file before the first send reserves a hidden draft id without creating a sidebar session', async () => {
  const dispatched = []
  let attachmentState = []
  const preserveAttachmentsForSessionRef = { current: null }
  const file = { name: 'notes.txt', type: 'text/plain' }
  const target = { files: [file], value: 'selected' }
  const { handleFileChange } = useChatAttachmentActions({
    attachments: [],
    createPendingAttachment: () => ({ id: 'pending-1', uploadStatus: 'uploading' }),
    createSessionId: () => 'attachment-session',
    dispatch: (action) => dispatched.push(action),
    draftWorkspacePath: ' D:\\Projects\\gugo ',
    effectiveAgentId: 'agent-1',
    prepareAttachment: async () => ({ id: 'pending-1', uploadStatus: 'ready', kind: 'file' }),
    preserveAttachmentsForSessionRef,
    setAttachments: (update) => {
      attachmentState = typeof update === 'function' ? update(attachmentState) : update
    },
    setWorkbenchMessage: () => {},
    state: { activeSessionId: null },
    t: (key) => key,
  })

  await handleFileChange({ target })

  assert.equal(target.value, '')
  assert.equal(preserveAttachmentsForSessionRef.current, 'attachment-session')
  assert.deepEqual(dispatched, [{
    type: 'SET_DRAFT_SESSION_ID',
    payload: { sessionId: 'attachment-session' },
  }])
  const nextState = reduceSessionLifecycleState(
    {
      sessions: [],
      activeSessionId: null,
      draftSessionId: null,
      draftWorkspacePath: 'D:\\Projects\\gugo',
      newDraftVersion: 0,
      sessionDrafts: {},
    },
    dispatched[0],
  )
  assert.deepEqual(nextState.sessions, [])
  assert.equal(nextState.activeSessionId, null)
  assert.equal(nextState.draftSessionId, 'attachment-session')
  assert.equal(nextState.draftWorkspacePath, 'D:\\Projects\\gugo')
})

test('workspace path persists on a session, can be cleared, and is inherited by a fork', () => {
  const base = { sessions: [], activeSessionId: null, newDraftVersion: 0, sessionDrafts: {} }
  const created = reduceSessionLifecycleState(base, {
    type: 'NEW_SESSION',
    payload: { id: 'root', title: 'Root', workspacePath: ' D:\\Projects\\gugo ' },
  })
  assert.equal(created.sessions[0].workspacePath, 'D:\\Projects\\gugo')
  const forked = reduceSessionLifecycleState(created, {
    type: 'ADD_SERVER_FORK',
    payload: { session: { id: 'fork', parentSessionId: 'root', revision: 0 }, messages: [] },
  })
  assert.equal(forked.sessions.find((session) => session.id === 'fork').workspacePath, 'D:\\Projects\\gugo')
  const cleared = reduceSessionLifecycleState(forked, {
    type: 'SET_SESSION_WORKSPACE',
    payload: { sessionId: 'root', workspacePath: '' },
  })
  assert.equal(Object.hasOwn(cleared.sessions.find((session) => session.id === 'root'), 'workspacePath'), false)
})

test('normal and project new-chat actions remain drafts until an accepted send creates the session', () => {
  const existing = {
    id: 'existing',
    title: 'Existing conversation',
    messages: [{ id: 'message-1', role: 'user', content: 'hello' }],
  }
  const base = {
    sessions: [existing],
    activeSessionId: existing.id,
    draftSessionId: 'stale-draft-id',
    draftWorkspacePath: 'D:\\Stale',
    newDraftVersion: 2,
    sessionDrafts: {},
  }

  const normalDraft = reduceSessionLifecycleState(base, { type: 'START_NEW_DRAFT' })
  assert.equal(normalDraft.activeSessionId, null)
  assert.equal(normalDraft.draftSessionId, null)
  assert.equal(normalDraft.draftWorkspacePath, '')
  assert.equal(normalDraft.newDraftVersion, 3)
  assert.deepEqual(normalDraft.sessions, [existing])

  const projectDraft = reduceSessionLifecycleState(normalDraft, {
    type: 'START_NEW_DRAFT',
    payload: { workspacePath: ' D:\\Projects\\gugo ' },
  })
  assert.equal(projectDraft.activeSessionId, null)
  assert.equal(projectDraft.draftSessionId, null)
  assert.equal(projectDraft.draftWorkspacePath, 'D:\\Projects\\gugo')
  assert.equal(projectDraft.newDraftVersion, 4)
  assert.deepEqual(projectDraft.sessions, [existing])

  const accepted = reduceSessionLifecycleState(projectDraft, {
    type: 'NEW_SESSION',
    payload: { id: 'accepted', title: 'First message', workspacePath: projectDraft.draftWorkspacePath },
  })
  assert.equal(accepted.activeSessionId, 'accepted')
  assert.equal(accepted.sessions.length, 2)
  assert.equal(accepted.sessions[0].workspacePath, 'D:\\Projects\\gugo')
  assert.equal(accepted.draftSessionId, null)
  assert.equal(accepted.draftWorkspacePath, '')
})
