#!/usr/bin/env node
/**
 * browsersvc —— 单例浏览器 CDP 守护进程的 CLI。
 *
 *   browsersvc start|stop|status|restart|run|logs|ops|console|network|har|cookies|detect|skills [--port=9333] [--idle-ms=900000]
 *              [--kernel=/path/to/chrome] [--wrapper=/path/to/wrapper.sh] [--root=/path/to/state]
 *              [--install] [--uninstall] [--force] [--dir=$DSH_HOME/skills]   # skills：查看/落盘/撤销随包技能
 *                                                                             #（插件默认把它们注册成「系统内置」技能，落盘是可选项）
 *
 * 约定：CDP 只监听 127.0.0.1；对外端口由本地代理暴露，代理同时负责空闲回收。
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectKernels, ensureRoot, logFile, readConfigFile, resolveConfig, stateFile } from '../src/config.mjs';
import { isAlive, probeVersion, readState, runSupervisor } from '../src/daemon.mjs';
import { readConsole, readNetwork, readOps } from '../src/opslog.mjs';
import { defaultSkillsRoot, inspectSkills, removeSkills, syncSkills } from '../src/skills.mjs';

const BIN = fileURLToPath(new URL('./browsersvc.mjs', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parse(argv) {
  const out = { cmd: argv[0] ?? 'status', flags: {} };
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) out.flags[a.slice(2, eq)] = a.slice(eq + 1);
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out.flags[a.slice(2)] = argv[++i];
    else out.flags[a.slice(2)] = true;
  }
  return out;
}

const toCfg = (flags) => resolveConfig({
  root: flags.root,
  port: flags.port,
  idleMs: flags['idle-ms'],
  kernel: flags.kernel,
  wrapper: flags.wrapper,
  maxRestarts: flags['max-restarts'],
  userDataDir: flags['user-data-dir'],
  startTimeoutMs: flags['start-timeout'],
  internalPortBase: flags['internal-port-base'],
});

function print(obj, code = 0) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  process.exit(code);
}

/** 读 /proc/<pid>/cmdline 用于身份校验；读不到（非 linux / 进程已退出）返回 null。 */
function pidCmdline(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
  } catch {
    return null;
  }
}

async function status(cfg, { quiet = false } = {}) {
  const st = readState(cfg.root);
  if (!st || !st.supervisorPid || !isAlive(st.supervisorPid)) {
    if (!quiet) print({ running: false, root: cfg.root, stateFile: stateFile(cfg.root) }, 1);
    return { running: false };
  }
  const version = st.port ? await probeVersion(st.port, 2000, st.token) : null;
  const info = {
    running: true,
    healthy: Boolean(version),
    port: st.port,
    internalPort: st.internalPort,
    pid: st.supervisorPid,
    browserPid: st.browserPid,
    kernel: st.kernel,
    kernelKind: st.kernelKind,
    browserVersion: version?.Browser ?? st.browserVersion,
    protocolVersion: version?.['Protocol-Version'] ?? st.protocolVersion,
    wsEndpoint: version?.webSocketDebuggerUrl ?? null,
    startedAt: st.startedAt,
    idleMs: st.idleMs,
    logFile: logFile(cfg.root),
  };
  if (!quiet) print(info, version ? 0 : 1);
  return info;
}

const toFlagArgs = (flagsIn) => Object.entries(flagsIn).map(([k, v]) => (v === true ? `--${k}` : `--${k}=${v}`));

