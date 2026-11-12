#!/usr/bin/env node
// scripts/review-bids.mjs — T-001 竞标大厅评审脚本（裁判）
//
// 设计约束（见 tasks/T-001.md）：
//   1. 确定性：无随机数、无网络、无模型调用、无 Date 依赖的评分逻辑；
//   2. 预算唯一来源：chain/policy.json（单任务 8 元 / 单日 8 元 / 单笔熔断 2 元）；
//   3. 单价唯一来源：chain/pricing.json（per_1m_tokens，CNY）；
//   4. 只写 reports/**，绝不写 chain/**；不执行任何 git 命令；
//   5. 退出码取自 policy.exit_codes。
//
// 用法：
//   node scripts/review-bids.mjs --check-task T-001
//   node scripts/review-bids.mjs --self-test
//   node scripts/review-bids.mjs --task T-001 --dry-run
//   node scripts/review-bids.mjs --task T-001 [--bids bids/T-001] [--out reports/T-001/bid-result.json] [--json]

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(process.cwd());
const P = (rel) => join(ROOT, rel);

const POLICY_FILE = 'chain/policy.json';
const PRICING_FILE = 'chain/pricing.json';
const TASK_DIR = 'tasks';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};

const round6 = (n) => Math.round(n * 1e6) / 1e6;
const cny = (n) => `¥${round6(n).toFixed(2)}`;
const pad = (s, n) => String(s).padEnd(n);

function readJson(rel) {
  const abs = P(rel);
  if (!existsSync(abs)) throw Object.assign(new Error(`缺少文件 ${rel}`), { kind: 'invalid_config' });
  try {
    return JSON.parse(readFileSync(abs, 'utf8'));
  } catch (e) {
    throw Object.assign(new Error(`${rel} 不是合法 JSON: ${e.message}`), { kind: 'invalid_config' });
  }
}

function sha256(text) {
  return 'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex');
}

const escapeRe = (c) => c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
const normalize = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');

export function globToRegExp(glob) {
  const g = normalize(glob);
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += escapeRe(c);
  }
  return new RegExp('^' + re + '$');
}

export function matchesAny(target, patterns) {
  return patterns.some((p) => globToRegExp(p).test(normalize(target)));
}

// touched 可能是具体路径，也可能是 glob；被允许 = 命中允许模式，或被允许模式的固定前缀覆盖
export function pathAllowed(touched, allowedPatterns) {
  const t = normalize(touched);
  for (const raw of allowedPatterns) {
    const a = normalize(raw);
    if (globToRegExp(a).test(t)) return true;
    const starAt = a.indexOf('*');
    if (starAt > 0) {
      const prefix = a.slice(0, starAt);
      if (t.startsWith(prefix)) return true;
    }
  }
  return false;
}

class CliError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

function exitCode(policy, kind) {
  const codes = (policy && policy.exit_codes) || {};
  return typeof codes[kind] === 'number' ? codes[kind] : 4;
}

export function loadPolicy() {
  const policy = readJson(POLICY_FILE);
  if (policy.schema_version !== 1) throw new CliError('invalid_config', 'policy.schema_version 必须为 1');
  const need = [
    ['budget.task.max_cost_cny', policy.budget?.task?.max_cost_cny],
    ['budget.daily.max_cost_cny', policy.budget?.daily?.max_cost_cny],
    ['budget.circuit_breaker.single_call_max_cny', policy.budget?.circuit_breaker?.single_call_max_cny],
    ['models.provider', policy.models?.provider]
  ];
  for (const [k, v] of need) {
    if (v === undefined || v === null) throw new CliError('invalid_config', `policy 缺少 ${k}`);
  }
  return policy;
}

export function loadPricing() {
  const pricing = readJson(PRICING_FILE);
  if (!Array.isArray(pricing.pricing_versions) || pricing.pricing_versions.length === 0) {
    throw new CliError('invalid_config', 'pricing.pricing_versions 为空');
  }
  const versions = [...pricing.pricing_versions].sort((a, b) =>
    String(b.effective_from).localeCompare(String(a.effective_from))
  );
  const current = versions[0];
  const byModel = new Map();
  for (const m of current.models || []) byModel.set(m.model, m);
  return { pricing, current, byModel, verified: current.verified === true };
}

