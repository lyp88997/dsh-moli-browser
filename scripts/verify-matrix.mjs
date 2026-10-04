#!/usr/bin/env node
/**
 * 多版本 DSH 兼容矩阵：把**同一个 tarball** 分别装进不同版本的 DSH，验证「装得上、挂得上、探测通过、能浏览」。
 *
 *   node scripts/verify-matrix.mjs                       # 只测 PATH 上的 dsh（当前宿主版本）
 *   node scripts/verify-matrix.mjs \
 *     --dsh /tmp/dsh-mat/0.1.7-rc.2/node_modules/.bin/dsh \
 *     --dsh /tmp/dsh-mat/0.1.7-rc.1/node_modules/.bin/dsh --smoke
 *
 * 每行（一个宿主版本）都在**一次性隔离 DSH_HOME** 里，依次：
 *   1) dsh plugin --profile <p> add <tgz>   → 依赖 + dsh.profile.bundles
 *   2) dsh --profile <p> --dump-config      → 本包层、browser 行选中 cdp-daemon、tool-browser 行、无预期外 not found
 *   3) 补宿主 peer 目录（scripts/lib/host-peers.mjs）→ 本包入口能 import
 *   4) apply(桩 ctx)                        → 启动期探测通过、注册出 cdp-daemon；打印探测到的宿主版本
 *   5) --smoke                              → 用**装进来的** bin 自启守护进程，真开一个页面并读回正文
 *
 * 刻意串行：每行一个无头内核（实测约 +600 MB），并行会顶到容器内存上限。
 * 环境变量：DSH_BIN 不参与（用 --dsh 指定），DSH_HOME 一律被覆盖为临时目录。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { linkHostPeers } from './lib/host-peers.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PKG = 'dsh-moli-browser';
const PROFILE = 'matrix';

const argv = process.argv.slice(2);
const valuesOf = (flag) => argv.flatMap((a, i) => (a === flag && argv[i + 1] ? [argv[i + 1]]
  : a.startsWith(`${flag}=`) ? [a.slice(flag.length + 1)] : []));
const KEEP = argv.includes('--keep');
const SMOKE = argv.includes('--smoke');
const PKG_VERSION = JSON.parse(readFileSync(resolve(HERE, '../package.json'), 'utf8')).version;
const TGZ = resolve(valuesOf('--tgz')[0] ?? resolve(HERE, `../dist/${PKG}-${PKG_VERSION}.tgz`));
const CASES = valuesOf('--dsh');
if (CASES.length === 0) CASES.push('dsh');

if (!existsSync(TGZ)) {
  console.error(`找不到 tarball：${TGZ}\n先打包：pnpm pack --pack-destination dist（见 README §8）`);
  process.exit(2);
}

/** 该 bin 背后的 DSH 版本（= 宿主包 package.json 的 version），失败返回 undefined。 */
function hostVersion(bin) {
  try {
    const which = spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).stdout.trim();
    if (!which) return undefined;
    return JSON.parse(readFileSync(join(dirname(dirname(realpathSync(which))), 'package.json'), 'utf8')).version;
  } catch {
    return undefined;
  }
}

