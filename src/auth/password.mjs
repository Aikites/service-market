// src/auth/password.mjs —— scrypt 口令哈希与口令策略。
// 约束（见 tasks/T-002.md §4.1）：只用 Node 内置 crypto；禁止明文/可逆/MD5/SHA1 单次哈希；
// 校验失败返回 false，不把异常抛给 HTTP 层；登录时可用 dummyVerify 填充时序。

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

export const SCRYPT_PARAMS = Object.freeze({ N: 16384, r: 8, p: 1 });
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 72;

const SALT_BYTES = 16;
const KEY_BYTES = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const DUMMY_SALT = Buffer.from('sm-auth-dummy-salt', 'utf8');

const LIMITS = Object.freeze({
  N_MIN: 1024,
  N_MAX: 1048576,
  R_MAX: 32,
  P_MAX: 16,
  KEY_MIN: 32,
  KEY_MAX: 128,
  SALT_MIN: 8,
  SALT_MAX: 64,
});

// 常见弱口令（小写比较）。命中即拒绝，不追求覆盖全部字典。
const WEAK_PASSWORDS = new Set([
  '12345678',
  '123456789',
  '1234567890',
  'password',
  'password1',
  'password12',
  'passw0rd',
  'qwertyui',
  'qwerty123',
  '1qaz2wsx',
  'abc12345',
  'abcd1234',
  '11111111',
  '88888888',
  'iloveyou',
  'admin123',
  'letmein1',
  'welcome1',
  'sunshine',
  'football',
  'baseball',
  'dragon12',
  'monkey12',
  'master12',
  'trustno1',
  'superman',
  'starwars',
]);

function isPowerOfTwo(value) {
  return Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

function derive(password, salt, params, keylen) {
  return scrypt(password, salt, keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: SCRYPT_MAXMEM,
  });
}

// 输出格式：scrypt$N$r$p$saltBase64$hashBase64
export async function hashPassword(password) {
  if (typeof password !== 'string') throw new TypeError('password 必须是字符串');
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, SCRYPT_PARAMS, KEY_BYTES);
  return [
    'scrypt',
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

function parseStoredHash(stored) {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!isPowerOfTwo(N) || N < LIMITS.N_MIN || N > LIMITS.N_MAX) return null;
  if (!Number.isInteger(r) || r < 1 || r > LIMITS.R_MAX) return null;
  if (!Number.isInteger(p) || p < 1 || p > LIMITS.P_MAX) return null;

  const salt = Buffer.from(parts[4], 'base64');
  const key = Buffer.from(parts[5], 'base64');
  if (salt.length < LIMITS.SALT_MIN || salt.length > LIMITS.SALT_MAX) return null;
  if (key.length < LIMITS.KEY_MIN || key.length > LIMITS.KEY_MAX) return null;

  return { params: { N, r, p }, salt, key };
}

export async function verifyPassword(password, stored) {
  if (typeof password !== 'string') return false;
  const parsed = parseStoredHash(stored);
  if (!parsed) return false;
  try {
    const derived = await derive(password, parsed.salt, parsed.params, parsed.key.length);
    if (derived.length !== parsed.key.length) return false;
    return timingSafeEqual(derived, parsed.key);
  } catch {
    return false;
  }
}

// 邮箱不存在时也跑一次同参数 scrypt，降低「响应时间差暴露账号是否存在」。
export async function dummyVerify(password) {
  try {
    await derive(typeof password === 'string' ? password : '', DUMMY_SALT, SCRYPT_PARAMS, KEY_BYTES);
  } catch {
    /* 时序填充失败不影响判定结果 */
  }
  return false;
}

// 返回错误文案；通过返回 null。邮箱 local part 只用于「密码不能与邮箱前缀相同」。
export function checkPasswordPolicy(password, email = '') {
  if (typeof password !== 'string') return '密码必须是字符串';
  if (password.length < PASSWORD_MIN_LENGTH) return `密码至少 ${PASSWORD_MIN_LENGTH} 位`;
  if (password.length > PASSWORD_MAX_LENGTH) return `密码最多 ${PASSWORD_MAX_LENGTH} 位`;

  const lower = password.toLowerCase();
  if (WEAK_PASSWORDS.has(lower)) return '密码过于常见，请换一个';
  if (/^\d+$/.test(password)) return '密码不能是纯数字';
  if (/^(.)\1+$/.test(password)) return '密码不能是单个字符重复';

  const localPart = String(email).split('@')[0].toLowerCase();
  if (localPart.length >= 3 && lower === localPart) return '密码不能与邮箱前缀相同';

  return null;
}