export function parseTaskCard(text, sourceName) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) throw new CliError('invalid_config', `${sourceName}: front-matter 必须用 --- 包裹`);
  let front;
  try {
    front = JSON.parse(m[1]);
  } catch (e) {
    throw new CliError('invalid_config', `${sourceName}: front-matter 必须是合法 JSON/YAML 流式映射 (${e.message})`);
  }
  const body = text.slice(m[0].length);

  let bidding = null;
  for (const block of body.matchAll(/```json\r?\n([\s\S]*?)```/g)) {
    let obj;
    try {
      obj = JSON.parse(block[1]);
    } catch {
      continue;
    }
    if (obj && typeof obj === 'object' && obj.bidding) {
      bidding = obj.bidding;
      break;
    }
  }
  if (!bidding) throw new CliError('invalid_config', `${sourceName}: 正文缺少含 bidding 的 json 代码块`);

  const weights = bidding.weights || {};
  const sum = ['price', 'delivery', 'quality'].reduce((s, k) => s + Number(weights[k] || 0), 0);
  if (Math.abs(sum - 1) > 1e-9) {
    throw new CliError('invalid_config', `${sourceName}: weights 之和必须为 1，实际 ${round6(sum)}`);
  }
  for (const k of ['bid_dir', 'result_file', 'max_delivery_days', 'min_bids', 'quality_rubric']) {
    if (bidding[k] === undefined) throw new CliError('invalid_config', `${sourceName}: bidding 缺少 ${k}`);
  }

  return { front, body, bidding, bidding_hash: sha256(JSON.stringify(bidding)) };
}

export function loadTaskCard(taskId) {
  if (!/^T-[0-9]{3}$/.test(taskId)) throw new CliError('invalid_config', `task_id 非法: ${taskId}`);
  const rel = `${TASK_DIR}/${taskId}.md`;
  const abs = P(rel);
  if (!existsSync(abs)) throw new CliError('invalid_config', `任务卡不存在: ${rel}`);
  const card = parseTaskCard(readFileSync(abs, 'utf8'), rel);
  if (card.front.task_id !== taskId) {
    throw new CliError('invalid_config', `${rel}: front-matter task_id=${card.front.task_id} 与文件名不一致`);
  }
  return card;
}

export function checkTaskCard(policy, card, pricing) {
  const problems = [];
  const front = card.front;
  const required = [
    'schema_version',
    'task_id',
    'title',
    'status',
    'created_at',
    'created_by',
    'objective',
    'allowed_paths',
    'required_tests',
    'invariants',
    'acceptance',
    'budget',
    'human_approval'
  ];
  for (const k of required) if (!(k in front)) problems.push(`front-matter 缺少 ${k}`);
  if (front.schema_version !== 1) problems.push('schema_version 必须为 1');
  if (!Array.isArray(front.allowed_paths) || front.allowed_paths.length === 0) {
    problems.push('allowed_paths 不得为空');
  }
  const maxTask = Number(policy.budget.task.max_cost_cny);
  const budget = Number(front.budget?.max_cost_cny ?? 0);
  if (!(budget > 0)) problems.push('budget.max_cost_cny 必须为正数');
  if (budget > maxTask) problems.push(`budget.max_cost_cny=${budget} 超过 policy 上限 ${maxTask}`);
  const calls = front.budget?.max_model_calls;
  if (calls !== undefined && calls > policy.budget.task.max_model_calls) {
    problems.push(`budget.max_model_calls=${calls} 超过 policy 上限 ${policy.budget.task.max_model_calls}`);
  }
  for (const t of front.required_tests || []) {
    if (!t.id || !t.file) problems.push('required_tests 条目缺少 id/file');
    else if (!pathAllowed(t.file, front.allowed_paths || [])) problems.push(`required_tests.file=${t.file} 不在 allowed_paths 内`);
  }
  if ((front.acceptance?.commands || []).length === 0) problems.push('acceptance.commands 不得为空');
  const unknown = (front.invariants || []).filter((i) => !/^INV-[0-9]{3}$/.test(i));
  if (unknown.length) problems.push(`invariants 格式非法: ${unknown.join(',')}`);
  const missingModels = [...new Set(Object.values(policy.models.routes || {}).map((r) => r.model))].filter(
    (m) => !pricing.byModel.has(m)
  );
  if (missingModels.length) problems.push(`policy 路由使用了未定价模型: ${missingModels.join(',')}`);
  return problems;
}

