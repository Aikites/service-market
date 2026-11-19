// 资格闸门、分项评分、排序与定标。
// 与 scripts/review-bids.mjs 的口径保持一致；所有阈值都从 card/policy 传入。

import { matchesAny, pathAllowed, round6 } from './config.mjs';
import { buildPricingIndex, estimateCostCny } from './pricing.mjs';

export const REQUIRED_BID_FIELDS = [
  'bid_id',
  'agent_id',
  'provider',
  'model',
  'quote_cny',
  'delivery_days',
  'estimate',
  'touched_paths',
  'plan',
  'submitted_at',
];

export function validateBid(policy, pricing, card, budget, bid) {
  const bidding = card.bidding;
  const front = card.front;
  const fails = [];
  const add = (gate, reason) => fails.push({ gate, reason });

  for (const field of REQUIRED_BID_FIELDS) {
    if (bid?.[field] === undefined || bid?.[field] === null) {
      add('G1', `缺少字段 ${field}`);
    }
  }

  const quote = Number(bid?.quote_cny);
  const days = Number(bid?.delivery_days);
  if (!Number.isFinite(quote) || quote <= 0) {
    add('G1', `quote_cny 必须为正数，实际 ${bid?.quote_cny}`);
  }
  if (!Number.isFinite(days) || days <= 0) {
    add('G1', `delivery_days 必须为正数，实际 ${bid?.delivery_days}`);
  }

  const lockedProvider = policy.models.provider;
  if (bid?.provider !== lockedProvider) {
    add('G2', `provider=${bid?.provider} 违反单供应商锁定(${lockedProvider})`);
  }

  const pricingIndex = buildPricingIndex(pricing);
  if (bid?.model && !pricingIndex.byModel.has(bid.model)) {
    add('G2', `model=${bid.model} 不在 ${pricingIndex.current.pricing_version} 价格表内`);
  }

  const taskMax = Number(front.budget.max_cost_cny);
  if (Number.isFinite(quote) && quote > taskMax) {
    add('G3', `报价 ${quote} 超过单任务上限 ${taskMax}`);
  }

  if (Number.isFinite(quote) && quote > budget.remaining) {
    add(
      'G4',
      `报价 ${quote} 超过当日剩余 ${budget.remaining}（上限 ${budget.dailyMax}，已花 ${budget.spent}）`
    );
  }

  const estimated = estimateCostCny(pricingIndex, bid);
  if (estimated === null) {
    add('G5', '无法按价格表复算成本（estimate 字段非法或模型未定价）');
  } else if (Number.isFinite(quote) && estimated > quote) {
    add('G5', `复算成本 ${estimated} > 报价 ${quote}，属亏本报标`);
  }

  if (Number.isFinite(days) && days > Number(bidding.max_delivery_days)) {
    add('G6', `交付 ${days} 天超过上限 ${bidding.max_delivery_days} 天`);
  }

  const touched = Array.isArray(bid?.touched_paths) ? bid.touched_paths : [];
  if (touched.length === 0) add('G7', 'touched_paths 为空');
  for (const path of touched) {
    if (!pathAllowed(path, front.allowed_paths || [])) {
      add('G7', `路径 ${path} 不在 allowed_paths 内`);
    }
    if (matchesAny(path, front.forbidden_paths || [])) {
      add('G7', `路径 ${path} 命中任务 forbidden_paths`);
    }
    if (matchesAny(path, policy.protected_paths || [])) {
      add('G7', `路径 ${path} 命中 policy.protected_paths（需人工介入）`);
    }
  }

  const plan = bid?.plan || {};
  for (const section of bidding.required_plan_sections || []) {
    const value = plan[section];
    if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) {
      add('G8', `plan.${section} 缺失或为空`);
    }
  }

  const taskInvariants = front.invariants || [];
  for (const invariant of plan.invariants || []) {
    if (!taskInvariants.includes(invariant)) {
      add('G8', `plan.invariants 含标书外条目 ${invariant}`);
    }
  }

  return {
    bid_id: bid?.bid_id,
    agent_id: bid?.agent_id,
    provider: bid?.provider,
    model: bid?.model,
    quote_cny: Number.isFinite(quote) ? round6(quote) : null,
    delivery_days: Number.isFinite(days) ? round6(days) : null,
    est_cost_cny: estimated,
    touched_paths: touched,
    qualified: fails.length === 0,
    fails,
    source_bid: bid,
  };
}

export const evaluateBid = validateBid;

