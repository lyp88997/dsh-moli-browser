#!/usr/bin/env node
/**
 * 验收「本包作为 DSH 组合包（bundle）能不能一条命令装完即用」。
 *
 *   node scripts/verify-bundle.mjs [--tgz dist/dsh-moli-browser-<version>.tgz]   # 版本默认读根 package.json
 *
 * 全程在一次性隔离 DSH_HOME（/tmp）里跑，**不碰默认 profile**：
 *   1) 交付物形状：tarball 里只有**一个** package.json，带 shims、patch、bin 与可执行的 browsersvc
 *   2) dsh plugin --profile <p> add <tgz>  → 包进依赖、层追加到 dsh.profile.bundles
 *   3) --dump-config                       → 一个包就挂出接缝 browser + 33 工具 + cdp provider
 *                                            （关键：bundles 里**没有** dsh-builtin-browser）
 *   4) 默认自启命令指向装进来的 bin/browsersvc.mjs（不再需要用户自己配 autoStartCommand）
 *   5) ./browser 与 ./tool-browser 转出口的导出键与 dsh-builtin-browser 源模块**完全一致**
 *      （loader 挂的是模块本身；少一个 default 或多一个都会在组合期报错）
 *   6) dsh plugin --profile <p> remove <pkg> → 依赖与层同时移除
 *
 * 环境变量：DSH_BIN（默认 dsh）
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { linkHostPeers } from './lib/host-peers.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const DSH = process.env.DSH_BIN ?? 'dsh';
const PROFILE = 'bundleverify';
const PKG = 'dsh-moli-browser';

const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const hit = argv.find((a) => a === flag || a.startsWith(`${flag}=`));
  if (!hit) return fallback;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : argv[argv.indexOf(hit) + 1];
};
const PKG_VERSION = JSON.parse(readFileSync(resolve(HERE, '../package.json'), 'utf8')).version;
const TGZ = resolve(argOf('--tgz', resolve(HERE, `../dist/${PKG}-${PKG_VERSION}.tgz`)));

let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

if (!existsSync(TGZ)) {
  console.error(`找不到 tarball：${TGZ}\n先打包：pnpm pack --pack-destination dist（见 README §8）`);
  process.exit(2);
}

const root = mkdtempSync(join(tmpdir(), 'dshbundle-'));
const profileDir = join(root, 'profiles', PROFILE);
const installed = join(profileDir, 'node_modules', PKG);
function cleanup() {
  rmSync(root, { recursive: true, force: true });
}
process.on('exit', cleanup);

const env = { ...process.env, DSH_HOME: root };
function run(args, { allowFail = false } = {}) {
  const res = spawnSync(DSH, args, { env, encoding: 'utf8', timeout: 180_000 });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  if (!allowFail && res.status !== 0) {
    console.error(`\n命令失败：dsh ${args.join(' ')}\n${out}`);
    process.exit(2);
  }
  return { status: res.status, out };
}
const manifest = () => JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
const dumpConfig = () => run(['--profile', PROFILE, '--dump-config']).out;
function rowBlock(dump, id) {
  const lines = dump.split('\n');
  const i = lines.findIndex((l) => l.trim() === `- id: ${id}`);
  if (i < 0) return '';
  const out = [lines[i]];
  for (let j = i + 1; j < lines.length; j += 1) {
    if (/^\s*- id: /.test(lines[j])) break;
    out.push(lines[j]);
  }
  return out.join('\n');
}

console.log(`\n=== 组合包安装验收（隔离 DSH_HOME=${root}）===`);
console.log(`tarball: ${TGZ}\n`);

// 1) 交付物形状：单一包
console.log('1. 交付物形状（一个包）');
{
  const listed = spawnSync('tar', ['tzf', TGZ], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  const manifests = listed.filter((p) => p.endsWith('/package.json'));
  check('tarball 里没有 plugin/package.json（交付包只有根包）', !manifests.includes('package/plugin/package.json'), manifests.join(' , '));
  const probeManifest = spawnSync('tar', ['xzOf', TGZ, 'package/tools/seam-probe/package.json'], { encoding: 'utf8' }).stdout;
  check('tarball 里唯一的 dsh 组合包是根包（tools/seam-probe 只是诊断插件）', !/"dsh"\s*:/.test(probeManifest), probeManifest.slice(0, 80));
  check('tarball 含接缝/工具转出口', listed.includes('package/plugin/shims/browser.js') && listed.includes('package/plugin/shims/tool-browser.js'));
  check('tarball 含 bundle patch', listed.includes('package/plugin/cordis.patch.yml'));
  check('tarball 含守护进程 CLI', listed.includes('package/bin/browsersvc.mjs'));
  check('tarball 含随包全局技能（两份 SKILL.md + browser-runtime 的脚本）',
    listed.includes('package/skills/browser/SKILL.md')
    && listed.includes('package/skills/browser-runtime/SKILL.md')
    && listed.includes('package/skills/browser-runtime/scripts/browse.mjs')
    && listed.includes('package/skills/browser-runtime/scripts/chromium-wrapper.sh'),
    listed.filter((p) => p.startsWith('package/skills/')).join(' , ') || '（一个都没有）');
  check('tarball 含内置技能提供者（src/skill-provider.mjs 与 skills/ 一起发货）',
    listed.includes('package/src/skill-provider.mjs') && listed.includes('package/src/skills.mjs'),
    listed.filter((p) => p.startsWith('package/src/')).join(' , '));
}

// 2) 官方安装命令：包进依赖 + 层追加到 bundles
console.log('2. dsh plugin --profile … add <tgz>');
{
  const { status, out } = run(['plugin', '--profile', PROFILE, 'add', TGZ], { allowFail: true });
  check('add 退出码 0', status === 0, out.trim().split('\n').slice(-3).join(' | '));
  const m = existsSync(join(profileDir, 'package.json')) ? manifest() : {};
  check('依赖里出现本包（file: tarball 引用）',
    String(m.dependencies?.[PKG] ?? '').startsWith('file:'), JSON.stringify(m.dependencies ?? {}));
  const bundles = m.dsh?.profile?.bundles ?? [];
  check('dsh.profile.bundles 追加了本包', bundles.includes(PKG), JSON.stringify(bundles));
  check('bundles 里没有 dsh-builtin-browser（它是依赖，不是组合包）',
    !bundles.includes('dsh-builtin-browser'), JSON.stringify(bundles));
  check('接缝依赖被装进 profile（shims 才能解析）',
    existsSync(join(profileDir, 'node_modules', 'dsh-builtin-browser')));
  check('装好的包没有子 package.json', !existsSync(join(installed, 'plugin', 'package.json')));
  const binStat = existsSync(join(installed, 'bin', 'browsersvc.mjs'));
  check('装好的包里 browsersvc 存在且可执行',
    binStat && (readFileSync(join(installed, 'bin', 'browsersvc.mjs'), 'utf8').length > 0));
}

// 3) 一个包就挂出接缝 + 工具 + provider
console.log('3. --dump-config（一个包装完）');
{
  const dump = dumpConfig();
  check('出现本包层', /# == dsh-moli-browser/.test(dump));
  check('browser 行由本包挂出并选中 cdp-daemon',
    /name: dsh-moli-browser\/browser/.test(rowBlock(dump, 'browser'))
    && /browserProvider: cdp-daemon/.test(rowBlock(dump, 'browser')));
  check('tool-browser 行由本包挂出',
    /name: dsh-moli-browser\/tool-browser/.test(rowBlock(dump, 'tool-browser')));
  check('browser-moli provider 行已插入', /- id: browser-moli/.test(dump));
  check('本包三行没有 not found', !/entry "(browser|tool-browser|browser-moli)" not found/.test(dump));
}

// 4) 默认自启命令指向装进来的 bin（不再需要用户配 autoStartCommand）
console.log('4. 默认自启命令');
{
  const providerPath = join(installed, 'plugin', 'lib', 'provider.js');
  const script = `import(${JSON.stringify(providerPath)}).then(m => console.log(m.defaultAutoStartCommand() ?? '')).catch(e => console.log('ERR ' + e.message))`;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30_000 });
  const cmd = (res.stdout ?? '').trim();
  check('defaultAutoStartCommand 指向装进来的 browsersvc',
    cmd.includes(join(installed, 'bin', 'browsersvc.mjs')) && / start$/.test(cmd), cmd || (res.stderr ?? '').trim().split('\n')[0]);
}

// 5) 转出口形状必须与接缝模块一致（loader 挂的是模块本身）
console.log('5. 转出口形状（shim ≡ dsh-builtin-browser 的模块）');
{
  // 隔离 home 在 boot 之前没有 profiles/node_modules —— 宿主 dsh 在 boot 时才会把它建起来
  // （240 个 @deepseek-ai/* 入口），profile 内任何包向上查找都靠它解析宿主提供的 peer
  // （cordis / dsh-tools / dsh-llm …）。这里按同一机制补一份软链，才能从隔离 profile
  // import dsh-builtin-browser/*。真实部署里 boot 过就有，无需手工补。
  // 真实部署里 boot 过就有这份 peer 目录；隔离 home 没有，按同一机制补出来（scripts/lib/host-peers.mjs）。
  const peers = linkHostPeers({ root, dshBin: DSH });
  if (!peers.ok) check('能找到宿主 @deepseek-ai（补 profiles/node_modules 用）', false, peers.error);
  const script = `
    const keys = (m) => Object.keys(m).sort().join(',');
    const out = {};
    for (const spec of ['dsh-moli-browser/browser', 'dsh-builtin-browser/browser',
                        'dsh-moli-browser/tool-browser', 'dsh-builtin-browser/tool-browser']) {
      try { out[spec] = keys(await import(spec)); } catch (e) { out[spec] = 'ERR ' + e.code + ' ' + e.message.split('\\n')[0]; }
    }
    console.log(JSON.stringify(out));`;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: profileDir, env, encoding: 'utf8', timeout: 60_000,
  });
  const line = (res.stdout ?? '').split('\n').find((l) => l.startsWith('{')) ?? '{}';
  let shapes = {};
  try { shapes = JSON.parse(line); } catch { /* 保持空 */ }
  const seamBrowser = shapes['dsh-builtin-browser/browser'] ?? '';
  const shimBrowser = shapes['dsh-moli-browser/browser'] ?? '';
  const seamTools = shapes['dsh-builtin-browser/tool-browser'] ?? '';
  const shimTools = shapes['dsh-moli-browser/tool-browser'] ?? '';
  check('browser 转出口的导出键与源模块一致', shimBrowser !== '' && shimBrowser === seamBrowser,
    `shim=${shimBrowser} seam=${seamBrowser}`);
  check('tool-browser 转出口的导出键与源模块一致', shimTools !== '' && shimTools === seamTools,
    `shim=${shimTools} seam=${seamTools}`);
}

