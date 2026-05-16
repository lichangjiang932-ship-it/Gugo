# Background Task System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a durable server-side task system that lets users create long-running and batch jobs from one sentence, observe parent/child progress, stop or retry work, and recover unfinished jobs after server restarts.

**Architecture:** The Node server becomes the source of truth for jobs, steps, events, and artifacts. SQLite provides a durable queue and recovery ledger; a lightweight in-process worker claims queued work and emits Server-Sent Events to React clients. The existing frontend task panel is replaced with a task-center UI that reads the backend state instead of local transient store entries.

**Tech Stack:** Node HTTP server, better-sqlite3, React 19, Vite, Server-Sent Events, Node test runner.

---

## File map

- Create `server/jobStore.js` — SQL-facing repository for jobs, steps, events, and job artifacts.
- Create `server/jobPlanner.js` — converts one natural-language request into an initial parent/child plan.
- Create `server/jobRuntime.js` — queue loop, state transitions, cancellation, retry, and recovery orchestration.
- Create `server/jobRoutes.js` — REST + SSE request handlers for the task domain.
- Modify `server/db.js` — schema additions and cleanup helpers.
- Modify `server/appServer.js` — route `/api/jobs/*` to task handlers and start/stop runtime.
- Create `src/lib/jobClient.js` — browser API client + SSE subscription helper.
- Replace `src/pages/TaskRunPanel.jsx` — full task-center experience.
- Modify `src/store/taskStatus.js` — backend-aligned status labels.
- Modify `tests/serverWiring.test.js` — assert task routes are wired.
- Create `tests/jobStore.test.js`
- Create `tests/jobPlanner.test.js`
- Create `tests/jobRuntime.test.js`
- Create `tests/jobRoutes.test.js`
- Create `tests/jobClient.test.js`

### Task 1: Add durable task tables and repository helpers

**Files:**
- Modify: `server/db.js`
- Create: `server/jobStore.js`
- Test: `tests/jobStore.test.js`

- [ ] **Step 1: Write the failing repository test**

```js
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-job-store-tests', String(process.pid))

const {
  createJob,
  appendJobSteps,
  listJobs,
  getJobWithChildren,
  appendJobEvent,
  listJobEvents,
  updateJob,
} = await import('../server/jobStore.js')

test('job store persists parent job, child steps, and events', () => {
  const job = createJob({ id: 'job-1', title: '生成 3 份周报', prompt: '生成 3 份周报', status: 'queued' })
  appendJobSteps('job-1', [
    { id: 'step-1', title: '规划任务', kind: 'plan' },
    { id: 'step-2', title: '生成周报', kind: 'batch_item' },
  ])
  appendJobEvent({ jobId: 'job-1', type: 'created', message: '已创建' })
  updateJob('job-1', { status: 'running' })

  const loaded = getJobWithChildren('job-1')
  assert.equal(job.id, 'job-1')
  assert.equal(listJobs()[0].status, 'running')
  assert.equal(loaded.steps.length, 2)
  assert.equal(listJobEvents('job-1')[0].message, '已创建')
})
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test tests/jobStore.test.js`  
Expected: FAIL because `server/jobStore.js` does not exist.

- [ ] **Step 3: Extend the SQLite schema**

```js
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  error TEXT
);

CREATE TABLE IF NOT EXISTS job_steps (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  parent_step_id TEXT,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  input_json TEXT,
  output_json TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  step_id TEXT,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  payload_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS job_artifacts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  step_id TEXT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  filename TEXT,
  created_at INTEGER NOT NULL
);
```

- [ ] **Step 4: Implement the minimal repository**

```js
export function createJob({ id, title, prompt, status = 'queued', now = Date.now() }) {
  getDb().prepare(`
    INSERT INTO jobs (id, title, prompt, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, title, prompt, status, now, now)
  return getJob(id)
}

