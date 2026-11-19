import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cookieOf, nextEmail, postJson, registerUser, startServer, TEST_PASSWORD } from './helpers.mjs';

let server;

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server.stop();
});

function login(email, password) {
  return postJson(server.base, '/api/auth/login', { email, password });
}

describe('登录接口', () => {
  it('正确密码返回 200、user 和新的会话 Cookie', async () => {
    const email = nextEmail('login-ok');
    const registered = await registerUser(server.base, { email });
    expect(registered.response.status).toBe(201);

    const response = await login(email, TEST_PASSWORD);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.user.email).toBe(email);
    expect(payload.user).not.toHaveProperty('passwordHash');
    expect(cookieOf(response).startsWith('sm_session=')).toBe(true);
  });

  it('错误密码与不存在邮箱都返回同一个 401 文案', async () => {
    const email = nextEmail('login-bad');
    await registerUser(server.base, { email });

    const wrongPassword = await login(email, 'wrong-password-1');
    const wrongPayload = await wrongPassword.json();
    expect(wrongPassword.status).toBe(401);
    expect(wrongPayload.ok).toBe(false);

    const missing = await login(`nobody-${Date.now()}@example.com`, 'wrong-password-1');
    const missingPayload = await missing.json();
    expect(missing.status).toBe(401);
    expect(missingPayload.error).toBe(wrongPayload.error);
    expect(wrongPayload.error).toBe('邮箱或密码错误');
  });

  it('连续 5 次失败后第 6 次返回 429 且带 Retry-After', async () => {
    const email = nextEmail('login-limited');
    await registerUser(server.base, { email });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await login(email, 'wrong-password-1');
      expect(response.status).toBe(401);
    }

    const limited = await login(email, TEST_PASSWORD);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    const payload = await limited.json();
    expect(payload.ok).toBe(false);
  });

  it('成功登录会清空失败计数，之后的错误密码回到 401', async () => {
    const email = nextEmail('login-reset');
    await registerUser(server.base, { email });

    expect((await login(email, 'wrong-password-1')).status).toBe(401);
    expect((await login(email, 'wrong-password-2')).status).toBe(401);
    expect((await login(email, TEST_PASSWORD)).status).toBe(200);

    const afterSuccess = await login(email, 'wrong-password-3');
    expect(afterSuccess.status).toBe(401);
  });
});