// 5b) 版本适配（P2）：启动期探测 + 宿主 peer 解析 + 工具面跟随
console.log('5b. 版本适配（启动期探测 / 宿主 peer / 工具面）');
{
  const compatPath = join(installed, 'plugin', 'lib', 'compat.js');
  const script = `
    const out = {};
    try { await import('dsh-moli-browser'); out.pluginEntry = 'ok'; }
    catch (e) { out.pluginEntry = 'ERR ' + e.code + ' ' + String(e.message).split('\\n')[0]; }
    const compat = await import(${JSON.stringify(compatPath)});
    out.versions = compat.readVersions();
    const bm = await import('dsh-builtin-browser/browser');
    const tm = await import('dsh-builtin-browser/tool-browser');
    const v = (deps) => { const r = compat.inspectSeam(deps); return { ok: r.ok, fatal: r.fatal, warnings: r.warnings }; };
    out.real = v({ browserModule: bm, toolModule: tm, hostVersion: out.versions.host });
    out.noDefault = v({ browserModule: { BrowserError: class {} }, toolModule: tm, hostVersion: out.versions.host });
    out.noApply = v({ browserModule: bm, toolModule: { name: 'tool-browser', inject: ['tools', 'browser'] }, hostVersion: out.versions.host });
    out.missingInject = v({ browserModule: bm, toolModule: { name: 'tool-browser', apply() {}, inject: ['tools'] }, hostVersion: out.versions.host });
    out.unknownHost = v({ browserModule: bm, toolModule: tm, hostVersion: '9.9.9-alpha.9' });
    out.message = compat.seamMismatchMessage({ fatal: ['x'], warnings: [] }, { host: '1.2.3', seam: '4.5.6' });
    console.log(JSON.stringify(out));`;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: profileDir, env, encoding: 'utf8', timeout: 60_000,
  });
  const line = (res.stdout ?? '').split('\n').find((l) => l.startsWith('{')) ?? '{}';
  let p = {};
  try { p = JSON.parse(line); } catch { /* 保持空 */ }
  const fatalOf = (key) => (p[key]?.fatal ?? []).join('；');

  check('本包入口在只声明 peer 时仍可 import（schemastery 解析到宿主）', p.pluginEntry === 'ok', p.pluginEntry ?? (res.stderr ?? '').trim().split('\n')[0]);
  check('本包不携带自己的 @deepseek-ai/schemastery（peer 由宿主提供）',
    !existsSync(join(installed, 'node_modules', '@deepseek-ai', 'schemastery')));
  check('读得到宿主 DSH 与接缝版本', Boolean(p.versions?.host) && Boolean(p.versions?.seam), JSON.stringify(p.versions));
  check('真实接缝通过启动期探测（0 fatal）', p.real?.ok === true && (p.real?.fatal ?? []).length === 0, fatalOf('real'));
  check('接缝缺默认导出 → 探测判死并说清缺什么',
    p.noDefault?.ok === false && /default/.test(fatalOf('noDefault')), fatalOf('noDefault'));
  check('tool-browser 缺 apply → 探测判死', p.noApply?.ok === false && /apply/.test(fatalOf('noApply')), fatalOf('noApply'));
  check('tool-browser 的 inject 缺 browser → 探测判死',
    p.missingInject?.ok === false && /inject/.test(fatalOf('missingInject')), fatalOf('missingInject'));
  check('未知宿主版本只告警、不阻断',
    p.unknownHost?.ok === true && /9\.9\.9-alpha\.9/.test((p.unknownHost?.warnings ?? []).join('；')),
    JSON.stringify(p.unknownHost));
  check('探测失败的人话带包名与期望面',
    /dsh-builtin-browser@0\.1\.22/.test(p.message ?? '') && /未启用/.test(p.message ?? ''), p.message);

  const seamToolsSrc = readFileSync(join(profileDir, 'node_modules', 'dsh-builtin-browser', 'lib', 'tool-browser', 'index.js'), 'utf8');
  const toolNames = new Set([...seamToolsSrc.matchAll(/'browser_[a-z0-9_]+'/g)].map((m) => m[0]));
  check('接缝工具面仍是 33 个且含 browser_a11y（变了就同步 README 工具表与计数）',
    toolNames.size === 33 && toolNames.has("'browser_a11y'"),
    `count=${toolNames.size} a11y=${toolNames.has("'browser_a11y'")}`);
}

