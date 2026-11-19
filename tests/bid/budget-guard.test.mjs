import { describe, expect, it } from 'vitest';
import {
  buildBudgetContext,
  estimateCostCny,
  buildPricingIndex,
  validateBid,
} from '../../src/bid/index.mjs';
import { makeBid, makeCard, makePolicy, makePricing } from './fixtures.mjs';

const pricing = makePricing();
const pricingIndex = buildPricingIndex(pricing);

describe('预算闸门', () => {
  it('空 state 标记 empty_state，缺失 state 标记 assumed_zero', () => {
    const empty = buildBudgetContext(makePolicy());
    const missing = buildBudgetContext(makePolicy(), { stateExists: false });

    expect(empty.source).toBe('empty_state');
    expect(empty.spent).toBe(0);
    expect(empty.remaining).toBe(8);
    expect(missing.source).toBe('assumed_zero');
    expect(missing.remaining).toBe(8);
  });

  it('从 state 读出已花费并计算剩余', () => {
    const context = buildBudgetContext(makePolicy(), {
      rawState: JSON.stringify({ global: { budget: { daily_spent_cny: 2.5 } } }),
    });

    expect(context.source).toBe('state');
    expect(context.dailyMax).toBe(8);
    expect(context.spent).toBe(2.5);
    expect(context.remaining).toBe(5.5);
  });

  it('已花费超过上限时剩余按 0 截断，不出现负数', () => {
    const context = buildBudgetContext(makePolicy(), {
      rawState: JSON.stringify({ global: { budget: { daily_spent_cny: 12 } } }),
    });

    expect(context.remaining).toBe(0);
  });

  it('损坏 state 或上限不一致必须显式报错', () => {
    expect(() =>
      buildBudgetContext(makePolicy(), { rawState: '{not-json' })
    ).toThrow(/不是合法 JSON/);
    expect(() =>
      buildBudgetContext(makePolicy(), {
        rawState: JSON.stringify({ global: { budget: { daily_spent_cny: 1 } } }),
      })
    ).not.toThrow();
    expect(() =>
      buildBudgetContext(makePolicy(), {
        rawState: JSON.stringify({ global: { budget: { daily_spent_cny: 1, daily_max_cny: 99 } } }),
      })
    ).toThrow(/不一致/);
  });

  it('超过单任务上限判 G3，超过当日剩余判 G4', () => {
    const card = makeCard({ taskMax: 8 });
    const budget = buildBudgetContext(makePolicy(), {
      rawState: JSON.stringify({ global: { budget: { daily_spent_cny: 3 } } }),
    });
    const quote = makeBid({ quote_cny: 9 });
    const result = validateBid(makePolicy(), pricingIndex, card, budget, quote);

    expect(result.fails.some((fail) => fail.gate === 'G3')).toBe(true);
    expect(result.fails.some((fail) => fail.gate === 'G4')).toBe(true);
    expect(result.qualified).toBe(false);
  });

  it('闸门阈值来自标书和 policy，不是硬编码', () => {
    const strictCard = makeCard({ taskMax: 5 });
    const looseCard = makeCard({ taskMax: 8 });
    const bid = makeBid({ quote_cny: 5.5 });
    const budget = buildBudgetContext(makePolicy());

    const strict = validateBid(makePolicy(), pricingIndex, strictCard, budget, bid);
    const loose = validateBid(makePolicy(), pricingIndex, looseCard, budget, bid);

    expect(strict.fails.some((fail) => fail.gate === 'G3')).toBe(true);
    expect(loose.fails.some((fail) => fail.gate === 'G3')).toBe(false);
  });

  it('报价恰好等于上限时放行，剩余为 0 时只拦超额报价', () => {
    const card = makeCard({ taskMax: 8 });
    const exact = validateBid(
      makePolicy(),
      pricingIndex,
      card,
      buildBudgetContext(makePolicy()),
      makeBid({ quote_cny: 8 })
    );
    expect(exact.fails.filter((fail) => fail.gate === 'G3' || fail.gate === 'G4')).toHaveLength(0);

    const exhausted = buildBudgetContext(makePolicy(), {
      rawState: JSON.stringify({ global: { budget: { daily_spent_cny: 8 } } }),
    });
    const over = validateBid(
      makePolicy(),
      pricingIndex,
      card,
      exhausted,
      makeBid({ quote_cny: 0.01 })
    );
    expect(over.fails.some((fail) => fail.gate === 'G4')).toBe(true);
  });

  it('复算成本与价格表一致，未知模型返回 null', () => {
    expect(estimateCostCny(pricingIndex, makeBid())).toBe(0.2995);
    expect(estimateCostCny(pricingIndex, makeBid({ model: 'unknown-model' }))).toBeNull();
    expect(estimateCostCny(pricingIndex, makeBid({ estimate: { input_tokens: 'x' } }))).toBeNull();
  });

  it('日上限变化会同步改变可用余额', () => {
    const context = buildBudgetContext(makePolicy({ dailyMax: 10 }), {
      rawState: JSON.stringify({ global: { budget: { daily_spent_cny: 3 } } }),
    });

    expect(context.dailyMax).toBe(10);
    expect(context.remaining).toBe(7);
    expect(context.remaining).not.toBe(5);
  });
});
