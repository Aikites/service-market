# 给 Cline 的总任务卡：完成竞标大厅网站

> 用法：把本文件从第一行开始整份复制给 Cline。
>
> 这是**手动交接卡**，不是 `chain/loop` 自动任务。目标仓库：`E:\网站\交易网站`。
>
> T-001 已冻结；T-002 认证卡已 confirmed。本卡把 T-002 和完成网站所需的后续步骤整理成一份可执行说明。

## 0. 当前基线

- 竞标大厅已存在：`index.html`、`server.js`、`src/bid/*.mjs`、`tests/bid/*.test.mjs`
- T-001 竞标评审、预算闸门、只读 API 已通过 10 阶段 verify，19 个测试全绿
- 已有只读接口：`GET /api/bids`、`GET /api/bid-result`、`GET /api/budget`
- `server.js` 目前只接受 GET/HEAD；所有 POST 返回 405
- `admin.html`、`README.md`、`.env.example` 目前是 0 字节
- 需求表单只在 localStorage 里存草稿，没有服务端持久化
- 认证尚未实现；T-002 卡是 `tasks/T-002.md`
- 没有数据库、没有 Prisma、没有运行时依赖；Node 内置模块优先
- `chain/loop.mjs`、`chain/run.mjs`、`chain/state.mjs` 是 0 字节，自动链不可用
- `node_modules` 可能是临时链接；CI/新环境需要正常安装依赖

## 1. 硬约束

1. 不引入第三方依赖，不改 `package.json`。
2. 不改 `src/bid/**`、`tests/bid/**`；竞标评分/预算逻辑是冻结基线。
3. 不改 `chain/**`、`scripts/**`、`reports/**`、`tasks/**`。
4. 不写真实支付、不接 OAuth、不发邮件。
5. 所有写接口从服务端会话取用户，不信任 body/query 里的 userId/role。
6. 密码/会话/token 不写日志、不进响应、不进 git。
7. `data/` 加入 `.gitignore`；不要提交真实用户、会话、需求文件。
8. 金额统一用人民币元（前端展示），预算上限仍读 `chain/policy.json`，不要硬编码 8 元。
9. 保持 T-001 的只读 API 行为不变；`/api/bids`、`/api/bid-result`、`/api/budget` 的响应字段不能改。
10. 任何失败都要返回 `{ ok: false, error }`，不把堆栈抛给浏览器。

## 2. 允许修改的路径

```text
server.js
index.html
admin.html
login.html          （新建）
register.html       （新建）
src/auth/**         （新建）
data/**             （运行时数据，gitignore）
tests/auth/**       （新建，T-002 的 4 个 required tests）
tests/site/**       （新建，需求/管理页测试）
docs/auth.md        （新建）
README.md           （补文档）
.env.example        （补占位变量）
.gitignore
```

禁止修改：

```text
src/bid/**
tests/bid/**
chain/**
scripts/**
reports/**
tasks/**
bids/**             （只读；投标文件由人工/Agent 放置）
package.json
pnpm-lock.yaml
```

## 3. 阶段一：T-002 认证（必做，先完成）

### 3.1 存储

新增 `src/auth/store.mjs`，默认 `data/auth.json`，可用 `AUTH_DATA_FILE` 覆盖；测试必须用临时文件。

```json
{
  "version": 1,
  "users": [
    {
      "id": "usr_...",
      "email": "user@example.com",
      "name": "用户",
      "passwordHash": "scrypt$16384$8$1$...$...",
      "role": "USER",
      "createdAt": "2026-11-19T00:00:00.000Z",
      "updatedAt": "2026-11-19T00:00:00.000Z"
    }
  ],
  "sessions": [
    {
      "id": "ses_...",
      "tokenHash": "sha256 hex",
      "userId": "usr_...",
      "createdAt": "2026-11-19T00:00:00.000Z",
      "expiresAt": "2026-11-26T00:00:00.000Z",
      "lastSeenAt": "2026-11-19T00:00:00.000Z"
    }
  ]
}
```

要求：

- 目录不存在时创建；临时文件 + rename 原子写
- 进程内 Promise 队列串行写，避免并发写坏 JSON
- 读时过滤过期会话
- `data/` 加入 `.gitignore`

### 3.2 密码

新增 `src/auth/password.mjs`：

- `scrypt`：N=16384、r=8、p=1、16 字节盐、64 字节 key
- 格式：`scrypt$N$r$p$saltBase64$hashBase64`
- 校验格式/参数上下界，失败返回 false，不抛 500
- 邮箱不存在时也跑一次 dummy scrypt
- 密码 8–72 位；拒绝常见弱口令、纯数字、与邮箱 local part 相同

