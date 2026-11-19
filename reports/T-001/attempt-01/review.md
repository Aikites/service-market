# T-001 Attempt 01 · Review

## 结论

**needs_human**：T-001 的竞标评分、预算闸门和 19 个既有测试已经通过，但 `verify` 仍有 7 个阶段跳过，T-001 还是 draft，`admin.html` 仍为空。不能把当前报告当成完整 CI 门禁，也不能自动冻结。

## 实际验证

```text
node node_modules/vitest/vitest.mjs run
Test Files  2 passed (2)
Tests       19 passed (19)

node scripts/review-bids.mjs --check-task T-001
task_ok: true
problems: []

node scripts/review-bids.mjs --task T-001 --dry-run
合格 2/3，BID-GAMMA-01 中标，¥4.00 / 12d / 0.57

node scripts/verify.mjs --task T-001
[schema] PASS 20/20
[invariant] PASS 3/3
PASSED，2 条告警
```

`verify.json` 中 `schema`、`unit`、`invariant` 为 passed；`scope`、`test_integrity`、`typecheck`、`lint`、`i18n_parity`、`build`、`security` 仍为 skipped。`scripts/verify.mjs` 当前只实现 schema/invariant，其余阶段需要补脚本才能真正跑绿。

## Findings

| ID | 严重级 | 问题 | 处理 |
|---|---|---|---|
| F1 | high | verify 只有 schema/invariant 真跑，其余 7 阶段 skipped | 冻结前补齐，或人工明确接受 |
| F2 | medium | `server.js` 500 响应返回 `error.message`，可能泄漏内部信息 | 改固定文案，内部记日志 |
| F3 | medium | `admin.html` 0 字节，`/admin.html` 实际 404 | T-002 填充并加 ADMIN 保护 |
| F4 | high | T-001 仍 draft，`human_approval` 三项为空 | 人工确认后填 approval + task_sha256 |

## 本次修复

`src/bid/config.mjs` 的 `assertWeights()` 先校验每项 `0~1`，再校验和为 1。旧顺序会让 `{price:1.2, delivery:0, quality:0.3}` 先报“和必须为 1”，而既有测试期望 `/0~1/`。修复后 19/19 通过；详见 `rca.json`。

## 冻结 T-001 前必须做

- [ ] 处理 F1：补齐 verify 的 7 个阶段，或由人类书面接受 skipped 风险
- [ ] 处理 F4：人工填写 `human_approval.approved_by` / `approved_at` / `task_sha256`，status 改 confirmed
- [ ] 确认 `admin.html` 空文件是否可接受（T-002 会填）
- [ ] 在 CI 的 Node 22 环境复跑；本地验证使用 Node 24.15.0，`verify.json` 的 environment 字段按项目目标 Node 22 记录
- [ ] 确认 T-001 的 uncommitted 改动（`index.html`、`server.js`、`src/bid`、`tests/bid`）如何处理后再冻结

## 产物

- `reports/T-001/attempt-01/verify.json`
- `reports/T-001/attempt-01/verify.log`
- `reports/T-001/attempt-01/unit.log`
- `reports/T-001/attempt-01/junit.xml`
- `reports/T-001/attempt-01/review.json`
- `reports/T-001/attempt-01/rca.json`
- `reports/T-001/attempt-01/builder.md`
- `reports/T-001/attempt-01/bid-review.log`
