import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cookieOf, nextEmail, postJson, registerUser, startServer, TEST_PASSWORD } from './helpers.mjs';

let server;

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server.stop();
});

function me(cookie) {
  return fetch(`${server.base}/api/auth/me`, {
    headers: cookie ? { cookie } : {},
  });
}

function login(email) {
  return postJson(server.base, '/api/auth/login', { email, password: TEST_PASSWORD }).then(async (response) => ({
    response,
    payload: await response.json().catch(() => ({})),
    cookie: cookieOf(response),
  }));
}

function tokenOf(cookie) {
  return cookie.startsWith('sm_session=') ? cookie.slice('sm_session='.length) : '';
}

describe('会话有效期、登出与轮换', () => {
  it('有效会话访问 /api/auth/me 返回 200', async () => {
    const email = nextEmail('session-ok');
    const registered = await registerUser(server.base, { email });
    expect(registered.response.status).toBe(201);

    const response = await me(registered.cookie);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.user.email).toBe(email);
    expect(typeof payload.session.expiresAt).toBe('string');
  });

  it('第二次登录轮换旧会话，旧 Cookie 失效且服务端只存 token 哈希', async () => {
    const email = nextEmail('session-rotate');
    const registered = await registerUser(server.base, { email });
    const firstCookie = registered.cookie;

    const second = await login(email);
    expect(second.response.status).toBe(200);

    const oldSession = await me(firstCookie);
    expect(oldSession.status).toBe(401);

    const newSession = await me(second.cookie);
    expect(newSession.status).toBe(200);

    const token = tokenOf(second.cookie);
    expect(token.length).toBeGreaterThan(20);

    const data = server.readData();
    const expectedHash = createHash('sha256').update(token, 'utf8').digest('hex');
    const stored = data.sessions.find((session) => session.tokenHash === expectedHash);
    expect(stored).toBeTruthy();
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(data)).not.toContain(token);
  });

  it('篡改过的 token 返回 401', async () => {
    const email = nextEmail('session-tamper');
    const registered = await registerUser(server.base, { email });
    const token = tokenOf(registered.cookie);

    const response = await me(`sm_session=${token}tampered`);
    expect(response.status).toBe(401);

    const payload = await response.json();
    expect(payload.ok).toBe(false);
  });

  it('服务端过期会话按未登录处理', async () => {
    const email = nextEmail('session-expired');
    const registered = await registerUser(server.base, { email });
    expect((await me(registered.cookie)).status).toBe(200);

    const data = server.readData();
    const expiredAt = new Date(Date.now() - 1000).toISOString();
    data.sessions = data.sessions.map((session) => ({ ...session, expiresAt: expiredAt }));
    server.writeData(data);

    const response = await me(registered.cookie);
    expect(response.status).toBe(401);
  });

  it('登出后旧 Cookie 返回 401，并清 Cookie', async () => {
    const email = nextEmail('session-logout');
    const registered = await registerUser(server.base, { email });

    const response = await postJson(
      server.base,
      '/api/auth/logout',
      {},
      { cookie: registered.cookie }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie') || '').toContain('Max-Age=0');

    const afterLogout = await me(registered.cookie);
    expect(afterLogout.status).toBe(401);
  });
});
