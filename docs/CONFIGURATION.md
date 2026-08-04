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
    "AUTH_MODE": "local",
    "WORKSPACE_FS_ENABLED": true,
    "WORKSPACE_GIT_ENABLED": true,
    "JOB_RUNTIME_CONCURRENCY": 4,
    "MEMORY_INJECT_TOKEN_CAP": 800
  }
}
```

配置键必须使用大写环境变量形式，值必须是字符串、数字、布尔值或 `null`。包含 API key、token、secret、password、credential 或 private key 的键会被拒绝；模型密钥继续使用系统环境变量、`.env` 或现有的用户凭据库。

`npm run serve` 会在加载后端模块前合并这些层，因此仍直接读取 `process.env` 的旧模块也能得到一致配置。直接执行 `node server/appServer.js` 只保留旧的 `.env` 动态读取兼容，正式启动应使用 `npm run serve`。

## 认证模式与模型凭据

### 默认本机模式：`AUTH_MODE=local`

`AUTH_MODE` 未设置时默认为 `local`。该模式面向一台电脑上的单个可信使用者：浏览器首次打开应用时，服务端会自动选择或创建一个本地所有者并建立会话，不要求注册、邮箱验证码或密码。

Gugo 不附带任何可用的模型 API Key。本地所有者进入“设置 → 模型”后，可添加自己的 OpenAI 兼容、Anthropic、Gemini、Ollama 或 LM Studio Provider。模型 API Key 和自定义请求头会加密保存在服务端；也可以通过 `.env` 配置服务端默认模型。公开的 `/api/health` 只检查服务和数据库 liveness，不要求模型已配置；模型 readiness 请看需认证的 `/api/health/full` 或“设置 → 系统诊断”。

本机建议配置：

```dotenv
AUTH_MODE=local
SERVER_HOST=127.0.0.1
```

`local` 是便利模式，不提供多用户身份边界。不要把它用于共享服务器、局域网或公网部署。

### 非回环暴露保护

`AUTH_MODE=local` 只允许有效监听地址为回环地址（`127.0.0.0/8`、`localhost` 或 `::1`）。服务启动时会检查实际对外暴露地址：普通部署检查 `SERVER_HOST`，Compose 部署还会考虑宿主机的 `DOCKER_BIND_ADDRESS`。如果本地免登录模式将监听或发布到非回环地址，服务默认拒绝启动，而不只是打印提示。

正确做法是改用多用户认证：

```dotenv
AUTH_MODE=multi_user
SERVER_HOST=0.0.0.0
```

Docker 跨设备访问还需设置 `DOCKER_BIND_ADDRESS=0.0.0.0`，并配置 SMTP；公网部署还需 HTTPS、防火墙和可信反向代理。

仅在外层已有独立且经过验证的访问控制、并完全理解“任何能连接的人都将成为本地所有者”的风险时，才可使用危险覆盖：

```dotenv
AUTH_MODE=local
SERVER_HOST=0.0.0.0
ALLOW_INSECURE_LOCAL_AUTH=1
```

只有精确值 `1` 会放行；服务会输出 `HIGH RISK` 警告。该开关不会增加密码、用户隔离、TLS 或请求鉴权，也不是 `multi_user` 的替代品。不要在普通局域网、端口映射、隧道或公网环境中使用。

### 多用户模式：`AUTH_MODE=multi_user`

局域网共享、公网服务或任何多人使用场景都必须显式设置：

```dotenv
AUTH_MODE=multi_user
```

该模式启用邮箱验证码/密码登录，并按用户隔离模型 Provider、Agent、记忆、任务、连接器和其他服务端资源。局域网或公网部署必须配置真实 SMTP；未配置 SMTP 时验证码会出现在响应中，只允许回环地址上的开发调试。公网还必须使用 HTTPS、防火墙、可信反向代理、限流和固定的 `APP_PUBLIC_URL`。

### 从既有账户选择本地所有者

从旧版或 `multi_user` 切换到 `local` 时，服务会尽量保留既有数据归属：

- 数据库只有一个用户时，自动采用该用户；
- 尚未确定本地所有者且浏览器携带有效旧会话时，采用该会话对应用户；
- 已记录本地所有者后，其他旧 Token 不能再改变归属；
- 数据库有多个用户且无法确定归属时，会创建独立的 `local-default` 用户，原用户数据不会自动合并。

多用户数据库若要指定保留哪位用户的数据，可在第一次以 `local` 启动前设置：

```dotenv
AUTH_MODE=local
LOCAL_USER_ID=existing-user-id
```

`LOCAL_USER_ID` 必须是数据库中已经存在的用户 ID，不是邮箱；不存在时本地认证初始化会报错，浏览器无法进入工作台。服务记录选定所有者后可移除该变量。切换模式前应备份整个 `APP_DATA_DIR` 和浏览器会话导出；不同用户的数据不会自动合并或转移。

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
