#!/usr/bin/env node
// scope/test_integrity.mjs —— 工厂完整性测试（8 阶段），本地与 CI 共用的唯一入口
//
// 为什么和最初的设计稿不一样（重要，别照着旧 flag 手抄）：
//   设计稿里的 --check-json / --stage budget / --stage score / --stage policy，在
//   scripts/verify.mjs 里原本都不存在。名字看着对，跑起来是「未知参数/未知阶段」的用法错误，
//   那种红是假红，会把真正的回归一起淹掉。现在每条都换成已实现、可单独复现的命令：
//     --check-json        全仓 JSON 语法体检（BOM / 截断 / 尾逗号）
//     --stages invariant  不变量阶段（等价设计稿的 --stage invariant）
//     --self-test         13 项正反例自检
//     --negative-test     只跑 7 条反例，断言坏输入必被判红
//     --regression        同一输入连跑两遍，断言逐字节一致
//     --only INV-00x      只判定指定不变量（拆出 budget / score 两个粒度）
//
// 非职责：不装依赖、不联网、不调用大模型、不改写任何配置；只调度 scripts/verify.mjs 并留存报告。
// 退出码：0 全部通过 / 1 有阶段失败 / 2 用法错误。
//
// 用法：
//   node scope/test_integrity.mjs                 跑 8 个阶段并写 scope/integrity-report.json
//   node scope/test_integrity.mjs --verbose       回放每个阶段的完整输出
//   node scope/test_integrity.mjs --json          只输出报告 JSON
//   node scope/test_integrity.mjs --only S06,S07  只跑指定阶段（本地定位用）

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCOPE_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCOPE_DIR, '..');
const REPORT_REL = 'scope/integrity-report.json';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d = null) => {
  const i = argv.indexOf(n);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : d;
};

const EXIT = { ok: 0, failed: 1, config: 2 };

// 顺序即门禁顺序：先语法、再不变量、再自证、再确定性、最后整包
const STAGES = [
  { id: 'S01', name: 'json-syntax', why: '全仓 JSON 可解析（BOM / 截断 / 尾逗号）', args: ['scripts/verify.mjs', '--check-json'] },
  { id: 'S02', name: 'invariant-rules', why: '按 docs/invariants.json 实跑 INV-001..003', args: ['scripts/verify.mjs', '--stages', 'invariant'] },
  { id: 'S03', name: 'self-test', why: '闸门自检：正例 + 反例共 13 项', args: ['scripts/verify.mjs', '--self-test'] },
  { id: 'S04', name: 'bad-case-reject', why: '反例必红：7 条坏输入必须被判失败', args: ['scripts/verify.mjs', '--negative-test'] },
  { id: 'S05', name: 'stable-regression', why: '确定性：同一输入连跑两遍逐字节一致', args: ['scripts/verify.mjs', '--regression'] },
  { id: 'S06', name: 'budget-limit', why: '预算类不变量 INV-001/INV-002 单独复核', args: ['scripts/verify.mjs', '--stages', 'invariant', '--only', 'INV-001,INV-002'] },
  { id: 'S07', name: 'score-range', why: '评分区间不变量 INV-003 单独复核', args: ['scripts/verify.mjs', '--stages', 'invariant', '--only', 'INV-003'] },
  { id: 'S08', name: 'final-policy', why: '整包门禁：schema + invariant 全量（等价 CI 门禁）', args: ['scripts/verify.mjs', '--stages', 'schema,invariant'] }
];

const USAGE = `
scope/test_integrity.mjs —— 工厂完整性测试（8 阶段）

用法：
  node scope/test_integrity.mjs                 跑全部 8 个阶段并写 ${REPORT_REL}
  node scope/test_integrity.mjs --verbose       回放每个阶段的完整输出
  node scope/test_integrity.mjs --json          只输出报告 JSON
  node scope/test_integrity.mjs --only S06,S07  只跑指定阶段（本地定位用）

退出码：0 全部通过 / 1 有阶段失败 / 2 用法错误。
`;

