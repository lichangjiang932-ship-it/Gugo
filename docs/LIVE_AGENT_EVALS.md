# Live Agent Evaluations

`npm run eval:offline` verifies deterministic runtime contracts. It does not measure whether a real model can solve an open-ended task. Use the opt-in live runner for that separate purpose.

## Safety boundary

The runner refuses to start unless `GUGO_LIVE_EVAL=1` is set. Every task workspace is copied to a temporary directory before Gugo runs, so the source fixture is not modified. Verification commands are executed without a shell and must be declared as an executable plus an argument array.

The runner uses the normal Headless Turn runtime, permission mode, checkpoints, tool validation and terminal events. It does not bypass provider billing. Configure a dedicated model/provider and review its cost policy before enabling a run.

## Dataset

```json
{
  "tasks": [
    {
      "id": "fix-parser",
      "prompt": "Fix the parser defect and run the relevant tests.",
      "workspace": "./fixtures/fix-parser",
      "mode": "bypass",
      "timeoutMs": 1200000,
      "verify": [
        {
          "script": "./verifiers/fix-parser.mjs"
        }
      ]
    }
  ]
}
```

Rules:

- `id` must be unique and contain only letters, digits, `.`, `_`, or `-`.
- `workspace` is resolved relative to the dataset file and must be a directory.
- The source workspace is copied before execution.
- `mode` is one of `normal`, `acceptEdits`, `plan`, or `bypass`.
- Non-interactive mutation benchmarks normally use `bypass` only inside disposable fixtures.
- A task passes only when Gugo exits successfully with `turn.completed` and every verifier exits with code `0`.
- Verifier `cwd`, when present, is relative to the copied workspace.
- Prefer `script` for benchmark acceptance. It is resolved inside the dataset directory, must be a regular non-symlink file, stays outside the copied mutable workspace, and runs with the current Node executable while its cwd is the copied workspace.
- `command` + `args` remains available for project checks, but a check stored inside the mutable workspace can be modified by the Agent and is not sufficient as the sole benchmark oracle.

## Run

PowerShell:

```powershell
$env:GUGO_LIVE_EVAL = '1'
$env:MODEL_BASE_URL = 'http://127.0.0.1:11434/v1'
$env:MODEL_NAME = 'your-model'
npm run eval:live -- --dataset .\evals\starter-suite.json --output .\output\live-eval.json
```

Use `--keep` to retain copied workspaces for diagnosis. Without it, temporary workspaces are deleted after the report is assembled.

The report records per-task duration, terminal type, CLI exit, verifier exits, model/provider identity, completed and failed model requests, failovers, tool-call count and names, approval requests, Turn attempts, terminal usage, and false completion (`turn.completed` followed by verifier failure). Aggregate metrics include model requests, tool calls, approval requests, and false completions. Compare Gugo and another harness only with the same model, task fixtures, timeouts, prompts, and verifier commands.
