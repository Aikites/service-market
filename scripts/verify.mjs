#!/usr/bin/env node
// scripts/verify.mjs —— 验收入口（第一阶段：底层不变量 + 配置预检）
//
// 职责：
//   1. 读取 docs/invariants.json，按声明的 check 批量校验 INV-001..N；
//   2. 预检 policy.json / pricing.json / 任务卡三者是否自洽（不依赖 ajv、不联网）；
//   3. 违规即非 0 退出，CI 与 .githooks 直接拦截；未实现的阶段显式 skipped，绝不输出「假绿」。
//
// 非职责（明确不做）：
//   - 不调用任何大模型、不访问网络、不执行 git；
//   - 不改写 chain/**（唯一例外：显式 --mark-pricing-verified 且带 --by <人>，--ci 下禁用）；
//   - 不代替 scripts/review-bids.mjs 打分，只校验其结果是否落在不变量内。
//
// 确定性：文本输出逐字节一致（无随机、无当前时间参与判定），任务卡 DoD 的「重复执行一致」同样适用于本脚本。
//
// 退出码：0 通过 / 1 存在违规 / 2 用法或配置错误。

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathAllowed } from '../src/bid/config.mjs';

const ROOT = resolve(process.cwd());
const P = (rel) => join(ROOT, rel);
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d = null) => {
  const i = argv.indexOf(n);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : d;
};

const EXIT = { ok: 0, failed: 1, config: 2 };

// 与 chain/schemas/verify.schema.json 的 stage.name 枚举保持同一集合
const ALL_STAGES = ['schema', 'scope', 'test_integrity', 'typecheck', 'lint', 'unit', 'invariant', 'i18n_parity', 'build', 'security'];
const IMPLEMENTED_STAGES = new Set(ALL_STAGES);
const STAGE_PENDING = {
  scope: '已实现：git diff/untracked + allowed_paths 比对',
  test_integrity: '已实现：删除测试/skip 标记/断言计数',
  typecheck: '已实现：JS 语法检查（本仓库无 tsconfig）',
  lint: '已实现：git diff --check + debugger 扫描',
  unit: '已实现：node_modules/vitest 或 pnpm test',
  i18n_parity: '已实现：locales/*.json 键集合比对',
  build: '已实现：静态页/入口语法检查',
  security: '已实现：密钥/危险调用扫描'
};

class VerifyError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round6 = (n) => Math.round(n * 1e6) / 1e6;
const cny = (n) => (isNum(n) ? `¥${n.toFixed(2)}` : '¥n/a');
const TIMESTAMP_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

function readText(rel) {
  const abs = P(rel);
  if (!existsSync(abs)) throw new VerifyError('invalid_config', `缺少文件 ${rel}`);
  return readFileSync(abs, 'utf8');
}

function readJson(rel) {
  const abs = P(rel);
  if (!existsSync(abs)) throw new VerifyError('invalid_config', `缺少文件 ${rel}`);
  const raw = readFileSync(abs, 'utf8');
  if (raw.trim() === '') throw new VerifyError('invalid_config', `${rel} 为空文件`);
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new VerifyError('invalid_config', `${rel} 不是合法 JSON：${e.message}`);
  }
}

// 支持 "a.b.c" 取值，缺失返回 undefined；调用方必须显式判空，禁止让 undefined 参与比较
function dig(obj, dotted) {
  return String(dotted)
    .split('.')
    .reduce((node, key) => (node && typeof node === 'object' ? node[key] : undefined), obj);
}

function loadConfig() {
  const policy = readJson('chain/policy.json');
  if (policy.schema_version !== 1) throw new VerifyError('invalid_config', 'policy.schema_version 必须为 1');
  const contracts = policy.factory?.contracts || {};
  const handoff = policy.factory?.handoff || {};
  return {
    policy,
    paths: {
      policy: 'chain/policy.json',
      pricing: policy.observability?.pricing_file || 'chain/pricing.json',
      invariants: contracts.invariants_file || 'docs/invariants.json',
      tasksDir: contracts.tasks_dir || 'tasks',
      state: handoff.state_file || 'chain/state.json',
      reportsDir: handoff.reports_dir || 'reports'
    }
  };
}

function parseTaskCard(rel) {
  const text = readText(rel);
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) throw new VerifyError('invalid_config', `${rel}: front-matter 必须用 --- 包裹`);
  let front;
  try {
    front = JSON.parse(m[1]);
  } catch (e) {
    throw new VerifyError('invalid_config', `${rel}: front-matter 不是合法 JSON（${e.message}）`);
  }
  const body = text.slice(m[0].length);
  const blocks = [...body.matchAll(/```json\s*\r?\n([\s\S]*?)```/g)].map((x) => x[1]);
  let bidding = null;
  for (const b of blocks) {
    try {
      const o = JSON.parse(b);
      // 任务卡把评审配置包在 { "bidding": { ... } } 里；同时兼容裸对象写法
      const cand = o && typeof o === 'object' && o.bidding && typeof o.bidding === 'object' ? o.bidding : o;
      if (cand && typeof cand === 'object' && cand.bid_dir && cand.weights) {
        bidding = cand;
        break;
      }
    } catch {
      /* 非 bidding 块，跳过 */
    }
  }
  if (!bidding) throw new VerifyError('invalid_config', `${rel}: 未找到含 bid_dir 与 weights 的 json bidding 块`);
  const weights = bidding.weights || {};
  const sum = ['price', 'delivery', 'quality'].reduce((a, k) => a + (Number(weights[k]) || 0), 0);
  if (Math.abs(sum - 1) > 1e-9) {
    throw new VerifyError('invalid_config', `${rel}: bidding.weights 之和为 ${sum}，必须为 1`);
  }
  return { rel, front, bidding, body };
}

function loadDailySpent(stateRel, dailyMax) {
  const abs = P(stateRel);
  if (!existsSync(abs)) return { spent: 0, source: 'missing', detail: `${stateRel} 不存在，当日已花费按 0 计` };
  const raw = readFileSync(abs, 'utf8');
  if (raw.trim() === '') return { spent: 0, source: 'empty_state', detail: `${stateRel} 为空（快照未写入），当日已花费按 0 计` };
  let state;
  try {
    state = JSON.parse(raw);
  } catch (e) {
    throw new VerifyError('state_corrupt', `${stateRel} 非空但解析失败：${e.message}`);
  }
  const spent = dig(state, 'global.budget.daily_spent_cny');
  if (!isNum(spent)) throw new VerifyError('state_corrupt', `${stateRel} 缺少数值型 global.budget.daily_spent_cny`);
  const stateMax = dig(state, 'global.budget.daily_max_cny');
  if (isNum(stateMax) && round6(stateMax) !== round6(dailyMax)) {
    throw new VerifyError('state_corrupt', `${stateRel} daily_max_cny=${stateMax} 与 policy ${dailyMax} 不一致，需人工对账`);
  }
  return { spent: round6(spent), source: 'state', detail: `${stateRel} 当日已花费 ${cny(spent)}` };
}