export function loadBudgetContext(policy) {
  const stateRel = policy.factory?.handoff?.state_file || 'chain/state.json';
  const dailyMax = Number(policy.budget.daily.max_cost_cny);
  if (!existsSync(P(stateRel))) {
    return { dailyMax, spent: 0, remaining: dailyMax, source: 'assumed_zero', state_file: stateRel };
  }
  const raw = readFileSync(P(stateRel), 'utf8');
  // 0 字节 = 快照尚未写入（脚手架占位），按 0 计但必须打标；非空且解析失败才算损坏
  if (raw.trim() === '') {
    return { dailyMax, spent: 0, remaining: dailyMax, source: 'empty_state', state_file: stateRel };
  }
  let state;
  try {
    state = JSON.parse(raw);
  } catch (e) {
    throw new CliError('state_corrupt', `${stateRel} 不是合法 JSON: ${e.message}`);
  }
  const b = state?.global?.budget;
  if (!b || typeof b.daily_spent_cny !== 'number') {
    throw new CliError('state_corrupt', `${stateRel} 缺少 global.budget.daily_spent_cny`);
  }
  if (b.daily_max_cny !== undefined && Number(b.daily_max_cny) !== dailyMax) {
    throw new CliError(
      'state_corrupt',
      `${stateRel} daily_max_cny=${b.daily_max_cny} 与 policy ${dailyMax} 不一致，需人工对账`
    );
  }
  const spent = round6(Math.max(0, Number(b.daily_spent_cny)));
  return { dailyMax, spent, remaining: round6(Math.max(0, dailyMax - spent)), source: 'state', state_file: stateRel };
}

export function estimateCostCny(pricing, bid) {
  const price = pricing.byModel.get(bid.model);
  if (!price) return null;
  const est = bid.estimate || {};
  const inputTokens = Number(est.input_tokens);
  const outputTokens = Number(est.output_tokens);
  const hit = Math.min(1, Math.max(0, Number(est.cache_hit_ratio ?? 0)));
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return null;
  const miss = 1 - hit;
  const inputCost = (inputTokens * (hit * price.input_cache_hit_per_1m + miss * price.input_cache_miss_per_1m)) / 1e6;
  const outputCost = (outputTokens * price.output_per_1m) / 1e6;
  return round6(inputCost + outputCost);
}

const REQUIRED_BID_FIELDS = [
  'bid_id',
  'agent_id',
  'provider',
  'model',
  'quote_cny',
  'delivery_days',
  'estimate',
  'touched_paths',
  'plan',
  'submitted_at'
];

