// 预算上下文：当日上限来自 policy，已花费来自 chain/state.json。
// 文件缺失、空文件、损坏三种情况必须显式区分，不能静默按 0 放行。

import { round6 } from './config.mjs';

function dailyMaxFromPolicy(policy) {
  const dailyMax = Number(policy?.budget?.daily?.max_cost_cny);
  if (!Number.isFinite(dailyMax) || dailyMax < 0) {
    throw new Error('policy.budget.daily.max_cost_cny 缺失或非法');
  }
  return dailyMax;
}

export function buildBudgetContext(
  policy,
  { rawState = null, stateFile = 'chain/state.json', stateExists = true } = {}
) {
  const dailyMax = dailyMaxFromPolicy(policy);

  if (stateExists === false) {
    return {
      dailyMax,
      spent: 0,
      remaining: round6(dailyMax),
      source: 'assumed_zero',
      state_file: stateFile,
    };
  }

  const raw = rawState === null || rawState === undefined ? '' : String(rawState);
  if (raw.trim() === '') {
    return {
      dailyMax,
      spent: 0,
      remaining: round6(dailyMax),
      source: 'empty_state',
      state_file: stateFile,
    };
  }

  let state;
  try {
    state = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${stateFile} 不是合法 JSON: ${error.message}`);
  }

  const budget = state?.global?.budget;
  if (!budget || typeof budget.daily_spent_cny !== 'number') {
    throw new Error(`${stateFile} 缺少 global.budget.daily_spent_cny`);
  }
  if (budget.daily_max_cny !== undefined && Number(budget.daily_max_cny) !== dailyMax) {
    throw new Error(
      `${stateFile} daily_max_cny=${budget.daily_max_cny} 与 policy ${dailyMax} 不一致，需人工对账`
    );
  }

  const spent = round6(Math.max(0, Number(budget.daily_spent_cny)));
  return {
    dailyMax,
    spent,
    remaining: round6(Math.max(0, dailyMax - spent)),
    source: 'state',
    state_file: stateFile,
  };
}
