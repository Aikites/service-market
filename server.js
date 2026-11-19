#!/usr/bin/env node
// 竞标大厅只读服务：不调用大模型、不联网、不写 chain/**。
// 三个接口：GET /api/bids、GET /api/bid-result、GET /api/budget。

import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureAdminUser } from './src/auth/admin.mjs';
import { getSession } from './src/auth/middleware.mjs';
import { handleAuthRoute } from './src/auth/routes.mjs';
import {
  buildBudgetContext,
  buildPricingIndex,
  parseTaskCard,
  rankBids,
} from './src/bid/index.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || '127.0.0.1';
const parsedPort = Number(process.env.PORT);
const PORT =
  Number.isInteger(parsedPort) && parsedPort >= 0 && parsedPort <= 65535 ? parsedPort : 3000;
const TASK_ID = 'T-001';

function absolute(relativePath) {
  return join(ROOT, relativePath);
}

function readText(relativePath) {
  return readFileSync(absolute(relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function loadContext() {
  const policy = readJson('chain/policy.json');
  const pricing = buildPricingIndex(readJson('chain/pricing.json'));
  const card = parseTaskCard(readText(`tasks/${TASK_ID}.md`), `tasks/${TASK_ID}.md`);

  const stateFile = 'chain/state.json';
  const statePath = absolute(stateFile);
  const stateExists = existsSync(statePath);
  const rawState = stateExists ? readFileSync(statePath, 'utf8') : null;
  const budget = buildBudgetContext(policy, { rawState, stateFile, stateExists });

  return { policy, pricing, card, budget };
}

function listBids(context) {
  const relativeDir = context.card.bidding.bid_dir;
  const dir = absolute(relativeDir);
  if (!existsSync(dir)) {
    return { bids: [], parse_errors: [], bid_dir: relativeDir, exists: false };
  }

  const files = readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort();
  const bids = [];
  const parseErrors = [];

  for (const file of files) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('顶层必须是对象');
      }
      bids.push(parsed);
    } catch (error) {
      parseErrors.push({ file: `${relativeDir}/${file}`, reason: error.message, gate: 'G0' });
    }
  }

  return { bids, parse_errors: parseErrors, bid_dir: relativeDir, exists: true };
}

function sanitizeBid(bid) {
  return {
    bid_id: bid.bid_id ?? null,
    agent_id: bid.agent_id ?? null,
    provider: bid.provider ?? null,
    model: bid.model ?? null,
    quote_cny: bid.quote_cny ?? null,
    delivery_days: bid.delivery_days ?? null,
    touched_paths: Array.isArray(bid.touched_paths) ? bid.touched_paths : [],
    plan: bid.plan ?? {},
    submitted_at: bid.submitted_at ?? null,
  };
}

function budgetPayload(context) {
  const { policy, pricing, card, budget } = context;
  return {
    task_max_cny: card.front.budget.max_cost_cny,
    daily_max_cny: budget.dailyMax,
    daily_spent_cny: budget.spent,
    daily_remaining_cny: budget.remaining,
    single_call_max_cny: policy.budget.circuit_breaker.single_call_max_cny,
    max_delivery_days: card.bidding.max_delivery_days,
    min_bids: card.bidding.min_bids,
    weights: card.bidding.weights,
    provider: policy.models.provider,
    models: [...pricing.byModel.keys()],
    pricing_version: pricing.current.pricing_version,
    pricing_verified: pricing.verified,
    budget_source: budget.source,
    state_file: budget.state_file,
  };
}

function computedResult(context, loaded) {
  const outcome = rankBids(
    context.policy,
    context.pricing,
    context.card,
    context.budget,
    loaded.bids
  );

  return {
    schema_version: 1,
    kind: 'bid-review',
    self_test: false,
    task_id: context.card.front.task_id,
    task_status: context.card.front.status,
    generated_at: null,
    source: 'computed',
    bidding_hash: null,
    sources: {
      policy: 'chain/policy.json',
      pricing: 'chain/pricing.json',
      pricing_version: context.pricing.current.pricing_version,
      pricing_verified: context.pricing.verified,
      bid_dir: loaded.bid_dir,
    },
    limits: budgetPayload(context),
    counts: {
      bids: outcome.bid_count,
      qualified: outcome.qualified_count,
      disqualified: outcome.disqualified.length,
      unparsable: loaded.parse_errors.length,
      min_bids: Number(context.card.bidding.min_bids),
    },
    insufficient_bids: outcome.insufficient_bids,
    disqualified: [
      ...loaded.parse_errors.map((parseError) => ({
        bid_id: null,
        agent_id: null,
        file: parseError.file,
        fails: [{ gate: parseError.gate, reason: parseError.reason }],
      })),
      ...outcome.disqualified,
    ],
    ranking: outcome.ranking.map((entry) => ({
      rank: entry.rank,
      bid_id: entry.bid_id,
      agent_id: entry.agent_id,
      provider: entry.provider,
      model: entry.model,
      quote_cny: entry.quote_cny,
      est_cost_cny: entry.est_cost_cny,
      delivery_days: entry.delivery_days,
      scores: entry.scores,
      total: entry.total,
      quality_detail: entry.quality_detail,
    })),
    winner: outcome.winner
      ? {
          bid_id: outcome.winner.bid_id,
          agent_id: outcome.winner.agent_id,
          quote_cny: outcome.winner.quote_cny,
          delivery_days: outcome.winner.delivery_days,
          total: outcome.winner.total,
          reason: `总分 ${outcome.winner.total} 排名第 1`,
        }
      : null,
    notes: ['评分由 src/bid 实时计算，未调用任何大模型'],
  };
}

