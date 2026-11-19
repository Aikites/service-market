# T-001 Attempt 02 · Review

## 结论

**approve**（代码层）。T-001 的 10 个 verify 阶段已全部实跑通过，19 个 Vitest 测试通过，3 条不变量覆盖。T-001 卡已经人工改为 confirmed。

## 验证证据

```text
node scripts/verify.mjs --task T-001
[schema] PASS 20/20
[scope] PASS 1/1
[test_integrity] PASS 3/3
[typecheck] PASS 1/1
[lint] PASS 2/2
[unit] PASS 1/1
[invariant] PASS 3/3
[i18n_parity] PASS 1/1
[build] PASS 1/1
[security] PASS 1/1
结果：PASSED（0 项违规，3 条告警，实跑阶段 10 个）
```

```text
node node_modules/vitest/vitest.mjs run
Test Files  2 passed (2)
Tests       19 passed (19)
```

## 本次补齐的基础设施

`scripts/verify.mjs` 原来只有 `schema` 和 `invariant` 两个阶段；本次补齐：

- `scope`：git diff/untracked + allowed_paths/forbidden/protected 比对
- `test_integrity`：测试删除、skip/todo 标记、expect 计数
- `typecheck`：JS/MJS 语法检查（本仓库没有 tsconfig）
- `lint`：git diff --check + debugger 扫描
- `unit`：node_modules/vitest 或 pnpm test
- `i18n_parity`：locales/*.json 键集合比对
- `build`：静态入口与 server.js 语法
- `security`：eval/Function/私钥/云 key 扫描

同时修复了 `src/bid/config.mjs` 的 `assertWeights()` 顺序问题（A01 记录），并修掉 `index.html`/`server.js` 的 EOF 空行，lint 才通过。

## 非阻断问题

1. `server.js` 500 响应仍返回 `error.message`，建议 T-002 一并改成固定文案。
2. `admin.html` 还是 0 字节；T-002 填充并加 ADMIN 保护。
3. 价格表 `verified=false`；需要人工核对后 `--mark-pricing-verified`。
4. `i18n_parity` 目前只有 zh-CN，属于单语言通过。

## 产物

- `reports/T-001/attempt-02/verify.json`
- `reports/T-001/attempt-02/verify.log`
- `reports/T-001/attempt-02/unit.log`
- `reports/T-001/attempt-02/junit.xml`
- `reports/T-001/attempt-02/review.json`
- `reports/T-001/attempt-02/review.md`
- `reports/T-001/attempt-02/builder.md`
- `reports/T-001/attempt-02/bid-review.log`

## 冻结后人工动作

- [x] 人工确认 T-001 的 3 条告警可接受
- [x] 填 `human_approval.approved_by` / `approved_at` / `task_sha256`
- [x] `status` 改为 `confirmed`
- [x] 把 `index.html`、`server.js`、`src/bid`、`tests/bid` 的改动提交到分支
- [x] 然后确认 T-002
