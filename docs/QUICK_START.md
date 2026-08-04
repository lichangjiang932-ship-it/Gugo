# Quick Start

[Full English README](../README.en.md) | [中文 README](../README.md)

## Local development

```bash
git clone https://github.com/lichangjiang932-ship-it/your-model-atelier.git
cd your-model-atelier
npm ci
cp .env.example .env
npm run dev
```

Set `MODEL_BASE_URL`, `MODEL_NAME`, and `MODEL_API_KEY` in `.env`, then open
`http://127.0.0.1:5175`.

## Production-style local run

```bash
npm run local
```

## Docker

```bash
docker compose up --build -d
docker compose logs -f app
```

See [OPERATION_GUIDE.md](OPERATION_GUIDE.md) for backup, upgrade, reverse-proxy,
and troubleshooting guidance.
