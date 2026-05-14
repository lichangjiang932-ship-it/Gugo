# Diagnostics And Chat Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local system/model diagnostics foundation and improve the chat workbench with export, retry, context compression, model switching, and clearer billing details.

**Architecture:** The Node server owns all sensitive diagnostics and model configuration. The React app only reads safe status objects and sends chat messages with the selected model name. Chat UX improvements stay in `ChatSplit.jsx` and existing persisted sessions.

**Tech Stack:** Node HTTP middleware, Vite plugin middleware, React 19, localStorage persistence, Node test runner.

---

### Task 1: Backend Diagnostics

**Files:**
- Modify: `server/modelProxy.js`
- Modify: `server/billingAuth.js`
- Test: `tests/modelProxy.test.js`
- Test: `tests/billingAuth.test.js`

- [ ] Add pure helpers that return safe model, billing, and mail diagnostics without exposing secrets.
- [ ] Add `GET /api/system/diagnostics` through the Vite and production servers.
- [ ] Test configured and missing states, price multiplier parsing, SMTP config status, and API key redaction.

### Task 2: Frontend Diagnostics Page

**Files:**
- Modify: `src/lib/modelClient.js`
- Modify: `src/pages/SettingsView.jsx`

- [ ] Add a frontend client for `/api/system/diagnostics`.
- [ ] Add a new settings tab that renders model, endpoint, model catalog, billing, and mail status.
- [ ] Keep all values safe for browser display.

### Task 3: Chat Workbench Enhancements

**Files:**
- Modify: `src/store/AppContext.jsx`
- Modify: `src/pages/ChatSplit.jsx`
- Modify: `src/lib/modelClient.js`
- Test: `tests/modelClient.test.js`

- [ ] Preserve billing metadata as message metadata instead of mixing it into assistant text.
- [ ] Add retry for failed user messages.
- [ ] Add current session export.
- [ ] Add a deterministic context compression action that summarizes older messages locally.
- [ ] Keep model switching in the top bar and make charge/balance easier to read.

### Task 4: Verification

**Commands:**
- `npm test`
- `npm run lint`
- `npm run build`

- [ ] Confirm all tests pass.
- [ ] Confirm the build succeeds.
- [ ] Restart the local dev server on `127.0.0.1:5175`.
