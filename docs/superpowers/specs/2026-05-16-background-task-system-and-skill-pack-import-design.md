# Background Task System and Skill Pack Import Design

## 1. Product intent

`your-model-atelier` should evolve from a chat-first assistant into a workspace that can also carry work after the user leaves the chat surface. The current task page only mirrors short-lived frontend state; the new system should instead support:

- long-running work
- batch generation
- background exports
- resumable workflows
- direct task creation from a single natural-language request
- local skill-pack import as a reusable asset pipeline

The task center should feel closer to a real workbench than a status panel: the user can start a job in one sentence, watch the system decompose it, leave the page, come back later, stop it, retry it, inspect outputs, and continue from the surviving state.

## 2. Product shape

### 2.1 Task center

The task center becomes a first-class destination in the app with three regions:

1. **Creation bar**
   - a single natural-language input at the top
   - placeholder examples for long tasks, batch work, exports, and workflows
   - submit immediately creates a server-side parent job

2. **Task list**
   - filters: active, queued, completed, failed, cancelled
   - each row shows title, status, progress, timestamps, and latest activity
   - batch and long-running jobs expand to show child steps

3. **Detail panel**
   - parent-job summary
   - child-step tree
   - live event log
   - produced artifacts
   - controls: stop, retry failed step, retry whole job, resume where valid, open result

The page should borrow the calm clarity of modern AI workspaces without copying another product's visual language. Its job is to make long work legible.

### 2.2 Imported skills

The skills page gains an **Import skill folder** flow. A skill pack is a local folder with this v1 contract:

```text
my-skill/
  skill.json
  README.md
  prompts/
    system.md
```

Required fields in `skill.json`:

- `id`
- `name`
- `description`
- `version`
- `icon`
- `permissions`

Required asset:

- `prompts/system.md`

Optional assets reserved for later:

- `examples/`
- `templates/`
- `schemas/`

Import flow:

1. choose folder
2. validate structure and schema
3. preview metadata and prompt summary
4. install

If the imported ID collides with an existing skill, the new skill is preserved under an automatically suffixed ID such as `writer-2`, `writer-3`, etc. Existing skills are never silently overwritten.

Imported skills must be genuinely executable:

- visible in the skills library
- available in slash-command search
- available to task creation and worker execution
- able to provide their own system prompt and config

## 3. System architecture

### 3.1 New backend task domain

Add a persistent task domain to the existing Node + SQLite backend:

- `jobs`
- `job_steps`
- `job_events`
- `job_artifacts`
- `skills`
- `skill_assets`

Optional follow-on table once automation scheduling is built:

- `automations`

Core responsibilities:

- **job planner**: converts a natural-language request into a parent job plus child steps
- **queue manager**: decides what can run now and what should wait
- **worker runtime**: executes steps, records events, writes artifacts, and checks cancellation
- **recovery service**: resumes interrupted jobs after process restart
- **skill registry**: resolves built-in and imported skill definitions uniformly
- **event stream**: publishes job changes to connected clients in real time

### 3.2 Execution model

Every user-created job has:

- one parent job
- zero or more child steps
- explicit status transitions
- an append-only event trail
- zero or more output artifacts

Recommended job states:

- `queued`
- `planning`
- `running`
- `waiting`
- `completed`
- `failed`
- `cancel_requested`
- `cancelled`

Recommended step states:

- `queued`
- `running`
- `completed`
- `failed`
- `skipped`
- `cancelled`

The planner may initially create a coarse step plan, then refine steps during execution when the user request demands decomposition. Parent progress is derived from child steps plus terminal state, not manually maintained by the UI.

### 3.3 Queueing and recovery

The worker loop runs on the server, not in the browser.

- queued jobs survive page navigation and browser closure
- running jobs survive route changes
- after server restart, non-terminal jobs are scanned and recovered
- interrupted `running` steps are either retried or returned to `queued` according to step type
- cancellation is cooperative: workers check `cancel_requested` between steps and inside long operations where feasible

For v1, use a single-process durable queue backed by SQLite tables rather than adding a separate broker. This fits the current app scale while preserving a clean migration path to a dedicated queue later.

### 3.4 Realtime transport

Use Server-Sent Events for live updates from backend to frontend:

- simpler than WebSockets for one-way status/event streaming
- enough for task progress, logs, and artifact availability
- compatible with reconnect and replay using last known event ID

REST remains responsible for:

- creating jobs
- listing jobs
- fetching job detail
- cancelling/retrying/resuming jobs
- importing skills

## 4. Data flow

### 4.1 Creating a task

1. user submits one-sentence request in task center
2. frontend `POST /api/jobs`
3. backend stores parent job as `queued`
4. planner service generates initial child steps
5. worker claims the next runnable step
6. events stream to the UI
7. artifacts are stored and linked to the job

### 4.2 Importing a skill pack

1. user selects a local folder
2. frontend reads the folder contents through browser file APIs
3. frontend packages the validated files for upload
4. backend validates schema and required files again
5. backend resolves collisions by suffixing the ID
6. backend persists skill metadata plus assets
7. registry refreshes
8. imported skill appears in both skills UI and task/chat execution surfaces

### 4.3 Running a job with an imported skill

