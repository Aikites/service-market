// tests/auth/helpers.mjs —— 认证测试共用：临时数据文件 + 真实 HTTP 服务。
// 所有测试都通过 AUTH_DATA_FILE 指向系统临时目录，不写仓库 data/auth.json。

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const TEST_PASSWORD = 'correct-horse-9';

let emailSeq = 0;

export function nextEmail(prefix = 'user') {
  emailSeq += 1;
  return `${prefix}${emailSeq}@example.com`;
}

export async function startServer(extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sm-auth-'));
  const dataFile = join(dir, 'auth.json');

  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: '0',
    NODE_ENV: 'test',
    AUTH_DATA_FILE: dataFile,
    ADMIN_EMAIL: '',
    ADMIN_PASSWORD: '',
    ...extraEnv,
  };

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`服务启动超时：${output}`)), 20000);

    const onData = (chunk) => {
      output += chunk.toString('utf8');
      const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => {
      output += chunk.toString('utf8');
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`服务退出 ${code}：${output}`));
    });
  });

  return {
    base,
    dataFile,
    dir,
    readData() {
      return JSON.parse(readFileSync(dataFile, 'utf8'));
    },
    writeData(data) {
      writeFileSync(dataFile, JSON.stringify(data, null, 2), 'utf8');
    },
    async stop() {
      await new Promise((resolve) => {
        child.once('exit', () => resolve());
        child.kill();
      });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function postJson(base, pathname, body, headers = {}) {
  return fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

export function cookieOf(response) {
  const raw = response.headers.get('set-cookie');
  if (!raw) return '';
  return raw.split(';')[0];
}

export function registerUser(base, overrides = {}) {
  const email = overrides.email || nextEmail();
  return postJson(base, '/api/auth/register', {
    name: overrides.name || '测试用户',
    email,
    password: overrides.password || TEST_PASSWORD,
    ...overrides.body,
  }).then(async (response) => ({
    response,
    payload: await response.json().catch(() => ({})),
    email,
    cookie: cookieOf(response),
  }));
}