export function evaluateBid(policy, pricing, card, budget, bid) {
  const bidding = card.bidding;
  const front = card.front;
  const fails = [];
  const add = (gate, reason) => fails.push({ gate, reason });

  for (const k of REQUIRED_BID_FIELDS) if (bid[k] === undefined || bid[k] === null) add('G1', `缺少字段 ${k}`);
  const quote = Number(bid.quote_cny);
  const days = Number(bid.delivery_days);
  if (!Number.isFinite(quote) || quote <= 0) add('G1', `quote_cny 必须为正数，实际 ${bid.quote_cny}`);
  if (!Number.isFinite(days) || days <= 0) add('G1', `delivery_days 必须为正数，实际 ${bid.delivery_days}`);

  const lockedProvider = policy.models.provider;
  if (bid.provider !== lockedProvider) add('G2', `provider=${bid.provider} 违反单供应商锁定(${lockedProvider})`);
  if (bid.model && !pricing.byModel.has(bid.model)) {
    add('G2', `model=${bid.model} 不在 ${pricing.current.pricing_version} 价格表内`);
  }

  if (Number.isFinite(quote) && quote > Number(front.budget.max_cost_cny)) {
    add('G3', `报价 ${cny(quote)} 超过单任务上限 ${cny(front.budget.max_cost_cny)}`);
  }

  if (Number.isFinite(quote) && quote > budget.remaining) {
    add(
      'G4',
      `报价 ${cny(quote)} 超过当日剩余 ${cny(budget.remaining)}（上限 ${cny(budget.dailyMax)}，已花 ${cny(budget.spent)}）`
    );
  }

  const est = estimateCostCny(pricing, bid);
  if (est === null) add('G5', '无法按价格表复算成本（estimate 字段非法或模型未定价）');
  else if (Number.isFinite(quote) && est > quote) add('G5', `复算成本 ${cny(est)} > 报价 ${cny(quote)}，属亏本报标`);

  if (Number.isFinite(days) && days > Number(bidding.max_delivery_days)) {
    add('G6', `交付 ${days} 天超过上限 ${bidding.max_delivery_days} 天`);
  }

  const touched = Array.isArray(bid.touched_paths) ? bid.touched_paths : [];
  if (touched.length === 0) add('G7', 'touched_paths 为空');
  for (const t of touched) {
    if (!pathAllowed(t, front.allowed_paths || [])) add('G7', `路径 ${t} 不在 allowed_paths 内`);
    if (matchesAny(t, front.forbidden_paths || [])) add('G7', `路径 ${t} 命中任务 forbidden_paths`);
    if (matchesAny(t, policy.protected_paths || [])) add('G7', `路径 ${t} 命中 policy.protected_paths（需人工介入）`);
  }

  const plan = bid.plan || {};
  for (const section of bidding.required_plan_sections || []) {
    const v = plan[section];
    if (v === undefined || v === null || (Array.isArray(v) && v.length === 0)) add('G8', `plan.${section} 缺失或为空`);
  }
  const taskInv = front.invariants || [];
  for (const inv of plan.invariants || []) {
    if (!taskInv.includes(inv)) add('G8', `plan.invariants 含标书外条目 ${inv}`);
  }

  return {
    bid_id: bid.bid_id,
    agent_id: bid.agent_id,
    provider: bid.provider,
    model: bid.model,
    quote_cny: Number.isFinite(quote) ? round6(quote) : null,
    delivery_days: Number.isFinite(days) ? round6(days) : null,
    est_cost_cny: est,
    touched_paths: touched,
    qualified: fails.length === 0,
    fails,
    source_bid: bid
  };
}

export function qualityScore(card, bid) {
  const rubric = card.bidding.quality_rubric;
  const plan = bid.plan || {};
  const milestones = Array.isArray(plan.milestones) ? plan.milestones : [];
  const risks = Array.isArray(plan.risks) ? plan.risks : [];
  const tests = Array.isArray(plan.test_plan) ? plan.test_plan : [];
  const detail = [];

  detail.push({
    item: 'milestones_at_least',
    ok: milestones.length >= Number(rubric.milestones_at_least),
    note: `${milestones.length}/${rubric.milestones_at_least}`
  });
  detail.push({
    item: 'risks_at_least',
    ok: risks.length >= Number(rubric.risks_at_least),
    note: `${risks.length}/${rubric.risks_at_least}`
  });
  detail.push({
    item: 'test_plan_at_least',
    ok: tests.length >= Number(rubric.test_plan_at_least),
    note: `${tests.length}/${rubric.test_plan_at_least}`
  });

  if (rubric.milestones_cover_all_touched) {
    const deliverables = milestones.map((m) => String(m.deliverable || '')).join(' ');
    const roots = [...new Set((bid.touched_paths || []).map((p) => normalize(p).split('/')[0]))].sort();
    const missing = roots.filter((r) => !deliverables.includes(r));
    detail.push({
      item: 'milestones_cover_all_touched',
      ok: missing.length === 0,
      note: missing.length ? `缺 ${missing.join(',')}` : 'ok'
    });
  }
  if (rubric.invariants_subset_of_task) {
    const taskInv = card.front.invariants || [];
    const planInv = Array.isArray(plan.invariants) ? plan.invariants : [];
    const bad = planInv.filter((i) => !taskInv.includes(i));
    detail.push({ item: 'invariants_subset_of_task', ok: bad.length === 0, note: bad.length ? `多出 ${bad.join(',')}` : 'ok' });
  }

  const hits = detail.filter((d) => d.ok).length;
  return { hits, total: detail.length, score: detail.length ? round6(hits / detail.length) : 0, detail };
}