1. planner or user request references the imported skill
2. skill registry resolves the effective prompt/config from backend storage
3. worker composes model input with the skill prompt
4. results, events, and artifacts are written back to the job domain

## 5. UX behavior

### 5.1 New task composer

The composer should encourage broad, natural requests:

- "把这 30 个主题各生成一份周报并导出 PDF"
- "把昨天会议纪要整理成汇报、行动项和邮件草稿"
- "按这个技能批量生成 20 份招商文案"

The system should answer with structure, not with a chat reply:

- job title
- detected intent
- generated child steps
- current first action

### 5.2 Parent/child display

Batch work is never shown as a single opaque spinner. A parent row expands into children:

```text
批量生成行业周报
  ├─ 读取输入列表
  ├─ 生成 1 / 30
  ├─ 生成 2 / 30
  ├─ ...
  └─ 汇总并导出
```

Each child exposes:

- status
- short description
- elapsed time
- latest message
- output or failure reason

### 5.3 Stop / retry / resume

- **Stop** requests cancellation for the entire parent job.
- **Retry step** is available on failed children.
- **Retry job** recreates a runnable plan from the last safe checkpoint.
- **Resume** is only shown when the backend has a valid continuation state.

### 5.4 Artifacts

Artifacts deserve a first-class surface:

- type
- title
- created time
- originating step
- preview/download actions

The task center should make artifacts discoverable without forcing users back into chat history.

## 6. API surface

Suggested v1 endpoints:

- `POST /api/jobs`
- `GET /api/jobs`
- `GET /api/jobs/:id`
- `POST /api/jobs/:id/cancel`
- `POST /api/jobs/:id/retry`
- `POST /api/jobs/:id/steps/:stepId/retry`
- `GET /api/jobs/:id/events`
- `GET /api/jobs/:id/artifacts`
- `GET /api/jobs/stream`
- `POST /api/skills/import`
- `GET /api/skills`

Potential later endpoints:

- `POST /api/automations`
- `PATCH /api/automations/:id`
- `POST /api/jobs/:id/clone`

## 7. Error handling

### 7.1 Task execution failures

- failed child steps preserve their input, output, and error
- parent jobs can end in `failed` or `completed_with_errors`
- partial success is explicit rather than hidden
- retries must be idempotent where possible
- generated artifacts are never discarded merely because a later step fails

### 7.2 Recovery failures

- jobs interrupted by restart emit recovery events
- unrecoverable steps become `failed` with a clear reason
- the UI distinguishes "failed while running" from "failed while recovering"

### 7.3 Skill import failures

- missing `skill.json`
- malformed JSON
- missing `prompts/system.md`
- unsupported schema version
- invalid permissions list
- unreadable folder contents

The preview step should catch most issues before install, but the backend remains authoritative.

## 8. Security and safety

- imported skills are data, not executable JavaScript
- prompts are treated as content, not trusted code
- filesystem import only reads files explicitly provided by the user
- backend validation is repeated even if the browser already validated the package
- artifact download remains routed through existing safe artifact handling
- future automation scheduling must reuse the same permission model as interactive execution

## 9. Testing strategy

### 9.1 Backend

- database schema migration tests
- job state transition tests
- planner-to-step creation tests
- durable queue recovery tests
- cancellation tests
- retry/resume tests
- skill-pack validation tests
- collision-renaming tests
- API contract tests
- SSE stream tests

### 9.2 Frontend

- task creation flow
- parent/child rendering
- event-stream updates
- stop/retry/resume affordances
- artifact visibility
- import preview flow
- imported skill visibility in skills page and slash search

### 9.3 End-to-end

- create long-running job, leave page, reopen and verify progress
- restart server during a queued/running job and verify recovery
- batch task with one child failure and successful partial completion
- import skill folder, create task with imported skill, generate artifact

## 10. Delivery decomposition

### Phase 1 — Durable task foundation

- schema
- backend job APIs
- worker runtime
- recovery loop
- SSE stream
- task center UI replacement

### Phase 2 — Execution depth

- parent/child decomposition
- retries
- cancellation
- artifact attachment and visibility
- richer logs and partial-success semantics

### Phase 3 — Skill packs

- folder import flow
- validation and persistence
- registry unification for built-in and imported skills
- availability in chat and task execution

### Phase 4 — Automation readiness

- recurring schedules
- cloned jobs
- saved workflow presets

The implementation plan should preserve this sequencing even if some UI work lands slightly ahead of deeper backend pieces.

## 11. Non-goals for the first delivery

- collaborative multi-user task assignment
- public skill marketplace
- arbitrary executable plugin code inside skill folders
- distributed workers across multiple machines
- real-time co-editing of task definitions

## 12. Acceptance criteria

The work is complete when:

1. a user can create a long-running job from one sentence in the task center
2. the server persists and executes the job independently of the current page
3. a batch job visibly expands into child steps
4. the user can cancel a running job
5. jobs survive server restart with a documented recovery behavior
6. artifacts remain attached to their originating job and are easy to retrieve
7. a local skill folder can be imported without overwriting an existing colliding skill
8. an imported skill can actually be used by chat and by task execution
9. tests cover persistence, recovery, cancellation, import validation, and core UI flows

