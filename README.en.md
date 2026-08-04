# Gugo

[简体中文](README.md) | **English**

Gugo is a self-hosted, browser-based AI workspace for agents, tools, memory,
background jobs, subagents, MCP integrations, and generated artifacts. It runs
as a React single-page application backed by a Node.js HTTP server and SQLite.

The default `local` mode is single-user and requires no sign-up or login. Bring
your own model endpoint and API key in Settings after startup.

> Gugo is under active development. Back up your data before upgrading, and
> review the trust model before enabling powerful local tools.

## Highlights

- Server-owned chat turns with streaming, tool calls, approval gates,
  cancellation, checkpoints, and recovery
- OpenAI-compatible, Anthropic, Gemini, and local model endpoints
- Persistent agents, skills, memory, knowledge graph, todos, and session history
- Background jobs and subagent runs with independent contexts and configurable budgets
- Filesystem, patch, shell, Git, browser, search, and artifact tools
- PowerPoint, Word, spreadsheet, React, and HTML artifact previews
- MCP client and authenticated Streamable HTTP MCP server
- Native Notion, GitHub, Slack, and Google Drive connectors, plus browser shortcuts
- SQLite WAL storage, optional multi-user ownership checks, and encrypted connector secrets
- No built-in payment, recharge, credit, or usage-billing system

The browser application catalog contains website shortcuts. Only connectors
explicitly documented as native integrations expose structured API tools.

## Requirements

- Node.js `^20.19.0`, `^22.13.0`, or `>=24.0.0`
- npm
- A model endpoint and API key, or a compatible local model server
- Edge or Chrome and Node.js 22+ for browser automation

## Quick start

```bash
git clone https://github.com/lichangjiang932-ship-it/your-model-atelier.git
cd your-model-atelier
npm ci
cp .env.example .env
```

Start the development server:

```bash
npm run dev
```

Open `http://127.0.0.1:5175`. The default `AUTH_MODE=local` signs in a local
owner automatically, so no account setup is required. Open **Settings → Models**
and add your own OpenAI-compatible, Anthropic, Gemini, Ollama, or LM Studio
provider. Gugo ships with no usable model API key.

You may instead configure a server-wide default model in `.env`:

```dotenv
MODEL_BASE_URL=https://api.example.com/v1
MODEL_NAME=your-model
MODEL_API_KEY=your-api-key
```

For a production-style local run:

```bash
npm run local
```

## Docker

Create `.env`, then run:

```bash
docker compose up --build -d
docker compose logs -f app
```

Application data is stored in the `app-data` volume. Back up both the SQLite
data and the credential-encryption key before upgrades.

Compose publishes the port on host `127.0.0.1` by default. Before exposing it
to a LAN or the public internet, set `AUTH_MODE=multi_user`, configure SMTP, and
explicitly set `DOCKER_BIND_ADDRESS=0.0.0.0`. Public deployments also require
HTTPS, firewall rules, and a trusted reverse proxy.

## Configuration

- [Configuration reference](docs/CONFIGURATION.md)
- [Operation guide](docs/OPERATION_GUIDE.md) (Chinese)
- [Quick start](docs/QUICK_START.md)
- [Scheduling](docs/SCHEDULING.md)
- [Turn recovery](docs/TURN_RECOVERY.md)

Gugo does not meter or charge credits. Any model or connector cost is billed
directly by the provider whose credentials you configure.

## Trust and security

Workspace reads, writes, shell commands, Git mutations, hooks, MCP stdio, and
browser automation have different risk levels. Defaults are conservative.

Shell execution is not a sandbox. Only enable it for trusted users and trusted
workspaces. For public deployments, use HTTPS, a fixed `APP_PUBLIC_URL`, strict
reverse-proxy header handling, rate limits, and operating-system isolation.

`AUTH_MODE=local` has no network access control and must remain bound to a
loopback address. Any LAN or public deployment must use `AUTH_MODE=multi_user`.

See [SECURITY.md](SECURITY.md) for private vulnerability reporting.

## Development

```bash
npm run lint
npm test
npm run test:coverage
npm run build
docker compose config --quiet
```

The CI matrix covers supported Node.js versions and Windows/Linux behavior. It
also performs dependency auditing, secret scanning, coverage checks, Docker
Compose validation, and an image build.

## Project structure

```text
src/                 React application
server/              HTTP routes, services, stores, adapters, and tools
shared/              Shared turn-event contracts
tests/               Node test suite
docs/                Configuration and operations documentation
skill-packs/         Distributable skills
seed/                Built-in skill assets
```

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md) before opening a pull request.

See [CHANGELOG.md](CHANGELOG.md) for release history and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for vendored assets and
production dependency license provenance.

## License

Gugo is released under the [MIT License](LICENSE). Third-party components
remain subject to their respective licenses and copyright notices.