export function scoreBids(card, qualified, evaluated) {
  const quotes = qualified.map((q) => q.quote_cny);
  const days = qualified.map((q) => q.delivery_days);
  const minQ = Math.min(...quotes);
  const maxQ = Math.max(...quotes);
  const minD = Math.min(...days);
  const maxD = Math.max(...days);
  const w = card.bidding.weights;
  const norm = (v, min, max) => (max === min ? 1 : round6((max - v) / (max - min)));

  return evaluated.map((e) => {
    if (!e.qualified) return { ...e, scores: null, total: null };
    const q = qualityScore(card, e.source_bid);
    const price = norm(e.quote_cny, minQ, maxQ);
    const delivery = norm(e.delivery_days, minD, maxD);
    const total = round6(w.price * price + w.delivery * delivery + w.quality * q.score);
    return { ...e, scores: { price, delivery, quality: q.score }, quality_detail: q.detail, total };
  });
}

export function rankBids(policy, pricing, card, budget, bids) {
  const evaluated = bids.map((b) => evaluateBid(policy, pricing, card, budget, b));
  const qualified = evaluated.filter((e) => e.qualified);
  const scored = scoreBids(card, qualified, evaluated);

  const ranked = scored
    .filter((e) => e.qualified)
    .sort(
      (a, b) =>
        b.total - a.total || a.quote_cny - b.quote_cny || a.delivery_days - b.delivery_days ||
        String(a.agent_id).localeCompare(String(b.agent_id))
    )
    .map((e, i) => ({ rank: i + 1, ...e }));

  const disqualified = scored
    .filter((e) => !e.qualified)
    .map((e) => ({
      bid_id: e.bid_id ?? null,
      agent_id: e.agent_id ?? null,
      quote_cny: e.quote_cny,
      fails: e.fails
    }));

  const insufficient = ranked.length < Number(card.bidding.min_bids);
  const winner = insufficient ? null : ranked[0];

  return {
    card,
    budget,
    bid_count: bids.length,
    qualified_count: ranked.length,
    insufficient_bids: insufficient,
    disqualified,
    ranking: ranked,
    winner
  };
}

export function loadBidsFromDir(dirRel) {
  const abs = P(dirRel);
  if (!existsSync(abs)) return { bids: [], parse_errors: [], dir: dirRel, exists: false };
  const files = readdirSync(abs)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const bids = [];
  const parse_errors = [];
  for (const f of files) {
    try {
      const bid = JSON.parse(readFileSync(join(abs, f), 'utf8'));
      if (!bid || typeof bid !== 'object' || Array.isArray(bid)) throw new Error('顶层必须是对象');
      bids.push(bid);
    } catch (e) {
      parse_errors.push({ file: `${dirRel}/${f}`, reason: e.message, gate: 'G0' });
    }
  }
  return { bids, parse_errors, dir: dirRel, exists: true };
}

export function buildResult({ policy, pricing, card, budget, outcome, bidsDir, parseErrors, selfTest }) {
  const front = card.front;
  return {
    schema_version: 1,
    kind: 'bid-review',
    self_test: selfTest === true,
    task_id: front.task_id,
    task_status: front.status,
    generated_at: new Date().toISOString(),
    bidding_hash: card.bidding_hash,
    sources: {
      policy: POLICY_FILE,
      pricing: PRICING_FILE,
      pricing_version: pricing.current.pricing_version,
      pricing_verified: pricing.verified,
      bid_dir: bidsDir
    },
    limits: {
      task_max_cny: Number(front.budget.max_cost_cny),
      policy_task_max_cny: Number(policy.budget.task.max_cost_cny),
      daily_max_cny: budget.dailyMax,
      daily_spent_cny: budget.spent,
      daily_remaining_cny: budget.remaining,
      budget_source: budget.source,
      single_call_max_cny: Number(policy.budget.circuit_breaker.single_call_max_cny),
      max_delivery_days: Number(card.bidding.max_delivery_days),
      provider: policy.models.provider,
      weights: card.bidding.weights
    },
    counts: {
      bids: outcome.bid_count,
      qualified: outcome.qualified_count,
      disqualified: outcome.disqualified.length,
      unparsable: parseErrors.length,
      min_bids: Number(card.bidding.min_bids)
    },
    insufficient_bids: outcome.insufficient_bids,
    disqualified: [
      ...parseErrors.map((p) => ({ bid_id: null, agent_id: null, file: p.file, fails: [{ gate: p.gate, reason: p.reason }] })),
      ...outcome.disqualified
    ],
    ranking: outcome.ranking.map((r) => ({
      rank: r.rank,
      bid_id: r.bid_id,
      agent_id: r.agent_id,
      provider: r.provider,
      model: r.model,
      quote_cny: r.quote_cny,
      est_cost_cny: r.est_cost_cny,
      delivery_days: r.delivery_days,
      scores: r.scores,
      total: r.total,
      quality_detail: r.quality_detail
    })),
    winner: outcome.winner
      ? {
          bid_id: outcome.winner.bid_id,
          agent_id: outcome.winner.agent_id,
          quote_cny: outcome.winner.quote_cny,
          delivery_days: outcome.winner.delivery_days,
          total: outcome.winner.total,
          reason: `总分 ${outcome.winner.total} 排名第 1（价格权重 ${card.bidding.weights.price} / 周期 ${card.bidding.weights.delivery} / 方案 ${card.bidding.weights.quality}）`
        }
      : null,
    notes: [
      budget.source === 'state'
        ? `${budget.state_file} 读出当日已花费 ${cny(budget.spent)}`
        : budget.source === 'empty_state'
          ? `${budget.state_file} 为空（快照尚未写入），当日已花费按 0 计，需人工确认`
          : `${budget.state_file} 缺失，当日已花费按 0 计，需人工确认`,
      pricing.verified ? `价格表 ${pricing.current.pricing_version} 已核对` : `价格表 ${pricing.current.pricing_version} 未核对（verified=false），仅供估算`,
      '本结果由确定性脚本产出，未调用任何大模型'
    ]
  };
}

