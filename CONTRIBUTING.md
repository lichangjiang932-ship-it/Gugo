# Contributing to Gugo

Thank you for improving Gugo. Small, focused changes with tests are the
easiest to review and maintain.

## Before you start

- Search existing issues and pull requests.
- Use an issue for design discussion when a change affects storage, security,
  public APIs, authentication, or tool execution semantics.
- Never include credentials, `.env`, databases, generated artifacts, user
  uploads, logs, or private conversation data in a report or commit.

## Development setup

Requirements:

- Node.js `^20.19.0`, `^22.13.0`, or `>=24.0.0`
- npm
- Git
- Edge or Chrome only when working on browser automation

```bash
git clone https://github.com/lichangjiang932-ship-it/your-model-atelier.git
cd your-model-atelier
npm ci
cp .env.example .env
npm run hooks:install
npm run dev
```

Use a non-production model credential in your local `.env`. The file is
ignored by Git.

The pre-commit hook runs the production dependency license check and uses
Gitleaks for staged secret scanning when Gitleaks is installed. CI always runs
the complete dependency audit and repository-history secret scan.

## Branches and commits

Create a branch from `main`. Recommended prefixes are `feat/`, `fix/`,
`docs/`, `test/`, and `chore/`. Use concise conventional commit messages, for
example:

```text
fix(turns): preserve replay cursor after handler failure
```

Do not add generated-by or AI co-author trailers.

## Quality checks

Run the checks relevant to your change, and run the complete suite before a
large pull request:

```bash
npm run lint
npm test
npm run test:coverage
npm run build
docker compose config --quiet
```

New behavior needs regression tests. Database changes must be additive,
idempotent migrations and must preserve upgrades from existing installations.
UI text must be added to all five supported locales: Chinese, English,
Japanese, Korean, and Traditional Chinese.

## Pull requests

Describe the problem, the chosen behavior, security or migration impact, and
the exact verification performed. Keep refactors separate from unrelated
feature work. Screenshots are welcome for visible UI changes, but redact all
private data.

By contributing, you agree that your contribution is licensed under the MIT
License in [LICENSE](LICENSE).
