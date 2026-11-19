// src/auth/store.mjs —— v0 认证数据文件（data/auth.json）。
//
// 设计边界（tasks/T-002.md §3）：
//   - 默认 data/auth.json，可用 AUTH_DATA_FILE 覆盖（测试必须用临时文件）；
//   - 目录不存在时创建；tmp + rename 原子替换；文件权限尽量 0o600（Windows 忽略）；
//   - 同进程写操作用 Promise 队列串行，避免并发写坏 JSON；
//   - 读取时过滤过期会话。
//
// 明确限制：这是单实例文件存储，不是生产数据库；多进程/多实例会互相覆盖。

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_FILE = 'data/auth.json';
export const STORE_VERSION = 1;

export function authFilePath() {
  const custom = process.env.AUTH_DATA_FILE;
  if (typeof custom === 'string' && custom.trim()) {
    const value = custom.trim();
    return isAbsolute(value) ? value : resolve(process.cwd(), value);
  }
  return join(ROOT, DEFAULT_FILE);
}

export function emptyStore() {
  return { version: STORE_VERSION, users: [], sessions: [] };
}

function normalizeStore(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const users = Array.isArray(data.users)
    ? data.users.filter(
        (user) => user && typeof user === 'object' && typeof user.id === 'string' && typeof user.email === 'string'
      )
    : [];
  const now = Date.now();
  const sessions = Array.isArray(data.sessions)
    ? data.sessions.filter((session) => {
        if (!session || typeof session !== 'object') return false;
        if (typeof session.tokenHash !== 'string' || typeof session.userId !== 'string') return false;
        const expiresAt = Date.parse(session.expiresAt);
        return Number.isFinite(expiresAt) && expiresAt > now;
      })
    : [];
  return { version: STORE_VERSION, users, sessions };
}

export function readStore() {
  const file = authFilePath();
  if (!existsSync(file)) return emptyStore();

  const text = readFileSync(file, 'utf8');
  if (!text.trim()) return emptyStore();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 不把文件内容或路径细节抛给客户端，由 HTTP 层统一返回通用错误。
    throw new Error('认证数据文件损坏，需人工处理');
  }
  return normalizeStore(parsed);
}

export function writeStore(data) {
  const file = authFilePath();
  mkdirSync(dirname(file), { recursive: true });

  const payload = {
    version: STORE_VERSION,
    users: Array.isArray(data.users) ? data.users : [],
    sessions: Array.isArray(data.sessions) ? data.sessions : [],
  };

  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* Windows 上 chmod 可能无效，忽略 */
  }
  renameSync(tmp, file);
  return payload;
}

let writeQueue = Promise.resolve();

// 读-改-写整段串行：mutator 内可以抛错，抛错时不落盘。
export function mutateStore(mutator) {
  const task = writeQueue.then(async () => {
    const data = readStore();
    const result = await mutator(data);
    writeStore(data);
    return result;
  });
  writeQueue = task.then(
    () => undefined,
    () => undefined
  );
  return task;
}
