// src/auth/http.mjs —— 认证路由共用的 HTTP 助手。
// 统一错误形状 { ok:false, error }，不把堆栈或内部路径返回给客户端。

export const MAX_BODY_BYTES = 16 * 1024;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

function baseHeaders(extra) {
  return {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extra,
  };
}

export function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(
    status,
    baseHeaders({
      'content-type': 'application/json; charset=utf-8',
      ...extraHeaders,
    })
  );
  res.end(body);
}

export function sendText(res, status, text, extraHeaders = {}) {
  res.writeHead(
    status,
    baseHeaders({
      'content-type': 'text/plain; charset=utf-8',
      ...extraHeaders,
    })
  );
  res.end(text);
}

export function redirect(res, location) {
  res.writeHead(302, baseHeaders({ location, 'content-type': 'text/plain; charset=utf-8' }));
  res.end('Found');
}

export async function readJsonBody(req, limit = MAX_BODY_BYTES) {
  const contentType = String((req.headers && req.headers['content-type']) || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    throw new HttpError(415, '请求必须为 application/json');
  }

  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    throw new HttpError(413, '请求体过大');
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw new HttpError(413, '请求体过大');
    }
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) throw new HttpError(400, '请求体不能为空');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, '请求体必须是合法 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, '请求体必须是 JSON 对象');
  }
  return parsed;
}

// 带 Origin 的 POST 必须与 Host 同源，降低跨站写 Cookie 的风险。
export function assertSameOrigin(req) {
  const origin = req.headers && req.headers.origin;
  if (typeof origin !== 'string' || !origin) return;

  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new HttpError(403, '请求来源不合法');
  }

  const host = req.headers.host;
  if (!host || originHost !== host) {
    throw new HttpError(403, '跨站请求被拒绝');
  }
}

// 登录后的 next 只允许站内路径：单个 / 开头、不以 // 开头、不含反斜杠/控制字符。
export function safeNextPath(value) {
  if (typeof value !== 'string') return '/';
  const next = value.trim();
  if (!next.startsWith('/')) return '/';
  if (next.startsWith('//')) return '/';
  if (next.includes('\\')) return '/';
  if (/[\u0000-\u001f\u007f]/.test(next)) return '/';
  return next;
}
