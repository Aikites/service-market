// 竞标大厅的纯配置工具：不读环境变量、不碰 DOM、不联网。
// 金额上限与权重由调用方从 tasks/T-001.md 和 chain/policy.json 读入后传入。

export const WEIGHT_KEYS = ['price', 'delivery', 'quality'];

export function round6(value) {
  return Math.round(Number(value) * 1e6) / 1e6;
}

export function cny(value) {
  return `¥${round6(value).toFixed(2)}`;
}

export function normalizePath(value) {
  return String(value)
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

const escapeRegExpChar = (char) => char.replace(/[.+^${}()|[\]\\]/g, '\\$&');

export function globToRegExp(glob) {
  const pattern = normalizePath(glob);
  let source = '';

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += escapeRegExpChar(char);
    }
  }

  return new RegExp(`^${source}$`);
}

export function matchesAny(target, patterns = []) {
  return patterns.some((pattern) => globToRegExp(pattern).test(normalizePath(target)));
}

export function pathAllowed(touched, allowedPatterns = []) {
  const target = normalizePath(touched);

  for (const raw of allowedPatterns) {
    const allowed = normalizePath(raw);
    if (globToRegExp(allowed).test(target)) return true;

    const starAt = allowed.indexOf('*');
    if (starAt > 0 && target.startsWith(allowed.slice(0, starAt))) return true;
  }

  return false;
}

export function assertWeights(weights, sourceName = 'bidding.weights') {
  for (const key of WEIGHT_KEYS) {
    const value = Number(weights?.[key]);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`${sourceName}.${key} 必须是 0~1 之间的数字`);
    }
  }

  const sum = WEIGHT_KEYS.reduce((total, key) => total + Number(weights?.[key] || 0), 0);
  if (Math.abs(sum - 1) > 1e-9) {
    throw new Error(`${sourceName} 三项权重之和必须为 1，实际 ${round6(sum)}`);
  }
  return weights;
}

export function validateBiddingConfig(bidding, sourceName = 'bidding') {
  if (!bidding || typeof bidding !== 'object') {
    throw new Error(`${sourceName} 缺失`);
  }
  for (const key of ['bid_dir', 'result_file', 'max_delivery_days', 'min_bids', 'quality_rubric']) {
    if (bidding[key] === undefined || bidding[key] === null) {
      throw new Error(`${sourceName} 缺少 ${key}`);
    }
  }
  assertWeights(bidding.weights, `${sourceName}.weights`);
  return bidding;
}

export function parseTaskCard(text, sourceName = 'task card') {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(String(text));
  if (!match) throw new Error(`${sourceName}: front-matter 必须用 --- 包裹`);

  let front;
  try {
    front = JSON.parse(match[1]);
  } catch (error) {
    throw new Error(`${sourceName}: front-matter 必须是合法 JSON (${error.message})`);
  }

  const body = String(text).slice(match[0].length);
  let bidding = null;

  for (const block of body.matchAll(/```json\r?\n([\s\S]*?)```/g)) {
    let parsed;
    try {
      parsed = JSON.parse(block[1]);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === 'object' && parsed.bidding) {
      bidding = parsed.bidding;
      break;
    }
  }

  if (!bidding) throw new Error(`${sourceName}: 正文缺少含 bidding 的 json 代码块`);
  validateBiddingConfig(bidding, `${sourceName}: bidding`);

  return { front, body, bidding };
}