### 3.3 会话

新增 `src/auth/session.mjs`：

- token：`randomBytes(32).toString("base64url")`
- 只存 `sha256(token)`，不存原文
- TTL 7 天；过期/被删/哈希不匹配按未登录
- 登录成功删除该用户旧会话并创建新会话（轮换）
- 登出删除当前会话

Cookie：

- 名 `sm_session`
- `HttpOnly`、`SameSite=Lax`、`Path=/`
- 生产环境加 `Secure`
- `Max-Age=604800`；登出 `Max-Age=0`

### 3.4 接口

`server.js` 增加：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/register` | 201，写 Cookie |
| POST | `/api/auth/login` | 200，写 Cookie |
| POST | `/api/auth/logout` | 200，清 Cookie + 删会话 |
| GET | `/api/auth/me` | 200/401 |

- JSON body 上限 16 KB；要求 `content-type: application/json`
- 注册：email trim/lowercase、name 2–30、password 8–72；role 固定 USER，客户端 role 忽略
- 登录：邮箱不存在/密码错误统一 401「邮箱或密码错误」
- 失败限流：`IP + email` 1 分钟 5 次，第 6 次 429 + `Retry-After`
- 错误统一 `{ ok: false, error }`

### 3.5 页面

- `login.html`：邮箱 + 密码；成功跳 `next` 或 `/`
- `register.html`：称呼 + 邮箱 + 密码；成功跳 `/`
- `index.html` 右上角加「登录 / 注册 / 我的账号 / 退出」
- `/login`、`/register` 映射到 HTML
- `/admin.html`：未登录 302 `/login?next=/admin.html`；USER 403；ADMIN 200
- `next` 只允许单个 `/` 开头、不以 `//` 开头、不含反斜杠/控制字符

管理员引导：

- `.env.example` 增加 `AUTH_DATA_FILE`、`ADMIN_EMAIL`、`ADMIN_PASSWORD`
- 启动或首次注册时，若 `ADMIN_EMAIL` 存在且库里没有，创建 ADMIN
- 已存在用户不改角色/密码；不提供默认管理员密码

### 3.6 T-002 测试

必须新增：

- `tests/auth/register.test.mjs`
  - 合法注册 201、role=USER、密码是 scrypt 哈希
  - 重复邮箱 409、弱口令 400、客户端 role=ADMIN 仍是 USER
- `tests/auth/login.test.mjs`
  - 正确密码 200；错误密码/不存在邮箱统一 401
  - 第 6 次失败 429
- `tests/auth/session-expiry.test.mjs`
  - 有效 200；过期/登出/篡改 401；第二次登录轮换旧会话
- `tests/auth/role-middleware.test.mjs`
  - ADMIN `/admin.html` 200；匿名 302；USER 403；客户端传 role 不能提权

每个文件至少一条允许 + 一条拒绝断言，禁止 skip/todo。

阶段一验收：

```bash
pnpm test
node scripts/verify.mjs --task T-002
```

> `verify --task T-002` 只覆盖 T-002 的 scope；阶段二开始后不要再用它做全站门禁。

## 4. 阶段二：需求发布持久化（必做）

目标：把「发布需求」从 localStorage 草稿改成服务端持久化；不改变竞标评分。

### 4.1 数据

`data/requirement.json`（gitignore）：

```json
{
  "version": 1,
  "task_id": "T-001",
  "title": "需求标题",
  "description": "需求描述",
  "budget_cny": 6.2,
  "delivery_days": 5,
  "status": "OPEN",
  "created_by": "usr_...",
  "created_at": "2026-11-19T00:00:00.000Z",
  "updated_at": "2026-11-19T00:00:00.000Z"
}
```

- 一个站点只维护当前一条需求；重复发布覆盖旧需求，但必须保留历史？v0 只保留当前一条，明确写入文档。
- 预算必须 `> 0` 且 `<= min(task budget 8, daily remaining)`；读取 `chain/policy.json` 和 `chain/state.json`，不要硬编码。
- 交付周期 1–14 天（读 T-001 卡 bidding.max_delivery_days）。

### 4.2 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/requirement` | 公开；无需求返回 `{ ok: true, requirement: null }` |
| POST | `/api/requirement` | 登录 USER/ADMIN；创建/替换当前需求 |
| POST | `/api/admin/requirement/close` | ADMIN；状态改 CLOSED |

