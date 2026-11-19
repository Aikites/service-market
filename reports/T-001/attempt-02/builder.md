# T-001 Attempt 02 · Builder Note

## 本次工作

1. 修复 `src/bid/config.mjs` 的 `assertWeights()`：先逐项校验 0~1，再校验和为 1。修复 A01 的既有测试失败。
2. 修掉 `index.html` / `server.js` 的 EOF 空行，使 `git diff --check` 通过。
3. 补齐 `scripts/verify.mjs` 的 7 个阶段：
   - scope、test_integrity、typecheck、lint、unit、i18n_parity、build、security
4. 生成 A02 的 verify/review/junit/日志产物。
5. 放宽 `chain/schemas/verify.schema.json` 的 `environment.node` 到 22–24，匹配 `package.json` 的 engines。

## 验证

```text
node node_modules/vitest/vitest.mjs run
Test Files  2 passed (2)
Tests       19 passed (19)

node scripts/verify.mjs --task T-001
10 个阶段全部 PASS，0 违规，3 条告警
```

## 说明

- 本 attempt 没有实现 T-002 认证。
- `admin.html` 仍为空，属于 T-002。
- 价格表仍 `verified=false`，属于人工核对项。
- 目标仓库当前有未提交的 T-001 代码改动；冻结前需要提交到分支。