export function renderReport(result) {
  const L = [];
  L.push('');
  L.push(`竞标评审  task=${result.task_id}  投标 ${result.counts.bids} / 合格 ${result.counts.qualified}`);
  L.push(`预算      单任务 ${cny(result.limits.task_max_cny)}  当日上限 ${cny(result.limits.daily_max_cny)}  已花 ${cny(result.limits.daily_spent_cny)}  剩余 ${cny(result.limits.daily_remaining_cny)} (${result.limits.budget_source})`);
  L.push(`价格表    ${result.sources.pricing_version}${result.sources.pricing_verified ? '' : '（未核对）'}  供应商 ${result.limits.provider}`);
  L.push('');

  if (result.disqualified.length) {
    L.push('废标：');
    for (const d of result.disqualified) {
      L.push(`  - ${pad(d.bid_id || '(无法解析)', 18)} ${d.agent_id || ''}`);
      for (const f of d.fails) L.push(`      ${f.gate}  ${f.reason}`);
    }
    L.push('');
  }

  if (result.ranking.length) {
    L.push(`排名  ${pad('bid_id', 18)}${pad('agent', 16)}${pad('报价', 10)}${pad('周期', 8)}${pad('价格分', 10)}${pad('周期分', 10)}${pad('方案分', 10)}总分`);
    for (const r of result.ranking) {
      L.push(
        `  ${r.rank}   ${pad(r.bid_id, 18)}${pad(r.agent_id, 16)}${pad(cny(r.quote_cny), 10)}${pad(r.delivery_days + 'd', 8)}` +
          `${pad(r.scores.price, 10)}${pad(r.scores.delivery, 10)}${pad(r.scores.quality, 10)}${r.total}`
      );
    }
    L.push('');
  }

  if (result.winner) {
    L.push(`中标：${result.winner.bid_id} / ${result.winner.agent_id}  报价 ${cny(result.winner.quote_cny)}  交付 ${result.winner.delivery_days} 天  总分 ${result.winner.total}`);
  } else {
    L.push(
      `未定标：${result.insufficient_bids ? `合格投标不足 ${result.counts.min_bids}` : '无可中标投标'}（需人工介入）`
    );
  }
  L.push('');
  for (const n of result.notes) L.push(`· ${n}`);
  L.push('');
  return L.join('\n');
}