export function qualityScore(card, bid) {
  const rubric = card.bidding.quality_rubric;
  const plan = bid?.plan || {};
  const milestones = Array.isArray(plan.milestones) ? plan.milestones : [];
  const risks = Array.isArray(plan.risks) ? plan.risks : [];
  const tests = Array.isArray(plan.test_plan) ? plan.test_plan : [];
  const detail = [];

  detail.push({
    item: 'milestones_at_least',
    ok: milestones.length >= Number(rubric.milestones_at_least),
    note: `${milestones.length}/${rubric.milestones_at_least}`,
  });
  detail.push({
    item: 'risks_at_least',
    ok: risks.length >= Number(rubric.risks_at_least),
    note: `${risks.length}/${rubric.risks_at_least}`,
  });
  detail.push({
    item: 'test_plan_at_least',
    ok: tests.length >= Number(rubric.test_plan_at_least),
    note: `${tests.length}/${rubric.test_plan_at_least}`,
  });

  if (rubric.milestones_cover_all_touched) {
    const deliverables = milestones.map((milestone) => String(milestone?.deliverable || '')).join(' ');
    const roots = [...new Set((bid?.touched_paths || []).map((path) => String(path).split('/')[0]))].sort();
    const missing = roots.filter((root) => !deliverables.includes(root));
    detail.push({
      item: 'milestones_cover_all_touched',
      ok: missing.length === 0,
      note: missing.length ? `缺 ${missing.join(',')}` : 'ok',
    });
  }

  if (rubric.invariants_subset_of_task) {
    const taskInvariants = card.front.invariants || [];
    const planInvariants = Array.isArray(plan.invariants) ? plan.invariants : [];
    const extra = planInvariants.filter((invariant) => !taskInvariants.includes(invariant));
    detail.push({
      item: 'invariants_subset_of_task',
      ok: extra.length === 0,
      note: extra.length ? `多出 ${extra.join(',')}` : 'ok',
    });
  }

  const hits = detail.filter((item) => item.ok).length;
  return {
    hits,
    total: detail.length,
    score: detail.length ? round6(hits / detail.length) : 0,
    detail,
  };
}

export function normalizeScore(value, min, max) {
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max)) return 0;
  if (max === min) return 1;
  return round6((max - value) / (max - min));
}

export function scoreBid(card, bid, range) {
  const quality = qualityScore(card, bid);
  const weights = card.bidding.weights;
  const price = normalizeScore(Number(bid.quote_cny), range.minQuote, range.maxQuote);
  const delivery = normalizeScore(Number(bid.delivery_days), range.minDelivery, range.maxDelivery);
  const total = round6(
    Number(weights.price) * price +
      Number(weights.delivery) * delivery +
      Number(weights.quality) * quality.score
  );

  return {
    scores: { price, delivery, quality: quality.score },
    quality_detail: quality.detail,
    total,
  };
}

export function scoreBids(card, qualified, evaluated) {
  if (qualified.length === 0) {
    return evaluated.map((entry) => ({ ...entry, scores: null, total: null }));
  }

  const quotes = qualified.map((entry) => entry.quote_cny);
  const days = qualified.map((entry) => entry.delivery_days);
  const range = {
    minQuote: Math.min(...quotes),
    maxQuote: Math.max(...quotes),
    minDelivery: Math.min(...days),
    maxDelivery: Math.max(...days),
  };

  return evaluated.map((entry) => {
    if (!entry.qualified) return { ...entry, scores: null, total: null };
    return { ...entry, ...scoreBid(card, entry.source_bid, range) };
  });
}

export function rankBids(policy, pricing, card, budget, bids) {
  const evaluated = (bids || []).map((bid) => validateBid(policy, pricing, card, budget, bid));
  const qualified = evaluated.filter((entry) => entry.qualified);
  const scored = scoreBids(card, qualified, evaluated);

  const ranking = scored
    .filter((entry) => entry.qualified)
    .sort(
      (left, right) =>
        right.total - left.total ||
        left.quote_cny - right.quote_cny ||
        left.delivery_days - right.delivery_days ||
        String(left.agent_id).localeCompare(String(right.agent_id))
    )
    .map((entry, index) => ({ rank: index + 1, ...entry }));

  const disqualified = scored
    .filter((entry) => !entry.qualified)
    .map((entry) => ({
      bid_id: entry.bid_id ?? null,
      agent_id: entry.agent_id ?? null,
      quote_cny: entry.quote_cny,
      fails: entry.fails,
    }));

  const insufficient = ranking.length < Number(card.bidding.min_bids);

  return {
    card,
    budget,
    bid_count: bids?.length || 0,
    qualified_count: ranking.length,
    insufficient_bids: insufficient,
    disqualified,
    ranking,
    winner: insufficient ? null : ranking[0],
  };
}
