/**
 * 网页面板的宿主半边：观测数据的只读 JSON 路由 + 实时网页窗口的三条路由（0.7.0）。
 *
 * 只读部分的数据全部来自观测日志文件（`src/opslog.mjs` 写的 ops/console/network.jsonl），
 * 不需要碰浏览器，面板坏了也不会影响浏览器工具本身。
 *
 * 实时窗口部分（`/browser-service/live*`）是对浏览器的**读写**入口，因此比只读路由多三道闸：
 *   1. 只认回环地址（127.0.0.1 / ::1）—— 远端一律 403；
 *   2. POST/DELETE 要求 Origin/Referer 与本机 Host 同源（浏览器必带 Origin，跨站请求挡在门外）；
 *   3. 请求体上限 64 KB，动作按白名单转发。
 * `/browser-service/logs`（POST）同样只对本机同源开放：它删观测日志，属于写操作。
 * `/browser-service/viewport`（POST）改浏览器窗口分辨率，也是写操作，同样只对本机同源开放。
 * 客户端半边（`plugin/client.js`）轮询这些路由，把画面显示成浮动窗口。
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { LOG_KINDS, clearEntries, readConsole, readNetwork, readOps } from '../../src/opslog.mjs';
import { defaultRoot } from '../../src/config.mjs';

export const PANEL_PATH = '/browser-service/panel.json';
export const LIVE_IMAGE_PATH = '/browser-service/live.jpg';
export const LIVE_STATE_PATH = '/browser-service/live.json';
export const LIVE_INPUT_PATH = '/browser-service/live';
export const LOGS_PATH = '/browser-service/logs';
export const VIEWPORT_PATH = '/browser-service/viewport';

/** 自身版本号：面板「设置」区显示用（读自己的 package.json，读不到就留空）。 */
const PACKAGE_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version ?? '';
  } catch {
    return '';
  }
})();

/** 面板一次最多拉多少条：够看，又不至于把网页拖垮。 */
const MAX_LINES = 200;
const DEFAULT_LINES = 40;

/** 长轮询最长等待：没等到新帧就回 204，让客户端稍后再问（而不是把连接吊住）。 */
const MAX_FRAME_WAIT_MS = 1500;

/** 这么久没人取帧就停流：面板收起/页面切走之后浏览器不该一直录屏。 */
const STREAM_IDLE_MS = 30_000;
const IDLE_TICK_MS = 5_000;

/** 输入动作的请求体上限。 */
const MAX_BODY = 64 * 1024;

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function linesOf(reqUrl) {
  let raw;
  try {
    raw = new URL(reqUrl, 'http://127.0.0.1').searchParams.get('lines');
  } catch {
    return DEFAULT_LINES;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_LINES;
  return Math.min(MAX_LINES, Math.max(1, Math.floor(value)));
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 地址栏输入的规整：没有协议就按 https 补（用户只会打 `example.com`）。
 * 已经有协议的（`file:`、`javascript:` 之类）原样交给 provider 的 http(s) 白名单去挡。
 */
function normalizeUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) throw new Error('请先输入网址');
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) return `https://${text}`;
  return text;
}

function json(res, code, payload, extra = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...extra,
  });
  res.end(body);
}

/** 实时窗口只对本机开放：这是能操作浏览器的入口，不能给远端。 */
function isLoopback(req) {
  const address = req.socket?.remoteAddress;
  return typeof address === 'string' && LOOPBACK.has(address);
}

/**
 * 同源校验（CSRF 防线）：浏览器发的跨站请求一定带 Origin，且与本机 Host 不同。
 * 没有来源头的请求（curl、脚本测试）在回环检查之后放行。
 */