export function selfTestBids() {
  const stamp = '2026-11-12T00:00:00.000Z';
  return [
    {
      bid_id: 'BID-ALPHA-01',
      agent_id: 'agent-alpha',
      provider: 'deepseek',
      model: 'deepseek-chat',
      quote_cny: 6.2,
      delivery_days: 5,
      estimate: { input_tokens: 90000, output_tokens: 20000, cache_hit_ratio: 0.3 },
      touched_paths: ['index.html', 'src/**'],
      plan: {
        milestones: [
          { name: '数据结构与接口', days: 2, deliverable: 'src/bid/*.mjs' },
          { name: '页面与联调', days: 2, deliverable: 'index.html' },
          { name: '测试与文档', days: 1, deliverable: 'tests/bid' }
        ],
        risks: ['投标字段缺失', '预算口径漂移'],
        test_plan: ['权重之和必须为 1', '超预算投标必须废标'],
        invariants: ['INV-001', 'INV-002']
      },
      submitted_at: stamp
    },
    {
      bid_id: 'BID-BETA-01',
      agent_id: 'agent-beta',
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      quote_cny: 9.0,
      delivery_days: 4,
      estimate: { input_tokens: 80000, output_tokens: 15000, cache_hit_ratio: 0.2 },
      touched_paths: ['index.html', 'src/**'],
      plan: {
        milestones: [
          { name: '全量实现', days: 3, deliverable: 'src/bid + index.html' },
          { name: '自测', days: 1, deliverable: 'tests/bid' },
          { name: '交付', days: 0, deliverable: 'docs/bid-hall.md' }
        ],
        risks: ['排期过紧', '无缓冲'],
        test_plan: ['覆盖评分', '覆盖闸门'],
        invariants: ['INV-001']
      },
      submitted_at: stamp
    },
    {
      bid_id: 'BID-GAMMA-01',
      agent_id: 'agent-gamma',
      provider: 'deepseek',
      model: 'deepseek-chat',
      quote_cny: 4.0,
      delivery_days: 12,
      estimate: { input_tokens: 60000, output_tokens: 12000, cache_hit_ratio: 0.1 },
      touched_paths: ['index.html', 'src/**'],
      plan: {
        milestones: [
          { name: '先出可用版本', days: 8, deliverable: 'index.html 雏形' },
          { name: '再补数据结构', days: 4, deliverable: 'src/bid' }
        ],
        risks: ['方案粗糙'],
        test_plan: ['基础用例'],
        invariants: ['INV-001']
      },
      submitted_at: stamp
    }
  ];
}

const USAGE = [
  '用法:',
  '  node scripts/review-bids.mjs --check-task T-001      # 标书自检（字段 / 预算 / bidding 块 / 模型定价）',
  '  node scripts/review-bids.mjs --self-test [--json]    # 内置 3 个合成投标，不读写仓库',
  '  node scripts/review-bids.mjs --task T-001 --dry-run  # 只打印评审结果，不落盘',
  '  node scripts/review-bids.mjs --task T-001            # 落盘到 bidding.result_file',
  '  node scripts/review-bids.mjs --write-samples         # 把内置 3 个投标写入 bidding.bid_dir（不覆盖已有文件）',
  '可选: --bids <dir>  --out <file>  --json',
  '约束: 不调用大模型、不联网、不写 chain/**、不执行 git 命令。'
].join('\n');

function runCheckTask(policy, pricing, taskId) {
  const card = loadTaskCard(taskId);
  const problems = checkTaskCard(policy, card, pricing);
  const report = {
    task_id: taskId,
    task_ok: problems.length === 0,
    status: card.front.status,
    created_by: card.front.created_by,
    bidding_hash: card.bidding_hash,
    budget: card.front.budget,
    policy_limits: {
      task_max_cny: policy.budget.task.max_cost_cny,
      daily_max_cny: policy.budget.daily.max_cost_cny,
      single_call_max_cny: policy.budget.circuit_breaker.single_call_max_cny
    },
    weights: card.bidding.weights,
    problems
  };
  console.log(JSON.stringify(report, null, 2));
  return problems.length === 0 ? exitCode(policy, 'ok') : exitCode(policy, 'invalid_config');
}