const results = [];
function runCase(bin, index) {
  const version = hostVersion(bin) ?? bin;
  console.log(`\n=== ${version}  (${bin}) ===`);
  const root = mkdtempSync(join(tmpdir(), 'dshmatrix-'));
  const env = { ...process.env, DSH_HOME: root };
  const profileDir = join(root, 'profiles', PROFILE);
  const installed = join(profileDir, 'node_modules', PKG);
  const smokeRoot = join(root, 'smoke');
  const port = String(9400 + index);
  const checks = [];
  const ok = (name, pass, detail = '') => {
    checks.push({ name, pass: Boolean(pass), detail });
    console.log(`  ${pass ? '✓' : '✗'} ${name}${pass ? '' : ` — ${detail}`}`);
  };
  // 注意：`dsh plugin add` 自己会创建 profile 目录，所以这之前的命令不能用 cwd=profileDir
  // （spawnSync 的 cwd 不存在 → ENOENT、status=null、输出为空，看起来像命令失败）。
  const run = (cmd, args, timeout, cwd, extraEnv) => spawnSync(cmd, args, {
    env: extraEnv ? { ...env, ...extraEnv } : env, cwd, encoding: 'utf8', timeout,
  });

  try {
    const add = run(bin, ['plugin', '--profile', PROFILE, 'add', TGZ], 300_000);
    ok('add 退出码 0', add.status === 0, `${add.stdout ?? ''}${add.stderr ?? ''}`.trim().split('\n').slice(-3).join(' | '));
    const manifest = existsSync(join(profileDir, 'package.json'))
      ? JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) : {};
    ok('dependencies 指向本 tarball',
      String(manifest.dependencies?.[PKG] ?? '').startsWith('file:'), JSON.stringify(manifest.dependencies ?? {}));
    ok('dsh.profile.bundles 追加了本包',
      (manifest.dsh?.profile?.bundles ?? []).includes(PKG), JSON.stringify(manifest.dsh?.profile?.bundles ?? {}));

    const dump = run(bin, ['--profile', PROFILE, '--dump-config'], 180_000);
    const dumpOut = `${dump.stdout ?? ''}${dump.stderr ?? ''}`;
    ok('dump-config 退出码 0', dump.status === 0, dumpOut.trim().split('\n').slice(-2).join(' | '));
    ok('本包层 + browser 行选中 cdp-daemon',
      /# == dsh-moli-browser/.test(dumpOut) && /name: dsh-moli-browser\/browser/.test(dumpOut)
      && /browserProvider: cdp-daemon/.test(dumpOut));
    ok('tool-browser 行由本包挂出', /name: dsh-moli-browser\/tool-browser/.test(dumpOut));
    const unexpected = [...dumpOut.matchAll(/entry "([^"]+)" not found/g)]
      .map((m) => m[1]).filter((id) => id !== 'browser-electron' && id !== 'playwright-browser');
    ok('没有预期外的 not found', unexpected.length === 0, unexpected.join(', '));

    const peers = linkHostPeers({ root, dshBin: bin });
    ok('补出宿主 peer 目录', peers.ok, peers.error ?? '');

    const probeArgs = [join(HERE, 'lib', 'matrix-probe.mjs'), '--pkg-dir', installed];
    if (SMOKE) probeArgs.push('--smoke-root', smokeRoot, '--port', port);
    // DSH_BROWSER_SVC_ROOT 必须和自启命令的 --root 一致：provider 默认按它（否则 \$DSH_HOME/browser-service）
    // 去读 service.json 里的 token，不一致就会 401。
    const probe = run(process.execPath, probeArgs, SMOKE ? 180_000 : 60_000, profileDir,
      SMOKE ? { DSH_BROWSER_SVC_ROOT: smokeRoot } : undefined);
    const pick = (prefix) => (probe.stdout ?? '').split('\n').find((l) => l.startsWith(prefix));
    let probed = {};
    try { probed = JSON.parse((pick('MATRIX_JSON ') ?? '').slice('MATRIX_JSON '.length)); } catch { /* 保持空 */ }
    let page = {};
    try { page = JSON.parse((pick('MATRIX_PAGE ') ?? '').slice('MATRIX_PAGE '.length)); } catch { /* 保持空 */ }
    const probeErr = (probe.stderr ?? '').split('\n').map((l) => l.trim())
      .find((l) => /^([A-Za-z]*Error)\b/.test(l)) ?? '';
    ok('本包入口可在该宿主下加载并注册 provider',
      probed.registered?.includes('cdp-daemon') === true && probed.bareOk === true,
      probeErr || probed.bareError || (probe.stdout ?? '').slice(0, 200) || (probe.stderr ?? '').slice(0, 200));
    ok('启动期探测无 error 日志',
      Array.isArray(probed.logs?.error) && probed.logs.error.length === 0, JSON.stringify(probed.logs?.error ?? []));
    ok('探测到的宿主版本与本行一致',
      probed.versions?.host === version, `probe=${probed.versions?.host} row=${version}`);
    if (SMOKE) {
      // 断言只压在「导航到 example.com 且真的读到正文」：正文措辞是上游的外部事实（2026-09 已改），
      // 绑具体字符串会让矩阵因为别人改文案而红。
      ok('真开一个页面并读回正文',
        page.url === 'https://example.com/' && Number(page.contentLength) > 40, JSON.stringify(page));
    }
  } finally {
    if (SMOKE && existsSync(join(smokeRoot, 'service.json'))) {
      run(process.execPath, [join(installed, 'bin', 'browsersvc.mjs'), 'stop', '--root', smokeRoot], 60_000);
    }
    if (!KEEP) rmSync(root, { recursive: true, force: true });
  }
  const passed = checks.filter((c) => c.pass).length;
  console.log(`  → ${version}：${passed}/${checks.length} 通过${KEEP ? `（临时目录保留在 ${root}）` : ''}`);
  results.push({ version, bin, passed, total: checks.length, failed: checks.filter((c) => !c.pass).map((c) => c.name) });
}

console.log(`\n=== DSH 版本兼容矩阵（隔离 DSH_HOME${SMOKE ? ' + 真实浏览' : ''}）===\ntarball: ${TGZ}`);
CASES.forEach(runCase);

console.log('\n--- 汇总 ---');
for (const r of results) {
  console.log(`  ${r.passed === r.total ? '✓' : '✗'} DSH ${r.version}：${r.passed}/${r.total}${r.failed.length ? ` 失败：${r.failed.join('、')}` : ''}`);
}
const bad = results.filter((r) => r.passed !== r.total);
if (bad.length) {
  console.error(`\n有 ${bad.length} 个版本未通过：${bad.map((r) => r.version).join('、')}`);
  process.exit(1);
}
console.log(`\n全部 ${results.length} 个宿主版本通过。`);
