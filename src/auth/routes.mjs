// src/auth/routes.mjs —— 认证 HTTP 接口。
//
// 路由：POST /api/auth/register | /api/auth/login | /api/auth/logout，GET /api/auth/me。
// 安全约束（tasks/T-002.md §5/§7）：
//   - 注册角色固定 USER，客户端 role 一律忽略；
//   - 邮箱不存在与密码错误返回同一条 401 文案；
//   - 失败限流用进程内 Map（多实例失效，v0 单实例）；
//   - 错误统一 { ok:false, error }，不返回堆栈。

import { randomBytes } from 'node:crypto';
import { ensureAdminUser } from './admin.mjs';
import { assertSameOrigin, HttpError, readJsonBody, sendJson } from './http.mjs';
import { getSession, publicUser } from './middleware.mjs';
import { checkPasswordPolicy, dummyVerify, hashPassword, verifyPassword } from './password.mjs';
import {
  clearSessionCookie,
  createSession,
  revokeSession,
  sessionCookie,
  sessionTokenFromRequest,
} from './session.mjs';
import { mutateStore, readStore } from './store.mjs';

const REGISTER_WINDOW_MS = 60 * 60 * 1000;
const REGISTER_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const MAX_TRACKED_KEYS = 5000;
const EMAIL_MAX_LENGTH = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const NAME_MIN_LENGTH = 2;
const NAME_MAX_LENGTH = 30;

const registerAttempts = new Map();
const loginFailures = new Map();

function clientIp(req) {
  const socketAddress = req.socket && req.socket.remoteAddress;
  return String(socketAddress || (req.headers && req.headers['x-forwarded-for']) || 'unknown');
}

function sweep(map, windowMs) {
  const now = Date.now();
  for (const [key, entry] of map) {
    if (now - entry.startedAt >= windowMs) map.delete(key);
  }
}

function checkLimit(map, key, windowMs, max) {
  const entry = map.get(key);
  if (!entry) return { limited: false, retryAfter: 0 };
  const now = Date.now();
  if (now - entry.startedAt >= windowMs) return { limited: false, retryAfter: 0 };
  if (entry.count >= max) {
    return {
      limited: true,
      retryAfter: Math.max(1, Math.ceil((entry.startedAt + windowMs - now) / 1000)),
    };
  }
  return { limited: false, retryAfter: 0 };
}

function noteAttempt(map, key, windowMs) {
  const now = Date.now();
  const entry = map.get(key);
  if (!entry || now - entry.startedAt >= windowMs) {
    map.set(key, { count: 1, startedAt: now });
  } else {
    entry.count += 1;
  }
  if (map.size > MAX_TRACKED_KEYS) sweep(map, windowMs);
}

function normalizeEmail(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase();
}

function validateEmail(email) {
  if (!email) return '请填写邮箱';
  if (email.length > EMAIL_MAX_LENGTH) return `邮箱最长 ${EMAIL_MAX_LENGTH} 个字符`;
  if (!EMAIL_PATTERN.test(email)) return '邮箱格式不正确';
  return null;
}

function sendError(res, status, message, extraHeaders = {}) {
  return sendJson(res, status, { ok: false, error: message }, extraHeaders);
}

