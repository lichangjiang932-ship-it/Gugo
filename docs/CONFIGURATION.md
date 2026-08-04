# 分层运行配置

Gugo 支持以下配置层，后面的层覆盖前面的层：

1. `server-data/runtime.json`：当前安装的用户级默认值；
2. `.gugo/runtime.json`：可随项目共享的非敏感配置；
3. `APP_CONFIG_PATH`：显式指定的本地 JSON 配置；
4. `.env`：兼容现有安装；
5. 系统环境变量：部署平台的最终覆盖。

JSON 可以直接写环境变量键，也可以放在 `env` 对象中：

```json
{
  "env": {
    "WORKSPACE_FS_ENABLED": true,
    "WORKSPACE_GIT_ENABLED": true,
    "JOB_RUNTIME_CONCURRENCY": 4,
    "MEMORY_INJECT_TOKEN_CAP": 800
  }
}
```

配置键必须使用大写环境变量形式，值必须是字符串、数字、布尔值或 `null`。包含 API key、token、secret、password、credential 或 private key 的键会被拒绝；模型密钥继续使用系统环境变量、`.env` 或现有的用户凭据库。

`npm run serve` 会在加载后端模块前合并这些层，因此仍直接读取 `process.env` 的旧模块也能得到一致配置。直接执行 `node server/appServer.js` 只保留旧的 `.env` 动态读取兼容，正式启动应使用 `npm run serve`。

## 工作区信任

`WORKSPACE_FS_ENABLED`、`WORKSPACE_SHELL_ENABLED`、`WORKSPACE_GIT_ENABLED` 和
`WORKSPACE_GIT_MUTATION_ENABLED` 是服务端能力上限。目录被用户授权后，未信任状态只允许读取；
文件写入、Shell 与 Git 默认拒绝。用户显式信任目录后，`.gugo/config.json` 才会被读取，且其中的
`fileSystem`、`fileSystemWrite`、`shell`、`git`、`gitMutation` 只能进一步收紧全局开关。

`WORKSPACE_SHARED_TRUSTED=1` 会把工作区视为对所有用户已信任，只适用于单机、可信用户环境。
它不是执行沙箱，也不应在不可信用户可访问的部署中开启。

## OAuth 公网地址与反向代理

生产环境应显式设置 `APP_PUBLIC_URL=https://atelier.example.com`，MCP OAuth 回调地址只使用该 origin。
未配置时，服务使用 `SERVER_HOST`/`SERVER_PORT` 构造本机地址，并忽略请求中的 `Host`、
`X-Forwarded-Host` 和 `X-Forwarded-Proto`。只有受信反向代理已经清除客户端伪造的转发头时，
才可设置 `TRUST_PROXY=1`。

MCP OAuth 的 32 字节随机 state 只以 SHA-256 摘要保存；PKCE verifier 和授权上下文加密写入
SQLite，10 分钟后过期，并在 callback 时原子单次消费。因此服务重启不会丢失正在进行的授权，
同一 state 也不能重复使用。

## 自定义 bridge webhook 签名

`webhook`、`wechat` 和 `wechat_personal` provider 的请求必须携带：

```text
X-Gugo-Timestamp: <Unix 秒或毫秒>
X-Gugo-Signature: sha256=<hex(HMAC-SHA256(signingSecret, timestamp + "." + rawBody))>
```

服务拒绝与当前时间相差超过 5 分钟的请求，并用 SQLite 记录签名摘要，在有效窗口内拒绝完全相同的
重放。为兼容既有客户端，也接受 `X-Webhook-Timestamp` / `X-Signature-Timestamp`、
`X-Signature-256` / `X-Hub-Signature-256`，以及无点号的 `timestamp + rawBody` 签名格式；
不再接受只签 raw body、没有时间戳的旧格式。