// 只做存在性校验：不因 cwd 不同而把报告写到别处
const cwd = existsSync(join(ROOT, 'scripts/verify.mjs')) ? ROOT : process.cwd();

function gitCommit() {
  const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return null;
  return r.stdout.trim() || null;
}

function firstMeaningfulLine(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  // 优先取结论行（结果：PASSED / [json] PASS / 自检全部通过 / 反例全部… / 回归通过）
  const verdict = lines.find((s) => /^(结果：|\[json\]|自检全部通过|自检失败|反例全部|反例失败|回归通过|回归失败|\d+\/\d+ 通过)/.test(s));
  const picked = verdict || lines[0] || '';
  return picked.slice(0, 160);
}

function runStage(stage) {
  const startedAt = Date.now();
  const res = spawnSync(process.execPath, stage.args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const duration = Date.now() - startedAt;
  const exitCode = typeof res.status === 'number' ? res.status : -1;
  const stdout = res.stdout || '';
  const stderr = res.stderr || '';
  const ok = !res.error && exitCode === EXIT.ok;
  return {
    id: stage.id,
    name: stage.name,
    why: stage.why,
    cmd: `node ${stage.args.join(' ')}`,
    status: ok ? 'passed' : 'failed',
    exit_code: exitCode,
    duration_ms: duration,
    summary: firstMeaningfulLine(stdout) || firstMeaningfulLine(stderr),
    // 只在失败时留全文，避免报告被日志撑大；截断上限 8000 字符
    output: ok ? null : `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`.slice(0, 8000),
    error: res.error ? `${res.error.code || 'SPAWN_ERROR'}: ${res.error.message}` : null
  };
}

function main() {
  if (flag('--help') || flag('-h')) {
    console.log(USAGE);
    return EXIT.ok;
  }

  const onlyRaw = opt('--only');
  const pick = onlyRaw ? onlyRaw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : null;
  const selected = pick ? STAGES.filter((s) => pick.includes(s.id) || pick.includes(s.name.toUpperCase())) : STAGES;
  if (selected.length === 0) {
    console.error(`[integrity] --only 未匹配到任何阶段；可选：${STAGES.map((s) => `${s.id}=${s.name}`).join(', ')}`);
    return EXIT.config;
  }
  if (!existsSync(join(cwd, 'scripts/verify.mjs'))) {
    console.error(`[integrity] 在 ${cwd} 下找不到 scripts/verify.mjs，请在仓库根目录执行`);
    return EXIT.config;
  }

  const quiet = flag('--json');
  if (!quiet) {
    console.log(`工厂完整性测试（${selected.length} 阶段）· node ${process.version} · ${process.platform}-${process.arch}`);
    console.log('');
  }

  const results = [];
  for (const stage of selected) {
    const r = runStage(stage);
    results.push(r);
    if (quiet) continue;
    console.log(`${r.id} ${r.name.padEnd(17)} ${r.status === 'passed' ? 'PASS' : 'FAIL'}  ${r.summary}`);
    if (r.status === 'failed' || flag('--verbose')) {
      for (const line of String(r.output || r.summary).split(/\r?\n/)) {
        if (line.trim() !== '') console.log(`    | ${line}`);
      }
    }
  }

  const passed = results.filter((r) => r.status === 'passed').length;
  const failed = results.length - passed;
  const report = {
    schema_version: 1,
    kind: 'integrity-report',
    runner: 'scope/test_integrity.mjs',
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    git_commit: gitCommit(),
    started_at: new Date().toISOString(),
    repo_root: ROOT,
    only: pick,
    summary: { total: results.length, passed, failed, ok: failed === 0 },
    stages: results
  };

  mkdirSync(join(ROOT, 'scope'), { recursive: true });
  writeFileSync(join(ROOT, REPORT_REL), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  if (quiet) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('');
    console.log(`${passed}/${results.length} 通过${failed ? `，${failed} 个阶段失败` : ''} · 报告 ${REPORT_REL}`);
    if (failed) console.log('结论：工厂未通过质检，CI 应阻断合并。');
  }
  return failed === 0 ? EXIT.ok : EXIT.failed;
}

process.exitCode = main();