- 未登录 POST 401；USER 可以发需求；ADMIN 也可以
- title 4–80、description 10–1200、budget 数字、delivery 1–14
- 返回 `{ ok: true, requirement }`
- 非法/超预算 400；没有需求时 close 409

### 4.3 页面

`index.html`：

- 需求表单提交改为 `POST /api/requirement`
- 成功显示服务端返回的需求，不再把 localStorage 当权威
- 刷新页面时先 `GET /api/requirement` 渲染
- 未登录点「登记需求」跳 `/login?next=/`
- 保留「清除草稿」，但只清 localStorage
- 需求状态 CLOSED 时显示「已关闭」，禁用登记

### 4.4 测试

`tests/site/requirement.test.mjs`：

- 未登录 POST 401
- 合法发布 200/201 并落盘
- title/description/budget/delivery 非法 400
- 预算超过 8 或超过当日剩余 400
- GET 公开可见
- USER 调 admin close 403；ADMIN close 200
- 重复发布覆盖当前需求，不产生多份

## 5. 阶段三：管理员页 + 收尾（必做）

目标：把 `admin.html` 从 0 字节变成可用的管理员页，并补文档。

### 5.1 admin.html

- 只允许 ADMIN；未登录 302，USER 403
- 展示：当前需求、投标数量、合格/废标、预算、当前中标
- 按钮：
  - 「关闭需求」→ `POST /api/admin/requirement/close`
  - 「刷新评审」→ 重新 `GET /api/bid-result`
- 不新增写投标接口；投标仍由 `bids/T-001/*.json` 人工/Agent 放置
- 用现有深色风格，不引 UI 库

### 5.2 文档

- `README.md`：项目介绍、启动步骤、演示账号、功能、限制
- `docs/auth.md`：认证数据文件、接口、Cookie、管理员引导、回滚
- `.env.example`：`HOST`、`PORT`、`AUTH_DATA_FILE`、`ADMIN_EMAIL`、`ADMIN_PASSWORD`
- `.gitignore`：`data/`
- 明确「v0 单实例 + JSON 文件存储，不是生产数据库」

### 5.3 测试

`tests/site/admin.test.mjs`：

- 匿名 `/admin.html` 302；USER 403；ADMIN 200
- ADMIN close 后需求 CLOSED
- USER close 403
- `/api/requirement` 公开返回 CLOSED

`tests/site/regression.test.mjs`：

- `/api/bids`、`/api/bid-result`、`/api/budget` 仍返回 200，字段不变
- 19 个 T-001 测试仍通过

## 6. 检查命令

每阶段结束：

```powershell
cd E:\网站\交易网站
pnpm test
node --check server.js
```

认证阶段结束额外：

```bash
node scripts/verify.mjs --task T-002
```

全站完成后：

```powershell
pnpm test
node scripts/verify.mjs --task T-001 --stages schema,invariant,typecheck,lint,unit,i18n_parity,build,security
```

> 不要跑 `verify --task T-001` 的 scope/test_integrity：T-001 的 allowed_paths 不包含 `src/auth/**`，会按设计报越界。全站 scope 需要另开 T-003/T-004 卡；本卡是手动交接，不冒充链上任务。

手工验收：

1. `/register` 注册 → `/` 显示当前用户
2. `/login` 登录 → `/admin.html` 对 USER 403
3. 用 `ADMIN_EMAIL` 登录 → `/admin.html` 200
4. 发布需求 → 刷新仍存在
5. 放一个 `bids/T-001/*.json` → 首页排名更新
6. ADMIN 关闭需求 → 首页显示已关闭
7. 登出 → `/api/auth/me` 401

## 7. 停止条件

遇到以下情况停下来报告，不要猜：

1. 需要改 `src/bid/**` 或 `chain/**` 才能继续
2. 需要新增依赖或改 `package.json`
3. T-001 的只读 API 字段必须变
4. 需要数据库/Prisma（当前明确用文件存储）
5. 测试基线不是 19/19 通过
6. 需要真实支付、邮件、OAuth
7. 工作区有未提交改动可能覆盖别人代码

## 8. 最终报告

```markdown
## 完成情况
- T-002 认证：完成/未完成
- 需求持久化：完成/未完成
- 管理页/文档：完成/未完成

## 改动文件
- ...

## 验证
- pnpm test：X passed
- node scripts/verify.mjs --task T-002：通过/失败
- 手工流程：通过/失败

## 已知问题
- ...
```

不要没跑测试就声称完成。
