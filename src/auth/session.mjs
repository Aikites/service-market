// src/auth/session.mjs —— 服务端会话与 Cookie。
//
// 约束（tasks/T-002.md §4.2）：
//   - token = randomBytes(32).base64url，只存 sha256(token)；
//   - TTL 7 天；过期/被删/哈希不匹配一律按未登录；
//   - 登录成功先删该用户旧会话再建新会话（轮换）；登出删除当前会话；
//   - Cookie: sm_session / HttpOnly / SameSite=Lax / Path=/ / Max-Age=604800，
//     NODE_ENV=production 时加 Secure；不设置 Domain。

import { createHash, randomBytes } from 'node:crypto';
import { mutateStore, readStore } from './store.mjs';

export const SESSION_COOKIE = 'sm_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SECURE_ENVS = new Set(['production']);

export function hashToken(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex');
}

export function parseCookieHeader(header) {
  const jar = Object.create(null);
  if (typeof header !== 'string' || !header.trim()) return jar;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    const raw = part.slice(index + 1).trim();
    try {
      jar[name] = decodeURIComponent(raw);
    } catch {
      jar[name] = raw;
    }
  }
  return jar;
}

export function sessionTokenFromRequest(req) {
  const header = req && req.headers ? req.headers.cookie : undefined;
  const jar = parseCookieHeader(header);
  const token = jar[SESSION_COOKIE];
  return typeof token === 'string' && token ? token : null;
}

function nowIso() {
  return new Date().toISOString();
}

function newSessionId() {
  return `ses_${randomBytes(9).toString('base64url')}`;
}

// 返回 { token, session }；token 只在这一刻出现在内存里，落盘前已哈希。
export async function createSession(userId) {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  const session = {
    id: newSessionId(),
    tokenHash: hashToken(token),
    userId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
  };

  await mutateStore((data) => {
    // 轮换：删除该用户全部旧会话（按 userId，不按 token）。
    data.sessions = data.sessions.filter((item) => item.userId !== userId);
    data.sessions.push(session);
  });

  return { token, session };
}

// 返回 { session, user } 或 null。
export async function resolveSession(token) {
  if (typeof token !== 'string' || !token) return null;

  const data = readStore();
  const tokenHash = hashToken(token);
  const session = data.sessions.find((item) => item.tokenHash === tokenHash);
  if (!session) return null;
  if (!(Date.parse(session.expiresAt) > Date.now())) return null;

  const user = data.users.find((item) => item.id === session.userId);
  if (!user) return null;

  return { session, user };
}

export async function revokeSession(token) {
  if (typeof token !== 'string' || !token) return false;
  const tokenHash = hashToken(token);
  return mutateStore((data) => {
    const before = data.sessions.length;
    data.sessions = data.sessions.filter((item) => item.tokenHash !== tokenHash);
    return data.sessions.length !== before;
  });
}

export async function revokeUserSessions(userId) {
  return mutateStore((data) => {
    const before = data.sessions.length;
    data.sessions = data.sessions.filter((item) => item.userId !== userId);
    return before - data.sessions.length;
  });
}

// 注意：v0 不按请求刷新 lastSeenAt（避免每个请求都写文件）；保留字段供后续使用。
export function sessionRemainingMs(session) {
  const expiresAt = Date.parse(session && session.expiresAt);
  if (!Number.isFinite(expiresAt)) return 0;
  return Math.max(0, expiresAt - Date.now());
}

export function sessionCookie(token) {
  return buildCookie(token, Math.floor(SESSION_TTL_MS / 1000));
}

export function clearSessionCookie() {
  return buildCookie('', 0);
}

function buildCookie(token, maxAgeSeconds) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (SECURE_ENVS.has(String(process.env.NODE_ENV || ''))) parts.push('Secure');
  return parts.join('; ');
}

export { nowIso };