export function appendJobSteps(jobId, steps, now = Date.now()) {
  const stmt = getDb().prepare(`
    INSERT INTO job_steps
      (id, job_id, parent_step_id, title, kind, status, sort_order, input_json, created_at, updated_at)
    VALUES
      (@id, @jobId, @parentStepId, @title, @kind, @status, @sortOrder, @inputJson, @now, @now)
  `)
  const tx = getDb().transaction((rows) => rows.forEach((row, index) => stmt.run({
    id: row.id,
    jobId,
    parentStepId: row.parentStepId || null,
    title: row.title,
    kind: row.kind,
    status: row.status || 'queued',
    sortOrder: row.sortOrder ?? index,
    inputJson: row.input == null ? null : JSON.stringify(row.input),
    now,
  })))
  tx(steps)
}
```

- [ ] **Step 5: Re-run the repository test**

Run: `node --test tests/jobStore.test.js`  
Expected: PASS.

- [ ] **Step 6: Commit the repository foundation**

```bash
git add server/db.js server/jobStore.js tests/jobStore.test.js
git commit -m "feat add durable job store"
```

### Task 2: Add deterministic planning for parent and child work

**Files:**
- Create: `server/jobPlanner.js`
- Test: `tests/jobPlanner.test.js`

- [ ] **Step 1: Write the failing planner tests**

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildInitialPlan } from '../server/jobPlanner.js'

test('planner creates batch children when prompt mentions multiple outputs', () => {
  const plan = buildInitialPlan('生成 3 份行业周报并导出')
  assert.equal(plan.title, '生成 3 份行业周报并导出')
  assert.equal(plan.steps[0].kind, 'plan')
  assert.equal(plan.steps.filter((step) => step.kind === 'batch_item').length, 3)
  assert.equal(plan.steps.at(-1).kind, 'finalize')
})

test('planner falls back to a simple execution plan', () => {
  const plan = buildInitialPlan('整理今天的会议纪要')
  assert.deepEqual(plan.steps.map((step) => step.kind), ['plan', 'execute', 'finalize'])
})
```

- [ ] **Step 2: Run the planner test and verify it fails**

Run: `node --test tests/jobPlanner.test.js`  
Expected: FAIL because `buildInitialPlan` is missing.

- [ ] **Step 3: Implement the deterministic starter planner**

```js
export function buildInitialPlan(prompt = '') {
  const trimmed = String(prompt || '').trim()
  const count = Number(trimmed.match(/(\d+)\s*(?:份|个|条|篇)/)?.[1] || 0)
  const title = trimmed || '未命名任务'
  const steps = [{ id: 'plan', title: '规划任务', kind: 'plan' }]

  if (count > 1) {
    for (let index = 1; index <= count; index += 1) {
      steps.push({
        id: `item-${index}`,
        title: `生成 ${index} / ${count}`,
        kind: 'batch_item',
        input: { index, total: count },
      })
    }
  } else {
    steps.push({ id: 'execute', title: '执行任务', kind: 'execute' })
  }

  steps.push({ id: 'finalize', title: '汇总结果', kind: 'finalize' })
  return { title, steps }
}
```

- [ ] **Step 4: Run the planner test again**

Run: `node --test tests/jobPlanner.test.js`  
Expected: PASS.

- [ ] **Step 5: Commit the planner**

```bash
git add server/jobPlanner.js tests/jobPlanner.test.js
git commit -m "feat add starter job planner"
```

### Task 3: Build the worker runtime, cancellation, retry, and recovery

**Files:**
- Create: `server/jobRuntime.js`
- Modify: `server/jobStore.js`
- Test: `tests/jobRuntime.test.js`

- [ ] **Step 1: Write failing runtime tests**

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createInMemoryRuntime,
  recoverInterruptedJobs,
} from '../server/jobRuntime.js'

test('runtime completes queued child steps in order', async () => {
  const runtime = createInMemoryRuntime()
  const job = await runtime.createJob('生成 2 份周报')
  await runtime.drain()
  const loaded = runtime.getJob(job.id)
  assert.equal(loaded.status, 'completed')
  assert.deepEqual(loaded.steps.map((step) => step.status), ['completed', 'completed', 'completed', 'completed'])
})

test('runtime honors cancellation before the next step starts', async () => {
  const runtime = createInMemoryRuntime({ holdAfterFirstStep: true })
  const job = await runtime.createJob('生成 2 份周报')
  await runtime.runOneTick()
  runtime.requestCancel(job.id)
  await runtime.drain()
  assert.equal(runtime.getJob(job.id).status, 'cancelled')
})

