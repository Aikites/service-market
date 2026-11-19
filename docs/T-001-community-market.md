# T-001 社区 + 接单站：脚手架与核心领域模型

> 草稿。这是「贴吧式社区 + 发单/接单市场」新产品的第一张卡，不是现有服务商城的 T-001。
> 先放在 `_drafts/`，避免和 `tasks/T-001-scaffold.md` 撞号；确认新仓库后再移到 `tasks/T-001.md`。
>
> **2026-11-19 决策：本社区版暂不落地；T-002 已改为竞标大厅认证，见 `tasks/T-002.md`。本文保留为历史草稿。**

## 背景

要做一个网站，同时具备两种场景：

1. **社区**：像贴吧一样，用户进板块、发帖、回帖、点赞、举报；管理员可以隐藏、锁定、封禁。
2. **接单市场**：需求方发单（TaskPost），服务商申请接单（Application），需求方选中一个申请后生成订单（Order），后续交付、验收、评价。

两个场景共享用户、权限、审核和通知。用户既可以发帖，也可以发单或接单。

「自由发言」不等于无审核。社区必须有举报、限流、敏感词和管理员处置，否则很快会变成垃圾场。

## 本卡定位

T-001 只做地基，不做业务页面：

- 应用能跑
- 数据库模型立住（社区 + 接单）
- 状态机和权限有测试
- CI 变绿

真正的发帖、发单、接单页面从 T-003 开始。

## 产品模型

### 社区

```
Board（板块/吧）
  └─ Thread（帖子）
       ├─ Reply（回复）
       ├─ ThreadLike（点赞）
       └─ Report（举报，管理员处理）
```

- 板块有 slug、名称、简介；v0 由管理员预置，不开放用户建吧。
- 帖子状态：`PUBLISHED / LOCKED / HIDDEN / DELETED`。
- 回复状态：`PUBLISHED / HIDDEN / DELETED`。
- 作者可删除自己的帖子/回复；管理员可隐藏、锁定、删除任意内容。
- 举报是多态目标（帖子/回复/发单/用户），v0 不做自动审核。

### 接单市场

```
TaskPost（发单）
  └─ Application（接单申请/报价）
       └─ Order（选中后成交）
```

- 需求方创建 `TaskPost`：标题、描述、分类、预算区间、截止时间。
- 服务商对 `OPEN` 的发单提交 `Application`：报价、方案、工期。
- 需求方选中一个申请：
  - 该申请 → `ACCEPTED`
  - 其余申请 → `REJECTED`
  - 发单 → `ASSIGNED`
  - 生成 `Order`，金额取申请的报价快照
- 后续支付、交付、验收、评价沿用订单状态机。

## 范围

### 做

**1. 应用骨架**

- 创建 `src/app/layout.tsx`、`src/app/page.tsx`、`src/app/globals.css`
- 首页显示「社区 + 接单」占位，说明两个入口即将开放
- 配置 Tailwind：`tailwind.config.ts`、`postcss.config.mjs`
- 创建 `src/app/api/health/route.ts`：返回 `{ "ok": true }`
- 创建 `tests/e2e/smoke.spec.ts`：首页 200 且包含标题；health 返回 ok

**2. 数据模型**

新建 `prisma/schema.prisma`，包含：

| 模型 | 说明 |
|---|---|
| `User` | 账号；全局角色只有 `USER / ADMIN`，买家/服务商是上下文身份，不写死在用户表 |
| `Board` | 板块；`slug` 唯一 |
| `Thread` | 帖子；属于板块，有作者、状态、置顶 |
| `Reply` | 回复；属于帖子 |
| `ThreadLike` | 帖子点赞；`@@unique([threadId, userId])` |
| `TaskPost` | 发单；需求方、预算区间、截止时间、状态 |
| `Application` | 接单申请；报价、方案、工期、状态 |
| `Order` | 成交订单；`taskPostId` 和 `applicationId` 都唯一，金额是申请报价快照 |
| `Payment` | 支付记录；`providerRef`、`idempotencyKey` 唯一 |
| `OrderEvent` | 订单状态流水 |
| `Review` | 订单评价；`orderId` 唯一 |
| `Report` | 举报；多态目标（帖子/回复/发单/用户） |
| `AuditLog` | 管理员操作审计 |

关键约束：

- `Order.taskPostId @unique`、`Order.applicationId @unique`
- `Order.amountCents` 只能来自被选中申请的 `quoteCents`，不允许前端传
- `TaskPost.budgetMinCents <= budgetMaxCents` 由服务层校验
- 一个服务商对同一发单只保留一条有效申请（v0 服务层校验，不建部分唯一索引）
- 删除用户采用软删除或禁用，不做级联硬删

**3. 状态机与权限**

`src/domain/task-status.ts`

```
DRAFT     -> OPEN, CANCELLED
OPEN      -> ASSIGNED, CLOSED, CANCELLED
ASSIGNED  -> 终态（交付由 Order 跟踪）
CLOSED    -> 终态
CANCELLED -> 终态
```

`src/domain/application-status.ts`

```
PENDING  -> ACCEPTED, REJECTED, WITHDRAWN
ACCEPTED -> 终态
REJECTED -> 终态
WITHDRAWN-> 终态
```

`src/domain/task-policy.ts`

| 动作 | 起始状态 | 目标状态 | 谁可以 |
|---|---|---|---|
| PUBLISH | DRAFT | OPEN | 发单方本人、管理员 |
| CLOSE | OPEN | CLOSED | 发单方本人、管理员 |
| CANCEL | DRAFT / OPEN | CANCELLED | 发单方本人、管理员 |
| APPLY | 发单为 OPEN | 新建待审申请 | 服务商，且不是发单方本人 |

`src/domain/application-policy.ts`

