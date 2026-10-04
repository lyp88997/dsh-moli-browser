#!/usr/bin/env node
/**
 * 端到端验收 P3 数据层：观测文件 + `browsersvc` 的 ops / console / network / har / cookies。
 *
 * 不碰外网：本地起测试站点（set-cookie、console、fetch），真 spawn 守护进程（真 Chromium 内核），
 * 用真 provider（plugin/lib/provider.js）跑出记录，再用 bin/browsersvc.mjs 的 CLI 读回/注入。
 *
 *   node scripts/verify-data.mjs
 *
 * 环境变量：
 *   DSH_BROWSER_SVC_CLI   暴露的 CLI 路径（默认 ../bin/browsersvc.mjs）
 *   BROWSERSVC_PORT       公开端口（默认 9414）
 *   KEEP_ROOT=1           保留临时 root（排错用）
 */
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendNetwork, appendOp, readNetwork, readOps } from '../src/opslog.mjs';
import { LIVE_IMAGE_PATH, LIVE_INPUT_PATH, LIVE_STATE_PATH, LOGS_PATH, PANEL_PATH, VIEWPORT_PATH, registerPanel } from '../plugin/lib/panel.js';
import { createProvider } from '../plugin/lib/provider.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CLI = process.env.DSH_BROWSER_SVC_CLI ?? resolve(HERE, '../bin/browsersvc.mjs');
const PORT = Number(process.env.BROWSERSVC_PORT ?? 9414);

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

// ── 本地测试站点 ────────────────────────────────────────────────────────────
const HOME = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>观测页</title></head><body>
<h1 id="head">标题</h1>
<script>
  localStorage.setItem('demo', 'x');
  console.log('hello from page');
  console.error('bad thing');
  fetch('/api').then((r) => r.json()).then((d) => console.log('api', d.ok));
