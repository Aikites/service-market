import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cookieOf, nextEmail, postJson, registerUser, startServer, TEST_PASSWORD } from './helpers.mjs';
import { requireAdmin, requireUser } from '../../src/auth/middleware.mjs';

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-pass-2026';

let server;

beforeAll(async () => {
  server = await startServer({ ADMIN_EMAIL, ADMIN_PASSWORD });
  // 直接调用中间件的测试与子进程共用同一个数据文件。
  process.env.AUTH_DATA_FILE = server.dataFile;
});

afterAll(async () => {
  await server.stop();
});

function openAdmin(cookie) {
  return fetch(`${server.base}/admin.html`, {
    redirect: 'manual',
    headers: cookie ? { cookie } : {},
  });
}

describe('角色中间件与管理页', () => {
  it('匿名访问 /admin.html 返回 302 到登录页', async () => {
    const response = await openAdmin();
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/login?next=/admin.html');
  });

  it('USER 访问 /admin.html 返回 403，ADMIN 返回 200', async () => {
    const user = await registerUser(server.base);
    expect(user.response.status).toBe(201);

    const forbidden = await openAdmin(user.cookie);
    expect(forbidden.status).toBe(403);

    const adminLogin = await postJson(server.base, '/api/auth/login', {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });
    expect(adminLogin.status).toBe(200);
    const adminCookie = cookieOf(adminLogin);
    expect(adminCookie.startsWith('sm_session=')).toBe(true);

    const adminPage = await openAdmin(adminCookie);
    expect(adminPage.status).toBe(200);
    const html = await adminPage.text();
    expect(html).toContain('运营管理台');
  });

  it('客户端传 role=ADMIN 不能提权，管理页仍 403', async () => {
    const email = nextEmail('escalate');
    const created = await registerUser(server.base, { email, body: { role: 'ADMIN' } });
    expect(created.response.status).toBe(201);
    expect(created.payload.user.role).toBe('USER');

    const response = await openAdmin(created.cookie);
    expect(response.status).toBe(403);
  });

  it('requireUser 无会话返回 401，requireAdmin 对 USER 返回 403', async () => {
    await expect(requireUser({ headers: {} })).rejects.toMatchObject({ status: 401 });

    const user = await registerUser(server.base);
    await expect(requireAdmin({ headers: { cookie: user.cookie } })).rejects.toMatchObject({ status: 403 });
  });

  it('USER 可以用密码登录，但登录本身不改变角色', async () => {
    const email = nextEmail('login-role');
    const registered = await registerUser(server.base, { email });

    const login = await postJson(server.base, '/api/auth/login', { email, password: TEST_PASSWORD });
    const payload = await login.json();

    expect(login.status).toBe(200);
    expect(payload.user.role).toBe('USER');
    expect(registered.payload.user.role).toBe('USER');
  });
});