function runSelfTest(policy, pricing) {
  const card = loadTaskCard(opt('--task', 'T-001'));
  const budget = loadBudgetContext(policy);
  const outcome = rankBids(policy, pricing, card, budget, selfTestBids());
  const result = buildResult({
    policy,
    pricing,
    card,
    budget,
    outcome,
    bidsDir: '(self-test)',
    parseErrors: [],
    selfTest: true
  });

  if (flag('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(renderReport(result));

  const gates = new Set(result.disqualified.flatMap((d) => d.fails.map((f) => f.gate)));
  const checks = [
    [
      'BID-BETA-01 因 G3（单任务 8 元）被废标',
      result.disqualified.some((d) => d.bid_id === 'BID-BETA-01' && d.fails.some((f) => f.gate === 'G3'))
    ],
    ['存在 G4（当日剩余）判定', gates.has('G4')],
    ['最低价合格投标 agent-gamma 中标', result.winner?.agent_id === 'agent-gamma'],
    ['合格投标数 >= 2', result.counts.qualified >= 2],
    ['insufficient_bids = false', result.insufficient_bids === false],
    ['排名总分严格递减', result.ranking.every((r, i) => i === 0 || result.ranking[i - 1].total >= r.total)]
  ];

  console.log('自检:');
  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) failed++;
  }
  console.log(failed === 0 ? '自检全部通过' : `自检失败 ${failed} 项`);
  return failed === 0 ? exitCode(policy, 'ok') : exitCode(policy, 'invalid_config');
}

function runWriteSamples(policy) {
  const card = loadTaskCard(opt('--task', 'T-001'));
  const dirRel = normalize(opt('--bids', card.bidding.bid_dir));
  mkdirSync(P(dirRel), { recursive: true });
  let written = 0;
  let skipped = 0;
  for (const bid of selfTestBids()) {
    const rel = `${dirRel}/${bid.agent_id}.json`;
    if (existsSync(P(rel))) {
      skipped++;
      console.log(`跳过（已存在）${rel}`);
      continue;
    }
    writeFileSync(P(rel), JSON.stringify(bid, null, 2) + '\n', 'utf8');
    written++;
    console.log(`写入 ${rel}`);
  }
  console.log(`样例投标：写入 ${written}，跳过 ${skipped}`);
  return exitCode(policy, 'ok');
}

function runReview(policy, pricing, taskId) {
  const card = loadTaskCard(taskId);
  const budget = loadBudgetContext(policy);
  const bidsDir = opt('--bids', card.bidding.bid_dir);
  const loaded = loadBidsFromDir(bidsDir);
  if (!loaded.exists) throw new CliError('invalid_config', `投标目录不存在: ${bidsDir}`);

  const outcome = rankBids(policy, pricing, card, budget, loaded.bids);
  const result = buildResult({
    policy,
    pricing,
    card,
    budget,
    outcome,
    bidsDir,
    parseErrors: loaded.parse_errors,
    selfTest: false
  });

  if (flag('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(renderReport(result));

  const outRel = opt('--out', card.bidding.result_file);
  if (/^chain(\/|$)/.test(normalize(outRel))) {
    throw new CliError('invalid_config', `拒绝写入 ${outRel}：reports/** 之外不落盘，chain/** 绝不可写`);
  }
  if (flag('--dry-run')) {
    console.log(`--dry-run：未写入 ${outRel}`);
  } else {
    mkdirSync(dirname(P(outRel)), { recursive: true });
    writeFileSync(P(outRel), JSON.stringify(result, null, 2) + '\n', 'utf8');
    console.log(`已写入 ${outRel}`);
  }

  const budgetFail = result.disqualified.some((d) => d.fails.some((f) => f.gate === 'G3' || f.gate === 'G4'));
  if (result.insufficient_bids) return exitCode(policy, 'waiting_human');
  if (result.counts.qualified === 0 && budgetFail) return exitCode(policy, 'budget_exceeded');
  return exitCode(policy, 'ok');
}

export function main() {
  let policy = null;
  try {
    if (flag('--help') || argv.length === 0) {
      console.log(USAGE);
      return 0;
    }
    policy = loadPolicy();
    const pricing = loadPricing();
    if (flag('--check-task')) return runCheckTask(policy, pricing, opt('--check-task', 'T-001'));
    if (flag('--self-test')) return runSelfTest(policy, pricing);
    if (flag('--write-samples')) return runWriteSamples(policy);
    const taskId = opt('--task', null);
    if (!taskId) throw new CliError('invalid_config', '缺少 --task <T-00x>，或用 --help 查看用法');
    return runReview(policy, pricing, taskId);
  } catch (e) {
    const kind = e.kind || 'infra_error';
    console.error(`[review-bids] ${kind}: ${e.message}`);
    if (!e.kind && e.stack) console.error(e.stack);
    return exitCode(policy, kind);
  }
}

process.exitCode = (() => {
  const entry = process.argv[1] ? resolve(process.argv[1]) : '';
  const self = fileURLToPath(import.meta.url);
  return entry === self ? main() : 0;
})();
