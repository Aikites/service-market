import { describe, expect, it } from 'vitest';
import {
  assertWeights,
  normalizeScore,
  parseTaskCard,
  qualityScore,
  rankBids,
  scoreBid,
  validateBid,
  validateBiddingConfig,
} from '../../src/bid/index.mjs';
import { makeBid, makeBids, makeBudget, makeCard, makePolicy, makePricing } from './fixtures.mjs';

const policy = makePolicy();
const pricing = makePricing();
const card = makeCard();
const budget = makeBudget();

describe('竞标评分与定标', () => {
  it('三项权重必须归一且都在 0~1 区间', () => {
    const weights = { price: 0.45, delivery: 0.25, quality: 0.3 };
    expect(assertWeights(weights)).toBe(weights);
    expect(() => assertWeights({ price: 0.45, delivery: 0.25, quality: 0.2 })).toThrow(/之和/);
    expect(() => assertWeights({ price: 1.2, delivery: 0, quality: 0.3 })).toThrow(/0~1/);
    expect(() => validateBiddingConfig(card.bidding)).not.toThrow();
    expect(() => validateBiddingConfig({ ...card.bidding, quality_rubric: undefined })).toThrow(
      /quality_rubric/
    );
  });

  it('超预算投标被 G3/G4 废标，合格投标按权重排出 0.57 / 0.55', () => {
    const outcome = rankBids(policy, pricing, card, budget, makeBids());

    expect(outcome.bid_count).toBe(3);
    expect(outcome.qualified_count).toBe(2);
    expect(outcome.insufficient_bids).toBe(false);
    expect(outcome.disqualified).toHaveLength(1);

    const beta = outcome.disqualified[0];
    expect(beta.bid_id).toBe('BID-BETA-01');
    expect(beta.fails.map((fail) => fail.gate)).toEqual(expect.arrayContaining(['G3', 'G4']));

    expect(outcome.ranking.map((entry) => entry.agent_id)).toEqual(['agent-gamma', 'agent-alpha']);
    expect(outcome.winner.agent_id).toBe('agent-gamma');
    expect(outcome.winner.total).toBe(0.57);
    expect(outcome.ranking[1].total).toBe(0.55);
  });

  it('单项得分按 min/max 线性归一，公式与标书一致', () => {
    const scored = scoreBid(card, makeBid(), {
      minQuote: 4,
      maxQuote: 6.2,
      minDelivery: 5,
      maxDelivery: 12,
    });

    expect(scored.scores).toEqual({ price: 0, delivery: 1, quality: 1 });
    expect(scored.total).toBe(0.55);
    expect(normalizeScore(5, 5, 5)).toBe(1);
    expect(normalizeScore(4, 4, 6.2)).toBe(1);
    expect(normalizeScore(6.2, 4, 6.2)).toBe(0);
  });

  it('方案质量按 rubric 命中条数计分', () => {
    const gamma = qualityScore(card, makeBids()[2]);
    const alpha = qualityScore(card, makeBid());

    expect(gamma.total).toBe(5);
    expect(gamma.hits).toBe(2);
    expect(gamma.score).toBe(0.4);
    expect(alpha.score).toBe(1);
    expect(gamma.detail.map((item) => item.item)).toContain('milestones_at_least');
  });

  it('总分、报价、周期都相同时按 agent_id 字典序稳定排序', () => {
    const first = makeBid({ bid_id: 'BID-A', agent_id: 'agent-a', quote_cny: 5, delivery_days: 5 });
    const second = makeBid({ bid_id: 'BID-B', agent_id: 'agent-b', quote_cny: 5, delivery_days: 5 });
    const outcome = rankBids(policy, pricing, makeCard({ minBids: 1 }), budget, [second, first]);

    expect(outcome.winner.agent_id).toBe('agent-a');
    expect(outcome.ranking.map((entry) => entry.agent_id)).toEqual(['agent-a', 'agent-b']);
    expect(outcome.ranking[0].total).toBe(outcome.ranking[1].total);
  });

  it('合格投标少于 min_bids 时不产生中标', () => {
    const outcome = rankBids(policy, pricing, card, budget, [makeBid()]);

    expect(outcome.qualified_count).toBe(1);
    expect(outcome.insufficient_bids).toBe(true);
    expect(outcome.winner).toBeNull();
    expect(outcome.ranking).toHaveLength(1);
  });

  it('同一批投标重复评审结果完全一致', () => {
    const first = rankBids(policy, pricing, card, budget, makeBids());
    const second = rankBids(policy, pricing, card, budget, makeBids());
    const simplify = (outcome) =>
      outcome.ranking.map((entry) => ({
        rank: entry.rank,
        agent_id: entry.agent_id,
        total: entry.total,
        scores: entry.scores,
      }));

    expect(simplify(first)).toEqual(simplify(second));
    expect(first.winner.agent_id).toBe(second.winner.agent_id);
  });

  it('G1/G2/G5/G6/G7/G8 各自能拦住对应投标', () => {
    const badProvider = validateBid(
      policy,
      pricing,
      card,
      budget,
      makeBid({ provider: 'other', model: 'unknown-model' })
    );
    expect(badProvider.fails.filter((fail) => fail.gate === 'G2')).toHaveLength(2);

    const badDelivery = validateBid(policy, pricing, card, budget, makeBid({ delivery_days: 15 }));
    expect(badDelivery.fails.some((fail) => fail.gate === 'G6')).toBe(true);

    const badPath = validateBid(
      policy,
      pricing,
      card,
      budget,
      makeBid({ touched_paths: ['tasks/T-001.md'] })
    );
    expect(badPath.fails.filter((fail) => fail.gate === 'G7').length).toBeGreaterThanOrEqual(2);

    const badPlan = validateBid(
      policy,
      pricing,
      card,
      budget,
      makeBid({ plan: { risks: [], invariants: ['INV-999'] } })
    );
    expect(badPlan.fails.filter((fail) => fail.gate === 'G8').length).toBeGreaterThanOrEqual(2);

    const badQuote = validateBid(policy, pricing, card, budget, makeBid({ quote_cny: 0 }));
    expect(badQuote.fails.some((fail) => fail.gate === 'G1')).toBe(true);

    const lossMaking = validateBid(policy, pricing, card, budget, makeBid({ quote_cny: 0.1 }));
    expect(lossMaking.fails.some((fail) => fail.gate === 'G5')).toBe(true);
  });

  it('允许路径内的投标不触发 G7', () => {
    const good = validateBid(
      policy,
      pricing,
      card,
      budget,
      makeBid({
        touched_paths: ['index.html', 'src/bid/score.mjs', 'tests/bid/review-bids.test.mjs'],
      })
    );

    expect(good.fails.filter((fail) => fail.gate === 'G7')).toHaveLength(0);
    expect(good.qualified).toBe(true);
  });

  it('标书解析只认正文里带 bidding 的 JSON 块', () => {
    const text = [
      '---',
      JSON.stringify({ task_id: 'T-001', status: 'draft' }),
      '---',
      '',
      '```json',
      JSON.stringify({ bidding: card.bidding }),
      '```',
    ].join('\n');
    const parsed = parseTaskCard(text);

    expect(parsed.front.task_id).toBe('T-001');
    expect(parsed.bidding.weights.price).toBe(0.45);
    expect(() => parseTaskCard('no front matter')).toThrow(/front-matter/);
    expect(() => parseTaskCard('---\n{"task_id":"T-001"}\n---\n')).toThrow(/bidding/);
  });
});