async function start(cfg, { quiet = false } = {}) {
  ensureRoot(cfg.root);
  const existing = await status(cfg, { quiet: true });
  if (existing.running && existing.healthy) {
    const info = { alreadyRunning: true, ...existing };
    if (quiet) return info;
    print(info);
  }

  const out = openSync(logFile(cfg.root), 'a');
  const child = spawn(process.execPath, [BIN, 'run', ...toFlagArgs(flags)], {
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
  });
  child.unref();

  const until = Date.now() + cfg.startTimeoutMs;
  while (Date.now() < until) {
    await sleep(200);
    const st = readState(cfg.root);
    // 只看「port 能连」会误报：残留的旧状态文件里也有 port。必须确认这是本次
    // spawn 出来的 supervisor（pid 相同）且它已经完成了 listen（listening 字段）。
    if (st?.listening === true && st.supervisorPid === child.pid && st.port) {
      const version = await probeVersion(st.port, 2000, st.token);
      if (version) {
        const info = { started: true, pid: st.supervisorPid, browserPid: st.browserPid, port: st.port, browserVersion: version.Browser, protocolVersion: version['Protocol-Version'], kernel: st.kernel, root: cfg.root, logFile: logFile(cfg.root) };
        // 成功必须立刻返回：quiet 模式下没有 print 的 process.exit 兜底，否则会一直
        // 循环到超时，把刚启动好的实例报成失败（F23）。
        if (quiet) return info;
        print(info);
      }
    }
    if (child.exitCode !== null) {
      const info = { started: false, reason: `supervisor exited early (code ${child.exitCode})，见 ${logFile(cfg.root)}` };
      if (quiet) throw Object.assign(new Error(info.reason), { info });
      print(info, 1);
    }
  }
  const timeout = { started: false, reason: `在 ${cfg.startTimeoutMs}ms 内未就绪，见 ${logFile(cfg.root)}` };
  if (quiet) throw Object.assign(new Error(timeout.reason), { info: timeout });
  print(timeout, 1);
}

async function stop(cfg, { force = false, quiet = false } = {}) {
  const st = readState(cfg.root);
  if (!st) {
    const info = { stopped: true, reason: 'not running' };
    if (quiet) return info;
    print(info);
  }
  // pid 会被系统复用：动手前先确认这两个 pid 真的是状态文件登记的那两个进程，
  // 否则 SIGKILL 可能落到同 uid 的无关进程上（评审 F3）。
  let warning = null;
  if (!force && process.platform !== 'linux') {
    warning = '非 linux，无 /proc，无法核实 pid 身份，仅按 isAlive 处理';
  }
  if (!force && process.platform === 'linux') {
    const bad = [];
    const sup = st.supervisorPid ? pidCmdline(st.supervisorPid) : null;
    if (sup !== null && !sup.includes('browsersvc.mjs')) bad.push(`supervisor(${st.supervisorPid}) cmdline 不含 browsersvc.mjs：${sup}`);
    const brw = st.browserPid ? pidCmdline(st.browserPid) : null;
    if (brw !== null && st.internalPort && !brw.includes(`--remote-debugging-port=${st.internalPort}`)) bad.push(`browser(${st.browserPid}) cmdline 不含 --remote-debugging-port=${st.internalPort}：${brw}`);
    if (bad.length) {
      const info = { stopped: false, refused: true, reason: 'pid 身份校验未通过，未杀任何进程，状态文件已保留（确认无误后用 browsersvc stop --force）', details: bad, stateFile: stateFile(cfg.root) };
      if (quiet) return info;
      print(info, 1);
    }
  }
  const kill = async (pid, sig) => {
    if (!pid || !isAlive(pid)) return;
    try {
      process.kill(pid, sig);
    } catch {
      /* 已退出 */
    }
  };
  await kill(st.supervisorPid, 'SIGTERM');
  for (let i = 0; i < 100 && isAlive(st.supervisorPid); i += 1) await sleep(100);
  if (isAlive(st.supervisorPid)) await kill(st.supervisorPid, 'SIGKILL');
  await kill(st.browserPid, 'SIGTERM');
  for (let i = 0; i < 30 && isAlive(st.browserPid); i += 1) await sleep(100);
  if (isAlive(st.browserPid)) await kill(st.browserPid, 'SIGKILL');
  rmSync(stateFile(cfg.root), { force: true });
  const info = { stopped: true, supervisorPid: st.supervisorPid, browserPid: st.browserPid, ...(warning ? { warning } : {}) };
  if (quiet) return info;
  print(info);
}

function logs(cfg, flags) {
  const file = logFile(cfg.root);
  if (!existsSync(file)) print({ logs: [], reason: 'no log file yet', file });
  const n = Number(flags.lines ?? 60);
  if (!Number.isInteger(n) || n <= 0) print({ error: `invalid --lines: ${flags.lines}（需要正整数）` }, 2);
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  print({ file, lines: lines.slice(-n) });
}

/**
 * 观测：读回插件写下的最近 N 次浏览器操作（工具动作 / 耗时 / 成败 / 错误原因）。
 * 默认人话表格（一行一次操作），`--json` 给机器读。
 */
