# Skill Pack Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users import a local folder-based skill pack, preserve colliding skills by auto-renaming new IDs, and make imported skills executable from both chat and task workflows.

**Architecture:** A backend skill registry becomes the canonical source for built-in and imported skills. The browser collects folder files, uploads a normalized manifest, and previews validation before install. Chat and task execution resolve skills through one shared effective-config path rather than reading only the hard-coded `SKILLS` array.

**Tech Stack:** Node HTTP server, better-sqlite3, zod, React 19, browser directory upload APIs, Node test runner.

---

## File map

- Create `server/skillStore.js` — persistence for imported skill metadata and assets.
- Create `server/skillRegistry.js` — unified lookup for built-in + imported skills.
- Create `server/skillImport.js` — folder-package validation, collision renaming, and install orchestration.
- Create `server/skillRoutes.js` — REST endpoints for listing and importing skills.
- Modify `server/db.js` — skill tables.
- Modify `server/appServer.js` — route `/api/skills/*`.
- Create `src/lib/skillClient.js` — frontend API client.
- Modify `src/data.js` — accept external skill lists in resolver helpers instead of hard-coding only `SKILLS`.
- Modify `src/pages/SkillsMarket.jsx` — import-folder UI and backend-fed custom skills.
- Modify `src/pages/ChatSplit/index.jsx` — use merged skill source for slash search and prompt lookup.
- Modify `src/pages/ChatSplit/ChatComposer.jsx` — render imported skills in slash menu.
- Test: `tests/skillStore.test.js`
- Test: `tests/skillImport.test.js`
- Test: `tests/skillRoutes.test.js`
- Test: `tests/skillClient.test.js`
- Test: `tests/skillRuntimeResolution.test.js`

### Task 1: Persist imported skills and assets

**Files:**
- Modify: `server/db.js`
- Create: `server/skillStore.js`
- Test: `tests/skillStore.test.js`

- [ ] **Step 1: Write the failing persistence test**

```js
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-skill-store-tests', String(process.pid))

const {
  installSkill,
  getImportedSkill,
  listImportedSkills,
} = await import('../server/skillStore.js')

test('skill store persists imported skill metadata and prompt asset', () => {
  installSkill({
    id: 'writer',
    name: '写作助手',
    description: '生成长文',
    version: '1.0.0',
    icon: '✍️',
    permissions: ['内容生成'],
    files: {
      'README.md': '# Writer',
      'prompts/system.md': '你是写作助手',
    },
  })
  const skill = getImportedSkill('writer')
  assert.equal(skill.name, '写作助手')
  assert.equal(skill.files['prompts/system.md'], '你是写作助手')
  assert.equal(listImportedSkills().length, 1)
})
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test tests/skillStore.test.js`  
Expected: FAIL because the skill tables/store do not exist.

- [ ] **Step 3: Add the skill tables**

```js
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  version TEXT NOT NULL,
  icon TEXT NOT NULL,
  permissions_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_assets (
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  PRIMARY KEY (skill_id, path)
);
```

- [ ] **Step 4: Implement the store**

```js
export function installSkill({ id, name, description, version, icon, permissions, files, now = Date.now() }) {
  const db = getDb()
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO skills (id, name, description, version, icon, permissions_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, description, version, icon, JSON.stringify(permissions), now, now)

    const stmt = db.prepare(`
      INSERT INTO skill_assets (skill_id, path, content)
      VALUES (?, ?, ?)
    `)
    Object.entries(files).forEach(([assetPath, content]) => stmt.run(id, assetPath, content))
  })
  tx()
  return getImportedSkill(id)
}
```

- [ ] **Step 5: Re-run the persistence test**

Run: `node --test tests/skillStore.test.js`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/db.js server/skillStore.js tests/skillStore.test.js
git commit -m "feat persist imported skills"
```

### Task 2: Validate skill packs and preserve colliding IDs

**Files:**
- Create: `server/skillImport.js`
- Modify: `server/skillStore.js`
- Test: `tests/skillImport.test.js`

- [ ] **Step 1: Write failing import tests**

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  validateSkillPack,
  resolveImportedSkillId,
} from '../server/skillImport.js'

test('validator accepts a complete folder skill pack', () => {
  const result = validateSkillPack({
    'skill.json': JSON.stringify({
      id: 'writer',
      name: '写作助手',
      description: '生成长文',
      version: '1.0.0',
      icon: '✍️',
      permissions: ['内容生成'],
    }),
    'README.md': '# Writer',
    'prompts/system.md': '你是写作助手',
  })
  assert.equal(result.ok, true)
  assert.equal(result.skill.id, 'writer')
})

test('validator rejects packs without prompts/system.md', () => {
  const result = validateSkillPack({
    'skill.json': JSON.stringify({
      id: 'writer',
      name: '写作助手',
      description: '生成长文',
      version: '1.0.0',
      icon: '✍️',
      permissions: ['内容生成'],
    }),
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /prompts\/system\.md/)
})

test('collision resolver auto-suffixes imported IDs', () => {
  assert.equal(resolveImportedSkillId('writer', ['writer']), 'writer-2')
  assert.equal(resolveImportedSkillId('writer', ['writer', 'writer-2']), 'writer-3')
})
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `node --test tests/skillImport.test.js`  
Expected: FAIL because `skillImport.js` is missing.

- [ ] **Step 3: Implement validation and collision handling**

```js
import { z } from 'zod'

const manifestSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9_-]+$/),
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.string().min(1),
  icon: z.string().min(1),
  permissions: z.array(z.string()).default([]),
})

export function resolveImportedSkillId(baseId, existingIds = []) {
  if (!existingIds.includes(baseId)) return baseId
  let suffix = 2
  while (existingIds.includes(`${baseId}-${suffix}`)) suffix += 1
  return `${baseId}-${suffix}`
}
```

Then implement `validateSkillPack(files)` and `installValidatedSkillPack(files, existingIds)`.

- [ ] **Step 4: Re-run the import tests**

Run: `node --test tests/skillImport.test.js`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/skillImport.js server/skillStore.js tests/skillImport.test.js
git commit -m "feat validate skill pack imports"
```

### Task 3: Expose list and import APIs

**Files:**
- Create: `server/skillRoutes.js`
- Modify: `server/appServer.js`
- Test: `tests/skillRoutes.test.js`
- Modify: `tests/serverWiring.test.js`

- [ ] **Step 1: Write failing route tests**

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import { createAppServer } from '../server/appServer.js'

test('skill import endpoint installs and lists imported skills', async () => {
  const server = createAppServer({ getEnv: () => ({}) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const files = {
      'skill.json': JSON.stringify({
        id: 'writer',
        name: '写作助手',
        description: '生成长文',
        version: '1.0.0',
        icon: '✍️',
        permissions: ['内容生成'],
      }),
      'README.md': '# Writer',
      'prompts/system.md': '你是写作助手',
    }
    const imported = await fetch(`http://127.0.0.1:${port}/api/skills/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files }),
    }).then((res) => res.json())
    assert.equal(imported.skill.id, 'writer')

    const listed = await fetch(`http://127.0.0.1:${port}/api/skills`).then((res) => res.json())
    assert.equal(listed.skills.some((skill) => skill.id === 'writer'), true)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test tests/skillRoutes.test.js`  
Expected: FAIL because `/api/skills` is not routed.

- [ ] **Step 3: Implement route handlers**

```js
export async function handleSkillRequest(req, res) {
  const url = new URL(req.url, 'http://localhost')
  if (req.method === 'GET' && url.pathname === '/api/skills') {
    return sendJson(res, 200, { skills: listRuntimeSkills() })
  }
  if (req.method === 'POST' && url.pathname === '/api/skills/import') {
    const body = await readJson(req)
    const skill = importSkillPack(body.files)
    return sendJson(res, 201, { skill })
  }
}
```

- [ ] **Step 4: Wire the route into `appServer.js` and update wiring tests**

```js
if (req.url?.startsWith('/api/skills')) {
  return handleSkillRequest(req, res)
}
```

- [ ] **Step 5: Re-run route tests**

Run: `node --test tests/skillRoutes.test.js tests/serverWiring.test.js`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/skillRoutes.js server/appServer.js tests/skillRoutes.test.js tests/serverWiring.test.js
git commit -m "feat expose imported skill api"
```

### Task 4: Add browser client and import-folder UI

**Files:**
- Create: `src/lib/skillClient.js`
- Modify: `src/pages/SkillsMarket.jsx`
- Test: `tests/skillClient.test.js`
- Test: `tests/skillsImportWiring.test.js`

- [ ] **Step 1: Write failing client tests**

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import { importSkillPack, listSkills } from '../src/lib/skillClient.js'

test('skill client uses list and import endpoints', async () => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init })
    return { ok: true, json: async () => ({ skills: [], skill: { id: 'writer' } }) }
  }
  await listSkills({ fetchImpl })
  await importSkillPack({ 'skill.json': '{}' }, { fetchImpl })
  assert.deepEqual(calls.map((call) => call.url), ['/api/skills', '/api/skills/import'])
})
```

- [ ] **Step 2: Write failing UI wiring tests**

```js
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('skills page exposes folder import flow', () => {
  const source = fs.readFileSync(new URL('../src/pages/SkillsMarket.jsx', import.meta.url), 'utf8')
  assert.match(source, /webkitdirectory/)
  assert.match(source, /importSkillPack/)
  assert.match(source, /导入技能包/)
})
```

- [ ] **Step 3: Run the focused tests and verify they fail**

Run: `node --test tests/skillClient.test.js tests/skillsImportWiring.test.js`  
Expected: FAIL because the client/UI are missing.

- [ ] **Step 4: Implement the client**

```js
export function listSkills({ fetchImpl = fetch } = {}) {
  return readJsonResponse(fetchImpl('/api/skills'))
}

export function importSkillPack(files, { fetchImpl = fetch } = {}) {
  return readJsonResponse(fetchImpl('/api/skills/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files }),
  }))
}
```

- [ ] **Step 5: Implement the import-folder UI**

```jsx
<input
  ref={folderInputRef}
  type="file"
  webkitdirectory=""
  directory=""
  multiple
  className="hidden"
  onChange={handleFolderSelected}