function loadResult(context) {
  const resultFile = context.card.bidding.result_file;
  if (existsSync(absolute(resultFile))) {
    return { ...readJson(resultFile), source: 'report', result_file: resultFile };
  }
  return computedResult(context, listBids(context));
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, payload, method = 'GET') {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(method === 'HEAD' ? undefined : body);
}

function sendFile(res, relativePath, method) {
  const file = absolute(relativePath);
  if (!existsSync(file) || !statSync(file).isFile() || statSync(file).size === 0) {
    return sendJson(res, 404, { ok: false, error: '页面不存在' }, method);
  }

  const body = readFileSync(file);
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(file)] || 'application/octet-stream',
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  res.end(method === 'HEAD' ? undefined : body);
}

// 认证相关的 HTML 响应（302 / 403），与 JSON 接口分开，避免把 HTML 当 JSON 返回。
function sendHtml(res, status, html, extraHeaders = {}) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  res.end(html);
}

const FORBIDDEN_PAGE = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>403 · 需要管理员权限</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #080d1a; color: #e8eefb; font: 15px/1.7 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; }
      .card { max-width: 420px; padding: 28px 26px; border: 1px solid #22304d; border-radius: 16px; background: #111a2e; text-align: center; }
      h1 { margin: 0 0 10px; font-size: 22px; }
      p { margin: 0 0 18px; color: #93a4c3; }
      a { color: #38bdf8; text-decoration: none; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>403 · 需要管理员权限</h1>
      <p>当前账号不是管理员，无法打开运营页面。</p>
      <a href="/">返回竞标大厅</a>
    </div>
  </body>
</html>`;

async function handle(req, res) {
  const method = req.method || 'GET';

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname);
  } catch {
    return sendJson(res, 400, { ok: false, error: '请求路径非法' }, method);
  }

  // 认证接口是唯一的写入口；其余路径仍按 T-001 的只读规则处理。
  if (pathname.startsWith('/api/auth/')) {
    const handled = await handleAuthRoute(req, res, pathname);
    if (handled) return;
  }

  if (method !== 'GET' && method !== 'HEAD') {
    return sendJson(res, 405, { ok: false, error: '只读接口，仅支持 GET' }, method);
  }

  try {
    if (pathname === '/api/health') {
      return sendJson(res, 200, { ok: true }, method);
    }

    if (pathname === '/api/budget') {
      const context = loadContext();
      return sendJson(res, 200, { ok: true, ...budgetPayload(context) }, method);
    }

    if (pathname === '/api/bids') {
      const context = loadContext();
      const loaded = listBids(context);
      return sendJson(
        res,
        200,
        {
          ok: true,
          bid_dir: loaded.bid_dir,
          exists: loaded.exists,
          count: loaded.bids.length,
          parse_errors: loaded.parse_errors,
          bids: loaded.bids.map(sanitizeBid),
        },
        method
      );
    }

    if (pathname === '/api/bid-result') {
      const context = loadContext();
      return sendJson(res, 200, loadResult(context), method);
    }

    if (pathname === '/' || pathname === '/index.html') {
      return sendFile(res, 'index.html', method);
    }

    if (pathname === '/login' || pathname === '/login.html') {
      return sendFile(res, 'login.html', method);
    }

    if (pathname === '/register' || pathname === '/register.html') {
      return sendFile(res, 'register.html', method);
    }

    if (pathname === '/admin.html') {
      const session = await getSession(req);
      if (!session) {
        // 未登录：跳到登录页；next 由前端校验为站内路径。
        return sendHtml(res, 302, '跳转到登录页', { location: '/login?next=/admin.html' });
      }
      if (session.user.role !== 'ADMIN') {
        return sendHtml(res, 403, FORBIDDEN_PAGE);
      }
      return sendFile(res, 'admin.html', method);
    }

    return sendJson(res, 404, { ok: false, error: '接口不存在' }, method);
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: error.message }, method);
  }
}

const server = createServer((req, res) => {
  handle(req, res).catch((error) => {
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, error: error.message });
    } else {
      res.end();
    }
  });
});

async function main() {
  try {
    const admin = await ensureAdminUser();
    if (admin) console.log(`已引导管理员账号: ${admin.email}`);
  } catch (error) {
    console.warn('[auth] 管理员引导失败:', error && error.message ? error.message : 'unknown');
  }

  server.listen(PORT, HOST, () => {
    const address = server.address();
    const actualPort = address && typeof address === 'object' ? address.port : PORT;
    console.log(`竞标大厅已启动: http://${HOST}:${actualPort}`);
  });
}

main();