// 5c) 客户端半边（网页面板）：loader 协议 + cordis 插件形状 + 只点平台种子表
console.log('5c. 客户端半边（网页面板）');
{
  const res = spawnSync(process.execPath, [join(HERE, 'lib', 'client-probe.mjs'), installed, PKG], {
    cwd: profileDir, env, encoding: 'utf8', timeout: 60_000,
  });
  const line = (res.stdout ?? '').split('\n').find((l) => l.startsWith('{')) ?? '{}';
  let c = {};
  try { c = JSON.parse(line); } catch { /* 保持空 */ }
  const installedPkg = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));

  check('tarball 里带 plugin/client.js', existsSync(join(installed, 'plugin', 'client.js')));
  check('package.json 声明 exports["./client"] 与 dsh.client.platform=web',
    installedPkg.exports?.['./client'] === './plugin/client.js' && installedPkg.dsh?.client?.platform === 'web',
    JSON.stringify({ client: installedPkg.exports?.['./client'], dsh: installedPkg.dsh?.client }));
  check('客户端入口走 window.__ModuleLoader__.load 且 id = 包名',
    c.imported === 'ok' && c.loads?.length === 1 && c.loads[0]?.id === PKG && c.loads[0]?.factory === 'function',
    JSON.stringify({ imported: c.imported, loads: c.loads, stderr: (res.stderr ?? '').trim().split('\n')[0] }));
  check('factory 返回标准 cordis 插件（apply + inject: slots）',
    c.apply === 'function' && (c.inject ?? []).includes('slots'), JSON.stringify({ apply: c.apply, inject: c.inject }));
  check('apply 把看板注册到 shell.overlay（list 槽，自带 id）',
    c.injected === 'shell.overlay' && c.register?.name === 'shell.overlay' && typeof c.register?.id === 'string',
    JSON.stringify({ injected: c.injected, register: c.register }));
  check('看板组件能渲染（没有数据时回落胶囊）', c.render === 'null', String(c.render));
  check('客户端半边引用实时窗口的三条路由（与服务端一字不差）',
    (c.liveRoutes ?? []).length === 3, JSON.stringify(c.liveRoutes));
  check('客户端半边引用两条写路由（清日志 / 改分辨率）',
    (c.writeRoutes ?? []).length === 2, JSON.stringify(c.writeRoutes));
  check('客户端半边导出可测的纯函数（几何夹取 / 设置规整 / 外观样式）',
    ['clampInt', 'clampRect', 'normalizeSettings', 'pillAnchor', 'withScheme', 'appearanceStyle'].every((name) => (c.internals ?? []).includes(name)),
    JSON.stringify(c.internals));
  check('窗口几何夹取：超界收进视口、没记过位置时摆正中',
    c.clamp?.oversize?.w === 800 && c.clamp?.oversize?.h === 600 && c.clamp?.oversize?.x === 0 && c.clamp?.oversize?.y === 0
      && c.clamp?.undersize?.w === 320 && c.clamp?.undersize?.h === 240
      && c.clamp?.anchored?.x === 200 && c.clamp?.anchored?.y === 150,
    JSON.stringify(c.clamp));
  check('窗口几何夹取认「面板间距」：可用区域扣掉两侧边距，落位不贴边',
    c.clamp?.margin?.w === 780 && c.clamp?.margin?.h === 580 && c.clamp?.margin?.x === 10 && c.clamp?.margin?.y === 10,
    JSON.stringify(c.clamp?.margin));
  check('窗口几何夹取认「顶部留白」：窗口不许压到宿主顶栏，且竖直方向在留白之下居中',
    c.clampTop?.none?.x === 200 && c.clampTop?.none?.y === 150
      && c.clampTop?.auto?.x === 200 && c.clampTop?.auto?.y === 174
      && c.clampTop?.pinned?.x === 10 && c.clampTop?.pinned?.y === 70,
    JSON.stringify(c.clampTop));
  check('顶部留白自动量：贴顶 + 够宽 + 高度合理里取最高的；量不到按 48；手填夹到 0~200',
    c.topInset?.measured === 96 && c.topInset?.none === 0 && c.topInset?.auto === 48
      && c.topInset?.manual === 120 && c.topInset?.clamped === 200 && c.topInset?.zero === 0,
    JSON.stringify(c.topInset));
  check('顶部留白上限生效：手填 60px 时窗口高度收在「视口 − 留白」以内，且不越下边界',
    c.clampTop?.capped?.h === 520 && c.clampTop?.capped?.y === 70,
    JSON.stringify(c.clampTop?.capped));
  check('贴合画面比例：优先用真实帧尺寸、没帧按设置的分辨率、给不出就不锁比例',
    c.ratio?.frame === '1920 / 1080' && c.ratio?.fallback === '1920 / 1080' && c.ratio?.bad === null,
    JSON.stringify(c.ratio));
  check('两项新设置（0.8.2）：顶部留白默认 auto（可手填 0~200）、贴合画面比例默认开',
    c.geoDefaults?.topInset === 'auto' && c.geoDefaults?.fitPicture === true
      && c.geoClamp?.topInset === 200 && c.geoClamp?.manual === 96
      && c.geoClamp?.auto === 'auto' && c.geoClamp?.fitOff === false,
    JSON.stringify({ defaults: c.geoDefaults, clamp: c.geoClamp }));
  check('设置规整：越界夹取、非法入口回落网页、新键有默认值（含 0.8.2 的新默认：不自动取帧 / 1920×1080 / 40% 毛玻璃）',
    c.settings?.quality === 95 && c.settings?.maxWidth === 320 && c.settings?.pollMs === 500
      && c.settings?.lines === 200 && c.settings?.tab === 'live'
      && c.settings?.pillPos === 'lt' && c.settings?.autoClean === 0
      && c.settings?.viewport === '1920x1080' && c.settings?.pillX === 15 && c.settings?.pillY === 48
      && c.settings?.panelGap === 10 && c.settings?.zBase === 40
      && c.settings?.borderColor === 'theme' && c.settings?.cardAlpha === 40 && c.settings?.glass === 'frost'
      // autoStream 缺省必须走 DEFAULT_SETTINGS（旧写法 `source.autoStream !== false` 会让「没给」变成 true）
      && c.settings?.autoStream === false,
    JSON.stringify(c.settings));
  check('窗口外观规整：颜色只认主题/无/6 位十六进制、不透明度夹到可读范围、未知玻璃档回落毛玻璃',
    c.appearanceClamp?.borderColor === 'theme' && c.appearanceClamp?.cardAlpha === 20
      && c.appearanceClamp?.glass === 'frost' && c.appearanceCustom === '#aabbcc',
    JSON.stringify({ clamp: c.appearanceClamp, custom: c.appearanceCustom }));
  check('窗口外观样式：自定义色 + 液态玻璃出高光与内圈描边，无边框 + 关玻璃出全透明边与零模糊；内部分区随透明度、分隔线随自定义色',
    c.appear?.liquid?.['--bsp-alpha'] === '60%' && c.appear?.liquid?.['--bsp-rim'] === '#aabbcc'
      && c.appear?.liquid?.['--bsp-blur'] === '18px' && c.appear?.liquid?.['--bsp-sat'] === '165%'
      && c.appear?.liquid?.['--bsp-glow'] === '1' && typeof c.appear?.liquid?.['--bsp-shadow'] === 'string'
      && c.appear?.plain?.['--bsp-alpha'] === '100%' && c.appear?.plain?.['--bsp-rim'] === 'transparent'
      && c.appear?.plain?.['--bsp-blur'] === '0px' && c.appear?.plain?.['--bsp-glow'] === '0'
      && c.appear?.plain?.['--bsp-shadow'] === undefined
      // 外壳透明了，里面那几块（标题栏/左侧入口/底栏/吸顶条）也必须跟着透明，否则只有边框线在变
      && /^color-mix\(in srgb,.+ 60%,transparent\)$/.test(c.appear?.liquid?.['--bsp-card'] ?? '')
      && /^color-mix\(in srgb,.+ 60%,transparent\)$/.test(c.appear?.liquid?.['--bsp-surface'] ?? '')
      && String(c.appear?.liquid?.['--bsp-card']).includes('bg-layer-2')
      && String(c.appear?.liquid?.['--bsp-surface']).includes('bg-layer-3')
      // 自定义边框色时内部隔线同色调一层浅的；主题/无边框时保持宿主细线
      && String(c.appear?.liquid?.['--bsp-divider']).includes('#aabbcc')
      && String(c.appear?.liquid?.['--bsp-divider']).includes('45%')
      && String(c.appear?.plain?.['--bsp-divider']).includes('border-l1')
      && /^color-mix\(in srgb,.+ 100%,transparent\)$/.test(c.appear?.plain?.['--bsp-surface'] ?? ''),
    JSON.stringify(c.appear));
  check('设置规整：像素量与分辨率档位越界一律拉回',
    c.settingsClamp?.pillX === 0 && c.settingsClamp?.pillY === 400
      && c.settingsClamp?.panelGap === 0 && c.settingsClamp?.zBase === 1
      && c.settingsClamp?.viewport === '1920x1080',
    JSON.stringify(c.settingsClamp));
  check('胶囊四角定位只给对角两边的偏移、非法值回落左上',
    c.pill?.lt?.left === '15px' && c.pill?.lt?.top === '48px' && c.pill?.lt?.right === 'auto' && c.pill?.lt?.bottom === 'auto'
      && c.pill?.rb?.right === '15px' && c.pill?.rb?.bottom === '48px' && c.pill?.rb?.left === 'auto' && c.pill?.rb?.top === 'auto'
      && c.pill?.bad?.left === '15px' && c.pill?.bad?.top === '48px',
    JSON.stringify(c.pill));
  check('胶囊偏移可自定义（水平 30 / 垂直 60 直接落到命中角）',
    c.pill?.custom?.right === '30px' && c.pill?.custom?.top === '60px'
      && c.pill?.custom?.left === 'auto' && c.pill?.custom?.bottom === 'auto',
    JSON.stringify(c.pill?.custom));
  check('胶囊「自由」位置：直接给 left/top，超出视口按自身尺寸夹回屏内（存储范围放宽到 0~10000）',
    c.pill?.free?.left === '900px' && c.pill?.free?.top === '500px'
      && c.pill?.free?.right === 'auto' && c.pill?.free?.bottom === 'auto'
      && c.pill?.freeFit?.left === '1050px' && c.pill?.freeFit?.top === '769px'
      && c.pillFreeClamp === 9999,
    JSON.stringify({ free: c.pill?.free, freeFit: c.pill?.freeFit, clamp: c.pillFreeClamp }));
  check('胶囊起点换算：自由读坐标、贴角按角 + 偏移 + 尺寸算、越界夹回（切到自由/起拖都不跳）',
    c.pillPoint?.free?.x === 900 && c.pillPoint?.free?.y === 500
      && c.pillPoint?.freeFar?.x === 1050 && c.pillPoint?.freeFar?.y === 769
      && c.pillPoint?.lt?.x === 15 && c.pillPoint?.lt?.y === 48
      && c.pillPoint?.rb?.x === 1035 && c.pillPoint?.rb?.y === 721,
    JSON.stringify(c.pillPoint));
  check('胶囊可拖动接线：指针事件 + 指针捕获 + 拖动阈值 + 自由档 + 拖动期抓手/禁触摸滚动',
    c.dragWiring?.pointerDown === true && c.dragWiring?.capture === true && c.dragWiring?.release === true
      && c.dragWiring?.freeMode === true && c.dragWiring?.slop === true
      && c.dragWiring?.grabbing === true && c.dragWiring?.touchAction === true,
    JSON.stringify(c.dragWiring));
  check('实时画面「最大边」默认提到 1920（0.8.3：与默认视口同长边，不再先缩后放）',
    c.defaultMaxWidth === 1920, JSON.stringify(c.defaultMaxWidth));
  check('取帧开关跨页签记忆：切回「网页」自动续上，不用再点「开始」（组件外记忆 + 默认值看「打开即取帧」 + 变化回写）',
    c.resumeWiring?.memory === true && c.resumeWiring?.init === true && c.resumeWiring?.keep === true,
    JSON.stringify(c.resumeWiring));
  check('地址栏输入补协议（与宿主 normalizeUrl 同规则，空串不提交）',
    c.scheme?.bare === 'https://example.com' && c.scheme?.full === 'http://a' && c.scheme?.empty === '',
    JSON.stringify(c.scheme));
  const seeds = new Set([
    'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
    '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
  ]);
  check('客户端只 require 平台种子表内的包（否则要打包或写进 dsh.client.inject）',
    (c.requires ?? []).length > 0 && (c.requires ?? []).every((name) => seeds.has(name)),
    JSON.stringify(c.requires));
}

