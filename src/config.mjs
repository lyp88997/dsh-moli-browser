/**
 * 配置与内核解析。
 * 优先级：CLI 参数 > 环境变量 > $ROOT/config.json > 自动探测。
 */
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULTS = {
  port: 9333,            // 公开 CDP 端口（0 = 自动择取）
  idleMs: 15 * 60_000,   // 无客户端连接多久后自杀
  maxRestarts: 5,        // 窗口内最大重启次数
  restartWindowMs: 60_000,
  startTimeoutMs: 25_000,
  internalPortBase: 9300,
};

/** 数值配置的合法区间：越界或非整数一律拒绝，避免 NaN 静默打穿定时器与重启预算。 */
const LIMITS = {
  port: [0, 65535],
  idleMs: [1000, 24 * 3600_000],
  maxRestarts: [0, 10_000],
  startTimeoutMs: [1000, 10 * 60_000],
  internalPortBase: [1, 65534],
};

export function dshHome(env = process.env) {
  const v = env.DSH_HOME?.trim();
  return v && v.length ? v : join(homedir(), '.dsh');
}

export function defaultRoot(env = process.env) {
  const v = env.DSH_BROWSER_SVC_ROOT?.trim();
  return v && v.length ? v : join(dshHome(env), 'browser-service');
}

/** 读 $ROOT/config.json（缺失/损坏返回 {}）。 */
export function readConfigFile(root) {
  const file = join(root, 'config.json');
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 自动探测候选内核。返回 { kind: 'wrapper' | 'chrome', path } 列表，按优先级排列。
 * wrapper = 负责注入 LD_LIBRARY_PATH / FONTCONFIG_FILE / 沙箱参数的包装脚本。
 */
export function detectKernels(env = process.env, found = existsSync) {
  const out = [];
  const add = (kind, path) => {
    if (typeof path === 'string' && path.length > 0 && found(path) && !out.some((c) => c.path === path)) out.push({ kind, path });
  };
  add('wrapper', env.DSH_BROWSER_WRAPPER);
  add('chrome', env.DSH_BROWSER_CHROME);
  // 本机（非 root 容器）常见落点，纯属便利，找不到就跳过
  add('wrapper', '/home/node/DSH/.browser/chromium-wrapper.sh');
  add('chrome', '/home/node/DSH/.browser/chromium/chrome-headless-shell');
  for (const dir of (env.PATH ?? '').split(':')) {
    if (!dir) continue;
    for (const name of ['chrome-headless-shell', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'msedge']) {
      add('chrome', join(dir, name));
    }
  }
  return out;
}

/** 合并出最终配置；任何越界/非整数配置直接抛错（调用方负责转成干净的 CLI 报错）。 */
export function resolveConfig(cli = {}, env = process.env) {
  const root = cli.root ?? defaultRoot(env);
  const file = readConfigFile(root);
  const num = (v, key) => {
    if (v === undefined || v === null || v === '') return undefined;
    const n = Number(v);
    const [lo, hi] = LIMITS[key];
    if (!Number.isInteger(n)) throw new Error(`无效的 ${key}：${JSON.stringify(v)}（需要整数）`);
    if (n < lo || n > hi) throw new Error(`无效的 ${key}：${n}（允许 ${lo}..${hi}）`);
    return n;
  };
  const cfg = {
    root,
    port: num(cli.port, 'port') ?? num(env.DSH_BROWSER_SVC_PORT, 'port') ?? num(file.port, 'port') ?? DEFAULTS.port,
    idleMs: num(cli.idleMs, 'idleMs') ?? num(env.DSH_BROWSER_SVC_IDLE_MS, 'idleMs') ?? num(file.idleMs, 'idleMs') ?? DEFAULTS.idleMs,
    maxRestarts: num(cli.maxRestarts, 'maxRestarts') ?? num(file.maxRestarts, 'maxRestarts') ?? DEFAULTS.maxRestarts,
    restartWindowMs: DEFAULTS.restartWindowMs,
    startTimeoutMs: num(cli.startTimeoutMs, 'startTimeoutMs') ?? num(file.startTimeoutMs, 'startTimeoutMs') ?? DEFAULTS.startTimeoutMs,
    internalPortBase: num(cli.internalPortBase, 'internalPortBase') ?? num(file.internalPortBase, 'internalPortBase') ?? DEFAULTS.internalPortBase,
    userDataDir: cli.userDataDir ?? file.userDataDir ?? join(root, 'profile'),
    kernel: null,
    kernelKind: null,
  };
  const want = cli.wrapper ?? file.wrapper;
  const wantChrome = cli.kernel ?? file.kernel;
  const candidates = detectKernels(env);
  if (want) cfg.kernel = want, cfg.kernelKind = 'wrapper';
  else if (wantChrome) cfg.kernel = wantChrome, cfg.kernelKind = 'chrome';
  else if (candidates.length) ({ path: cfg.kernel, kind: cfg.kernelKind } = candidates[0]);
  return cfg;
}

/**
 * 内核必须存在、是文件、且可执行——在 spawn 之前拒绝，否则 Node 会以
 * `Unhandled 'error' event  Error: spawn … ENOENT` 的原始栈崩掉，且内核已被
 * 部分拉起时没人回收。显式指定的路径与探测到的候选都走这一道。
 */
export function assertKernelExecutable(path) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new Error(`浏览器内核不存在：${path}`);
  }
  if (!stat.isFile()) throw new Error(`浏览器内核不是普通文件：${path}`);
  try {
    accessSync(path, constants.X_OK);
  } catch {
    throw new Error(`浏览器内核不可执行：${path}`);
  }
  return path;
}

/** 内核启动参数（CDP 只绑回环！host 网络下这是硬要求）。 */
export function browserArgs(cfg, internalPort) {
  return [
    '--headless',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${internalPort}`,
    `--user-data-dir=${cfg.userDataDir}`,
    'about:blank',
  ];
}

/** 建目录并把已存在目录的权限收敛回 0700（`mkdirSync` 的 mode 只对「新建」生效）。 */
export function ensureRoot(root) {
  const profile = join(root, 'profile');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  for (const dir of [root, profile]) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* 只读挂载等场景：权限不是我们能改的，继续 */
    }
  }
  const log = logFile(root);
  if (existsSync(log)) {
    try {
      chmodSync(log, 0o600);
    } catch {
      /* 同上 */
    }
  }
  return root;
}

export function stateFile(root) {
  return join(root, 'service.json');
}

export function logFile(root) {
  return join(root, 'service.log');
}