| 动作 | 起始状态 | 目标状态 | 谁可以 |
|---|---|---|---|
| ACCEPT | PENDING | ACCEPTED | 发单方本人、管理员 |
| REJECT | PENDING | REJECTED | 发单方本人、管理员 |
| WITHDRAW | PENDING | WITHDRAWN | 申请人本人 |

`src/domain/moderation-policy.ts`

| 动作 | 谁可以 |
|---|---|
| 删除自己的帖子/回复 | 作者本人 |
| 隐藏/锁定/置顶任意帖子 | 管理员 |
| 处理举报 | 管理员 |
| 封禁用户 | 管理员 |

`src/domain/order-status.ts`、`order-policy.ts`

- 订单状态机沿用：`PENDING_PAYMENT → PAID → IN_PROGRESS → DELIVERED → COMPLETED`，另有取消、退款、争议。
- 角色从上下文取：订单买家、订单服务商、管理员；不要用全局 `User.role` 判断买家/服务商。

**4. 迁移与测试**

- 生成 `prisma/migrations/0001_init`，覆盖全部表
- 新增测试：
  - `task-status.test.ts`
  - `application-status.test.ts`
  - `task-policy.test.ts`
  - `application-policy.test.ts`
  - `moderation-policy.test.ts`
- 更新/保留：
  - `money.test.ts`
  - `order-status.test.ts`
  - `order-policy.test.ts`

### 不做

- 登录、注册、会话（T-002）
- 板块、帖子、回复的页面与接口（T-003）
- 发单页面与接口（T-004）
- 申请接单页面、选标成交事务（T-005）
- 支付（T-006）
- 举报后台、封禁、敏感词、限流（T-007）
- 通知、搜索、附件上传、实时刷新、移动端
- 真实资金

## 验收标准

- [ ] `pnpm dev` 打开 `/` 显示「社区 + 接单」占位
- [ ] `/api/health` 返回 `{"ok":true}` 且状态 200
- [ ] `pnpm db:migrate` 成功，数据库包含社区与接单全部表
- [ ] `Order` 的 `taskPostId`、`applicationId` 均有唯一约束
- [ ] `ThreadLike` 的 `(threadId, userId)` 唯一
- [ ] `TaskPost` 不能从 `DRAFT` 直接到 `ASSIGNED`
- [ ] `Application` 不能从 `ACCEPTED` 回到 `WITHDRAWN`
- [ ] 发单方不能对自己的发单 `APPLY`
- [ ] 服务商不能 `ACCEPT` 自己的申请
- [ ] 只有发单方本人或管理员能 `PUBLISH` / `CLOSE` / `CANCEL` / `ACCEPT` / `REJECT`
- [ ] 只有申请人本人能 `WITHDRAW`
- [ ] 作者只能删除自己的帖子/回复；管理员可以隐藏/锁定任意帖子
- [ ] 每个动作的边都存在于对应状态机
- [ ] `pnpm test` 通过（含 money / order 现有测试）
- [ ] `pnpm build` 成功
- [ ] `pnpm e2e` 通过
- [ ] GitHub Actions 绿

## 测试要求

- 单测：上述状态机与权限测试
- 单测：金额、订单状态机、订单权限保持通过
- E2E：首页与 health
- 不需要数据库集成测试（本卡只建迁移，不查数据）
- 每个权限规则至少覆盖「允许」和「拒绝」两条

## 涉及文件

- `src/app/layout.tsx`、`src/app/page.tsx`、`src/app/globals.css`
- `src/app/api/health/route.ts`
- `tests/e2e/smoke.spec.ts`
- `tailwind.config.ts`、`postcss.config.mjs`
- `prisma/schema.prisma`、`prisma/migrations/**`
- `src/domain/task-status.ts`
- `src/domain/application-status.ts`
- `src/domain/task-policy.ts`
- `src/domain/application-policy.ts`
- `src/domain/moderation-policy.ts`
- `src/domain/order-status.ts`、`order-policy.ts`
- 对应 `*.test.ts`

## 风险与回滚

- **两个产品塞一个库**：社区和接单只通过 `Order` 和用户关联，不要让帖子表反向依赖订单表；否则后面拆不开。
- **「自由发言」的滥用风险**：本卡只建模型，T-003 必须同时做限流、举报、敏感词和管理员处置，否则上线即失控。
- **状态机边写错**：选标事务依赖这些边，先用测试固定住；T-001 不写选标事务本身。
- **全局角色误用**：`User.role` 只有 `USER / ADMIN`，买家/服务商按资源归属判断；不要把 `PROVIDER` 写进用户表，否则一个人不能既发单又接单。
- **删表/改表**：新仓库无数据可直接建；如果复用旧库，先确认 `Service` 等旧表无数据并备份。
- 回滚：保留 schema 的 SQL 备份；迁移失败用 `prisma migrate resolve`；代码回退到上一分支。

## 后续任务

- T-002 认证：注册、登录、会话、角色中间件
- T-003 社区核心：板块、帖子、回复、点赞、分页
- T-004 发单：TaskPost 创建、编辑、发布、关闭
- T-005 接单：Application 提交、撤回、选标成交事务（accept + reject 其余 + assign + create order）
- T-006 支付：订单支付、回调幂等、退款
- T-007 社区治理：举报、隐藏、锁定、封禁、敏感词、限流
- T-008 通知与个人主页：订单通知、帖子回复通知、成交记录

> 一张卡装不下「贴吧 + 接单」整个产品。T-001 只负责地基；上面的 T-002 ~ T-008 才是功能。先把地基跑绿，再让 Cline 一张一张做。

## 完成定义

- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` 通过
- [ ] `pnpm e2e` 通过
- [ ] CI 绿
- [ ] 人工打开首页确认
- [ ] 空库上迁移可重复执行