// 6) 随包全局技能：装到技能根目录、台账归属、改过的文件不覆盖
console.log('6. 随包全局技能（skills/ → 技能根目录）');
{
  const skillsDir = join(root, 'skills');
  const bin = join(installed, 'bin', 'browsersvc.mjs');
  const call = (args) => spawnSync(process.execPath, [bin, ...args], { env, encoding: 'utf8', timeout: 30_000 });
  const before = call(['skills', '--dir', skillsDir]);
  check('空目录时 skills 报全部缺失且退出码 0',
    before.status === 0 && (before.stdout.match(/缺失/g) ?? []).length >= 7,
    (before.stdout ?? '').split('\n').slice(0, 2).join(' | '));

  const first = call(['skills', '--install', '--dir', skillsDir]);
  check('--install 把 7 个技能文件（含 scripts/）装进技能根目录',
    first.status === 0 && /装 7 · 升级 0/.test(first.stdout ?? '')
    && ['browser/SKILL.md', 'browser-runtime/SKILL.md', 'browser-runtime/scripts/fonts.conf']
      .every((rel) => existsSync(join(skillsDir, rel))),
    (first.stdout ?? '').split('\n')[0]);

  const marker = JSON.parse(readFileSync(join(skillsDir, '.dsh-moli-browser.skills.json'), 'utf8'));
  check('写入归属台账（版本 = 包版本，7 条哈希）',
    marker.version === PKG_VERSION && Object.keys(marker.files ?? {}).length === 7,
    JSON.stringify({ version: marker.version, files: Object.keys(marker.files ?? {}).length }));

  const again = call(['skills', '--install', '--dir', skillsDir]);
  check('重复安装是幂等的（7 个已最新、不重写台账）',
    again.status === 0 && /装 0 · 升级 0 · 已最新 7/.test(again.stdout ?? '') && /没有需要写入的改动/.test(again.stdout ?? ''),
    (again.stdout ?? '').split('\n')[0]);

  const edited = join(skillsDir, 'browser', 'SKILL.md');
  writeFileSync(edited, `${readFileSync(edited, 'utf8')}\n<!-- 用户自己加的一行 -->\n`);
  const guarded = call(['skills', '--install', '--dir', skillsDir]);
  check('磁盘上被改过的技能不覆盖（跳过 1 并说清原因）',
    guarded.status === 0 && /跳过 1/.test(guarded.stdout ?? '')
    && /被改过/.test(guarded.stdout ?? '')
    && readFileSync(edited, 'utf8').includes('用户自己加的一行'),
    (guarded.stdout ?? '').split('\n').slice(0, 2).join(' | '));

  const forced = call(['skills', '--install', '--force', '--dir', skillsDir]);
  check('--force 才覆盖（升级 1 且内容回到随包版本）',
    forced.status === 0 && /升级 1/.test(forced.stdout ?? '')
    && !readFileSync(edited, 'utf8').includes('用户自己加的一行'),
    (forced.stdout ?? '').split('\n')[0]);

  const listed = JSON.parse((call(['skills', '--dir', skillsDir, '--json']).stdout ?? '').trim() || '{}');
  check('skills --json 列出每个文件的状态与哈希（可被脚本消费）',
    Array.isArray(listed.files) && listed.files.length === 7
    && listed.files.every((f) => f.state === 'current' && typeof f.sourceHash === 'string')
    && listed.skillsDir === skillsDir,
    JSON.stringify({ skillsDir: listed.skillsDir, states: [...new Set((listed.files ?? []).map((f) => f.state))] }));

  const pluginSource = readFileSync(join(installed, 'plugin', 'lib', 'index.js'), 'utf8');
  check('插件把随包技能注册成内置提供者（registerProvider + rank 600 + 默认开）',
    /skillCtx\.skills\.registerProvider\(/.test(pluginSource)
    && /createSkillsProvider\(/.test(pluginSource)
    && /registerSkills: Schema\.boolean\(\)\.default\(true\)/.test(pluginSource)
    && /syncSkills: Schema\.boolean\(\)\.default\(false\)/.test(pluginSource),
    'index.js 里没有 registerProvider / registerSkills');
  check('插件仍保留可选的落盘同步（syncSkills 打开时才写文件 + skillsDir 可配）',
    /if \(config\.syncSkills === true\)/.test(pluginSource) && /syncSkills\(\{/.test(pluginSource)
    && /skillsDir: Schema\.string\(\)/.test(pluginSource));

  // 撤销：只撤本包写过且没被改过的文件（0.8.2 起，落盘会盖住内置那份，要能干净撤回）
  writeFileSync(edited, `${readFileSync(edited, 'utf8')}\n<!-- 又改了一次：撤销时应当保留 -->\n`);
  const undoKept = call(['skills', '--uninstall', '--dir', skillsDir]);
  check('--uninstall 保留用户改过的 1 个、撤掉其余 6 个（台账留在原地）',
    undoKept.status === 0 && /删 6 · 保留 1/.test(undoKept.stdout ?? '')
    && /被改过/.test(undoKept.stdout ?? '')
    && readFileSync(edited, 'utf8').includes('撤销时应当保留')
    && !existsSync(join(skillsDir, 'browser-runtime', 'scripts', 'browse.mjs'))
    && existsSync(join(skillsDir, '.dsh-moli-browser.skills.json')),
    (undoKept.stdout ?? '').split('\n').slice(0, 3).join(' | '));

  call(['skills', '--install', '--force', '--dir', skillsDir]);
  const undoAll = call(['skills', '--uninstall', '--dir', skillsDir]);
  check('--uninstall 撤净后删掉台账、不留空目录（技能回到只由内置提供者提供）',
    undoAll.status === 0 && /删 7 · 保留 0/.test(undoAll.stdout ?? '')
    && !existsSync(join(skillsDir, '.dsh-moli-browser.skills.json'))
    && !existsSync(join(skillsDir, 'browser')) && !existsSync(join(skillsDir, 'browser-runtime')),
    (undoAll.stdout ?? '').split('\n').slice(0, 2).join(' | '));
}

// 7) 官方移除命令：依赖与层同时移除
console.log('7. dsh plugin --profile … remove <pkg>');
{
  const { status, out } = run(['plugin', '--profile', PROFILE, 'remove', PKG], { allowFail: true });
  check('remove 退出码 0', status === 0, out.trim().split('\n').slice(-3).join(' | '));
  const m = manifest();
  check('依赖里不再有本包', !(PKG in (m.dependencies ?? {})), JSON.stringify(m.dependencies ?? {}));
  check('dsh.profile.bundles 里不再有本包',
    !(m.dsh?.profile?.bundles ?? []).includes(PKG), JSON.stringify(m.dsh?.profile?.bundles ?? []));
}

console.log(`\n结果：${passed} 通过，${failures.length} 失败${failures.length ? ` →\n  - ${failures.join('\n  - ')}` : ''}`);
process.exit(failures.length === 0 ? 0 : 1);
