# Windows 本地运行说明

这份说明用于在 Windows 本机运行 Your Model Atelier。项目支持：

- 后端统一配置 OpenAI 兼容模型 API
- 邮箱验证码登录
- 本地点击金额充值积分，不接真实支付
- 不同模型按倍率消耗积分
- 聊天请求通过本地后端代理，浏览器不会看到模型 API Key

## 1. 进入项目目录

```powershell
cd "D:\destok\your-model-atelier(1)\your-model-atelier"
```

## 2. 检查 Node.js 和 npm

```powershell
node -v
npm -v
```

如果命令不存在，请先安装 Node.js 20 或更高版本。

当前目录已保留 `node_modules`，通常可以直接运行。如果换电脑或依赖丢失，再执行：

```powershell
npm install
```

## 3. 创建本机配置文件

复制模板：

```powershell
Copy-Item .env.example .env
```

然后编辑 `.env`。不要把 `.env` 发给别人，也不要提交到仓库。

## 4. 配置模型 API

`.env` 示例：

```env
MODEL_BASE_URL=https://api.openai.com/v1
MODEL_NAME=gpt-4o-mini
MODEL_NAMES=gpt-4o-mini,gpt-4o,deepseek-chat
MODEL_API_KEY=sk-your-key-here
MODEL_TEMPERATURE=0.7
MODEL_MAX_TOKENS=4096
MODEL_PRICE_MULTIPLIERS=gpt-4o-mini:1,gpt-4o:3,deepseek-chat:0.6
CREDIT_BASE_PER_1K_TOKENS=10
```

说明：

- `MODEL_NAME` 是默认模型。
- `MODEL_NAMES` 是前端可选择的模型白名单。
- `MODEL_PRICE_MULTIPLIERS` 是每个模型的积分倍率。
- `CREDIT_BASE_PER_1K_TOKENS` 是基础计费单价。
- `MODEL_API_KEY` 只在后端使用，浏览器请求里不会出现。

## 5. 邮箱验证码配置，可选

如果你只想本地测试，只需要配置上面的模型 API。`MAIL_*` 可以全部不填，发送验证码时页面会直接显示本地验证码。

如果你要真实发送邮件，再配置 QQ SMTP：

`.env` 示例：

```env
MAIL_SERVER=smtp.qq.com
MAIL_PORT=587
MAIL_USE_TLS=true
MAIL_USE_SSL=false
MAIL_USERNAME=your-email@qq.com
MAIL_PASSWORD=your-smtp-authorization-code
MAIL_DEFAULT_SENDER=your-email@qq.com
AUTH_DEV_CODES=false
```

注意：

- `MAIL_PASSWORD` 应填写 QQ 邮箱 SMTP 授权码，不是 QQ 登录密码。
- 如果只是本机调试，可以不配置 `MAIL_*`，或者设置 `AUTH_DEV_CODES=true`，页面会显示验证码。
- 不要把真实邮箱授权码写入文档、截图或聊天记录。

## 6. 启动开发服务

```powershell
npm run dev -- --host 127.0.0.1 --port 5175
```

打开：

```text
http://127.0.0.1:5175/#/settings
```

常用页面：

- 设置页：`http://127.0.0.1:5175/#/settings`
- 聊天页：`http://127.0.0.1:5175/#/chat`

## 7. 本地测试流程

1. 打开设置页。
2. 进入“账户”。
3. 输入邮箱，点击发送验证码。
4. 输入验证码并登录。
5. 点击充值金额，积分会立即到账。
6. 进入“模型 & 接入”，确认后端模型已配置，并能看到模型倍率。
7. 进入聊天页，选择模型并发送消息。
8. 成功回复后，会显示本次消耗积分和剩余余额。

如果余额不足，聊天会提示先充值。

## 8. 生产式本地运行

构建并启动本地 Node 服务：

```powershell
npm run local
```

默认读取：

```env
SERVER_HOST=127.0.0.1
SERVER_PORT=5173
```

如需给局域网其他设备访问，可把 `.env` 改成：

```env
SERVER_HOST=0.0.0.0
SERVER_PORT=5173
```

然后其他设备访问你的电脑局域网 IP，例如：

```text
http://你的电脑IP:5173/#/chat
```

## 9. 本地数据位置

运行后会自动生成：

```text
server-data/
```

里面保存本地用户、登录 session、积分余额和账单流水。

清空测试账号和积分：

```powershell
Remove-Item -Recurse -Force .\server-data
```

下次启动服务会自动重建。

## 10. 验证命令

```powershell
npm test
npm run lint
npm run build
```

接口快速检查：

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:5175/api/billing/packages
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:5175/api/model/status
```

## 11. 常见问题

### 网页打不开

确认服务正在运行：

```powershell
npm run dev -- --host 127.0.0.1 --port 5175
```

### 模型调用失败

检查 `.env`：

- `MODEL_BASE_URL`
- `MODEL_NAME`
- `MODEL_NAMES`
- `MODEL_API_KEY`

并确认模型接口是 OpenAI 兼容的 `/chat/completions` 协议。

### 收不到验证码

如果没有配置 `MAIL_*`，这是正常的：验证码会直接显示在页面上。

如果你配置了 QQ SMTP 但收不到邮件，检查 `.env`：

- `MAIL_SERVER=smtp.qq.com`
- `MAIL_PORT=587`
- `MAIL_USE_TLS=true`
- `MAIL_USERNAME`
- `MAIL_PASSWORD`
- `MAIL_DEFAULT_SENDER`

QQ 邮箱需要开启 SMTP，并使用授权码。

### 想快速测试验证码

设置：

```env
AUTH_DEV_CODES=true
```

重新启动服务后，发送验证码接口会返回 `devCode`。
