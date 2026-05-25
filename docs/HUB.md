# Hub 独立进程

阶段 2.1 引入。Hub 是一个**长期运行**的辅助进程，专门做主 HTTP 进程不适合做的事——定时任务、后台同步、跨会话消息分发钩子等。

## 为什么独立进程

1. **写权隔离**：SQLite 主库走 WAL，多进程读没问题，但多进程并发写会触发 `SQLITE_BUSY`。Hub 只允许写 `hub_*` 表，主进程不动这些表，两边写权天然分离。
2. **崩溃隔离**：Hub 里跑的是低优先级后台任务，挂了不影响 HTTP 服务。
3. **节奏不同**：HTTP 是请求驱动；Hub 是 tick 驱动（默认 30s）。混在一个事件循环里会让 metrics、shutdown、heap 都更难管。
4. **可选启动**：本地开发、CI、测试默认不需要 Hub。`HUB_ENABLED=1` 才拉起。

## 文件布局

```
server/hub/
  index.js          # 进程入口 + tick loop + graceful shutdown
  hubDb.js          # hub_schema_version 独立迁移 + hub_jobs CRUD
  jobRegistry.js    # name → handler
  jobs/
    echo.js         # demo handler
```

## 表结构

只有一张表 `hub_jobs`：

| 列 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | `hjob_<ts36>_<rand>` |
| name | TEXT | handler 名（如 `echo`） |
| payload | TEXT | JSON 字符串，可为 null |
| status | TEXT | `pending` / `running` / `done` / `failed` |
| created_at | INTEGER | ms |
| updated_at | INTEGER | ms |
| last_run_at | INTEGER | 最后一次进入 running 的时间 |
| last_error | TEXT | done 时复用作「最近输出」；failed 时是错误消息 |

索引：`(status, created_at)`。

## Schema 版本

**不动主 `schema_version`。** Hub 用独立 meta key `hub_schema_version`（参照 `runReasonixMigrations` 的做法）。`runHubMigrations()` 幂等，每次启动都调一次。

主进程升级 `DB_SCHEMA_VERSION` 不影响 Hub；Hub 升级 `HUB_SCHEMA_VERSION` 也不影响主进程。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `HUB_ENABLED` | 未设置 | 必须 `=1` 才会真的启动。否则 `node server/hub/index.js` 直接退出。 |
| `HUB_TICK_MS` | `30000` | tick 间隔，最小 100ms |
| `APP_DATA_DIR` | `./server-data` | 和主进程共用 |
| `APP_DB_PATH` | `<dataDir>/app.db` | 和主进程共用 |

## 启动

```bash
HUB_ENABLED=1 npm run hub
# 或
HUB_ENABLED=1 node server/hub/index.js
```

主进程的启动 (`npm run serve`) **不会**自动拉起 Hub。生产部署需要单独起一个进程（systemd / docker / PM2 都行）。

## 加一个新 job handler

1. 在 `server/hub/jobs/` 下写一个文件：

   ```js
   export async function syncFooHandler(job) {
     // 做事
     return 'optional summary string'  // 写到 last_error 字段
   }
   ```

2. 在 `server/hub/jobRegistry.js` 顶部 import，并 `register('sync_foo', syncFooHandler)`。

3. 入队（任何能写主 DB 的进程都行，包括 Hub 自己）：

   ```js
   import { enqueueJob } from './hubDb.js'
   enqueueJob({ name: 'sync_foo', payload: { id: 42 } })
   ```

handler 约定：

- `async (job) => string | null`：返回字符串会被写到 `last_error`（命名是历史负担）。
- 抛错 → `markFailed(job.id, err.message)`。

## 与主进程的边界

**Hub 能做的：**

- 读主 DB 任何表（只读）
- 写 `hub_*` 表
- 通过外部 API（HTTP / MCP / 第三方）做副作用

**Hub 不能做的：**

- 写主 schema 任何表（users / sessions / jobs / ledger / pinned_memories / todos …）
- 修改 `DB_SCHEMA_VERSION` 或主迁移
- 监听 HTTP 端口（这是主进程的事）
- 被主进程 `appServer.js` 直接 import 启动

需要让主进程触发 Hub 工作时，**通过 `hub_jobs` 表入队**，不要走进程内函数调用。

## Graceful shutdown

收到 `SIGINT` / `SIGTERM` 时：

1. 停止 tick timer
2. 等当前 `runOnce()` 跑完（最多 10s）
3. 关 DB
4. exit

超时强退 exit code 1。
