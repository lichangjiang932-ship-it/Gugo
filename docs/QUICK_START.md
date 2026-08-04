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

Open `http://127.0.0.1:5175`, then add your own provider under
**Settings → Models**. Gugo does not include a usable model API key. The default
`AUTH_MODE=local` automatically uses a local owner, so local use requires no
sign-up or login.

For a server-wide default model, uncomment and fill `MODEL_BASE_URL`,
`MODEL_NAME`, and `MODEL_API_KEY` in `.env` before startup.

## Production-style local run

```bash
npm run local
```

## Docker

```bash
docker compose up --build -d
docker compose logs -f app
```

Compose binds the host port to `127.0.0.1` by default. A LAN or public deployment
must use `AUTH_MODE=multi_user` with SMTP configured before setting
`DOCKER_BIND_ADDRESS=0.0.0.0`. Public deployments also require HTTPS, firewall
rules, and a trusted reverse proxy.

See [OPERATION_GUIDE.md](OPERATION_GUIDE.md) for backup, upgrade, reverse-proxy,
and troubleshooting guidance.