function loadBids(bidDir) {
  const abs = P(bidDir);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return { dir: bidDir, exists: false, bids: [], parse_errors: [] };
  const files = readdirSync(abs)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const bids = [];
  const parse_errors = [];
  for (const f of files) {
    const rel = `${bidDir}/${f}`;
    try {
      const raw = readFileSync(P(rel), 'utf8');
      if (raw.trim() === '') throw new Error('空文件');
      bids.push({ file: rel, bid: JSON.parse(raw) });
    } catch (e) {
      parse_errors.push({ file: rel, reason: e.message });
    }
  }
  return { dir: bidDir, exists: true, bids, parse_errors };
}

function loadReport(reportsDir, taskId) {
  const rel = `${reportsDir}/${taskId}/bid-result.json`;
  if (!existsSync(P(rel))) return { rel, data: null };
  return { rel, data: readJson(rel) };
}

// ---------------- 结果累积 ----------------

function createRun(taskId) {
  return { task_id: taskId, checks: [], warnings: [], invariants: [] };
}

function record(run, stage, id, ok, detail, severity = 'fail') {
  run.checks.push({ stage, id, ok: Boolean(ok), severity, detail: String(detail) });
  return Boolean(ok);
}

function failures(run) {
  return run.checks.filter((c) => !c.ok && c.severity === 'fail');
}

function warn(run, id, detail) {
  run.warnings.push({ id, detail: String(detail) });
}

// ---------------- 通用执行助手（scope/test/unit/build 共用） ----------------

function runGit(args) {
  return spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  });
}

function runCommand(command, args) {
  return spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  });
}

