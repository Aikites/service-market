# T-001 Attempt 01 · Builder Note

## 本次做了什么

- 保留 T-001 既有的竞标大厅、评分、预算、只读 API 结构。
- 修复 `src/bid/config.mjs` 的 `assertWeights()` 校验顺序：
  - 先逐项校验 `0~1` 区间
  - 再校验三项权重之和为 1
- 原因：既有测试用 `{price:1.2, delivery:0, quality:0.3}` 断言越界错误应匹配 `/0~1/`，旧实现先报“权重之和必须为 1”，测试失败。

## 验证

```text
node node_modules/vitest/vitest.mjs run
Test Files  2 passed (2)
Tests       19 passed (19)

node scripts/review-bids.mjs --check-task T-001
task_ok: true

node scripts/verify.mjs --task T-001
[schema] PASS 20/20
[invariant] PASS 3/3
结果：PASSED（0 项违规，2 条告警）
```

`verify` 仍有 7 个阶段未实现/跳过，见 `verify.json` 与 `review.json`。本 attempt 没有新增认证代码；认证在 T-002。

## 产物

- `reports/T-001/attempt-01/junit.xml`
- `reports/T-001/attempt-01/unit.log`
- `reports/T-001/attempt-01/verify.log`
- `reports/T-001/attempt-01/bid-review.log`
- `reports/T-001/attempt-01/verify.json`
- `reports/T-001/attempt-01/review.json`
- `reports/T-001/attempt-01/review.md`
- `reports/T-001/attempt-01/rca.json`