test('recovery returns interrupted running work to queued', () => {
  const recovered = recoverInterruptedJobs([
    { id: 'job-1', status: 'running' },
    { id: 'job-2', status: 'completed' },
  ])
  assert.deepEqual(recovered, [{ id: 'job-1', status: 'queued' }])
})
```

- [ ] **Step 2: Run the runtime test and verify it fails**

Run: `node --test tests/jobRuntime.test.js`  
Expected: FAIL because the runtime module is missing.

- [ ] **Step 3: Add repository helpers required by the runtime**

```js
export function listRecoverableJobs() {
  return getDb().prepare(`
    SELECT * FROM jobs
    WHERE status IN ('queued', 'planning', 'running', 'waiting', 'cancel_requested')
    ORDER BY created_at ASC
  `).all()
}

export function listQueuedSteps(jobId) {
  return getDb().prepare(`
    SELECT * FROM job_steps
    WHERE job_id = ? AND status = 'queued'
    ORDER BY sort_order ASC
  `).all(jobId)
}
```

- [ ] **Step 4: Implement the minimal runtime contract**

```js
export function recoverInterruptedJobs(jobs) {
  return jobs
    .filter((job) => ['planning', 'running', 'waiting'].includes(job.status))
    .map((job) => ({ ...job, status: 'queued' }))
}

export class JobRuntime {
  constructor({ planner, store, executeStep = defaultExecuteStep, onEvent = () => {} }) {
    this.planner = planner
    this.store = store
    this.executeStep = executeStep
    this.onEvent = onEvent
    this.running = false
  }
}
```

Then add:

- `createJob(prompt)`
- `requestCancel(jobId)`
- `retryJob(jobId)`
- `retryStep(jobId, stepId)`
- `runOneTick()`
- `drain()`
- startup recovery that converts stale non-terminal states to a runnable state and appends a recovery event

- [ ] **Step 5: Run the runtime test**

Run: `node --test tests/jobRuntime.test.js`  
Expected: PASS.

- [ ] **Step 6: Commit the worker runtime**

```bash
git add server/jobStore.js server/jobRuntime.js tests/jobRuntime.test.js
git commit -m "feat add job runtime lifecycle"
```

### Task 4: Expose REST and SSE job APIs

**Files:**
- Create: `server/jobRoutes.js`
- Modify: `server/appServer.js`
- Modify: `tests/serverWiring.test.js`
- Test: `tests/jobRoutes.test.js`

- [ ] **Step 1: Write failing API tests**

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import { createAppServer } from '../server/appServer.js'

test('job routes create and fetch jobs', async () => {
  const server = createAppServer({ getEnv: () => ({}) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const created = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '生成 2 份周报' }),
    }).then((res) => res.json())
    assert.equal(created.job.title, '生成 2 份周报')

    const detail = await fetch(`http://127.0.0.1:${port}/api/jobs/${created.job.id}`).then((res) => res.json())
    assert.equal(detail.job.id, created.job.id)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
```

- [ ] **Step 2: Run the API test and verify it fails**

Run: `node --test tests/jobRoutes.test.js`  
Expected: FAIL because `/api/jobs` is not routed.

- [ ] **Step 3: Implement the route handlers**

```js
export async function handleJobRequest(req, res, runtime) {
  const url = new URL(req.url, 'http://localhost')
  if (req.method === 'POST' && url.pathname === '/api/jobs') {
    const body = await readJson(req)
    const job = await runtime.createJob(body.prompt)
    return sendJson(res, 201, { job })
  }
  if (req.method === 'GET' && url.pathname === '/api/jobs') {
    return sendJson(res, 200, { jobs: runtime.listJobs() })
  }
}
```

Add:

- `GET /api/jobs`
- `GET /api/jobs/:id`
- `POST /api/jobs/:id/cancel`
- `POST /api/jobs/:id/retry`
- `POST /api/jobs/:id/steps/:stepId/retry`
- `GET /api/jobs/stream`

- [ ] **Step 4: Wire the router and update server wiring assertions**

```js
if (req.url?.startsWith('/api/jobs')) {
  return handleJobRequest(req, res, jobRuntime)
}
```

- [ ] **Step 5: Re-run the focused route tests**

Run: `node --test tests/jobRoutes.test.js tests/serverWiring.test.js`  
Expected: PASS.

- [ ] **Step 6: Commit the API layer**

```bash
git add server/jobRoutes.js server/appServer.js tests/jobRoutes.test.js tests/serverWiring.test.js
git commit -m "feat expose durable job api"
```

### Task 5: Add the frontend client and event subscription

**Files:**
- Create: `src/lib/jobClient.js`
- Test: `tests/jobClient.test.js`

- [ ] **Step 1: Write failing client tests**

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createJob,
  cancelJob,
  retryJob,
  listJobs,
  getJob,
} from '../src/lib/jobClient.js'

test('job client uses expected endpoints', async () => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init })
    return { ok: true, json: async () => ({ job: { id: 'job-1' }, jobs: [] }) }
  }
  await createJob('生成周报', { fetchImpl })
  await listJobs({ fetchImpl })
  await getJob('job-1', { fetchImpl })
  await cancelJob('job-1', { fetchImpl })
  await retryJob('job-1', { fetchImpl })
  assert.deepEqual(calls.map((call) => call.url), [
    '/api/jobs',
    '/api/jobs',
    '/api/jobs/job-1',
    '/api/jobs/job-1/cancel',
    '/api/jobs/job-1/retry',
  ])
})
```

