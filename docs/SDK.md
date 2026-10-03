# Gugo HTTP SDK v1

Gugo exposes dependency-free JavaScript and Python clients over the same versioned HTTP Turn contract. The JavaScript entry is `gugo/sdk`; the install-free Python module is shipped at `sdk/python/gugo_sdk.py` in the repository/npm package. Neither client imports the application server, SQLite stores, internal services, React, or plugin hosts. The Python module is not currently published to PyPI.

```js
import { createGugoClient } from 'gugo/sdk'

const gugo = createGugoClient({
  baseUrl: 'http://127.0.0.1:5173',
  token: process.env.GUGO_TOKEN,
  requestTimeoutMs: 30_000,
})

const turn = await gugo.startTurn({
  sessionId: 'sdk-example',
  content: 'Inspect the project and explain the failing test.',
  modelName: 'configured-model',
  modelMode: 'agent',
  intentMode: 'answer',
})

const terminal = await gugo.waitForTerminal({
  sessionId: 'sdk-example',
  turnId: turn.turnId || turn.id,
  onEvent(event) {
    if (event.type === 'tool.completed') console.log(event.payload?.name)
  },
})
console.log(terminal.type, terminal.payload)
```

Python can run directly from a checkout or unpacked npm package:

```bash
PYTHONPATH=/path/to/Gugo/sdk/python python your_script.py
```

```python
from gugo_sdk import GugoClient

client = GugoClient(
    base_url="http://127.0.0.1:5173",
    token="explicit-token",
)
turn = client.start_turn({
    "sessionId": "python-sdk-example",
    "content": "Inspect the project and explain the failing test.",
    "modelMode": "agent",
    "intentMode": "answer",
})
terminal = client.wait_for_terminal(
    session_id="python-sdk-example",
    turn_id=turn.get("turnId") or turn["id"],
)
print(terminal["type"], terminal.get("payload"))
```

## Public surface

`createGugoClient()` returns a frozen client with:

- `startTurn(input, options)`
- `getTurn({ sessionId, turnId })`
- `listTurnEvents({ sessionId, turnId, after, limit })`
- `streamTurnEvents({ sessionId, turnId, after, onEvent, onActivity })`
- `waitForTerminal({ sessionId, turnId, after, pollIntervalMs, timeoutMs, onEvent })`
- `steerTurn({ sessionId, turnId, content, clientRequestId })`
- `cancelTurn({ sessionId, turnId })`
- `resumeTurn({ sessionId, turnId, resolution, retryFailed, retryRecovery })`

The Python `GugoClient` exposes the equivalent synchronous methods: `start_turn`, `get_turn`, `list_turn_events`, `stream_turn_events`, `wait_for_terminal`, `steer_turn`, `cancel_turn`, and `resume_turn`.

The exported `GUGO_SDK_CONTRACT_VERSION` is currently `1` in both languages. Requests send `X-Gugo-SDK-Contract: 1`. The server remains authoritative for authentication, ownership, model selection, tool schemas, approval, directory authorization, checkpointing, and side effects.

## Reliability and security

- `baseUrl` must be absolute HTTP or HTTPS and cannot contain URL username/password credentials. The SDK never reads browser storage or environment credentials.
- Supply a token explicitly. Tenant ownership is enforced by the server, not by client-side identifiers.
- The default Python opener follows same-origin redirects only. Cross-origin or protocol-changing redirects fail with `GUGO_SDK_REDIRECT_DENIED` before the target can receive `Authorization`; callers that inject a custom opener own its redirect policy.
- JavaScript requests default to a 30-second bounded `requestTimeoutMs` (100 ms to 10 minutes); Python uses bounded `request_timeout` seconds. Socket/request deadlines fail with `GUGO_SDK_REQUEST_TIMEOUT`. JSON and SSE frame buffers are capped at 8 MiB. Custom `fetchImpl` implementations receive an abort signal and remain responsible for stopping their underlying I/O after cancellation.
- `waitForTerminal` / `wait_for_terminal` enforce their overall timeout independently of a longer request timeout or polling interval and fail with `GUGO_SDK_TIMEOUT`.
- Inputs are projected to the documented Turn fields; unknown object fields are not transmitted.
- HTTP errors retain stable server error codes through `GugoSdkError`.
- Polling and SSE streaming enforce contiguous event sequences, while accepting only an explicit server `compactedThrough` watermark for a compacted advance. Invalid gaps fail with `GUGO_SDK_EVENT_SEQUENCE_INVALID` rather than silently skipping history.
- SSE requests negotiate the v1 `turn.event` envelope and fail with `GUGO_SDK_STREAM_TRUNCATED` if the connection closes before a terminal event.
- JavaScript `waitForTerminal` supports `AbortSignal`; Python `wait_for_terminal` accepts a `threading.Event`. Python cancellation is checked between polling requests and SSE lines and cannot preempt a blocking standard-library socket read before its bounded request timeout.
- Both clients bound polling intervals, response/SSE buffers, request timeouts, and the overall wait timeout (maximum six hours).
- A terminal event is an execution fact, not proof that an external benchmark passed. Use an independent verifier for evaluations.

This SDK is a transport client, not an in-process plugin API. Replacement loops and persistence backends continue to use the versioned kernel ports documented in [KERNEL_BOUNDARY.md](./KERNEL_BOUNDARY.md).
