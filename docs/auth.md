# 认证（T-002 v0）

竞标大厅的人侧账号：邮箱注册、登录、登出、服务端会话、USER/ADMIN 全局角色。
Agent 投标仍是 `bids/T-001/*.json` 文件，不需要登录；本卡不改变 T-001 的评分、预算和只读 API。

## 1. 数据文件

- 默认 `data/auth.json`，可用 `AUTH_DATA_FILE` 覆盖（相对路径按进程 cwd 解析）。
- `data/` 已加入 `.gitignore`；**不要提交真实用户或会话**。
- 结构：

```json
{
  "version": 1,
  "users": [
    {
      "id": "usr_...",
      "email": "user@example.com",
      "name": "用户",
      "passwordHash": "scrypt$16384$8$1$<saltBase64>$<hashBase64>",
      "role": "USER",
      "createdAt": "2026-11-19T00:00:00.000Z",
      "updatedAt": "2026-11-19T00:00:00.000Z"
    }
  ],
  "sessions": [
    {
      "id": "ses_...",
      "tokenHash": "<sha256 hex>",
      "userId": "usr_...",
      "createdAt": "2026-11-19T00:00:00.000Z",
      "expiresAt": "2026-11-26T00:00:00.000Z",
      "lastSeenAt": "2026-11-19T00:00:00.000Z"
    }
  ]
}
```

写入策略：目录自动创建，`auth.json.tmp` + `rename` 原子替换，文件权限尽量 `0o600`（Windows 忽略）；
同进程写操作走 Promise 队列串行。读取时过滤过期会话。

> v0 是**单实例 + JSON 文件存储**，不是生产数据库。多实例会互相覆盖；上线前应换 SQLite/Postgres 并迁移用户与会话。

## 2. 环境变量

| 变量 | 说明 |
|---|---|
| `HOST` / `PORT` | 监听地址与端口，默认 `127.0.0.1:3000` |
| `AUTH_DATA_FILE` | 认证数据文件路径，默认 `data/auth.json` |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | 管理员引导；两个都设置且库里没有该邮箱时才创建 ADMIN |
| `NODE_ENV` | `production` 时 Cookie 追加 `Secure` |

管理员引导规则：

- 已存在同名邮箱时**不改角色、不改密码**；
- `ADMIN_PASSWORD` 必须满足 8–72 位且不是弱口令，否则跳过引导并打印一条警告（不回显密码）；
- 不提供默认管理员密码；`.env.example` 只有占位值。

> 注意：`chain/policy.json` 的 `scope.always_forbidden_paths` 含 `.env.*`，`.env.example` 属于受保护路径，
> 本卡按 fail-closed 不改动它；环境变量以上表 + 本节 PowerShell 示例为准。

PowerShell 示例（临时会话）：

```powershell
$env:ADMIN_EMAIL = "admin@example.com"
$env:ADMIN_PASSWORD = "换成你自己的强口令"
node server.js
```

## 3. 接口

所有 JSON 请求必须 `content-type: application/json`，body 上限 16 KB。
成功响应 `{ "ok": true, ... }`，失败响应 `{ "ok": false, "error": "..." }`。

| 方法 | 路径 | 成功 | 主要失败 |
|---|---|---|---|
| POST | `/api/auth/register` | 201 + `Set-Cookie` + `user` | 400 字段/弱口令、409 邮箱已注册、429 注册限流 |
| POST | `/api/auth/login` | 200 + 新 `Set-Cookie` + `user` | 401 邮箱或密码错误、429 失败限流 |
| POST | `/api/auth/logout` | 200 `{ ok: true }` + 清 Cookie（幂等） | 403 跨站 Origin |
| GET | `/api/auth/me` | 200 + `user` + `session.expiresAt` | 401 未登录 |

`user` 只含 `id`、`email`、`name`、`role`、`createdAt`；**任何响应都不返回 `passwordHash`**。

注册规则：邮箱 trim + 小写（`User@Example.com` 与 `user@example.com` 视为同一邮箱）、最长 254；
称呼 2–30 字；密码 8–72 位，拒绝常见弱口令、纯数字、单字符重复、与邮箱前缀相同；
**角色固定 USER，请求里的 `role` 一律忽略**。

登录规则：邮箱不存在时也执行一次同参数 scrypt（`dummyVerify`）降低时序差；
邮箱不存在与密码错误统一返回 401「邮箱或密码错误」；
`IP + email` 维度 1 分钟最多 5 次失败，第 6 次 429 并带 `Retry-After`；成功登录清空失败计数。

限流是进程内 `Map`，多实例失效，重启归零（v0 明确接受）。

## 4. 会话与 Cookie

- token：`randomBytes(32).toString("base64url")`，只在创建时返回给浏览器；
- 服务端只存 `sha256(token)`；
- TTL 7 天；过期、被删、哈希不匹配一律按未登录；
- 登录成功先删除该用户全部旧会话再建新会话（轮换，按 `userId` 删除）；
- 登出删除当前会话并清 Cookie。

Cookie：

```text
sm_session=<token>; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800
```

`NODE_ENV=production` 追加 `Secure`；不设置 `Domain`。登出时 `Max-Age=0`。

## 5. 页面与角色

| 路径 | 规则 |
|---|---|
| `/login`、`/login.html` | 静态登录页；成功后跳 `next`（只允许站内路径）或 `/` |
| `/register`、`/register.html` | 静态注册页；成功后跳 `/` |
| `/admin.html` | 匿名 302 到 `/login?next=/admin.html`；USER 403；ADMIN 200 |
| `/` | 右上角显示登录状态；ADMIN 多一个「管理台」入口 |

`next` 校验：必须以单个 `/` 开头、不以 `//` 开头、不含反斜杠与控制字符，防止开放重定向。
`requireUser(req)` / `requireAdmin(req)` 在 `src/auth/middleware.mjs`，供后续管理接口复用。
所有写接口从服务端会话取用户，不信任 body/query 里的 `userId` 或 `role`。

## 6. 安全边界

- 密码/会话/管理员密码不进日志、不进响应、不进 git；
- POST 若带 `Origin`，必须与请求 `Host` 同源，否则 403；
- 认证内部错误只返回「服务暂时不可用」，不返回堆栈；
- 不做找回密码、邮箱验证、OAuth、多设备管理、CSRF token、审计后台（后续卡）。

## 7. 回滚

1. 删除 `src/auth/`、`login.html`、`register.html`、`tests/auth/`、`docs/auth.md`；
2. 还原 `server.js`、`index.html`、`admin.html`、`.env.example`、`.gitignore`；
3. 删除 `data/`（会一并删除用户与会话）。

T-001 的 `/api/bids`、`/api/bid-result`、`/api/budget` 不依赖认证，回滚后照常工作。