function ops(cfg, flags) {
  const n = Number(flags.lines ?? 20);
  if (!Number.isInteger(n) || n <= 0) print({ error: `invalid --lines: ${flags.lines}（需要正整数）` }, 2);
  const { file, total, entries } = readOps({ root: cfg.root, lines: n });
  if (flags.json === true) print({ file, total, entries });
  if (entries.length === 0) print({ file, total, reason: '暂无操作记录（插件跑过一次 browser_* 工具后就有了）' });
  const rows = entries.map((e) => {
    const time = Number.isFinite(e.at) ? new Date(e.at).toISOString().slice(11, 23) : '-';
    const ms = Number.isFinite(e.ms) ? `${e.ms}ms` : '-';
    const where = `${e.session ?? '-'}/${e.tab ?? '-'}`;
    const detail = e.error ?? e.result ?? '';
    return `${time}  ${e.ok ? '✓' : '✗'}  ${String(e.action ?? '?').padEnd(14)} ${ms.padStart(7)}  ${where.padEnd(8)}  ${detail}`;
  });
  process.stdout.write(`${rows.join('\n')}\n\n共 ${entries.length}/${total} 条 · ${file}\n`);
  process.exit(0);
}

/**
 * 控制台 / 网络观测流：默认人话表格（一行一条），`--json` 给机器读。
 */
function stream(cfg, flags, kind) {
  const n = Number(flags.lines ?? 40);
  if (!Number.isInteger(n) || n <= 0) print({ error: `invalid --lines: ${flags.lines}（需要正整数）` }, 2);
  const read = kind === 'console' ? readConsole : readNetwork;
  const { file, total, entries } = read({ root: cfg.root, lines: n });
  if (flags.json === true) print({ file, total, entries });
  if (entries.length === 0) print({ file, total, reason: `暂无${kind === 'console' ? '控制台' : '网络'}记录（插件跑过一次 browser_* 工具后就有了）` });
  const time = (at) => (Number.isFinite(at) ? new Date(at).toISOString().slice(11, 23) : '-');
  const where = (e) => `${e.session ?? '-'}/${e.tab ?? '-'}`;
  const rows = kind === 'console'
    ? entries.map((e) => `${time(e.at)}  ${String(e.type ?? '?').padEnd(10)} ${where(e).padEnd(8)} ${e.text ?? ''}`)
    : entries.map((e) => {
      const status = e.status === undefined ? (e.error ?? '-') : String(e.status);
      const ms = Number.isFinite(e.ms) ? `${e.ms}ms` : '-';
      return `${time(e.at)}  ${String(e.phase ?? '?').padEnd(8)} ${status.padEnd(6)} ${ms.padStart(7)}  ${e.method ?? ''} ${e.url ?? ''}`;
    });
  process.stdout.write(`${rows.join('\n')}\n\n共 ${entries.length}/${total} 条 · ${file}\n`);
  process.exit(0);
}

/**
 * 导出某个会话的 HAR。playwright 只在 context 关闭时写盘，所以这里只找已落盘的文件：
 * 不给 `--out` 就报路径与大小；给了则复制过去（拒绝覆盖已有文件）。
 */
function har(cfg, flags) {
  const dir = join(cfg.root, 'har');
  const all = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.har')).sort() : [];
  if (all.length === 0) print({ har: null, dir, reason: '还没有 HAR（插件跑过一次 browser_* 工具、且会话已关闭后才会落盘）' }, 1);
  const wanted = typeof flags.session === 'string' && flags.session ? all.filter((name) => name.endsWith(`-${flags.session}.har`)) : all;
  const pick = wanted[wanted.length - 1];
  if (!pick) print({ har: null, dir, reason: `没有会话 ${flags.session} 的 HAR`, files: all }, 1);
  const src = join(dir, pick);
  const bytes = statSync(src).size;
  if (typeof flags.out === 'string' && flags.out) {
    const dest = resolve(flags.out);
    if (existsSync(dest)) print({ error: `拒绝覆盖已有文件：${dest}` }, 1);
    copyFileSync(src, dest);
    print({ har: dest, from: src, bytes, sessions: all.length });
  }
  print({ har: src, bytes, sessions: all.length, files: all });
}

