import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nextEmail, registerUser, startServer, TEST_PASSWORD } from './helpers.mjs';

let server;

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server.stop();
});

describe('注册接口', () => {
  it('合法注册返回 201、role=USER、HttpOnly Cookie，且只存 scrypt 哈希', async () => {
    const email = nextEmail('register');
    const { response, payload, cookie } = await registerUser(server.base, {
      email,
      name: '注册用户',
    });

    expect(response.status).toBe(201);
    expect(payload.ok).toBe(true);
    expect(payload.user.email).toBe(email);
    expect(payload.user.role).toBe('USER');
    expect(payload.user).not.toHaveProperty('passwordHash');

    const setCookie = response.headers.get('set-cookie') || '';
    expect(setCookie).toContain('sm_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('Max-Age=604800');
    expect(cookie.startsWith('sm_session=')).toBe(true);

    const stored = server.readData().users.find((user) => user.email === email);
    expect(stored).toBeTruthy();
    expect(stored.passwordHash.startsWith('scrypt$16384$8$1$')).toBe(true);
    expect(stored.passwordHash).not.toContain(TEST_PASSWORD);
    expect(JSON.stringify(stored)).not.toContain(TEST_PASSWORD);
  });

  it('重复邮箱返回 409，且大小写视为同一邮箱', async () => {
    const email = nextEmail('dup');
    const first = await registerUser(server.base, { email: email.replace('dup', 'Dup') });
    expect(first.response.status).toBe(201);

    const second = await registerUser(server.base, { email });
    expect(second.response.status).toBe(409);
    expect(second.payload.ok).toBe(false);
    expect(second.payload.error).toContain('邮箱已注册');
  });

  it('弱口令 / 短密码 / 纯数字返回 400', async () => {
    const short = await registerUser(server.base, { password: 'abc123' });
    expect(short.response.status).toBe(400);
    expect(short.payload.ok).toBe(false);

    const common = await registerUser(server.base, { password: 'password' });
    expect(common.response.status).toBe(400);

    const digits = await registerUser(server.base, { password: '20241119' });
    expect(digits.response.status).toBe(400);
    expect(digits.payload.error).toContain('纯数字');
  });

  it('客户端传 role=ADMIN 被忽略，注册结果仍是 USER', async () => {
    const email = nextEmail('role');
    const { response, payload } = await registerUser(server.base, {
      email,
      body: { role: 'ADMIN' },
    });

    expect(response.status).toBe(201);
    expect(payload.user.role).toBe('USER');

    const stored = server.readData().users.find((user) => user.email === email);
    expect(stored.role).toBe('USER');
  });

  it('非法邮箱返回 400，且不创建用户', async () => {
    const before = server.readData().users.length;
    const { response, payload } = await registerUser(server.base, { email: 'not-an-email' });

    expect(response.status).toBe(400);
    expect(payload.ok).toBe(false);
    expect(server.readData().users.length).toBe(before);
  });
});