async function handleRegister(req, res) {
  assertSameOrigin(req);

  const ip = clientIp(req);
  const limit = checkLimit(registerAttempts, ip, REGISTER_WINDOW_MS, REGISTER_MAX_ATTEMPTS);
  if (limit.limited) {
    return sendError(res, 429, '注册过于频繁，请稍后再试', { 'retry-after': String(limit.retryAfter) });
  }
  noteAttempt(registerAttempts, ip, REGISTER_WINDOW_MS);

  const body = await readJsonBody(req);

  const email = normalizeEmail(body.email);
  const emailProblem = validateEmail(email);
  if (emailProblem) return sendError(res, 400, emailProblem);

  const name = String(body.name == null ? '' : body.name).trim();
  const nameLength = [...name].length;
  if (nameLength < NAME_MIN_LENGTH || nameLength > NAME_MAX_LENGTH) {
    return sendError(res, 400, `称呼需 ${NAME_MIN_LENGTH}–${NAME_MAX_LENGTH} 个字符`);
  }

  const password = typeof body.password === 'string' ? body.password : '';
  const passwordProblem = checkPasswordPolicy(password, email);
  if (passwordProblem) return sendError(res, 400, passwordProblem);

  // 首次注册时兜底引导管理员（幂等；未配置环境变量时直接返回 null）。
  await ensureAdminUser();

  if (readStore().users.some((user) => user.email === email)) {
    return sendError(res, 409, '邮箱已注册');
  }

  const passwordHash = await hashPassword(password);
  const now = new Date().toISOString();

  let created;
  try {
    created = await mutateStore((data) => {
      if (data.users.some((user) => user.email === email)) {
        throw new HttpError(409, '邮箱已注册');
      }
      const user = {
        id: `usr_${randomBytes(9).toString('base64url')}`,
        email,
        name,
        passwordHash,
        // 角色固定 USER；body.role 一律忽略，防止自升管理员。
        role: 'USER',
        createdAt: now,
        updatedAt: now,
      };
      data.users.push(user);
      return user;
    });
  } catch (error) {
    if (error instanceof HttpError) return sendError(res, error.status, error.message);
    throw error;
  }

  const { token } = await createSession(created.id);
  return sendJson(res, 201, { ok: true, user: publicUser(created) }, { 'set-cookie': sessionCookie(token) });
}

async function handleLogin(req, res) {
  assertSameOrigin(req);

  const body = await readJsonBody(req);
  const email = normalizeEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  const key = `${clientIp(req)}|${email}`;

  const limit = checkLimit(loginFailures, key, LOGIN_WINDOW_MS, LOGIN_MAX_FAILURES);
  if (limit.limited) {
    return sendError(res, 429, '登录失败次数过多，请稍后再试', {
      'retry-after': String(limit.retryAfter),
    });
  }

  const user = readStore().users.find((item) => item.email === email) || null;
  const passwordOk = user ? await verifyPassword(password, user.passwordHash) : await dummyVerify(password);

  if (!user || !passwordOk) {
    noteAttempt(loginFailures, key, LOGIN_WINDOW_MS);
    // 不区分「邮箱不存在」和「密码错误」。
    return sendError(res, 401, '邮箱或密码错误');
  }

  loginFailures.delete(key);
  const { token } = await createSession(user.id);
  return sendJson(res, 200, { ok: true, user: publicUser(user) }, { 'set-cookie': sessionCookie(token) });
}

async function handleLogout(req, res) {
  assertSameOrigin(req);
  const token = sessionTokenFromRequest(req);
  if (token) await revokeSession(token);
  // 幂等：未登录也返回 200。
  return sendJson(res, 200, { ok: true }, { 'set-cookie': clearSessionCookie() });
}

async function handleMe(req, res) {
  const found = await getSession(req);
  if (!found) return sendError(res, 401, '未登录');
  return sendJson(res, 200, {
    ok: true,
    user: publicUser(found.user),
    session: { expiresAt: found.session.expiresAt },
  });
}

const ROUTES = {
  '/api/auth/register': { POST: handleRegister },
  '/api/auth/login': { POST: handleLogin },
  '/api/auth/logout': { POST: handleLogout },
  '/api/auth/me': { GET: handleMe },
};

// 返回 true 表示该请求已被认证路由接管，false 表示交给 server.js 继续匹配。
export async function handleAuthRoute(req, res, pathname) {
  const handlers = ROUTES[pathname];
  if (!handlers) return false;

  const method = String(req.method || 'GET').toUpperCase();
  const handler = handlers[method];
  if (!handler) {
    sendError(res, 405, '方法不允许', { allow: Object.keys(handlers).join(', ') });
    return true;
  }

  try {
    await handler(req, res);
  } catch (error) {
    if (error instanceof HttpError) {
      sendError(res, error.status, error.message);
    } else if (!res.headersSent) {
      console.error('[auth] 认证接口内部错误:', error && error.message ? error.message : 'unknown');
      sendError(res, 500, '服务暂时不可用');
    } else {
      res.end();
    }
  }
  return true;
}
