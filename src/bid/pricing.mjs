// 价格表索引与成本复算。单价只来自 chain/pricing.json，不写死任何数字。

import { round6 } from './config.mjs';

export function buildPricingIndex(pricing) {
  if (pricing && pricing.byModel instanceof Map && pricing.current) {
    return pricing;
  }

  const versions = [...(pricing?.pricing_versions || [])].sort((a, b) =>
    String(b.effective_from).localeCompare(String(a.effective_from))
  );

  if (versions.length === 0) {
    throw new Error('pricing.pricing_versions 为空');
  }

  const current = versions[0];
  const byModel = new Map();
  for (const model of current.models || []) {
    byModel.set(model.model, model);
  }

  return {
    pricing,
    current,
    byModel,
    verified: current.verified === true,
  };
}

export function estimateCostCny(pricing, bid) {
  const index = buildPricingIndex(pricing);
  const price = index.byModel.get(bid?.model);
  if (!price) return null;

  const estimate = bid?.estimate || {};
  const inputTokens = Number(estimate.input_tokens);
  const outputTokens = Number(estimate.output_tokens);
  const hitRatio = Math.min(1, Math.max(0, Number(estimate.cache_hit_ratio ?? 0)));

  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return null;

  const missRatio = 1 - hitRatio;
  const inputCost =
    (inputTokens *
      (hitRatio * Number(price.input_cache_hit_per_1m) +
        missRatio * Number(price.input_cache_miss_per_1m))) /
    1e6;
  const outputCost = (outputTokens * Number(price.output_per_1m)) / 1e6;

  return round6(inputCost + outputCost);
}