function sameOrigin(req) {
  const raw = req.headers.origin ?? req.headers.referer;
  if (!raw) return true;
  const host = req.headers.host;
  if (!host) return false;
  try {
    return new URL(String(raw)).host === host;
  } catch {
    return false;
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error(`请求体过大（上限 ${MAX_BODY} 字节）`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(text);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${describe(error)}`));
      }
    });
    req.on('error', reject);
  });
}

/**
 * 面板载荷：只给条目数与条目，外加「设置」区要显示的只读服务信息。
 * 仍然不回传本机绝对路径 —— 下载目录只回**目录名**（用户自己配的，回全路径没有额外用处）。
 */
export function panelPayload({ root = defaultRoot(), lines = DEFAULT_LINES, service = {} } = {}) {
  const shape = ({ total, entries }) => ({ total, entries });
  return {
    generatedAt: new Date().toISOString(),
    service: {
      version: PACKAGE_VERSION,
      session: service.session ?? null,
      cdpUrl: service.cdpUrl ?? '',
      downloadDir: service.downloadDir ? basename(service.downloadDir) : '',
      maxTabs: service.maxTabs ?? null,
      idleMs: service.idleMs ?? null,
      captureConsole: service.captureConsole !== false,
      captureNetwork: service.captureNetwork !== false,
      live: service.live ?? null,
      viewport: service.viewport ?? null,
    },
    ops: shape(readOps({ root, lines })),
    console: shape(readConsole({ root, lines })),
    network: shape(readNetwork({ root, lines })),
  };
}

/**
 * 注册面板路由；返回 disposer。宿主没有 webServer 服务时由调用方跳过。
 * @param {{webServer: {register: Function}}} ctx
 * @param {{provider?: object, config?: object}} [deps] 浏览器 provider（实时窗口用）+ 生效配置（设置区显示用）
 */
export function registerPanel(ctx, { provider, config } = {}) {
  /** 当前正在推流的视图：`{ sessionId, view }`。 */
  let streaming = null;
  /** 最近一次被客户端取帧的时间：用来判断「面板是不是已经不看了」。 */
  let lastFrameAt = 0;

  const targetId = () => (typeof provider?.liveTarget === 'function' ? provider.liveTarget() : null);
  const viewFor = (id) => (id && typeof provider?.liveView === 'function' ? provider.liveView(id) : null);
  const stopStreaming = async () => {
    const current = streaming;
    streaming = null;
    if (current?.view) await current.view.stop().catch(() => {});
  };

  /** 「设置」区的只读服务信息：生效配置 + 当前取帧参数。 */
  const serviceInfo = () => {
    const id = targetId();
    const view = viewFor(id);
    return {
      session: id ?? null,
      cdpUrl: config?.cdpUrl,
      downloadDir: config?.downloadDir,
      maxTabs: config?.maxTabs,
      idleMs: config?.idleMs,
      captureConsole: config?.captureConsole,
      captureNetwork: config?.captureNetwork,
      live: view?.options ?? null,
      viewport: typeof provider?.viewport === 'function' ? provider.viewport() : null,
    };
  };

  const panelHandler = (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      json(res, 405, { error: '只支持 GET' }, { allow: 'GET' });
      return;
    }
    try {
      const body = JSON.stringify(panelPayload({ lines: linesOf(req.url), service: serviceInfo() }));
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) {
      json(res, 500, { error: describe(error) });
    }
  };

  /** live.json：面板用它同步地址栏、标题与「有没有在推流」。 */
  const liveStateHandler = async (req, res) => {
    if (!provider) {
      json(res, 503, { error: '没有浏览器 provider', live: false });
      return;
    }
    const id = targetId();
    const view = viewFor(id);
    if (!view) {
      json(res, 200, {
        live: false,
        seq: 0,
        at: 0,
        url: '',
        title: '',
        width: 0,
        height: 0,
        session: null,
        reason: '当前没有打开的页面 —— 在上面的地址栏输入网址并点「跳转」即可打开',
      });
      return;
    }
    const state = await view.state();
    json(res, 200, { ...state, session: id, options: view.options ?? null });
  };

  /** live.jpg：长轮询取一帧。客户端把 seq 通过 ?since= 带回来，服务端只回更新的帧。 */
  const liveImageHandler = async (req, res) => {
    if (!provider) {
      json(res, 503, { error: '没有浏览器 provider' });
      return;
    }
    let search;
    try {
      search = new URL(req.url, 'http://127.0.0.1').searchParams;
    } catch {
      search = new URLSearchParams();
    }
    const since = Number(search.get('since')) || 0;
    // 设置区能调画质与最大边（越界由 liveview 夹住）；不传就沿用当前值。
    const options = {
      quality: search.get('quality'),
      maxWidth: search.get('max'),
      maxHeight: search.get('maxh'),
    };
    const id = targetId();
    const view = viewFor(id);
    if (!view) {
      json(res, 204, { error: '当前没有可用的浏览器会话' });
      return;
    }
    // 会话/标签页换了：旧的流没有意义，先停掉。
    if (streaming && streaming.sessionId !== id) await stopStreaming();
    try {
      await view.start(options);
      const applied = view.options ?? {};
      streaming = { sessionId: id, view };
      lastFrameAt = Date.now();
      const frame = await view.waitFrame({ since, timeoutMs: MAX_FRAME_WAIT_MS });
      if (!frame) {
        res.writeHead(204, { 'cache-control': 'no-store' });
        res.end();
        return;
      }
      res.writeHead(200, {
        'content-type': 'image/jpeg',
        'cache-control': 'no-store',
        'content-length': frame.jpeg.length,
        'x-frame-seq': String(frame.seq),
        'x-frame-w': String(frame.width),
        'x-frame-h': String(frame.height),
        'x-frame-quality': String(applied.quality ?? ''),
        'x-frame-max': `${applied.maxWidth ?? ''}x${applied.maxHeight ?? ''}`,
      });
      res.end(req.method === 'HEAD' ? undefined : frame.jpeg);
    } catch (error) {
      json(res, 500, { error: describe(error) });
    }
  };

  /** live：把窗口里的动作转发给页面；DELETE 表示「不看了，停流」。 */
  const liveInputHandler = async (req, res) => {
    if (req.method === 'DELETE') {
      await stopStreaming();
      json(res, 200, { ok: true, live: false });
      return;
    }
    if (req.method !== 'POST') {
      json(res, 405, { error: '只支持 POST / DELETE' }, { allow: 'POST, DELETE' });
      return;
    }
    if (!provider) {
      json(res, 503, { error: '没有浏览器 provider' });
      return;
    }
    if (!sameOrigin(req)) {
      json(res, 403, { error: '跨站请求被拒绝（实时窗口只接受同源请求）' });
      return;
    }
    let action;
    try {
      action = await readJson(req);
    } catch (error) {
      json(res, 400, { error: describe(error) });
      return;
    }
    const id = targetId();
    const view = viewFor(id);
    if (String(action.kind ?? '') === 'goto') {
      let url;
      try {
        url = normalizeUrl(action.url);
      } catch (error) {
        json(res, 400, { error: describe(error) });
        return;
      }
      try {
        // 地址栏的语义就是「打开这个网址」：一个会话都没有时顺手开一个（等价于 browser_open）
        // 再导航，而不是回 409 让用户先去别处把页面开好。
        let target = id;
        if (!view) target = await provider.open('面板地址栏');
        // 复用 provider 的导航通道：http(s) 校验与 ops 记账都在那里。
        await provider.openUrl(target, { url });
        json(res, 200, { ok: true, url, session: target, opened: !view });
      } catch (error) {
        json(res, 400, { error: describe(error) });
      }
      return;
    }
    if (!view) {
      json(res, 409, { error: '当前没有打开的页面 —— 在上面的地址栏输入网址并点「跳转」即可打开' });
      return;
    }
    try {
      json(res, 200, await view.input(action));
    } catch (error) {
      json(res, 400, { error: describe(error) });
    }
  };

  /** logs：手动「清理」与设置里的「自动清理」共用这一条（只认 POST + 同源 + 回环）。 */
  const logsHandler = async (req, res) => {
    if (!sameOrigin(req)) {
      json(res, 403, { error: '跨站请求被拒绝（清理日志只接受同源请求）' });
      return;
    }
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      json(res, 400, { error: describe(error) });
      return;
    }
    const action = String(body.action ?? 'clear') === 'trim' ? 'trim' : 'clear';
    const wanted = String(body.kind ?? 'all');
    const kinds = wanted === 'all' ? Object.keys(LOG_KINDS) : [wanted];
    const unknown = kinds.filter((kind) => !LOG_KINDS[kind]);
    if (unknown.length) {
      json(res, 400, { error: `未知的日志类型：${unknown.join('、')}` });
      return;
    }
    // clear = 清空；trim = 保留最近 keep 条（keep 缺省 0，等于清空）。
    const keep = action === 'trim' ? Math.max(0, Math.floor(Number(body.keep)) || 0) : 0;
    try {
      const result = {};
      for (const kind of kinds) result[kind] = clearEntries(kind, { root: defaultRoot(), keep });
      json(res, 200, { ok: true, action, keep, result });
    } catch (error) {
      json(res, 500, { error: describe(error) });
    }
  };

  /**
   * viewport：改浏览器窗口分辨率（面板「设置 → 分辨率」）。只认 POST + 同源 + 回环；
   * 具体夹取与「现页立即生效 + 记住给新会话」都在 provider.setViewport 里（单一事实源）。
   */
  const viewportHandler = async (req, res) => {
    if (!sameOrigin(req)) {
      json(res, 403, { error: '跨站请求被拒绝（改分辨率只接受同源请求）' });
      return;
    }
    if (!provider || typeof provider.setViewport !== 'function') {
      json(res, 503, { error: '当前没有可用的浏览器 provider' });
      return;
    }
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      json(res, 400, { error: describe(error) });
      return;
    }
    try {
      const applied = await provider.setViewport({ width: body.width, height: body.height });
      json(res, 200, { ok: true, viewport: applied, at: Date.now() });
    } catch (error) {
      json(res, 400, { error: describe(error) });
    }
  };

  // 实时窗口的入口统一套回环闸；面板本身保持只读（与 0.6.0 行为一致）。
  const guarded = (handler, allowed) => (req, res) => {
    if (!isLoopback(req)) {
      json(res, 403, { error: '实时窗口只对本机开放' });
      return;
    }
    if (!allowed.includes(req.method)) {
      json(res, 405, { error: `只支持 ${allowed.join(' / ')}` }, { allow: allowed.join(', ') });
      return;
    }
    Promise.resolve(handler(req, res)).catch((error) => {
      try {
        json(res, 500, { error: describe(error) });
      } catch {
        /* 响应已经发出去或连接已断：忽略 */
      }
    });
  };

  const routes = [
    { path: PANEL_PATH, handler: panelHandler },
    { path: LIVE_STATE_PATH, handler: guarded(liveStateHandler, ['GET', 'HEAD']) },
    { path: LIVE_IMAGE_PATH, handler: guarded(liveImageHandler, ['GET', 'HEAD']) },
    { path: LIVE_INPUT_PATH, handler: guarded(liveInputHandler, ['POST', 'DELETE']) },
    { path: LOGS_PATH, handler: guarded(logsHandler, ['POST']) },
    { path: VIEWPORT_PATH, handler: guarded(viewportHandler, ['POST']) },
  ];

  const disposers = routes.map(({ path, handler }) => ctx.webServer.register({ kind: 'exact', path, handler }));

  // 面板收起/页面切走之后就没人取帧了：30 秒没动静就停流（浏览器不必一直录屏）。
  const idleTimer = setInterval(() => {
    if (!streaming || Date.now() - lastFrameAt < STREAM_IDLE_MS) return;
    void stopStreaming();
  }, IDLE_TICK_MS);
  idleTimer.unref?.();

  return () => {
    clearInterval(idleTimer);
    void stopStreaming();
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* 路由已经跟着宿主一起没了：忽略 */
      }
    }
  };
}
