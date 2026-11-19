// src/auth/admin.mjs —— 管理员引导。
// 只从环境变量 ADMIN_EMAIL / ADMIN_PASSWORD 引导：库里没有该邮箱才创建 ADMIN；
// 已存在同名用户不改角色/密码；不提供默认管理员密码，示例值只放 .env.example。

import { randomBytes } from 'node:crypto';
import { checkPasswordPolicy, hashPassword } from './password.mjs';
import { mutateStore, readStore } from './store.mjs';

export function adminCredentials() {
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || '');
  if (!email || !password) return null;
  return { email, password };
}

export async function ensureAdminUser() {
  const creds = adminCredentials();
  if (!creds) return null;

  const existing = readStore().users.find((user) => user.email === creds.email);
  if (existing) return existing;

  const problem = checkPasswordPolicy(creds.password, creds.email);
  if (problem) {
    // 只提示策略问题，绝不回显密码本身。
    console.warn(`[auth] ADMIN_PASSWORD 不符合口令策略（${problem}），已跳过管理员引导`);
    return null;
  }

  const passwordHash = await hashPassword(creds.password);
  const now = new Date().toISOString();

  return mutateStore((data) => {
    const again = data.users.find((user) => user.email === creds.email);
    if (again) return again;

    const user = {
      id: `usr_${randomBytes(9).toString('base64url')}`,
      email: creds.email,
      name: '管理员',
      passwordHash,
      role: 'ADMIN',
      createdAt: now,
      updatedAt: now,
    };
    data.users.push(user);
    return user;
  });
}
