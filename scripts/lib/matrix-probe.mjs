#!/usr/bin/env node
/**
 * 多版本矩阵的探测脚本（由 scripts/verify-matrix.mjs 在**隔离 profile 里**调用）。
 *
 * 为什么单独成文件：模块解析按文件位置走，不按 cwd —— 放进 profile 里每次都带一份会把 tarball
 * 弄脏，所以这里用**绝对路径** import 装进去的包，探测脚本自己不需要解析任何宿主包。
 *
 * 用法：node matrix-probe.mjs --pkg-dir <装好的包目录> [--smoke-root <目录> --port <端口>]
 * 输出：一行 `MATRIX_JSON {…}`
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const pkgDir = argOf('--pkg-dir');
const smokeRoot = argOf('--smoke-root');
const port = argOf('--port');
const smoke = Boolean(smokeRoot && port);
const at = (rel) => pathToFileURL(join(pkgDir, rel)).href;

const logs = { info: [], warn: [], error: [] };
const registered = [];
const disposers = [];
const panelRoutes = [];
const injectedDeps = [];
const logger = {
  info: (m) => logs.info.push(String(m)),
  warn: (m) => logs.warn.push(String(m)),
  error: (m) => logs.error.push(String(m)),
};
const effect = (fn) => { disposers.push(fn); return () => {}; };
// 模拟真实 cordis ctx：`ctx.inject(deps, cb)` 把「有这些服务的 ctx」交给回调（本包用它挂可选的
// 面板路由）。桩里必须给全 webServer/effect/logger —— 少了就是桩失真，会把本的插件判成坏的。
const ctx = {
  logger,
  browser: { registerBrowserProvider: (p) => { registered.push(p); return () => {}; } },
  effect,
  inject: (deps, cb) => {
    injectedDeps.push(...deps);
    const child = {
      logger,
      effect,
      webServer: { register: (route) => { panelRoutes.push(route?.path); return () => {}; } },
    };
    return cb(child);
  },
};

const entry = await import(at('plugin/lib/index.js'));
const compat = await import(at('plugin/lib/compat.js'));
const versions = compat.readVersions();
const config = entry.Config(smoke
  ? {
    cdpUrl: `http://127.0.0.1:${port}`,
    autoStartCommand: `node ${join(pkgDir, 'bin', 'browsersvc.mjs')} start --root=${smokeRoot} --port=${port}`,
  }
  : {});
await entry.apply(ctx, config);

// 反向验证：宿主 ctx 上没有 `inject`（旧宿主/自定义 harness）时，apply 必须不抛，且 provider 照常注册
// —— 网页面板是可选件，不能把浏览器工具一起带坏。
const bareRegistered = [];
let bareError = null;
try {
  await entry.apply({ logger, browser: { registerBrowserProvider: (p) => { bareRegistered.push(p); return () => {}; } }, effect }, config);
} catch (error) {
  bareError = error instanceof Error ? error.message : String(error);
}
const bareOk = bareError === null && bareRegistered.length === 1;

const out = {
  name: entry.name,
  inject: entry.inject,
  versions,
  registered: registered.map((p) => p.id),
  logs,
  config: { providerId: config.providerId, cdpUrl: config.cdpUrl, maxTabs: config.maxTabs, idleMs: config.idleMs },
  injected: injectedDeps,
  panelRoutes,
  bareOk,
  bareError,
};
// 先打印核心探测结果：后面的真实浏览若失败，也不该丢掉「加载 + 注册 + 探测」的证据。
console.log(`MATRIX_JSON ${JSON.stringify(out)}`);

if (smoke && registered.length === 1) {
  const provider = registered[0];
  const page = {};
  try {
    const id = await provider.open('matrix');
    await provider.openUrl(id, { url: 'https://example.com/' });
    const snapshot = await provider.snapshot(id);
    const text = await provider.content(id, { maxChars: 4000 });
    Object.assign(page, {
      id,
      url: snapshot?.url,
      title: snapshot?.title,
      // 只报「读到了多少正文」与标题：example.com 的正文文案是上游随时会改的外部事实
      // （2026-09 实测正文已改成 "This domain is for use in documentation examples…"，
      // 不再有 "Example Domain" 字样），所以断言只压在「导航成功 + 真读到正文」，不绑措辞。
      contentLength: String(text?.content ?? '').length,
      hasTitle: /Example Domain/i.test(String(snapshot?.title ?? '')),
    });
  } catch (error) {
    Object.assign(page, { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
  }
  console.log(`MATRIX_PAGE ${JSON.stringify(page)}`);
}
await registered[0]?.dispose?.();
for (const fn of disposers) {
  try { fn(); } catch { /* 已经释放过 */ }
}
