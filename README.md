# Your Model Atelier

本地/内网可用的 AI 工作台。模型 API Key 由后端 `.env` 统一配置，浏览器只发送登录 token、消息内容和模型名，不会看到后端 API Key。

核心功能：

- 邮箱验证码登录
- 本地积分充值
- 多模型选择与倍率扣费
- OpenAI 兼容模型代理
- 本地账本与会话数据

## Windows 本地运行

请看完整说明：

[WINDOWS_LOCAL_RUN.md](./WINDOWS_LOCAL_RUN.md)

快速启动开发服务：

```powershell
npm run dev -- --host 127.0.0.1 --port 5175
```

打开：

```text
http://127.0.0.1:5175/#/settings
```

## 生产式本地运行

```powershell
npm run local
```

这会先构建 `dist/`，再启动 Node 本地服务，同时提供前端页面和 `/api/*` 后端接口。

## 常用命令

```powershell
npm test
npm run lint
npm run build
npm run serve
```