function walkFiles(relDir, out = []) {
  const abs = P(relDir);
  if (!existsSync(abs)) return out;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = `${relDir.replace(/\/$/, '')}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      walkFiles(rel, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

function isCodePath(rel) {
  if (!rel) return false;
  if (/^(node_modules|reports|tasks|chain|scope|docs|locales|\.git|\.github|\.githooks)\//.test(rel)) {
    return false;
  }
  if (/^(index\.html|admin\.html|login\.html|register\.html|server\.js|package\.json|\.env\.example|\.gitignore|README\.md)$/.test(rel)) {
    return true;
  }
  return /^(src|tests|bids)\//.test(rel) || /\.(m?js|html|json|css)$/.test(rel);
}

function changedCodePaths() {
  const paths = new Set();
  for (const args of [
    ['diff', '--name-only', 'HEAD'],
    ['diff', '--cached', '--name-only', 'HEAD'],
    ['ls-files', '--others', '--exclude-standard']
  ]) {
    const r = runGit(args);
    if (r.status !== 0) continue;
    for (const line of String(r.stdout || '').split(/\r?\n/)) {
      const rel = line.trim().replace(/\\/g, '/');
      if (rel && isCodePath(rel)) paths.add(rel);
    }
  }
  return [...paths].sort();
}

// ---------------- 阶段 2-9：scope / 测试完整性 / 语法 / lint / unit / i18n / build / security ----------------

function stageScope(run, ctx) {
  const paths = changedCodePaths();
  const allowed = ctx.card.front.allowed_paths || [];
  const forbidden = [
    ...(ctx.card.front.forbidden_paths || []),
    ...(ctx.cfg.policy.protected_paths || []),
    ...(ctx.cfg.policy.scope?.always_forbidden_paths || [])
  ];
  const outOfScope = paths.filter(
    (rel) => !pathAllowed(rel, allowed) || pathAllowed(rel, forbidden)
  );
  record(
    run,
    'scope',
    'scope.allowed_paths',
    outOfScope.length === 0,
    outOfScope.length === 0
      ? `代码改动 ${paths.length} 个，全部在 allowed_paths 内`
      : `越界文件：${outOfScope.join(', ')}`
  );
}

function stageTestIntegrity(run, ctx) {
  const changed = changedCodePaths();
  const testPaths = changed.filter((rel) => rel.startsWith('tests/'));
  const deleted = new Set();
  for (const args of [
    ['diff', '--diff-filter=D', '--name-only', 'HEAD'],
    ['diff', '--cached', '--diff-filter=D', '--name-only', 'HEAD']
  ]) {
    const r = runGit(args);
    if (r.status !== 0) continue;
    for (const line of String(r.stdout || '').split(/\r?\n/)) {
      const rel = line.trim().replace(/\\/g, '/');
      if (rel.startsWith('tests/')) deleted.add(rel);
    }
  }
  record(
    run,
    'test_integrity',
    'test_integrity.no_test_deletion',
    deleted.size === 0,
    deleted.size === 0 ? '没有删除测试文件' : `删除测试：${[...deleted].join(', ')}`
  );

  const skipPattern = /(?:\.skip|\.todo|it\.skip|test\.skip|describe\.skip)\s*\(/;
  const skipHits = [];
  const diff = runGit(['diff', '-U0', 'HEAD']);
  if (diff.status === 0) {
    for (const line of String(diff.stdout || '').split(/\r?\n/)) {
      if (line.startsWith('+') && !line.startsWith('+++') && skipPattern.test(line)) {
        skipHits.push(line.slice(1, 160));
      }
    }
  }
  for (const rel of testPaths) {
    if (!existsSync(P(rel))) continue;
    const text = readFileSync(P(rel), 'utf8');
    if (skipPattern.test(text)) skipHits.push(`${rel} 含 skip/todo`);
  }
  record(
    run,
    'test_integrity',
    'test_integrity.no_skip_added',
    skipHits.length === 0,
    skipHits.length === 0 ? '新增/修改测试没有 skip/todo' : skipHits.join(' | ')
  );

  const testFiles = walkFiles('tests').filter((rel) => /\.(test|spec)\.[cm]?js$/.test(rel));
  let assertions = 0;
  for (const rel of testFiles) {
    assertions += (readFileSync(P(rel), 'utf8').match(/\bexpect\s*\(/g) || []).length;
  }
  record(
    run,
    'test_integrity',
    'test_integrity.assertions_present',
    assertions > 0,
    `${testFiles.length} 个测试文件，${assertions} 个 expect`
  );
}

function stageTypecheck(run) {
  const files = ['server.js', ...walkFiles('src').filter((rel) => /\.(m?js|ts)$/.test(rel))];
  const failures = [];
  for (const rel of files) {
    const r = runCommand(process.execPath, ['--check', rel]);
    if (r.status !== 0) failures.push(`${rel}: ${(r.stderr || r.stdout || '').trim().split(/\r?\n/)[0]}`);
  }
  record(
    run,
    'typecheck',
    'typecheck.js_syntax',
    failures.length === 0,
    failures.length === 0
      ? `${files.length} 个 JS/MJS 文件语法通过（仓库无 tsconfig）`
      : failures.join(' | ')
  );
}

function stageLint(run) {
  const diffCheck = runGit(['diff', '--check', 'HEAD']);
  record(
    run,
    'lint',
    'lint.whitespace',
    diffCheck.status === 0,
    diffCheck.status === 0 ? 'diff 无空白错误' : String(diffCheck.stdout || diffCheck.stderr || '').slice(0, 300)
  );

  const debuggerHits = [];
  for (const rel of ['server.js', ...walkFiles('src')]) {
    if (!/\.(m?js|ts)$/.test(rel)) continue;
    const text = readFileSync(P(rel), 'utf8');
    if (/\bdebugger\b/.test(text)) debuggerHits.push(rel);
  }
  record(
    run,
    'lint',
    'lint.no_debugger',
    debuggerHits.length === 0,
    debuggerHits.length === 0 ? '没有 debugger 语句' : debuggerHits.join(', ')
  );
}

function stageUnit(run) {
  const vitest = P('node_modules/vitest/vitest.mjs');
  const r = existsSync(vitest)
    ? runCommand(process.execPath, [vitest, 'run', '--reporter=basic'])
    : runCommand('pnpm', ['test']);
  const lines = String(`${r.stdout || ''}\n${r.stderr || ''}`)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const summary = lines.find((s) => /Tests?\s+\d+|failed|passed/i.test(s)) || lines.at(-1) || '';
  record(
    run,
    'unit',
    'unit.vitest',
    r.status === 0,
    r.status === 0 ? summary.slice(0, 300) : summary.slice(0, 300) || 'vitest 失败'
  );
}

function flattenKeys(value, prefix = '', out = []) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      flattenKeys(child, prefix ? `${prefix}.${key}` : key, out);
    }
  } else {
    out.push(prefix);
  }
  return out;
}

function stageI18nParity(run) {
  const dir = P('locales');
  const files = existsSync(dir)
    ? readdirSync(dir).filter((name) => name.endsWith('.json') && !name.startsWith('.'))
    : [];
  if (files.length <= 1) {
    record(run, 'i18n_parity', 'i18n_parity.single_locale', true, files.length === 0 ? '无 locale 文件，按单语言通过' : `只有 ${files[0]}，按单语言通过`);
    return;
  }
  const keySets = new Map();
  for (const name of files) {
    let parsed = {};
    try {
      const raw = readFileSync(join(dir, name), 'utf8').trim();
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      record(run, 'i18n_parity', `i18n_parity.${name}`, false, `${name} 不是合法 JSON`);
      continue;
    }
    keySets.set(name, new Set(flattenKeys(parsed)));
  }
  const base = [...keySets.keys()].sort()[0];
  const missing = [];
  for (const [name, keys] of keySets) {
    if (name === base) continue;
    for (const key of keySets.get(base)) {
      if (!keys.has(key)) missing.push(`${name}:${key}`);
    }
  }
  record(run, 'i18n_parity', 'i18n_parity.key_parity', missing.length === 0, missing.length === 0 ? `${files.length} 个 locale 键一致` : missing.slice(0, 10).join(', '));
}

function stageBuild(run) {
  const required = ['index.html', 'server.js'];
  const problems = [];
  for (const rel of required) {
    if (!existsSync(P(rel)) || statSync(P(rel)).size === 0) problems.push(`${rel} 缺失或为空`);
  }
  const syntax = runCommand(process.execPath, ['--check', 'server.js']);
  if (syntax.status !== 0) problems.push('server.js 语法失败');
  const bidIndex = 'src/bid/index.mjs';
  if (existsSync(P(bidIndex))) {
    const r = runCommand(process.execPath, ['--check', bidIndex]);
    if (r.status !== 0) problems.push('src/bid/index.mjs 语法失败');
  }
  record(
    run,
    'build',
    'build.static_entry',
    problems.length === 0,
    problems.length === 0 ? '静态入口与 server.js 语法通过' : problems.join(' | ')
  );
}

function stageSecurity(run) {
  const patterns = [
    { id: 'eval', re: /\beval\s*\(/ },
    { id: 'new-function', re: /\bnew\s+Function\s*\(/ },
    { id: 'tls-disabled', re: /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0/ },
    { id: 'private-key', re: /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/ },
    { id: 'aws-key', re: /AKIA[0-9A-Z]{16}/ },
    { id: 'openai-key', re: /\bsk-[A-Za-z0-9]{20,}/ }
  ];
  const files = ['server.js', ...walkFiles('src'), 'index.html', 'login.html', 'register.html', 'admin.html'].filter((rel) => existsSync(P(rel)));
  const hits = [];
  for (const rel of files) {
    const text = readFileSync(P(rel), 'utf8');
    for (const p of patterns) {
      if (p.re.test(text)) hits.push(`${rel}:${p.id}`);
    }
  }
  record(run, 'security', 'security.no_secret_or_eval', hits.length === 0, hits.length === 0 ? `${files.length} 个文件未命中危险模式` : hits.join(', '));
}

// ---------------- 阶段 1：配置预检（不依赖 ajv / 不联网） ----------------

function stageSchema(run, ctx) {
  const { cfg, pricing } = ctx;
  const { policy } = cfg;
  const taskCap = dig(policy, 'budget.task.max_cost_cny');
  const dailyCap = dig(policy, 'budget.daily.max_cost_cny');
  const callCap = dig(policy, 'budget.circuit_breaker.single_call_max_cny');

  record(run, 'schema', 'policy.budget.task.max_cost_cny', isNum(taskCap) && taskCap > 0, `单任务上限 ${cny(taskCap)}`);
  record(run, 'schema', 'policy.budget.daily.max_cost_cny', isNum(dailyCap) && dailyCap > 0, `单日上限 ${cny(dailyCap)}`);
  record(run, 'schema', 'policy.budget.circuit_breaker.single_call_max_cny', isNum(callCap) && callCap > 0, `单笔熔断 ${cny(callCap)}`);
  record(
    run,
    'schema',
    'budget.task_le_daily',
    isNum(taskCap) && isNum(dailyCap) && round6(taskCap) <= round6(dailyCap),
    `单任务 ${cny(taskCap)} <= 单日 ${cny(dailyCap)}`
  );
  record(
    run,
    'schema',
    'policy.models.provider_locked',
    policy.models?.router_locked === true && policy.models?.require_single_provider === true && typeof policy.models?.provider === 'string',
    `供应商锁 ${policy.models?.provider ?? 'n/a'}`
  );
  const protectedPaths = Array.isArray(policy.protected_paths) ? policy.protected_paths : [];
  const selfProtected = protectedPaths.includes('scripts/verify.mjs') && protectedPaths.includes('chain/**');
  record(run, 'schema', 'policy.protected_paths.self_guard', selfProtected, `保护 ${protectedPaths.length} 条，含 chain/** 与 scripts/verify.mjs`);

  record(run, 'schema', 'pricing.schema_version', pricing.schema_version === 1, `schema_version=${pricing.schema_version}`);
  record(
    run,
    'schema',
    'pricing.units',
    pricing.default_currency === 'CNY' && pricing.unit_basis === 'per_1m_tokens',
    `${pricing.default_currency} / ${pricing.unit_basis}`
  );
  record(
    run,
    'schema',
    'pricing.fallback',
    ['reject_call', 'use_max_price'].includes(pricing.fallback?.strategy),
    `缺失型号策略 ${pricing.fallback?.strategy}`
  );

  const versions = Array.isArray(pricing.pricing_versions) ? pricing.pricing_versions : [];
  const current = [...versions].sort((a, b) => String(b.effective_from).localeCompare(String(a.effective_from)))[0];
  record(run, 'schema', 'pricing.version_present', Boolean(current), current ? `${current.pricing_version}（生效 ${current.effective_from}）` : '无价格版本');
  if (!current) return;

  if (versions[0] && current.pricing_version !== versions[0].pricing_version) {
    warn(run, 'pricing.version_order', `pricing_versions[0]=${versions[0].pricing_version} 不是最新版本，按数组顺序取值可能用错单价`);
  }
  record(
    run,
    'schema',
    'pricing.provider_matches_policy',
    current.provider === policy.models?.provider,
    `价格表 ${current.provider} / policy ${policy.models?.provider}`
  );

  const models = Array.isArray(current.models) ? current.models : [];
  const badPrice = models.filter(
    (m) =>
      !isNum(m.input_cache_hit_per_1m) ||
      !isNum(m.input_cache_miss_per_1m) ||
      !isNum(m.output_per_1m) ||
      m.input_cache_hit_per_1m < 0 ||
      m.input_cache_miss_per_1m < 0 ||
      m.output_per_1m < 0
  );
  record(run, 'schema', 'pricing.model_price_numeric', models.length > 0 && badPrice.length === 0, `${models.length} 个型号，非法单价 ${badPrice.length} 个`);

  const routeModels = Object.entries(policy.models?.routes || {})
    .filter(([, r]) => r && r.provider)
    .map(([k, r]) => [k, r.model]);
  const priced = new Set(models.map((m) => m.model));
  const unpriced = routeModels.filter(([, m]) => !priced.has(m));
  record(
    run,
    'schema',
    'pricing.covers_routes',
    unpriced.length === 0,
    unpriced.length === 0 ? `${routeModels.length} 条路由全部定价` : `未定价：${unpriced.map(([k, m]) => `${k}->${m}`).join(', ')}`
  );

  const verified = current.verified;
  record(run, 'schema', 'pricing.verified_flag', typeof verified === 'boolean', `verified=${verified}`);
  if (verified === true) {
    record(
      run,
      'schema',
      'pricing.verified_at',
      typeof current.verified_at === 'string' && TIMESTAMP_RE.test(current.verified_at),
      `verified=true 必须有合法 verified_at，实际 ${JSON.stringify(current.verified_at ?? null)}`
    );
  } else {
    warn(run, 'pricing.unverified', `价格表 ${current.pricing_version} 未与官方价格页核对（verified=false），成本估算仅供预估；核对后运行 --mark-pricing-verified --by <人>`);
  }
}

// 任务卡与报告漂移独立成段：pricing 无版本时提前 return 也不影响这里
function stageTaskCard(run, ctx) {
  const { cfg, card, report } = ctx;
  const { policy } = cfg;
  const taskCap = dig(policy, 'budget.task.max_cost_cny');
  const dailyCap = dig(policy, 'budget.daily.max_cost_cny');

  const cardCap = dig(card.front, 'budget.max_cost_cny');
  record(run, 'schema', 'task.budget.max_cost_cny', isNum(cardCap) && cardCap > 0, `任务卡单任务上限 ${cny(cardCap)}`);
  record(
    run,
    'schema',
    'task.budget_le_policy',
    isNum(cardCap) && isNum(taskCap) && round6(cardCap) <= round6(taskCap),
    `任务卡 ${cny(cardCap)} <= policy ${cny(taskCap)}`
  );
  record(
    run,
    'schema',
    'task.bidding.bid_dir',
    typeof card.bidding.bid_dir === 'string' && card.bidding.bid_dir.length > 0,
    String(card.bidding.bid_dir)
  );

  const declaredIds = new Set((ctx.book.invariants || []).map((i) => i.id));
  const cardInv = Array.isArray(card.front.invariants) ? card.front.invariants : [];
  const missing = cardInv.filter((id) => !declaredIds.has(id));
  record(
    run,
    'schema',
    'task.invariants_declared',
    missing.length === 0,
    missing.length ? `未在 ${cfg.paths.invariants} 登记：${missing.join(', ')}` : `${cardInv.length} 条已登记`
  );

  const status = card.front.status;
  const appr = card.front.human_approval || {};
  const filled = ['approved_by', 'approved_at', 'task_sha256'].filter((k) => appr[k] !== null && appr[k] !== undefined && appr[k] !== '');
  record(
    run,
    'schema',
    'task.human_approval_consistent',
    status === 'confirmed' ? filled.length === 3 : true,
    `status=${status}，human_approval 已填 ${filled.length}/3`
  );
  if (status !== 'confirmed' && filled.length > 0) {
    warn(run, 'task.approval_partial', `status=${status} 但 human_approval 已填 ${filled.join(',')}，确认状态不一致`);
  }
  if (status === 'draft') {
    warn(run, 'task.draft', `${card.rel} 仍为 draft，配置可跑但不可据此开始施工（任务卡需人工确认）`);
  }

  if (report.data) {
    const lim = report.data.limits || {};
    const src = report.data.sources || {};
    const drift = [];
    if (lim.task_max_cny !== cardCap) drift.push(`limits.task_max_cny=${lim.task_max_cny} != 任务卡 ${cardCap}`);
    if (lim.daily_max_cny !== dailyCap) drift.push(`limits.daily_max_cny=${lim.daily_max_cny} != policy ${dailyCap}`);
    if (src.pricing !== cfg.paths.pricing) drift.push(`sources.pricing=${src.pricing} != ${cfg.paths.pricing}`);
    record(run, 'schema', 'report.no_drift', drift.length === 0, drift.length ? drift.join('；') : `${report.rel} 与 policy/任务卡一致`);
  }
}

// ---------------- 阶段 2：不变量（纯函数，便于 --self-test 注入反例） ----------------

function evalPerTaskBudget(chk, d) {
  const field = chk.bid_field || 'quote_cny';
  const cap = Math.min(Number(d.taskCap), Number(d.policyCap));
  const bad = [];
  if (!isNum(d.taskCap) || !isNum(d.policyCap)) bad.push('任务卡或 policy 的单任务上限缺失/非数值');
  else if (round6(d.taskCap) > round6(d.policyCap)) bad.push(`任务卡 budget.max_cost_cny=${cny(d.taskCap)} 超过 policy ${cny(d.policyCap)}`);

  // bids/ 是投标池，含被判废的报价：超限本身不是违规（不发生花费），超限却未被判废才是（评审漏判）
  const dq = d.disqualifiedIds instanceof Set ? d.disqualifiedIds : new Set();
  let overCap = 0;
  for (const { file, bid } of d.bids) {
    const id = bid?.bid_id ?? null;
    const v = dig(bid, field);
    if (!isNum(v)) {
      // 关键：缺失字段不得放行（禁止 undefined/NaN 参与比较后「恒过」）
      if (!dq.has(id)) bad.push(`${file}: ${field} 缺失或非数值（${JSON.stringify(v ?? null)}），且未被评审判废`);
      continue;
    }
    if (round6(v) > round6(cap)) {
      overCap++;
      if (d.reportExists && !dq.has(id)) {
        bad.push(`${file}: ${field}=${cny(v)} > 上限 ${cny(cap)}，但未出现在报告 disqualified 中（评审漏判）`);
      }
    }
  }
  if (isNum(d.winnerQuote) && round6(d.winnerQuote) > round6(cap)) {
    bad.push(`中标报价 ${cny(d.winnerQuote)} > 上限 ${cny(cap)}`);
  }

  const note = `${d.bids.length} 份投标，上限 ${cny(cap)}` + (overCap ? `，其中 ${overCap} 份超限` : '');
  const status = bad.length ? 'failed' : d.reportExists && d.bids.length ? 'passed' : 'uncovered';
  return { status, bad, note };
}

function evalDailyBudget(chk, d) {
  const cap = Number(d.dailyCap);
  const bad = [];
  let amount;
  let note;
  if (chk.amount_from === 'all_quotes') {
    amount = round6(d.allQuotes);
    note = `全部投标报价之和 ${cny(amount)} + 当日已花 ${cny(d.spent)}`;
  } else {
    if (!isNum(d.winnerQuote)) return { status: 'uncovered', bad, note: '无中标结果（报告缺失或无合格投标），当日花费不可判定' };
    amount = round6(d.winnerQuote);
    note = `中标报价 ${cny(amount)} + 当日已花 ${cny(d.spent)}（来源 ${d.spentSource}）`;
  }
  const total = round6(amount + Number(d.spent));
  if (!isNum(cap)) bad.push('policy.budget.daily.max_cost_cny 缺失/非数值');
  else if (total > round6(cap)) bad.push(`当日合计 ${cny(total)} > 上限 ${cny(cap)}`);
  return { status: bad.length ? 'failed' : 'passed', bad, note, total };
}

function evalScoreRange(chk, d) {
  if (!d.reportExists) return { status: 'uncovered', bad: [], note: '评审报告不存在，评分区间不可判定' };
  const min = isNum(chk.min) ? chk.min : 0;
  const max = isNum(chk.max) ? chk.max : 1;
  const paths = Array.isArray(chk.score_paths) ? chk.score_paths : [];
  const bad = [];
  let count = 0;
  for (const row of d.ranking) {
    for (const p of paths) {
      const key = String(p).replace(/^ranking\[\]\./, '');
      const v = dig(row, key);
      count++;
      if (!isNum(v)) bad.push(`ranking[${row.rank}].${key}=${JSON.stringify(v ?? null)} 非数值`);
      else if (v < min || v > max) bad.push(`ranking[${row.rank}].${key}=${v} 超出 [${min}, ${max}]`);
    }
  }
  return { status: bad.length ? 'failed' : count ? 'passed' : 'uncovered', bad, note: `校验 ${count} 个分值` };
}

const EVALUATORS = {
  per_task_budget: evalPerTaskBudget,
  daily_budget: evalDailyBudget,
  score_range: evalScoreRange
};

function stageInvariant(run, ctx) {
  const { cfg, book, card, bids, spent, report } = ctx;
  const onlyIds = ctx.onlyIds || null;
  if (bids.parse_errors.length > 0) {
    record(run, 'invariant', 'bids.parsable', false, bids.parse_errors.map((p) => `${p.file}: ${p.reason}`).join('；'));
  }
  if (!bids.exists) warn(run, 'bids.dir_missing', `投标目录 ${bids.dir} 不存在，不变量按 uncovered 处理`);

  const ranking = Array.isArray(report.data?.ranking) ? report.data.ranking : [];
  const quotes = bids.bids.map((b) => dig(b.bid, 'quote_cny')).filter(isNum);
  const disqualifiedIds = new Set((report.data?.disqualified || []).map((x) => x?.bid_id).filter(Boolean));
  const data = {
    bids: bids.bids,
    taskCap: dig(card.front, 'budget.max_cost_cny'),
    policyCap: dig(cfg.policy, 'budget.task.max_cost_cny'),
    dailyCap: dig(cfg.policy, 'budget.daily.max_cost_cny'),
    spent: spent.spent,
    spentSource: spent.source,
    winnerQuote: ranking.length ? ranking[0].quote_cny : null,
    allQuotes: round6(quotes.reduce((a, b) => a + b, 0)),
    ranking,
    disqualifiedIds,
    reportExists: Boolean(report.data)
  };

  const declared = book.invariants || [];
  if (onlyIds) {
    const unknownIds = [...onlyIds].filter((id) => !declared.some((x) => x.id === id));
    if (unknownIds.length) {
      throw new VerifyError('invalid_config', `--only 指定的不变量未在 ${cfg.paths.invariants} 声明：${unknownIds.join(', ')}`);
    }
  }

  for (const inv of declared) {
    if (onlyIds && !onlyIds.has(inv.id)) continue;
    const chk = inv.check || {};
    const fn = EVALUATORS[chk.kind];
    const severity = chk.severity === 'warn' ? 'warn' : 'fail';
    if (!fn) {
      record(run, 'invariant', inv.id, false, `unsupported_check：${chk.kind}（未实现即不放行）`);
      run.invariants.push({ id: inv.id, title: inv.title || '', status: 'failed', note: '', detail: `unsupported_check ${chk.kind}` });
      continue;
    }
    const r = fn(chk, data);
    run.invariants.push({ id: inv.id, title: inv.title || '', status: r.status, note: r.note, detail: r.bad.join(' | ') });
    if (r.status === 'failed') record(run, 'invariant', inv.id, false, `${r.note}：${r.bad.join(' | ')}`, severity);
    else if (r.status === 'uncovered') record(run, 'invariant', inv.id, false, `uncovered：${r.note}`, 'warn');
    else record(run, 'invariant', inv.id, true, r.note);

    if (chk.kind === 'daily_budget' && chk.exposure_warn === true) {
      const exposure = round6(data.allQuotes + Number(data.spent));
      if (isNum(data.dailyCap) && exposure > round6(data.dailyCap)) {
        warn(
          run,
          `${inv.id}.exposure`,
          `全部投标报价之和 ${cny(data.allQuotes)} + 当日已花 ${cny(data.spent)} = ${cny(exposure)} 超过单日上限 ${cny(data.dailyCap)}；`
            + '敞口指标（同时兑现全部合同才会发生），不构成违规；若要求报价合计也不得超限，把 check.amount_from 改为 all_quotes'
        );
      }
    }
  }

  if (declared.length === 0) record(run, 'invariant', 'invariants.present', false, `${cfg.paths.invariants} 未声明任何不变量`);
}

// ---------------- 自检：证明闸门不是空壳 ----------------

const MIN_NEGATIVE_CASES = 5;

function selfTest() {
  const out = [];
  // negative=true 的用例断言「闸门必须报红」，用来证明闸门不是空壳；--negative-test 只跑这些
  const ok = (name, cond) => out.push({ name, ok: Boolean(cond), negative: false });
  const neg = (name, cond) => out.push({ name, ok: Boolean(cond), negative: true });
  const bid = (file, quote, id = 'B1') => ({ file, bid: quote === '__omit__' ? { bid_id: id } : { quote_cny: quote, bid_id: id } });
  const base = { bids: [], taskCap: 8, policyCap: 8, dailyCap: 8, spent: 0, spentSource: 'state', winnerQuote: 4, allQuotes: 4, ranking: [], reportExists: true };
  const c1 = { kind: 'per_task_budget', bid_field: 'quote_cny' };

  neg('INV-001 超上限且未被判废必须失败', evalPerTaskBudget(c1, { ...base, bids: [bid('a.json', 9)] }).status === 'failed');
  ok('INV-001 超上限但已判废视为合规', evalPerTaskBudget(c1, { ...base, disqualifiedIds: new Set(['B1']), bids: [bid('a.json', 9)] }).status === 'passed');
  ok('INV-001 报价等于上限视为合规', evalPerTaskBudget(c1, { ...base, bids: [bid('a.json', 8)] }).status === 'passed');
  neg('INV-001 字段缺失且未被判废必须失败', evalPerTaskBudget(c1, { ...base, bids: [bid('a.json', '__omit__')] }).status === 'failed');
  neg('INV-001 中标报价超上限必须失败', evalPerTaskBudget(c1, { ...base, bids: [bid('a.json', 1)], winnerQuote: 9 }).status === 'failed');
  neg('INV-001 任务卡额度超 policy 必须失败', evalPerTaskBudget(c1, { ...base, taskCap: 9, bids: [bid('a.json', 1)] }).status === 'failed');

  const c2 = { kind: 'daily_budget', amount_from: 'winner' };
  neg('INV-002 已花+中标超单日必须失败', evalDailyBudget(c2, { ...base, spent: 5, winnerQuote: 4 }).status === 'failed');
  ok('INV-002 恰好等于上限视为合规', evalDailyBudget(c2, { ...base, spent: 4, winnerQuote: 4 }).status === 'passed');
  ok('INV-002 无中标结果记 uncovered', evalDailyBudget(c2, { ...base, winnerQuote: null }).status === 'uncovered');

  const c3 = { kind: 'score_range', score_paths: ['ranking[].scores.price', 'ranking[].total'], min: 0, max: 1 };
  const row = (p, t) => ({ rank: 1, scores: { price: p }, total: t });
  neg('INV-003 分值 >1 必须失败', evalScoreRange(c3, { ...base, reportExists: true, ranking: [row(1, 1.2)] }).status === 'failed');
  neg('INV-003 负分必须失败', evalScoreRange(c3, { ...base, reportExists: true, ranking: [row(-0.1, 0.5)] }).status === 'failed');
  ok('INV-003 0 与 1 边界视为合规', evalScoreRange(c3, { ...base, reportExists: true, ranking: [row(0, 1)] }).status === 'passed');
  ok('INV-003 报告缺失记 uncovered', evalScoreRange(c3, { ...base, reportExists: false, ranking: [] }).status === 'uncovered');
  return out;
}

// --negative-test：只跑「必须报红」的用例，并卡住用例数量，防止有人把反例删光了还显示全绿
function negativeTest() {
  const all = selfTest();
  const neg = all.filter((r) => r.negative);
  console.log('反例测试（断言闸门必须把坏输入判失败）:');
  for (const r of neg) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  const bad = neg.filter((r) => !r.ok).length;
  if (neg.length < MIN_NEGATIVE_CASES) {
    console.log(`  覆盖不足：反例只有 ${neg.length} 条，至少需要 ${MIN_NEGATIVE_CASES} 条（不得为了变绿而删反例）`);
    return EXIT.failed;
  }
  console.log(bad ? `反例失败 ${bad} 项：闸门对坏输入没有报红` : `反例全部按预期拦截（${neg.length}/${neg.length}）`);
  return bad ? EXIT.failed : EXIT.ok;
}

// --regression：同一输入连跑两遍，断言结果逐字节一致（无时间/无随机/无顺序依赖）
function regressionTest(taskId, bidsDir) {
  const stages = ['schema', 'invariant'];
  const first = runVerify({ taskId, stages, bidsDir, onlyIds: null });
  const second = runVerify({ taskId, stages, bidsDir, onlyIds: null });
  const snap = (x) => JSON.stringify({ checks: x.run.checks, invariants: x.run.invariants, warnings: x.run.warnings, ran: x.ran, skipped: x.skipped });
  const render = (x) => renderText(x.run, x.ctx, { ran: x.ran, skipped: x.skipped, ciViolations: [], ok: true, only: null });
  const rows = [
    { name: '两次运行的检查项/不变量/告警快照完全一致', ok: snap(first) === snap(second) },
    { name: '两次运行的文本输出逐字节一致', ok: render(first) === render(second) },
    { name: '两次运行的违规数量一致（无累积/无双重计数）', ok: failures(first.run).length === failures(second.run).length }
  ];
  console.log('稳定性回归（同一输入连跑两遍）:');
  for (const r of rows) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  console.log(`  基线：${first.run.checks.length} 项检查 / ${first.run.invariants.length} 条不变量 / ${first.run.warnings.length} 条告警 / 违规 ${failures(first.run).length} 项`);
  const bad = rows.filter((r) => !r.ok).length;
  if (bad) {
    console.log('  失败：结果不确定，说明有当前时间、随机数或文件系统顺序参与了判定（本产物不能用于 CI 门禁）');
    return EXIT.failed;
  }
  console.log('回归通过：结果确定，可作为门禁');
  return EXIT.ok;
}

// --check-json：全仓 JSON 语法体检（含 BOM、空文件），不校验业务语义
const JSON_SKIP_DIRS = new Set(['node_modules', '.git', '.worktrees', 'dist', 'build', 'coverage', '.next', '.turbo']);

function walkJson(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      if (!JSON_SKIP_DIRS.has(entry.name)) walkJson(join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

function checkJson() {
  const files = walkJson(ROOT);
  const bad = [];
  const empty = [];
  for (const abs of files) {
    const rel = abs.slice(ROOT.length + 1).split('\\').join('/');
    let raw;
    try {
      raw = readFileSync(abs, 'utf8');
    } catch (e) {
      bad.push({ rel, reason: `读取失败：${e.message}` });
      continue;
    }
    // 空文件不是语法错误（chain/state.json 空=empty_state 是既定语义），只提示，由各阶段语义检查负责
    if (raw.trim() === '') {
      empty.push(rel);
      continue;
    }
    if (raw.charCodeAt(0) === 0xfeff) {
      bad.push({ rel, reason: '带 UTF-8 BOM，JSON.parse 会直接抛错' });
      continue;
    }
    try {
      JSON.parse(raw);
    } catch (e) {
      bad.push({ rel, reason: e.message });
    }
  }
  const checked = files.length - empty.length;
  console.log(
    `[json] ${bad.length ? 'FAIL' : 'PASS'}  ${checked - bad.length}/${checked} 个非空 JSON 文件语法合法`
      + `${empty.length ? `，另有 ${empty.length} 个空占位文件（不计入语法判定）` : ''}`
  );
  for (const b of bad) console.log(`  × ${b.rel}: ${b.reason}`);
  for (const rel of empty) console.log(`  · 空占位 ${rel}`);
  return bad.length ? EXIT.failed : EXIT.ok;
}

// ---------------- 渲染 ----------------

function renderText(run, ctx, plan) {
  const { cfg, book, card, bids, spent, report, pricing } = ctx;
  const L = [];
  const versions = Array.isArray(pricing.pricing_versions) ? pricing.pricing_versions : [];
  const current = [...versions].sort((a, b) => String(b.effective_from).localeCompare(String(a.effective_from)))[0] || {};
  L.push('');
  L.push(`verify  task=${run.task_id}  任务卡 ${card.rel}（${card.front.status}）`);
  L.push(
    `边界  单任务 ${cny(dig(cfg.policy, 'budget.task.max_cost_cny'))} / 单日 ${cny(dig(cfg.policy, 'budget.daily.max_cost_cny'))}`
      + ` / 单笔 ${cny(dig(cfg.policy, 'budget.circuit_breaker.single_call_max_cny'))}   当日已花 ${cny(spent.spent)}（${spent.source}）`
  );
  L.push(
    `配置  ${cfg.paths.invariants} ${(book.invariants || []).length} 条 · 价格表 ${current.pricing_version}（verified=${current.verified}）`
      + ` · 投标 ${bids.bids.length} 份（${bids.dir}${bids.exists ? '' : '，目录不存在'}）· 报告 ${report.data ? '已生成' : '未生成'}`
  );
  if (plan.only && plan.only.length) {
    L.push(`范围  仅判定 ${plan.only.join(', ')}（--only 过滤：其余不变量本次不判定，结果不得作为门禁）`);
  }
  L.push('');
  for (const s of plan.ran) {
    const list = run.checks.filter((c) => c.stage === s);
    const bad = list.filter((c) => !c.ok && c.severity === 'fail').length;
    const soft = list.filter((c) => !c.ok && c.severity === 'warn').length;
    L.push(`[${s}] ${bad ? 'FAIL' : 'PASS'}  ${list.length - bad - soft}/${list.length} 项通过${soft ? `，${soft} 项降级告警` : ''}`);
    if (s === 'invariant') {
      for (const inv of run.invariants) {
        L.push(`  ${inv.id}  ${String(inv.status).padEnd(9)} ${String(inv.title).padEnd(8)} ${inv.note || ''}${inv.detail ? ` → ${inv.detail}` : ''}`);
      }
    } else {
      for (const c of list.filter((x) => !x.ok && x.severity === 'fail')) L.push(`  × ${c.id}: ${c.detail}`);
    }
  }
  if (plan.skipped.length) {
    L.push('');
    L.push(`跳过 ${plan.skipped.length} 个阶段（未实现，不计为通过）：`);
    for (const s of plan.skipped) L.push(`  ${s.padEnd(14)} ${STAGE_PENDING[s] || '未实现'}`);
  }
  if (run.warnings.length) {
    L.push('');
    L.push(`告警 ${run.warnings.length} 条：`);
    for (const w of run.warnings) L.push(`  · ${w.id}  ${w.detail}`);
  }
  if (plan.ciViolations.length) {
    L.push('');
    for (const v of plan.ciViolations) L.push(`  ! ${v}`);
  }
  L.push('');
  L.push(
    `结果：${plan.ok ? 'PASSED' : 'FAILED'}（${failures(run).length} 项违规，${run.warnings.length} 条告警，实跑阶段 ${plan.ran.length} 个）`
  );
  L.push('本结果由确定性脚本产出，未调用任何大模型');
  return L.join('\n');
}

// ---------------- 编排 ----------------

function validateBook(book, rel) {
  if (book.schema_version !== 1) throw new VerifyError('invalid_config', `${rel}: schema_version 必须为 1`);
  if (!Array.isArray(book.invariants) || book.invariants.length === 0) throw new VerifyError('invalid_config', `${rel}: invariants 必须是非空数组`);
  const seen = new Set();
  for (const inv of book.invariants) {
    const id = String(inv?.id ?? '');
    if (!/^INV-[0-9]{3}$/.test(id)) throw new VerifyError('invalid_config', `${rel}: 非法不变量 id ${JSON.stringify(inv?.id ?? null)}`);
    if (seen.has(id)) throw new VerifyError('invalid_config', `${rel}: 不变量 id 重复 ${id}`);
    seen.add(id);
    if (!inv.check || typeof inv.check !== 'object') throw new VerifyError('invalid_config', `${rel}: ${id} 缺少 check`);
    if (typeof inv.check.kind !== 'string') throw new VerifyError('invalid_config', `${rel}: ${id} 的 check.kind 必须为字符串`);
    const sev = inv.check.severity ?? 'fail';
    if (sev !== 'fail' && sev !== 'warn') throw new VerifyError('invalid_config', `${rel}: ${id} severity 只能是 fail/warn，实际 ${sev}`);
  }
  return book;
}

function runVerify({ taskId, stages, bidsDir, onlyIds = null }) {
  const cfg = loadConfig();
  const book = validateBook(readJson(cfg.paths.invariants), cfg.paths.invariants);
  const pricing = readJson(cfg.paths.pricing);
  const card = parseTaskCard(`${cfg.paths.tasksDir}/${taskId}.md`);
  const dailyCap = dig(cfg.policy, 'budget.daily.max_cost_cny');
  const spent = loadDailySpent(cfg.paths.state, dailyCap);
  const bids = loadBids(bidsDir || card.bidding.bid_dir || `bids/${taskId}`);
  const report = loadReport(cfg.paths.reportsDir, taskId);
  const ctx = { cfg, book, card, pricing, bids, spent, report, onlyIds };
  const run = createRun(taskId);
  const ran = [];
  const skipped = [];
  for (const s of stages) {
    if (!IMPLEMENTED_STAGES.has(s)) {
      skipped.push(s);
      continue;
    }
    if (s === 'schema') {
      stageSchema(run, ctx);
      stageTaskCard(run, ctx);
    } else if (s === 'scope') {
      stageScope(run, ctx);
    } else if (s === 'test_integrity') {
      stageTestIntegrity(run, ctx);
    } else if (s === 'typecheck') {
      stageTypecheck(run);
    } else if (s === 'lint') {
      stageLint(run);
    } else if (s === 'unit') {
      stageUnit(run);
    } else if (s === 'invariant') {
      stageInvariant(run, ctx);
    } else if (s === 'i18n_parity') {
      stageI18nParity(run);
    } else if (s === 'build') {
      stageBuild(run);
    } else if (s === 'security') {
      stageSecurity(run);
    }
    ran.push(s);
  }
  return { run, ctx, ran, skipped };
}

function markPricingVerified() {
  if (flag('--ci')) {
    console.error('[verify] --ci 下禁止改写 chain/pricing.json：验收入口不得自证定价');
    return EXIT.config;
  }
  const by = opt('--by');
  if (!by) {
    console.error('[verify] --mark-pricing-verified 必须带 --by <核对人>，否则无法追溯是谁核对了官方价格页');
    return EXIT.config;
  }
  const cfg = loadConfig();
  const rel = cfg.paths.pricing;
  const pricing = readJson(rel);
  const versions = Array.isArray(pricing.pricing_versions) ? pricing.pricing_versions : [];
  if (versions.length === 0) throw new VerifyError('invalid_config', `${rel} 无价格版本`);
  const target = [...versions].sort((a, b) => String(b.effective_from).localeCompare(String(a.effective_from)))[0];
  target.verified = true;
  target.verified_at = new Date().toISOString();
  target.verified_by = by;
  writeFileSync(P(rel), JSON.stringify(pricing, null, 2) + '\n', 'utf8');
  console.log(`已标记 ${rel} 中 ${target.pricing_version} 为 verified=true`);
  console.log(`  verified_at=${target.verified_at}  verified_by=${by}`);
  console.log('注意：本操作只记录「谁在何时声称核对」，不校验单价本身；请确认已对照官方价格页。');
  return EXIT.ok;
}

// --only 只接受 INV-xxx，用于本地定位单个不变量；返回 Set / null（未指定）/ false（用法错误）
function parseOnly() {
  const raw = opt('--only');
  if (!raw) return null;
  const ids = raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (ids.length === 0) {
    console.error('[verify] --only 需要至少一个不变量 id，例如 --only INV-001,INV-002');
    return false;
  }
  const bad = ids.filter((id) => !/^INV-[0-9]{3}$/.test(id));
  if (bad.length) {
    console.error(`[verify] --only 只接受 INV-数字三位，非法：${bad.join(', ')}`);
    return false;
  }
  return new Set(ids);
}

const USAGE = `
scripts/verify.mjs —— 验收入口（底层不变量 + 配置预检）

用法：
  node scripts/verify.mjs                                     全部阶段（未实现的显式 skipped，不计通过）
  node scripts/verify.mjs --task T-001                        指定任务卡
  node scripts/verify.mjs --stages schema,invariant           只跑指定阶段（--stage 同义）
  node scripts/verify.mjs --stages invariant --only INV-001   只判定指定不变量（本地定位用，不得作门禁）
  node scripts/verify.mjs --strict                            告警升级为失败
  node scripts/verify.mjs --ci                                CI 模式：要求全部阶段实跑且无告警
  node scripts/verify.mjs --json                              机器可读输出
  node scripts/verify.mjs --bids bids/T-001                   覆盖投标目录
  node scripts/verify.mjs --self-test                         自检闸门本身（正例 + 反例）
  node scripts/verify.mjs --negative-test                     只跑反例：断言坏输入必被判失败
  node scripts/verify.mjs --regression                        连跑两遍，断言结果逐字节一致
  node scripts/verify.mjs --check-json                        全仓 JSON 语法体检（含 BOM / 空文件）
  node scripts/verify.mjs --mark-pricing-verified --by 张三   人工核对价格页后登记（--ci 下禁用）

已实现阶段：schema、invariant；其余阶段显式 skipped 并说明缺什么，绝不假装通过。
退出码：0 通过 / 1 存在违规 / 2 用法或配置错误。
`;

export function main() {
  try {
    if (flag('--help')) {
      console.log(USAGE);
      return EXIT.ok;
    }
    if (flag('--self-test')) {
      const results = selfTest();
      console.log('自检:');
      for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.negative ? '[反例] ' : ''}${r.name}`);
      const bad = results.filter((r) => !r.ok).length;
      const negOk = results.filter((r) => r.negative && r.ok).length;
      console.log(bad ? `自检失败 ${bad} 项` : `自检全部通过（${results.length} 项，其中反例 ${negOk} 条）`);
      return bad ? EXIT.failed : EXIT.ok;
    }
    if (flag('--negative-test')) return negativeTest();
    if (flag('--check-json')) return checkJson();
    if (flag('--mark-pricing-verified')) return markPricingVerified();

    const taskId = opt('--task', 'T-001');
    const bidsDir = opt('--bids');
    if (flag('--regression')) return regressionTest(taskId, bidsDir);

    const stagesArg = opt('--stages') || opt('--stage');
    const rawStages = stagesArg || ALL_STAGES.join(',');
    const stages = rawStages
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const unknown = stages.filter((s) => !ALL_STAGES.includes(s));
    if (unknown.length) {
      console.error(`[verify] 未知阶段：${unknown.join(', ')}`);
      console.error(`[verify] 合法阶段：${ALL_STAGES.join(', ')}`);
      return EXIT.config;
    }

    const ci = flag('--ci');
    const strict = flag('--strict') || ci;
    const onlyIds = parseOnly();
    if (onlyIds === false) return EXIT.config;
    if (onlyIds) {
      if (ci || strict) {
        console.error('[verify] --only 只用于本地定位，禁止与 --ci/--strict 同用：被过滤过的结果不得作为门禁');
        return EXIT.config;
      }
      if (!stages.includes('invariant')) {
        console.error('[verify] --only 只作用于 invariant 阶段，请同时指定 --stages invariant');
        return EXIT.config;
      }
    }

    const { run, ctx, ran, skipped } = runVerify({ taskId, stages, bidsDir, onlyIds });
    // 一个阶段都没真跑（全是未实现）时绝不能 exit 0：那是最典型的「假绿」
    if (ran.length === 0) {
      console.error(`[verify] 没有任何阶段实际执行（${stages.join(', ')} 均未实现），不得视为通过`);
      return EXIT.failed;
    }
    const ciViolations = [];
    if (ci && skipped.length) {
      ciViolations.push(`--ci 要求全部 ${ALL_STAGES.length} 个阶段实际执行；未实现：${skipped.join(', ')}`);
    }
    const ok = failures(run).length === 0 && ciViolations.length === 0 && !(strict && run.warnings.length > 0);
    const plan = { ran, skipped, ciViolations, ok, only: onlyIds ? [...onlyIds] : null };

    if (flag('--json')) {
      const payload = {
        schema_version: 1,
        kind: 'verify-entry',
        task_id: taskId,
        status: ok ? 'passed' : 'failed',
        only: onlyIds ? [...onlyIds] : null,
        stages: stages.map((s) => ({
          name: s,
          status: !ran.includes(s)
            ? 'skipped'
            : run.checks.some((c) => c.stage === s && !c.ok && c.severity === 'fail')
              ? 'failed'
              : 'passed'
        })),
        invariants: run.invariants,
        checks: run.checks,
        warnings: run.warnings,
        ci_violations: ciViolations
      };
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(renderText(run, ctx, plan));
    }
    return ok ? EXIT.ok : EXIT.failed;
  } catch (e) {
    const kind = e.kind || 'infra_error';
    console.error(`[verify] ${kind}: ${e.message}`);
    if (!e.kind && e.stack) console.error(e.stack);
    return kind === 'infra_error' ? EXIT.failed : EXIT.config;
  }
}

const invokedDirectly = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exitCode = main();
}