</script>
</body></html>`;
const CLEAN = '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>干净页</title></head><body>clean</body></html>';

const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  if (path === '/api') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  if (path === '/clean') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(CLEAN);
    return;
  }
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'set-cookie': ['probe=1; Path=/', 'secret=s3cr3t; Path=/; HttpOnly'],
  });
  response.end(HOME);
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ── 守护进程 ────────────────────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), 'browsersvc-verify-data-'));
const daemon = spawn(process.execPath, [CLI, 'run', `--root=${root}`, `--port=${PORT}`, '--idle-ms=3600000'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let daemonOutput = '';
daemon.stdout.on('data', (chunk) => { daemonOutput += chunk; });
daemon.stderr.on('data', (chunk) => { daemonOutput += chunk; });

async function waitForReady(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const line of daemonOutput.split('\n')) {
      if (!line.trim().startsWith('{')) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.ready === true) return parsed;
      } catch { /* 行还没写完 */ }
    }
    if (daemon.exitCode !== null) throw new Error(`守护进程提前退出（${daemon.exitCode}）：\n${daemonOutput}`);
    await new Promise((ok) => setTimeout(ok, 120));
  }
  throw new Error(`等待守护进程就绪超时：\n${daemonOutput}`);
}

/** 跑 CLI：命令必须在标志之前（parse() 把 argv[0] 当命令）。 */
function cli(...args) {
  const stdout = execFileSync(process.execPath, [CLI, ...args, `--root=${root}`, `--port=${PORT}`], { encoding: 'utf8' });
  return JSON.parse(stdout);
}
const cliFails = (...args) => {
  try {
    cli(...args);
    return false;
  } catch {
    return true;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let provider;
const shutdown = async () => {
  try { await provider?.dispose(); } catch { /* 忽略 */ }
  server.close();
  if (daemon.exitCode === null) daemon.kill('SIGTERM');
  await sleep(300);
  if (daemon.exitCode === null) daemon.kill('SIGKILL');
  await new Promise((done) => {
    const p = spawn(process.execPath, [CLI, 'stop', `--root=${root}`], { stdio: 'ignore' });
    p.on('close', done);
    p.on('error', done);
  });
  if (process.env.KEEP_ROOT !== '1') rmSync(root, { recursive: true, force: true });
};

const EXPORT = join(root, '..', `verify-data-export-${process.pid}.json`);

try {
  const ready = await waitForReady();
  console.log(`守护进程就绪：port=${ready.port} kernel=${ready.kernelKind}\n`);

  process.env.DSH_BROWSER_SVC_ROOT = root;
  const { chromium } = await import('playwright-core');
  provider = createProvider({
    chromium,
    config: {
      providerId: 'cdp-daemon',
      cdpUrl: `http://127.0.0.1:${PORT}`,
      connectTimeoutMs: 10_000,
      actionTimeoutMs: 15_000,
      navigationTimeoutMs: 15_000,
      lookupTimeoutMs: 5_000,
      snapshotMaxElements: 200,
      contentMaxChars: 200_000,
      viewportWidth: 1440,
      viewportHeight: 900,
      downloadDir: root,
    },
  });

  // ── 观测：ops / console / network ─────────────────────────────────────────
  console.log('P3 数据层：ops');
  const session = await provider.open('data');
  await provider.openUrl(session, { url: `${BASE}/` });
  await provider.execute(session, { script: 'document.title' });
  await sleep(400);

  const ops = cli('ops', '--json');
  const opsEntries = ops.entries ?? [];
  check('ops.jsonl 记下了 navigate 与 execute', opsEntries.some((e) => e.action === 'navigate') && opsEntries.some((e) => e.action === 'execute'), JSON.stringify(opsEntries.map((e) => e.action)));
  check('ops 每条带耗时/成败/会话与标签', opsEntries.length > 0 && opsEntries.every((e) => Number.isFinite(e.ms) && typeof e.ok === 'boolean' && e.session === session && typeof e.tab === 'string'));
  check('ops 记录了目标 URL 与结果摘要', opsEntries.some((e) => String(e.params ?? '').includes('/')) && opsEntries.some((e) => e.action === 'execute' && String(e.result ?? '').includes('观测页')), JSON.stringify(opsEntries.slice(-2)));
  check('open 不记入 ops（会话创建不是一次操作）', !opsEntries.some((e) => e.action === 'open'), JSON.stringify(opsEntries.map((e) => e.action)));
  const opsLines = execFileSync(process.execPath, [CLI, 'ops', `--root=${root}`, `--port=${PORT}`], { encoding: 'utf8' });
  check('ops 人话表格带汇总行', opsLines.includes('共 ') && opsLines.includes('ops.jsonl'));
  check('ops --lines 生效', (cli('ops', '--json', '--lines=1').entries ?? []).length === 1);

  // P3：通用追踪 —— 不带 #record 的读操作（snapshot/content/screenshot/listTabs…）也要进 ops，
  // 否则面板时间线只看得见点击与导航，读操作全丢。
  await provider.snapshot(session);
  await provider.content(session, { format: 'txt' });
  await provider.screenshot(session);
  await provider.listTabs(session);
  await provider.execute(session, { script: 'throw new Error("观测失败")' });
  await sleep(300);
  const traced = cli('ops', '--json').entries ?? [];
  const tracedActions = traced.map((e) => e.action);
  check('通用追踪覆盖 snapshot/content/screenshot/listTabs', ['snapshot', 'content', 'screenshot', 'listTabs'].every((a) => tracedActions.includes(a)), JSON.stringify(tracedActions));
  const tracedEntry = traced.filter((e) => ['snapshot', 'content', 'screenshot', 'listTabs'].includes(e.action));
  check('追踪条目也带耗时/会话/标签', tracedEntry.length >= 4 && tracedEntry.every((e) => Number.isFinite(e.ms) && e.session === session && e.tab === 't1' && e.ok === true), JSON.stringify(tracedEntry));
  const failedEntry = traced.find((e) => e.action === 'execute' && e.ok === false);
  check('失败操作记为 ok:false 并带错误原因', Boolean(failedEntry && String(failedEntry.error ?? '').includes('观测失败')), JSON.stringify(failedEntry));

  console.log('\nP3 数据层：console');
  const consoleLog = cli('console', '--json');
  const consoleEntries = consoleLog.entries ?? [];
  check('console.jsonl 抓到页面 log 与 error', consoleEntries.some((e) => e.type === 'log' && String(e.text).includes('hello from page')) && consoleEntries.some((e) => e.type === 'error' && String(e.text).includes('bad thing')), JSON.stringify(consoleEntries.map((e) => e.type)));
  check('console 记录带 URL 与所属标签', consoleEntries.every((e) => typeof e.url === 'string' && typeof e.session === 'string' && typeof e.tab === 'string'));

  console.log('\nP3 数据层：network');
  const network = cli('network', '--json');
  const networkEntries = network.entries ?? [];
  check('network.jsonl 记下 request/response 两个阶段', networkEntries.some((e) => e.phase === 'request') && networkEntries.some((e) => e.phase === 'response'), JSON.stringify(networkEntries.map((e) => `${e.phase}:${e.url}`)));
  check('response 带状态码与耗时', networkEntries.some((e) => e.phase === 'response' && e.status === 200 && Number.isFinite(e.ms)), JSON.stringify(networkEntries.filter((e) => e.phase === 'response')));
  check('抓到页面发起的 /api 请求', networkEntries.some((e) => String(e.url).endsWith('/api')));
  check('network 不记请求头与响应体（只记元数据）', networkEntries.every((e) => !('headers' in e) && !('body' in e)));

  console.log('\nP3 数据层：cookies 导出');
  const cookieJson = cli('cookies', '--json');
  const allCookies = (cookieJson.contexts ?? []).flatMap((c) => c.cookies ?? []);
  check('读到页面 cookie（probe=1）', allCookies.some((c) => c.name === 'probe' && c.value === '1'), JSON.stringify(allCookies));
  check('httpOnly cookie 也能读到（document.cookie 读不到）', allCookies.some((c) => c.name === 'secret' && c.httpOnly === true));
  check('读到 localStorage origin 快照', (cookieJson.origins ?? []).some((o) => o.origin === BASE && o.items.demo === 'x'), JSON.stringify(cookieJson.origins));
  check('cookie 只带稳定字段', allCookies.every((c) => Object.keys(c).every((k) => ['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite'].includes(k))));
  check('--url 过滤命中本站', (cli('cookies', '--json', `--url=${BASE}/`).contexts ?? []).flatMap((c) => c.cookies).some((c) => c.name === 'probe'));
  const other = cli('cookies', '--json', '--url=https://other.example/');
  check('--url 过滤不含本站时导出为空（--json 仍退出 0）', (other.contexts ?? []).length === 0 && (other.origins ?? []).length === 0);
  const exported = cli('cookies', `--export=${EXPORT}`);
  check('--export 写文件并回报条数', exported.exported === EXPORT && exported.cookies >= 2, JSON.stringify(exported));
  check('导出文件权限 0600', (statSync(EXPORT).mode & 0o777) === 0o600, `mode=${(statSync(EXPORT).mode & 0o777).toString(8)}`);
  check('--export 拒绝覆盖已有文件', cliFails('cookies', `--export=${EXPORT}`));

  // ── HAR：只在会话关闭后落盘 ───────────────────────────────────────────────
  console.log('\nP3 数据层：har');
  await provider.close(session);
  let harFiles = [];
  for (let i = 0; i < 20 && harFiles.length === 0; i += 1) {
    await sleep(150);
    const dir = join(root, 'har');
    harFiles = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.har')) : [];
  }
  check('会话关闭后写出 HAR', harFiles.length === 1 && harFiles[0].endsWith(`-${session}.har`), JSON.stringify(harFiles));
  const harInfo = cli('har');
  check('har 命令报出路径与字节', typeof harInfo.har === 'string' && harInfo.bytes > 0, JSON.stringify(harInfo));
  const harJson = JSON.parse(readFileSync(harInfo.har, 'utf8'));
  check('HAR 里含本次请求', (harJson.log?.entries ?? []).some((e) => String(e.request?.url).startsWith(BASE)), `${(harJson.log?.entries ?? []).length} 条`);
  const harOut = join(root, '..', `verify-data-copy-${process.pid}.har`);
  check('har --out 复制到指定文件', cli('har', `--out=${harOut}`).har === harOut && statSync(harOut).size > 0);
  check('har --out 拒绝覆盖已有文件', cliFails('har', `--out=${harOut}`));
  check('har --session 能按会话挑文件', cli('har', `--session=${session}`).har.endsWith(`-${session}.har`));
  rmSync(harOut, { force: true });

  // ── cookies 注入 ─────────────────────────────────────────────────────────
  console.log('\nP3 数据层：cookies 注入');
  const fresh = await provider.open('fresh');
  await provider.openUrl(fresh, { url: `${BASE}/clean` });
  const before = (await provider.execute(fresh, { script: 'document.cookie' })).value;
  const beforeLs = (await provider.execute(fresh, { script: 'JSON.stringify(Object.fromEntries(Object.entries(localStorage)))' })).value;
  check('新会话起始是干净的', before === '' && beforeLs === '{}', `cookie="${before}" ls=${beforeLs}`);
  const imported = cli('cookies', `--import=${EXPORT}`);
  check('--import 把 cookie 写进活会话上下文', imported.cookies >= 2 && imported.contexts === 1, JSON.stringify(imported));
  check('--import 恢复 localStorage', imported.items >= 1, `items=${imported.items}`);
  const after = (await provider.execute(fresh, { script: 'document.cookie' })).value;
  const afterLs = (await provider.execute(fresh, { script: 'JSON.stringify(Object.fromEntries(Object.entries(localStorage)))' })).value;
  check('页面 document.cookie 看到注入的普通 cookie', after.includes('probe=1'), after);
  check('页面 localStorage 看到注入的键', afterLs.includes('"demo":"x"'), afterLs);
  check('httpOnly cookie 注入到 Storage 层', (cli('cookies', '--json').contexts ?? []).flatMap((c) => c.cookies).some((c) => c.name === 'secret'));
  await provider.close(fresh);

  // ── 网页面板：宿主半边的只读 JSON 路由 ───────────────────────────────────
  console.log('\nP3 面板：宿主只读路由');
  const panelRoutes = new Map();
  const panelEffects = [];
  const fakeCtx = {
    webServer: {
      register: (entry) => {
        panelRoutes.set(entry.path, entry);
        return () => {
          panelRoutes.delete(entry.path);
        };
      },
    },
    effect: (fn) => panelEffects.push(fn()),
    logger: { info() {}, warn() {}, error() {} },
  };
  const disposePanel = registerPanel(fakeCtx);
  const panelRoute = panelRoutes.get(PANEL_PATH);
  check('路由注册成 exact + PANEL_PATH', panelRoute?.kind === 'exact' && panelRoute.path === PANEL_PATH);
  check('面板实例一次挂上六条路由（面板 + 实时窗口三条 + 日志清理 + 分辨率）', panelRoutes.size === 6, [...panelRoutes.keys()].join(','));
  const panelServer = createServer((request, response) => panelRoute.handler(request, response));
  await new Promise((r) => panelServer.listen(0, '127.0.0.1', r));
  const panelUrl = `http://127.0.0.1:${panelServer.address().port}${PANEL_PATH}`;
  const payload = await (await fetch(`${panelUrl}?lines=1`)).json();
  check('GET 返回 ops/console/network 三份', Boolean(payload.ops && payload.console && payload.network));
  check('--lines 生效（?lines=1 只回 1 条）', payload.ops.entries.length === 1, `entries=${payload.ops.entries.length} total=${payload.ops.total}`);
  check('面板条目就是观测到的真实操作', payload.ops.entries.every((e) => typeof e.action === 'string' && typeof e.ms === 'number'));
  check('面板载荷不含本机绝对路径', !JSON.stringify(payload).includes(root));
  const rejected = await fetch(panelUrl, { method: 'POST' });
  await rejected.text();
  check('非 GET 报 405', rejected.status === 405, `status=${rejected.status}`);
  await new Promise((r) => panelServer.close(r));
  disposePanel();
  check('dispose 后路由被摘掉', panelRoutes.size === 0);

  // ── 实时窗口：四条 exact 路由 + 回环/方法/同源三道闸门 ────────────────────
  console.log('\nP4 实时窗口：路由与闸门');
  const liveRoutes = new Map();
  const liveActions = [];
  const shown = { live: false, seq: 0, at: Date.now(), url: 'https://example.com/', title: '观测页', width: 800, height: 600, pageScaleFactor: 1 };
  // 模仿真 LiveView 的取帧参数语义：按边界夹取、缺字段沿用当前值（真实现是 resolveStreamOptions）。
  const liveStream = { quality: 85, maxWidth: 1280, maxHeight: 1200 };
  const clampInt = (value, min, max, fallback) => {
    // 与宿主同一条：没给（null/''）就用 fallback —— `Number(null) === 0` 会把高度塌到下限。
    if (value == null || value === '') return fallback;
    const raw = Number(value);
    if (!Number.isFinite(raw)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(raw)));
  };
  const stubView = {
    get options() {
      return { ...liveStream };
    },
    async start(options = {}) {
      liveStream.quality = clampInt(options.quality, 10, 95, liveStream.quality);
      liveStream.maxWidth = clampInt(options.maxWidth, 320, 1920, liveStream.maxWidth);
      liveStream.maxHeight = clampInt(options.maxHeight, 240, 1200, liveStream.maxHeight);
      if (shown.live) return this.options; // 真 LiveView.start() 是幂等的：重复取帧不该凭空多出画面
      shown.live = true;
      shown.seq += 1;
      shown.at = Date.now();
      return this.options;
    },
    async stop() {
      shown.live = false;
    },
    async state() {
      return { ...shown };
    },
    async waitFrame({ since = 0 } = {}) {
      if (!shown.live || shown.seq <= since) return null;
      return { seq: shown.seq, at: shown.at, jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), width: shown.width, height: shown.height };
    },
    async input(action) {
      liveActions.push(action);
      if (action.kind === 'pow') throw new Error('实时窗口不支持的动作："pow"');
      return { ok: true };
    },
  };
  const liveProvider = {
    liveTarget: () => 's1',
    liveView: () => stubView,
    openUrl: async (id, request) => {
      liveActions.push({ kind: 'openUrl', id, url: request.url });
      return 't1';
    },
  };
  const quietLogger = { info() {}, warn() {}, error() {} };
  const liveRoutesFor = (target) => ({
    webServer: {
      register: (entry) => {
        target.set(entry.path, entry);
        return () => target.delete(entry.path);
      },
    },
    effect: () => {},
    logger: quietLogger,
  });
  const disposeLive = registerPanel(liveRoutesFor(liveRoutes), {
    provider: liveProvider,
    // 设置区读的就是这份生效配置（下载目录只回目录名，不回绝对路径）。
    config: {
      cdpUrl: 'http://127.0.0.1:9333',
      downloadDir: `${root}/产出`,
      maxTabs: 5,
      idleMs: 300_000,
      captureConsole: true,
      captureNetwork: false,
    },
  });
  check(
    '实时窗口注册六条 exact 路由（面板 + 实时三条 + 日志清理 + 分辨率）',
    liveRoutes.size === 6 && [PANEL_PATH, LIVE_STATE_PATH, LIVE_IMAGE_PATH, LIVE_INPUT_PATH, LOGS_PATH, VIEWPORT_PATH].every((path) => liveRoutes.get(path)?.kind === 'exact'),
    [...liveRoutes.keys()].join(','),
  );

  const liveServer = createServer((request, response) => {
    const entry = liveRoutes.get(new URL(request.url, 'http://127.0.0.1').pathname);
    if (!entry) {
      response.writeHead(404);
      response.end();
      return;
    }
    entry.handler(request, response);
  });
  await new Promise((r) => liveServer.listen(0, '127.0.0.1', r));
  const liveBase = `http://127.0.0.1:${liveServer.address().port}`;
  const post = (body, extra = {}) => fetch(`${liveBase}${LIVE_INPUT_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(extra.headers ?? {}) },
    body: JSON.stringify(body),
  });

  const stateBefore = await (await fetch(`${liveBase}${LIVE_STATE_PATH}`)).json();
  check('live.json 报出会话与页面状态', stateBefore.session === 's1' && stateBefore.url === 'https://example.com/' && stateBefore.live === false, JSON.stringify(stateBefore));

  const frameResponse = await fetch(`${liveBase}${LIVE_IMAGE_PATH}?since=0`);
  const frameBytes = Buffer.from(await frameResponse.arrayBuffer());
  check(
    '取帧回 JPEG 且带帧序号与尺寸头',
    frameResponse.status === 200 && frameResponse.headers.get('content-type') === 'image/jpeg' && frameResponse.headers.get('x-frame-seq') === '1' && frameResponse.headers.get('x-frame-w') === '800' && frameBytes.length === 4,
    `status=${frameResponse.status} seq=${frameResponse.headers.get('x-frame-seq')} bytes=${frameBytes.length}`,
  );
  const stateAfter = await (await fetch(`${liveBase}${LIVE_STATE_PATH}`)).json();
  check('推流开始后 live.json 变 live:true', stateAfter.live === true && stateAfter.seq === 1, JSON.stringify(stateAfter));

  const stale = await fetch(`${liveBase}${LIVE_IMAGE_PATH}?since=1`);
  await stale.arrayBuffer();
  check('没有新帧时回 204（客户端不会收到重复画面）', stale.status === 204, `status=${stale.status}`);

  // ── P5：设置区的画质/最大边真的作用到取帧上，并把生效值读回来 ──────────────
  console.log('\nP5 实时窗口：取帧参数与设置区');
  const tuned = await fetch(`${liveBase}${LIVE_IMAGE_PATH}?since=0&quality=85&max=800&maxh=600`);
  await tuned.arrayBuffer();
  check(
    '画质与最大边按查询串透传给取帧',
    tuned.status === 200 && tuned.headers.get('x-frame-quality') === '85' && tuned.headers.get('x-frame-max') === '800x600',
    `quality=${tuned.headers.get('x-frame-quality')} max=${tuned.headers.get('x-frame-max')}`,
  );
  const bare = await fetch(`${liveBase}${LIVE_IMAGE_PATH}?since=0&quality=85&max=1280`);
  await bare.arrayBuffer();
  check(
    '缺 maxh 时沿用当前高度，不塌到下限 240（画面糊的根源）',
    bare.status === 200 && bare.headers.get('x-frame-max') === '1280x600',
    `max=${bare.headers.get('x-frame-max')}`,
  );
  const bounded = await fetch(`${liveBase}${LIVE_IMAGE_PATH}?since=0&quality=999&max=40&maxh=99999`);
  await bounded.arrayBuffer();
  check(
    '越界的画质/最大边被夹到安全边界',
    bounded.status === 200 && bounded.headers.get('x-frame-quality') === '95' && bounded.headers.get('x-frame-max') === '320x1200',
    `quality=${bounded.headers.get('x-frame-quality')} max=${bounded.headers.get('x-frame-max')}`,
  );
  const stateTuned = await (await fetch(`${liveBase}${LIVE_STATE_PATH}`)).json();
  check(
    'live.json 带出生效中的取帧参数',
    stateTuned.options?.quality === 95 && stateTuned.options?.maxWidth === 320 && stateTuned.options?.maxHeight === 1200,
    JSON.stringify(stateTuned.options),
  );
  const settingsPayload = await (await fetch(`${liveBase}${PANEL_PATH}?lines=1`)).json();
  const service = settingsPayload.service ?? {};
  const pkgVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  check(
    '设置区读到只读服务信息（版本/会话/上限/录制开关）',
    service.version === pkgVersion && service.session === 's1' && service.maxTabs === 5 && service.captureNetwork === false && service.idleMs === 300_000,
    JSON.stringify(service),
  );
  check(
    '设置区只回下载目录名、不回绝对路径',
    service.downloadDir === '产出' && !JSON.stringify(settingsPayload).includes(root),
    `downloadDir=${service.downloadDir}`,
  );

  const typed = await post({ kind: 'text', text: '实时窗口 ok' });
  await typed.text();
  check('打字转发给页面', typed.status === 200 && liveActions.some((a) => a.kind === 'text' && a.text === '实时窗口 ok'), JSON.stringify(liveActions.slice(-2)));

  const clicked = await post({ kind: 'down', x: 12, y: 34, button: 'left' });
  await clicked.text();
  check('点击坐标原样转发', clicked.status === 200 && liveActions.some((a) => a.kind === 'down' && a.x === 12 && a.y === 34 && a.button === 'left'));

  const jumped = await post({ kind: 'goto', url: 'https://example.com/next' });
  await jumped.text();
  check('地址栏跳转走 provider 的导航通道', jumped.status === 200 && liveActions.some((a) => a.kind === 'openUrl' && a.id === 's1' && a.url === 'https://example.com/next'), JSON.stringify(liveActions.slice(-2)));

  const bad = await post({ kind: 'pow' });
  await bad.text();
  check('视图不认识的动作回 400', bad.status === 400, `status=${bad.status}`);

  const crossSite = await post({ kind: 'text', text: 'x' }, { headers: { origin: 'http://evil.example' } });
  await crossSite.text();
  check('跨站 POST 被拒（403）', crossSite.status === 403, `status=${crossSite.status}`);

  const wrongMethod = await fetch(`${liveBase}${LIVE_IMAGE_PATH}`, { method: 'POST' });
  await wrongMethod.text();
  check('取帧路由只收 GET（POST 回 405）', wrongMethod.status === 405, `status=${wrongMethod.status}`);

  const outer = { code: 0, writeHead(code) { this.code = code; return this; }, end() {} };
  liveRoutes.get(LIVE_STATE_PATH).handler({ socket: { remoteAddress: '10.0.0.9' }, method: 'GET', url: LIVE_STATE_PATH }, outer);
  check('非本机来源被拒（403）', outer.code === 403, `code=${outer.code}`);

  const stopped = await fetch(`${liveBase}${LIVE_INPUT_PATH}`, { method: 'DELETE' });
  await stopped.json();
  check('DELETE 停流（视图收到 stop）', stopped.status === 200 && shown.live === false, `live=${shown.live}`);

  const bareRoutes = new Map();
  const disposeBare = registerPanel(liveRoutesFor(bareRoutes));
  const bareRes = { code: 0, writeHead(code) { this.code = code; return this; }, end() {} };
  bareRoutes.get(LIVE_STATE_PATH).handler({ socket: { remoteAddress: '127.0.0.1' }, method: 'GET', url: LIVE_STATE_PATH }, bareRes);
  check('没有 provider 时实时接口回 503', bareRes.code === 503, `code=${bareRes.code}`);
  disposeBare();

  await new Promise((r) => liveServer.close(r));
  disposeLive();
  check('dispose 后六条路由一起摘掉', liveRoutes.size === 0, [...liveRoutes.keys()].join(','));

  // ── P6：日志清理（手动「清理」与设置区「自动清理」共用的宿主路由）────────────
  //        以及「一个会话都没有时，地址栏跳转要自己开一个会话」。
  console.log('\nP6 面板：日志清理与无会话跳转');
  const gateActions = [];
  const noViewProvider = {
    liveTarget: () => null,
    liveView: () => null,
    open: async (label) => {
      gateActions.push({ kind: 'open', label });
      return 's9';
    },
    openUrl: async (id, request) => {
      gateActions.push({ kind: 'openUrl', id, url: request.url });
      return 't9';
    },
  };
  const gateRoutes = new Map();
  const disposeGate = registerPanel(liveRoutesFor(gateRoutes), { provider: noViewProvider });
  const gateServer = createServer((request, response) => {
    const entry = gateRoutes.get(new URL(request.url, 'http://127.0.0.1').pathname);
    if (!entry) {
      response.writeHead(404);
      response.end();
      return;
    }
    entry.handler(request, response);
  });
  await new Promise((r) => gateServer.listen(0, '127.0.0.1', r));
  const gateBase = `http://127.0.0.1:${gateServer.address().port}`;
  const gatePost = (path, body, extra = {}) => fetch(`${gateBase}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(extra.headers ?? {}) },
    body: JSON.stringify(body),
  });

  const noSessionState = await (await fetch(`${gateBase}${LIVE_STATE_PATH}`)).json();
  check('没有会话时 live.json 仍回 200 并给出可操作提示',
    noSessionState.live === false && /地址栏/.test(String(noSessionState.reason ?? '')),
    JSON.stringify(noSessionState.reason));

  const autoOpen = await gatePost(LIVE_INPUT_PATH, { kind: 'goto', url: 'example.com' });
  const autoOpenBody = await autoOpen.json();
  check('没有会话时地址栏跳转自动开会话、并补上 https',
    autoOpen.status === 200 && autoOpenBody.opened === true && autoOpenBody.session === 's9'
      && autoOpenBody.url === 'https://example.com'
      && gateActions.some((a) => a.kind === 'open' && a.label === '面板地址栏')
      && gateActions.some((a) => a.kind === 'openUrl' && a.id === 's9' && a.url === 'https://example.com'),
    JSON.stringify({ status: autoOpen.status, body: autoOpenBody, last: gateActions.slice(-2) }));

  const emptyUrl = await gatePost(LIVE_INPUT_PATH, { kind: 'goto', url: '   ' });
  await emptyUrl.text();
  check('空网址回 400（不拿空串去导航）', emptyUrl.status === 400, `status=${emptyUrl.status}`);

  const noSessionInput = await gatePost(LIVE_INPUT_PATH, { kind: 'text', text: 'x' });
  await noSessionInput.text();
  check('没有画面时非跳转动作回 409 且带「先开页面」提示', noSessionInput.status === 409, `status=${noSessionInput.status}`);

  for (let i = 0; i < 6; i += 1) appendNetwork({ seq: i, url: 'https://example.com/', status: 200 }, { root });
  const trimmed = await gatePost(LOGS_PATH, { action: 'trim', kind: 'network', keep: 2 });
  const trimmedBody = await trimmed.json();
  check('日志清理 trim 只留最近 N 条',
    trimmed.status === 200 && trimmedBody.result?.network === 2 && readNetwork({ root, lines: 20 }).total === 2,
    JSON.stringify({ status: trimmed.status, body: trimmedBody, total: readNetwork({ root, lines: 20 }).total }));

  const clearedAll = await gatePost(LOGS_PATH, { action: 'clear', kind: 'all' });
  const clearedAllBody = await clearedAll.json();
  check('日志清理 clear 一次清空全部分类',
    clearedAll.status === 200 && Object.keys(clearedAllBody.result ?? {}).length === 3
      && readNetwork({ root, lines: 20 }).total === 0 && readOps({ root, lines: 20 }).total === 0,
    JSON.stringify(clearedAllBody.result));

  const badKind = await gatePost(LOGS_PATH, { kind: 'bogus' });
  const badKindBody = await badKind.json();
  check('清理未知日志类型回 400',
    badKind.status === 400 && /未知的日志类型/.test(String(badKindBody.error ?? '')),
    `status=${badKind.status} error=${badKindBody.error}`);

  const logsWrongMethod = await fetch(`${gateBase}${LOGS_PATH}`, { method: 'GET' });
  await logsWrongMethod.text();
  check('清理路由只收 POST（GET 回 405）', logsWrongMethod.status === 405, `status=${logsWrongMethod.status}`);

  const logsCross = await gatePost(LOGS_PATH, { kind: 'all' }, { headers: { origin: 'http://evil.example' } });
  await logsCross.text();
  check('清理路由拒绝跨站请求（403）', logsCross.status === 403, `status=${logsCross.status}`);

  const logsOuter = { code: 0, writeHead(code) { this.code = code; return this; }, end() {} };
  gateRoutes.get(LOGS_PATH).handler({ socket: { remoteAddress: '10.0.0.9' }, method: 'POST', url: LOGS_PATH }, logsOuter);
  check('清理路由非本机来源被拒（403）', logsOuter.code === 403, `code=${logsOuter.code}`);

  await new Promise((r) => gateServer.close(r));
  disposeGate();
  check('dispose 后日志清理路由也摘掉', gateRoutes.size === 0, [...gateRoutes.keys()].join(','));

  // ── P7：分辨率（面板「设置 → 分辨率」走宿主 POST /browser-service/viewport）──────
  console.log('\nP7 面板：改浏览器窗口分辨率');
  const vpCalls = [];
  const vpProvider = {
    viewport: () => ({ width: 1280, height: 720 }),
    setViewport: async (request) => {
      vpCalls.push({ width: request.width, height: request.height });
      const width = Number(request.width);
      const height = Number(request.height);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        const error = new Error('browser: 分辨率需要给出宽与高（像素，正整数）');
        error.code = 'BROWSER_VIEWPORT_INVALID';
        throw error;
      }
      return { width, height, applied: 1 };
    },
  };
  const vpRoutes = new Map();
  const disposeVp = registerPanel(liveRoutesFor(vpRoutes), { provider: vpProvider });

  const vpServer = createServer((request, response) => {
    const entry = vpRoutes.get(new URL(request.url, 'http://127.0.0.1').pathname);
    if (!entry) {
      response.writeHead(404);
      response.end();
      return;
    }
    entry.handler(request, response);
  });
  await new Promise((r) => vpServer.listen(0, '127.0.0.1', r));
  const vpBase = `http://127.0.0.1:${vpServer.address().port}`;
  const vpPost = (body, extra = {}) => fetch(`${vpBase}${VIEWPORT_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(extra.headers ?? {}) },
    body: JSON.stringify(body),
  });

  const vpPanel = await (await fetch(`${vpBase}${PANEL_PATH}`)).json();
  check('panel.json 的服务信息带出当前生效分辨率',
    vpPanel.service?.viewport?.width === 1280 && vpPanel.service?.viewport?.height === 720,
    JSON.stringify(vpPanel.service?.viewport));

  const vpOk = await vpPost({ width: 1600, height: 900 });
  const vpOkBody = await vpOk.json();
  check('改分辨率回 200 并带出已应用的页面数',
    vpOk.status === 200 && vpOkBody.viewport?.width === 1600 && vpOkBody.viewport?.height === 900
      && vpOkBody.viewport?.applied === 1 && vpCalls.length === 1 && vpCalls[0].width === 1600,
    JSON.stringify({ status: vpOk.status, body: vpOkBody, calls: vpCalls }));

  const vpBad = await vpPost({ width: 0, height: -5 });
  const vpBadBody = await vpBad.json();
  check('非法分辨率回 400（provider 的校验错误原样透出）',
    vpBad.status === 400 && /分辨率/.test(String(vpBadBody.error ?? '')),
    `status=${vpBad.status} error=${vpBadBody.error}`);

  const vpWrongMethod = await fetch(`${vpBase}${VIEWPORT_PATH}`);
  await vpWrongMethod.text();
  check('分辨率路由只收 POST（GET 回 405）', vpWrongMethod.status === 405, `status=${vpWrongMethod.status}`);

  const vpCross = await vpPost({ width: 1280, height: 720 }, { headers: { origin: 'http://evil.example' } });
  await vpCross.text();
  check('分辨率路由拒绝跨站请求（403）', vpCross.status === 403, `status=${vpCross.status}`);

  const vpOuter = { code: 0, writeHead(code) { this.code = code; return this; }, end() {} };
  vpRoutes.get(VIEWPORT_PATH).handler({ socket: { remoteAddress: '10.0.0.9' }, method: 'POST', url: VIEWPORT_PATH }, vpOuter);
  check('分辨率路由非本机来源被拒（403）', vpOuter.code === 403, `code=${vpOuter.code}`);

  const vpBare = new Map();
  const disposeVpBare = registerPanel(liveRoutesFor(vpBare));
  const vpBareRes = { code: 0, writeHead(code) { this.code = code; return this; }, end() {} };
  vpBare.get(VIEWPORT_PATH).handler({ socket: { remoteAddress: '127.0.0.1' }, method: 'POST', url: VIEWPORT_PATH, headers: {}, on() {}, destroy() {} }, vpBareRes);
  check('没有 provider 时改分辨率回 503', vpBareRes.code === 503, `code=${vpBareRes.code}`);
  disposeVpBare();

  await new Promise((r) => vpServer.close(r));
  disposeVp();
  check('dispose 后分辨率路由也摘掉', vpRoutes.size === 0, [...vpRoutes.keys()].join(','));

  // ── 观测落盘不能把浏览器调用搞挂 ─────────────────────────────────────────
  console.log('\nP3 数据层：观测容错');
  const notADir = join(root, 'ops.jsonl'); // 拿一个普通文件当 root：mkdir 必然失败
  check('写不进去时 appendOp 返回 false（不抛）', appendOp({ at: Date.now(), action: 'x' }, { root: notADir }) === false);
  check('没有记录时 readOps 给空列表', readOps({ root: join(root, '不存在这个目录') }).entries.length === 0);
  rmSync(EXPORT, { force: true });
} catch (error) {
  check('验收脚本自身未抛异常', false, `${error?.stack ?? error}`);
} finally {
  await shutdown();
}

console.log(`\n结果：${passed} 通过，${failures.length} 失败`);
if (failures.length > 0) console.log(`失败项：${failures.join('、')}`);
process.exit(failures.length === 0 ? 0 : 1);