/>
```

Add:

- folder button
- file-to-map reader
- validation preview modal
- backend install action
- success refresh

- [ ] **Step 6: Re-run the focused tests**

Run: `node --test tests/skillClient.test.js tests/skillsImportWiring.test.js`  
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/skillClient.js src/pages/SkillsMarket.jsx tests/skillClient.test.js tests/skillsImportWiring.test.js
git commit -m "feat add skill folder import ui"
```

### Task 5: Unify runtime skill resolution for built-in and imported skills

**Files:**
- Create: `server/skillRegistry.js`
- Modify: `src/data.js`
- Modify: `src/pages/ChatSplit/index.jsx`
- Modify: `src/pages/ChatSplit/ChatComposer.jsx`
- Test: `tests/skillRuntimeResolution.test.js`

- [ ] **Step 1: Write failing runtime-resolution tests**

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getSkillSystemPrompt,
  getSkillEffectiveConfig,
} from '../src/data.js'

test('skill helpers resolve imported skills supplied at runtime', () => {
  const importedSkills = [{
    id: 'writer',
    name: '写作助手',
    systemPrompt: '你是写作助手',
  }]
  assert.equal(getSkillSystemPrompt('writer', {}, importedSkills), '你是写作助手')
  assert.equal(getSkillEffectiveConfig('writer', {}, importedSkills).enabled, true)
})
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test tests/skillRuntimeResolution.test.js`  
Expected: FAIL because helper signatures only read built-in `SKILLS`.

- [ ] **Step 3: Generalize the frontend helpers**

```js
function findSkill(skillId, externalSkills = []) {
  return [...externalSkills, ...SKILLS].find((item) => item.id === skillId)
}

export function getSkillSystemPrompt(skillId, skillConfigs, externalSkills = []) {
  const cfg = skillConfigs?.[skillId]
  if (cfg?.systemPrompt != null) return cfg.systemPrompt
  return findSkill(skillId, externalSkills)?.systemPrompt || ''
}
```

- [ ] **Step 4: Feed imported skills into chat slash search and prompt composition**

Use the backend-fetched skill list as the source for:

- slash menu filtering
- selected skill lookup
- system prompt injection

- [ ] **Step 5: Add the backend registry**

```js
export function listRuntimeSkills() {
  return [...SKILLS, ...listImportedSkills().map(toRuntimeSkill)]
}

export function getRuntimeSkill(id) {
  return listRuntimeSkills().find((skill) => skill.id === id) || null
}
```

- [ ] **Step 6: Re-run the focused test**

Run: `node --test tests/skillRuntimeResolution.test.js`  
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/skillRegistry.js src/data.js src/pages/ChatSplit/index.jsx src/pages/ChatSplit/ChatComposer.jsx tests/skillRuntimeResolution.test.js
git commit -m "feat unify runtime skill resolution"
```

### Task 6: Verify imported skills work end to end

**Files:**
- Modify as needed based on verification failures

- [ ] **Step 1: Run the targeted skill suite**

Run:

```bash
node --test tests/skillStore.test.js tests/skillImport.test.js tests/skillRoutes.test.js tests/skillClient.test.js tests/skillsImportWiring.test.js tests/skillRuntimeResolution.test.js
```

Expected: PASS.

- [ ] **Step 2: Run the full project checks**

Run:

```bash
npm test
npm run lint
npm run build
```

Expected: all commands succeed.

- [ ] **Step 3: Manually verify the import flow**

Use a folder containing:

```text
writer/
  skill.json
  README.md
  prompts/
    system.md
```

Confirm:

- preview shows metadata before install
- colliding import renames to `writer-2`
- imported skill appears in the skills page
- slash search finds the imported skill
- imported skill contributes its system prompt in chat

- [ ] **Step 4: Commit verification fixes**

```bash
git add .
git commit -m "test verify imported skill workflow"
```

