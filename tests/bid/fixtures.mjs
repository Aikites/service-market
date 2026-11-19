export function makePolicy({ dailyMax = 8, provider = 'deepseek' } = {}) {
  return {
    models: { provider },
    protected_paths: ['.github/**', 'chain/**', 'reports/**', 'tasks/**', 'scripts/verify.mjs'],
    budget: {
      task: { max_cost_cny: 8 },
      daily: { max_cost_cny: dailyMax },
      circuit_breaker: { single_call_max_cny: 2 },
    },
  };
}

export function makePricing() {
  return {
    pricing_versions: [
      {
        pricing_version: 'test-2026-11',
        effective_from: '2026-11-01T00:00:00.000Z',
        verified: false,
        models: [
          {
            model: 'deepseek-chat',
            input_cache_hit_per_1m: 0.5,
            input_cache_miss_per_1m: 2.0,
            output_per_1m: 8.0,
          },
          {
            model: 'deepseek-reasoner',
            input_cache_hit_per_1m: 1.0,
            input_cache_miss_per_1m: 4.0,
            output_per_1m: 16.0,
          },
        ],
      },
    ],
  };
}

export function makeCard({ taskMax = 8, minBids = 2, maxDeliveryDays = 14 } = {}) {
  return {
    front: {
      task_id: 'T-001',
      status: 'draft',
      budget: { max_cost_cny: taskMax },
      allowed_paths: ['index.html', 'server.js', 'src/**', 'tests/**', 'bids/**', 'docs/bid-hall.md'],
      forbidden_paths: ['chain/**', 'tasks/**', 'reports/**', 'scripts/verify.mjs'],
      invariants: ['INV-001', 'INV-002', 'INV-003'],
    },
    bidding: {
      bid_dir: 'bids/T-001',
      result_file: 'reports/T-001/bid-result.json',
      max_delivery_days: maxDeliveryDays,
      min_bids: minBids,
      weights: { price: 0.45, delivery: 0.25, quality: 0.3 },
      required_plan_sections: ['milestones', 'risks', 'test_plan', 'invariants'],
      quality_rubric: {
        milestones_at_least: 3,
        risks_at_least: 2,
        test_plan_at_least: 2,
        milestones_cover_all_touched: true,
        invariants_subset_of_task: true,
      },
      tie_break: ['total_desc', 'price_asc', 'delivery_asc', 'agent_id_asc'],
    },
  };
}

export function makeBudget(overrides = {}) {
  return {
    dailyMax: 8,
    spent: 0,
    remaining: 8,
    source: 'empty_state',
    state_file: 'chain/state.json',
    ...overrides,
  };
}

export function makeBid(overrides = {}) {
  const base = {
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
        { name: '测试与文档', days: 1, deliverable: 'tests/bid' },
      ],
      risks: ['投标字段缺失', '预算口径漂移'],
      test_plan: ['权重之和必须为 1', '超预算投标必须废标'],
      invariants: ['INV-001', 'INV-002'],
    },
    submitted_at: '2026-11-12T00:00:00.000Z',
  };

  return {
    ...base,
    ...overrides,
    estimate: { ...base.estimate, ...(overrides.estimate || {}) },
    plan: { ...base.plan, ...(overrides.plan || {}) },
  };
}

export function makeBids() {
  return [
    makeBid(),
    makeBid({
      bid_id: 'BID-BETA-01',
      agent_id: 'agent-beta',
      model: 'deepseek-reasoner',
      quote_cny: 9,
      delivery_days: 4,
      estimate: { input_tokens: 80000, output_tokens: 15000, cache_hit_ratio: 0.2 },
    }),
    makeBid({
      bid_id: 'BID-GAMMA-01',
      agent_id: 'agent-gamma',
      quote_cny: 4,
      delivery_days: 12,
      estimate: { input_tokens: 60000, output_tokens: 12000, cache_hit_ratio: 0.1 },
      plan: {
        milestones: [
          { name: '先出可用版本', days: 8, deliverable: 'index.html 雏形' },
          { name: '再补数据结构', days: 4, deliverable: 'src/bid' },
        ],
        risks: ['方案粗糙'],
        test_plan: ['基础用例'],
        invariants: ['INV-001'],
      },
    }),
  ];
}
