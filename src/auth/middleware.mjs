// src/auth/middleware.mjs —— 角色中间件，供静态页与后续管理接口复用。
// 所有身份都来自服务端会话；不信任 body/query/header 里的 userId 或 role。

import { HttpError } from './http.mjs';
import { resolveSession, sessionTokenFromRequest } from './session.mjs';

export function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    createdAt: user.createdAt,
  };
}

// 返回 { user, session, token } 或 null。
export async function getSession(req) {
  const token = sessionTokenFromRequest(req);
  if (!token) return null;
  const found = await resolveSession(token);
  if (!found) return null;
  return { ...found, token };
}

export async function currentUser(req) {
  const found = await getSession(req);
  return found ? found.user : null;
}

export async function requireUser(req) {
  const found = await getSession(req);
  if (!found) throw new HttpError(401, '未登录');
  return found;
}

export async function requireAdmin(req) {
  const found = await getSession(req);
  if (!found) throw new HttpError(401, '未登录');
  if (found.user.role !== 'ADMIN') throw new HttpError(403, '需要管理员权限');
  return found;
}

export function isAdmin(user) {
  return Boolean(user && user.role === 'ADMIN');
}