- [ ] **Step 2: Run the client test and verify it fails**

Run: `node --test tests/jobClient.test.js`  
Expected: FAIL because `jobClient.js` is missing.

- [ ] **Step 3: Implement the browser client**

```js
async function readJsonResponse(promise) {
  const response = await promise
  if (!response.ok) throw new Error(`request failed: ${response.status}`)
  return response.json()
}

export function createJob(prompt, { fetchImpl = fetch } = {}) {
  return readJsonResponse(fetchImpl('/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  }))
}
```

Then add:

- `listJobs`
- `getJob`
- `cancelJob`
- `retryJob`
- `retryStep`
- `subscribeToJobEvents(onEvent)`

- [ ] **Step 4: Re-run the client test**

Run: `node --test tests/jobClient.test.js`  
Expected: PASS.

- [ ] **Step 5: Commit the frontend client**

```bash
git add src/lib/jobClient.js tests/jobClient.test.js
git commit -m "feat add job api client"
```

### Task 6: Replace the old task page with a real task center

**Files:**
- Modify: `src/pages/TaskRunPanel.jsx`
- Modify: `src/store/taskStatus.js`
- Test: `tests/taskCenterWiring.test.js`

- [ ] **Step 1: Write failing UI wiring tests**

```js
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('task center uses backend job client instead of transient app tasks', () => {
  const source = fs.readFileSync(new URL('../src/pages/TaskRunPanel.jsx', import.meta.url), 'utf8')
  assert.match(source, /createJob/)
  assert.match(source, /listJobs/)
  assert.match(source, /cancelJob/)
  assert.doesNotMatch(source, /state\.tasks/)
})
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test tests/taskCenterWiring.test.js`  
Expected: FAIL because the current page still reads `state.tasks`.

- [ ] **Step 3: Implement the three-pane task center**

```jsx
const [prompt, setPrompt] = useState('')
const [jobs, setJobs] = useState([])
const [selectedJobId, setSelectedJobId] = useState(null)
const [selectedJob, setSelectedJob] = useState(null)

async function handleCreateJob(event) {
  event.preventDefault()
  const trimmed = prompt.trim()
  if (!trimmed) return
  const { job } = await createJob(trimmed)
  setPrompt('')
  setJobs((current) => [job, ...current])
  setSelectedJobId(job.id)
}
```

Render:

- top composer
- left task list with status filters
- expandable parent/child outline
- right-side detail panel with live log, artifacts, stop/retry controls

- [ ] **Step 4: Re-run the UI test**

Run: `node --test tests/taskCenterWiring.test.js`  
Expected: PASS.

- [ ] **Step 5: Commit the task center**

```bash
git add src/pages/TaskRunPanel.jsx src/store/taskStatus.js tests/taskCenterWiring.test.js
git commit -m "feat replace task page with task center"
```

### Task 7: Verify the end-to-end task foundation

**Files:**
- Modify as needed based on fixes from verification

- [ ] **Step 1: Run the targeted task suite**

Run:

```bash
node --test tests/jobStore.test.js tests/jobPlanner.test.js tests/jobRuntime.test.js tests/jobRoutes.test.js tests/jobClient.test.js tests/taskCenterWiring.test.js
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

- [ ] **Step 3: Manually verify the main flow**

Run the app, create `生成 3 份行业周报并导出`, navigate away from `/task`, return, stop a job, and confirm:

- the job survives route changes
- child steps render beneath the parent
- cancel transitions the job out of running state
- completed artifacts remain attached

- [ ] **Step 4: Commit any verification fixes**

```bash
git add .
git commit -m "test verify task center workflow"
```

