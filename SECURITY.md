# Security Policy

## Supported versions

Security fixes are provided for the latest release and the current `main`
branch. Older releases may receive a backport when the maintainers determine
that it is practical and necessary.

## Reporting a vulnerability

Please do not disclose a suspected vulnerability in a public issue, pull
request, discussion, or chat log.

Use GitHub's private vulnerability reporting page:

https://github.com/lichangjiang932-ship-it/your-model-atelier/security/advisories/new

Include the affected version or commit, deployment assumptions, reproduction
steps, impact, and any suggested mitigation. Remove API keys, tokens, personal
data, database files, and other secrets from the report.

The maintainers will acknowledge a complete report as soon as practical,
normally within seven days. We will coordinate validation, remediation, and
disclosure with the reporter. Please allow a reasonable remediation window
before publishing details.

## Security boundaries

Gugo is designed for self-hosted, trusted environments. Its shell and browser
tools are powerful automation features, not an operating-system sandbox.
Review the trust model in [docs/OPERATION_GUIDE.md](docs/OPERATION_GUIDE.md)
before enabling filesystem writes, Git mutation, shell execution, hooks, MCP
stdio, browser automation, public webhooks, or public-network access.
