#!/usr/bin/env node
/**
 * 动态读取 SERVER_PORT 环境变量进行健康检查，
 * 避免 Dockerfile / docker-compose 中硬编码端口。
 */
const port = process.env.SERVER_PORT || '5173'
const url = `http://localhost:${port}/api/health`

fetch(url)
  .then((r) => r.ok ? process.exit(0) : process.exit(1))
  .catch(() => process.exit(1))
