# 不变量 · 说明（人类可读版）

机器可读的唯一执行口径是 **`docs/invariants.json`**；本文件只做索引与解释，冲突时以 json 为准（`chain/policy.json` 的 `factory.contracts.invariants_file` / `invariants_doc` 分别指向这两份文件）。

## 清单

| ID | 名称 | 执行口径 | 检查点 |
|---|---|---|---|
| INV-001 | 单任务预算上限 | `task.budget.max_cost_cny ≤ policy.budget.task.max_cost_cny`；中标报价 ≤ 两者较小值；**任何超限报价必须已被评审判废**（否则是评审漏判） | `review-bids.mjs` G3 · `verify.mjs` stage=invariant |
| INV-002 | 单日预算上限 | `state.global.budget.daily_spent_cny + 中标报价 ≤ policy.budget.daily.max_cost_cny` | `review-bids.mjs` G4 · `verify.mjs` stage=invariant |
| INV-003 | 评分区间 | 报告里所有分项分与总分 ∈ `[0, 1]` | `review-bids.mjs` scoreBids · `verify.mjs` stage=invariant |

## 两个容易被写错的口径

1. **投标池 ≠ 花费。** `bids/{task}/` 里存的是全部投标，含被 G1–G8 判废的超预算报价。把「每份报价」当花费来卡单日上限，会让任何 ≥2 家正常竞标的拍卖直接变红。所以：
   - INV-001 卡「超限的报价有没有被判废」，不卡「有没有人报高价」；
   - INV-002 只计「当日已花 + 中标价」；全体报价之和属于**敞口**，超限只告警（`exposure_warn`）；
   - 真要卡报价合计：把 `check.amount_from` 改成 `all_quotes`（见 json）。
2. **缺失字段必须判失败。** 任何 `undefined`/`NaN` 参与比较都会得到 `false`，从而「恒过」。`verify.mjs` 对缺失数值字段直接判违规，并用 `--self-test` 固化这条。

## 新增一条不变量

1. 在 `docs/invariants.json` 追加对象：`id` 必须是 `INV-` 加三位数字、唯一、带 `check.kind`；
2. `check.kind` 必须是 `scripts/verify.mjs` 中 `EVALUATORS` 已实现的类型（现有 `per_task_budget` / `daily_budget` / `score_range`）；
3. 需要新 `kind` 时：先写实现 + `--self-test` 反例，再登记不变量 —— 未实现的 kind 会被判 `unsupported_check` 并**不放行**，不会静默跳过；
4. 若任务卡引用该 ID，必须同步 `tasks/T-XXX.md` front-matter 的 `invariants`，否则 `task.invariants_declared` 检查失败。

## 自检与流水线

```bash
node scripts/verify.mjs --self-test        # 13 项正反例：证明闸门不是空壳（7 条断言必须红）
node scripts/verify.mjs --negative-test    # 只跑反例（坏输入必须被判失败，且不得少于 5 条）
node scripts/verify.mjs --regression       # 同一输入连跑两遍，断言逐字节一致
node scripts/verify.mjs --check-json       # 全仓 JSON 语法体检（BOM / 截断 / 尾逗号）
node scripts/verify.mjs                    # schema + invariant（其余 8 阶段显式 skipped）
node scripts/verify.mjs --stages invariant --only INV-001   # 只判定一条不变量（本地定位用）

npm run test:integrity                     # 8 阶段完整性测试，写 scope/integrity-report.json
git hook run pre-commit                    # 不产生提交地验证钩子能跑
```

- **`npm run test:integrity` 是本地与 CI 的唯一共同入口**（`scope/test_integrity.mjs`），保证「本地绿 == CI 绿」；
- `--only` 会被 `--ci` / `--strict` 拒绝：过滤过的结果不得当作门禁；
- 一个阶段都没真跑时（全部 skipped）`verify.mjs` 直接 exit 1，不允许「零执行 = 通过」的假绿。

### 钩子

| 钩子 | 内容 | 绕过方式 |
|---|---|---|
| `.githooks/pre-commit` | `verify.mjs --stages schema,invariant`（约 0.1s） | `SKIP_FACTORY_HOOKS=1 git commit ...` |
| `.githooks/pre-push` | `scope/test_integrity.mjs`（8 阶段） | `SKIP_FACTORY_HOOKS=1 git push` |

钩子需要挂载一次：`npm run hooks:install`（等价 `git config core.hooksPath .githooks`）。
远程 CI 见 `.github/workflows/ci.yml`：Node 22 与 24 双版本矩阵，跑 `npm run test:integrity`，并上传 `integrity-report.json`。