/**
 * cookie / localStorage 的导出与注入。
 *
 * 为什么不用 playwright 的 context.cookies()/addCookies()：插件给每个会话建的是独立（incognito）
 * 上下文，而第二条 connectOverCDP 连接里 playwright 只把默认上下文当成自己的 context —— 实测
 * context.addCookies() 写进了默认上下文的 jar，页面 document.cookie 根本看不到。所以这里走
 * 浏览器级 CDP 会话：Target.getBrowserContexts 拿到真实上下文 id，再按 id 用 Storage.getCookies /
 * Storage.setCookies 读写；localStorage 走可见页面的 evaluate。
 *
 *   browsersvc cookies [--url=https://a.com] [--json | --export=file | --import=file]
 */
const COOKIE_FIELDS = ['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite'];

/** 只留 cookie 的稳定字段：CDP 读出来还带 size/priority/partitionKey 等，写回时没必要也不该带。 */
const pickCookie = (cookie) => Object.fromEntries(COOKIE_FIELDS.filter((k) => cookie[k] !== undefined).map((k) => [k, cookie[k]]));

function hostOf(raw) {
  try {
    return new URL(raw).hostname;
  } catch {
    return null;
  }
}

/** `--url` 过滤：cookie 的 domain 去前导点后与主机做后缀匹配；localStorage 只认同主机页面。 */
function urlMatcher(raw) {
  if (typeof raw !== 'string' || raw === '') return { cookie: () => true, page: () => true };
  const host = hostOf(raw);
  if (!host) print({ error: `invalid --url: ${raw}（需要 http(s) URL）` }, 2);
  return {
    cookie: (cookie) => {
      const domain = String(cookie.domain ?? '').replace(/^\./, '');
      return domain !== '' && (host === domain || host.endsWith(`.${domain}`));
    },
    page: (url) => hostOf(url) === host,
  };
}

/** 连运行中的守护进程（带 service.json 里的 token），拿浏览器级 CDP 会话与活着的会话上下文 id。 */
async function cdpBrowserSession(cfg) {
  const state = readState(cfg.root);
  if (!state?.token) print({ error: `浏览器服务没在运行（没有 ${stateFile(cfg.root)}）——先 browsersvc start` }, 1);
  const { chromium } = await import('playwright-core');
  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${state.port ?? cfg.port}/`, { headers: { Authorization: `Bearer ${state.token}` } });
  } catch (error) {
    print({ error: `连不上运行中的浏览器服务：${error.message}` }, 1);
  }
  const bs = await browser.newBrowserCDPSession();
  const { browserContextIds = [], defaultBrowserContextId } = await bs.send('Target.getBrowserContexts');
  return { browser, bs, contexts: browserContextIds.filter((id) => id !== defaultBrowserContextId) };
}

/** 读可见页面的 localStorage（按 origin 去重，只读；页面正在跳转就跳过，不打断导出）。 */
async function readOrigins(browser, match) {
  const seen = new Map();
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      const url = page.url();
      let origin;
      try {
        origin = new URL(url).origin;
      } catch {
        continue;
      }
      if (origin === 'null' || seen.has(origin) || !match(url)) continue;
      try {
        seen.set(origin, { origin, items: await page.evaluate(() => Object.fromEntries(Object.entries(window.localStorage))) });
      } catch {
        /* 跳过不可读的页面 */
      }
    }
  }
  return [...seen.values()];
}

async function cookies(cfg, flags) {
  const match = urlMatcher(flags.url);
  const { browser, bs, contexts } = await cdpBrowserSession(cfg);
  const done = async () => {
    await bs.detach().catch(() => {});
    await browser.close().catch(() => {});
  };

  if (typeof flags.import === 'string' && flags.import) {
    const file = resolve(flags.import);
    if (!existsSync(file)) print({ error: `找不到导入文件：${file}` }, 1);
    let data;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      print({ error: `导入文件不是合法 JSON：${error.message}` }, 2);
    }
    if (contexts.length === 0) print({ error: '没有活着的会话上下文 —— cookie 属于运行中的浏览器上下文，先用 browser_open 打开一个会话再导入' }, 1);
    const list = (data.contexts ?? []).flatMap((c) => c.cookies ?? []).map(pickCookie);
    let cookies = 0;
    for (const browserContextId of contexts) {
      if (list.length === 0) break;
      await bs.send('Storage.setCookies', { browserContextId, cookies: list });
      cookies += list.length;
    }
    const origins = data.origins ?? [];
    let items = 0;
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        let origin;
        try {
          origin = new URL(page.url()).origin;
        } catch {
          continue;
        }
        const pairs = Object.entries(origins.find((o) => o.origin === origin)?.items ?? {});
        if (pairs.length === 0) continue;
        await page.evaluate((kv) => { for (const [k, v] of kv) window.localStorage.setItem(k, v); }, pairs).catch(() => {});
        items += pairs.length;
      }
    }
    await done();
    print({ imported: file, contexts: contexts.length, cookies, origins: origins.length, items });
  }

  const exported = [];
  for (const browserContextId of contexts) {
    const { cookies: list = [] } = await bs.send('Storage.getCookies', { browserContextId });
    const picked = list.map(pickCookie).filter(match.cookie);
    if (picked.length > 0) exported.push({ browserContextId, cookies: picked });
  }
  const origins = await readOrigins(browser, match.page);
  const total = exported.reduce((n, c) => n + c.cookies.length, 0);
  const payload = { exportedAt: new Date().toISOString(), contexts: exported, origins };

  if (typeof flags.export === 'string' && flags.export) {
    const file = resolve(flags.export);
    if (existsSync(file)) print({ error: `拒绝覆盖已有文件：${file}` }, 1);
    writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    await done();
    print({ exported: file, cookies: total, contexts: exported.length, origins: origins.length });
  }
  if (flags.json === true) {
    await done();
    print({ ...payload, liveSessions: contexts.length });
  }
  await done();
  if (total === 0 && origins.length === 0) {
    print({ cookies: 0, liveSessions: contexts.length, reason: '没有可导出的 cookie（会话还没访问过站点？）' }, 1);
  }
  const rows = exported.flatMap(({ cookies: list }) => list.map((c) => {
    const flagsText = `${c.httpOnly ? '  [httpOnly]' : ''}${c.secure ? '  [secure]' : ''}`;
    return `${String(c.domain ?? '').padEnd(24)} ${c.name}=${String(c.value ?? '').slice(0, 60)}${flagsText}`;
  }));
  process.stdout.write(`${rows.join('\n')}\n\n共 ${total} 条 cookie · ${origins.length} 个 origin 的 localStorage · ${contexts.length} 个活会话上下文\n`);
  process.exit(0);
}

function detect(cfg) {
  print({
    candidates: detectKernels(),
    configFile: readConfigFile(cfg.root),
    resolved: { kernel: cfg.kernel, kernelKind: cfg.kernelKind, port: cfg.port, idleMs: cfg.idleMs, root: cfg.root },
  });
}

const SKILL_STATE = {
  missing: '缺失',
  current: '已最新',
  update: '可升级',
  modified: '你改过',
  foreign: '非本包',
  'unreadable-source': '源读不到',
};

/**
 * 随包技能：不带 --install/--uninstall 只报状态；--install 落盘（可选，默认目标是 `$DSH_HOME/skills`）；
 * --uninstall 撤掉落盘那份。插件默认走 `ctx.skills.registerProvider()` 注册成**内置**技能
 * （source=bundled，技能中心显示「系统内置」）；落盘那份是**用户级**（rank 400），会盖住内置那份。
 */
function skills(flags) {
  const root = typeof flags.dir === 'string' && flags.dir ? resolve(flags.dir) : defaultSkillsRoot();
  if (flags.uninstall === true) {
    const res = removeSkills({ root });
    if (flags.json === true) print(res, res.errors.length > 0 ? 1 : 0);
    process.stdout.write(`删 ${res.removed.length} · 保留 ${res.kept.length}\n技能目录：${root}\n`);
    for (const item of res.kept) process.stdout.write(`  保留 ${item.path} —— ${item.reason}\n`);
    for (const item of res.errors) process.stdout.write(`  失败 ${item}\n`);
    if (res.errors.length > 0) process.exit(1);
    process.stdout.write(
      res.markerRemoved
        ? '落盘的技能与台账都已撤掉；这两份技能现在只由插件的「内置」提供者提供（重启 DSH 后技能中心显示「系统内置」）\n'
        : '台账里还有属于本包的文件（上面「保留」那些不动它）；其余已撤掉\n',
    );
    process.exit(0);
  }
  if (flags.install !== true) {
    const st = inspectSkills({ root });
    if (flags.json === true) print({ skillsDir: root, source: st.source, version: st.version, marker: st.marker, files: st.files });
    const lines = st.files.map((f) => `${SKILL_STATE[f.state].padEnd(6)} ${f.path}`);
    const pending = st.files.filter((f) => f.state === 'missing' || f.state === 'update').length;
    const conflicts = st.files.filter((f) => f.state === 'modified' || f.state === 'foreign').length;
    const onDisk = st.files.filter((f) => f.state !== 'missing' && f.state !== 'unreadable-source').length;
    process.stdout.write(
      `${lines.join('\n')}\n\n技能目录：${root}\n随包来源：${st.source}\n本包版本：${st.version}；台账：${st.marker.version ?? '无'}\n`
      + `待处理 ${pending} 个（${pending > 0 ? 'browsersvc skills --install 装上' : '不用动'}）；槽位冲突 ${conflicts} 个（要覆盖加 --force）\n`
      + (onDisk > 0
        ? `注意：磁盘上这 ${onDisk} 个文件是**用户级**技能（rank 400），会在技能中心盖住插件注册的内置那份（rank 600）——想让技能中心显示「系统内置」，跑一次 browsersvc skills --uninstall\n`
        : '磁盘上没有落盘副本：技能由插件的内置提供者提供（技能中心显示「系统内置」）\n'),
    );
    process.exit(0);
  }
  const res = syncSkills({ root, force: flags.force === true });
  if (flags.json === true) print(res, res.errors.length > 0 ? 1 : 0);
  const parts = [
    `装 ${res.installed.length}`,
    `升级 ${res.updated.length}`,
    `已最新 ${res.unchanged.length}`,
    `跳过 ${res.skipped.length}`,
  ];
  process.stdout.write(`${parts.join(' · ')}\n技能目录：${root}（本包 ${res.version}）\n`);
  for (const item of res.skipped) process.stdout.write(`  跳过 ${item.path} —— ${item.reason}（要覆盖加 --force）\n`);
  for (const item of res.errors) process.stdout.write(`  失败 ${item}\n`);
  if (res.errors.length > 0) process.exit(1);
  process.stdout.write(`${res.installed.length + res.updated.length > 0 ? '技能下次会话即可用（重启 DSH 最稳）' : '没有需要写入的改动'}\n`);
  process.exit(0);
}

const { cmd, flags } = parse(process.argv.slice(2));
const USAGE = 'browsersvc start|stop|status|restart|run|logs|ops|console|network|har|cookies|detect|skills [--port=9333] [--idle-ms=900000] [--kernel=...] [--wrapper=...] [--root=...] [--start-timeout=30000] [--internal-port-base=9300] [--lines=20] [--out=file] [--session=s1] [--url=https://a.com] [--export=file] [--import=file] [--install] [--uninstall] [--force] [--dir=/path/to/skills] [--json]';

try {
  const cfg = toCfg(flags);
  switch (cmd) {
    case 'run':
      await runSupervisor(cfg);
      break;
    case 'start':
      await start(cfg);
      break;
    case 'stop':
      await stop(cfg, { force: flags.force === true });
      break;
    case 'restart': {
      // print() 会 process.exit：restart 必须用 quiet 模式拿返回值，否则 stop 打印完就
      // 退出，start 永远不会执行（F23：restart 变成「只停不起」）。
      const stopped = await stop(cfg, { force: flags.force === true, quiet: true });
      if (stopped.refused) print({ restarted: false, stopped: false, reason: stopped.reason, details: stopped.details }, 1);
      try {
        const started = await start(cfg, { quiet: true });
        print({ restarted: true, stopped: stopped.stopped === true, ...started });
      } catch (error) {
        print({ restarted: false, stopped: true, reason: error?.info?.reason ?? error?.message ?? String(error) }, 1);
      }
      break;
    }
    case 'status':
      await status(cfg);
      break;
    case 'logs':
      logs(cfg, flags);
      break;
    case 'ops':
      ops(cfg, flags);
      break;
    case 'console':
      stream(cfg, flags, 'console');
      break;
    case 'network':
      stream(cfg, flags, 'network');
      break;
    case 'har':
      har(cfg, flags);
      break;
    case 'cookies':
      await cookies(cfg, flags);
      break;
    case 'detect':
      detect(cfg);
      break;
    case 'skills':
      skills(flags);
      break;
    default:
      print({ error: `unknown command: ${cmd}`, usage: USAGE }, 2);
  }
} catch (error) {
  // 配置校验失败（端口/空闲时长越界、内核不存在…）也要给调用方一个干净的 JSON。
  print({ error: error.message, usage: USAGE }, 2);
}
