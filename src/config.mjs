/**
 * 配置与内核解析。
 * 优先级：CLI 参数 > 环境变量 > $ROOT/config.json > 自动探测。
 */
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULTS = {
  port: 9333,            // 公开 CDP 端口（0 = 自动择取）
  idleMs: 15 * 60_000,   // 无客户端连接多久后自杀
  maxRestarts: 5,        // 窗口内最大重启次数
  restartWindowMs: 60_000,
  startTimeoutMs: 25_000,
  internalPortBase: 9300,
  // moli 推流帧间隔（决策点 3 实测拍板）：200ms 滚动 1.5s 出 6 帧；moli 原默认 1000ms 只出
  // 2 帧；100ms 无额外收益；四档静止时同样零流量。
  screencastIntervalMs: 200,
};

/** 数值配置的合法区间：越界或非整数一律拒绝，避免 NaN 静默打穿定时器与重启预算。 */
const LIMITS = {
  port: [0, 65535],
  idleMs: [1000, 24 * 3600_000],
  maxRestarts: [0, 10_000],
  startTimeoutMs: [1000, 10 * 60_000],
  internalPortBase: [1, 65534],
  screencastIntervalMs: [10, 60_000],
};

/** moli 没装时的三步人话报错（探测失败、spawn 失败都用它）。 */
export const MOLI_INSTALL_HINT = [
  '未找到 moli 浏览器内核。三步装好：',
  '  1) 下载官方 release（https://github.com/lexmount/moli/releases）里与本机对应的包（x86_64-unknown-linux-gnu）；',
  '  2) 用 release 页公布的 sha256 校验下载包（sha256sum -c）；',
  '  3) 解压后放进 PATH，或用 DSH_BROWSER_MOLI=/path/to/moli（CLI 等价 --kernel=/path/to/moli）指定。',
  '字体/缺库报错时：设 FONTCONFIG_FILE 指向含中文字体的 fonts.conf（或装 libfontconfig1），详见 README 字体排查。',
].join('\n');

/** 本机已知 moli 落点（探测便利项，不存在就跳过；PATH/DSH_BROWSER_MOLI 优先级更高）。 */
const KNOWN_MOLI_DIRS = ['/home/node/Lightpanda/安装包'];
/** moli 是纯静态外挂字体栈之外还依赖系统 fontconfig 动态库，容器里没有 → 指向自带 libs。 */
const KNOWN_LIB_DIRS = [
  '/home/node/DSH/.browser/libs/usr/lib/x86_64-linux-gnu',
  '/home/node/DSH/.browser/libs/lib/x86_64-linux-gnu',
];
/** DSH 自带中文字体配置（否则面板/页面中文字形全成豆腐块）。 */
const KNOWN_FONTCONFIG = '/home/node/DSH/.browser/fonts.conf';

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
 * 自动探测候选内核。返回 { kind: 'moli' | 'wrapper', path } 列表，按优先级排列：
 *   1) DSH_BROWSER_MOLI（显式 moli 二进制）→ 2) PATH 里的 moli → 3) 本机已知安装目录（版本无关）。
 * wrapper = 手动指定的包装脚本（排障口，收到的形参就是 moli serve 形参，见 browserArgs）。
 * 单发动机方案：不探测 Chrome，没装 moli 就报 MOLI_INSTALL_HINT。
 */
export function detectKernels(env = process.env, found = existsSync) {
  const out = [];
  const add = (kind, path) => {
    if (typeof path === 'string' && path.length > 0 && found(path) && !out.some((c) => c.path === path)) out.push({ kind, path });
  };
  add('wrapper', env.DSH_BROWSER_WRAPPER);
  add('moli', env.DSH_BROWSER_MOLI);
  for (const dir of (env.PATH ?? '').split(':')) {
    if (dir) add('moli', join(dir, 'moli'));
  }
  // 本机已知落点（`安装包/moli-*/moli`，版本无关），纯属便利，找不到就跳过
  for (const base of KNOWN_MOLI_DIRS) {
    if (!found(base)) continue;
    let entries = [];
    try {
      entries = readdirSync(base);
    } catch {
      continue;
    }
    for (const name of entries.sort()) {
      if (name.startsWith('moli-')) add('moli', join(base, name, 'moli'));
    }
  }
  return out;
}

/** moli 运行环境：fontconfig 动态库 + DSH 自带中文字体配置。DSH_BROWSER_LIBS / DSH_BROWSER_FONTCONFIG 可覆盖。 */
export function moliEnv(env = process.env) {
  const out = { ...env };
  const libs = env.DSH_BROWSER_LIBS ?? KNOWN_LIB_DIRS.filter((d) => existsSync(d)).join(':');
  if (libs) out.LD_LIBRARY_PATH = out.LD_LIBRARY_PATH ? `${libs}:${out.LD_LIBRARY_PATH}` : libs;
  const fonts = env.DSH_BROWSER_FONTCONFIG ?? (existsSync(KNOWN_FONTCONFIG) ? KNOWN_FONTCONFIG : '');
  if (fonts) out.FONTCONFIG_FILE = fonts;
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
    screencastIntervalMs: num(cli.screencastIntervalMs, 'screencastIntervalMs')
      ?? num(env.DSH_BROWSER_SCREENCAST_INTERVAL_MS, 'screencastIntervalMs')
      ?? num(file.screencastIntervalMs, 'screencastIntervalMs')
      ?? DEFAULTS.screencastIntervalMs,
    kernel: null,
    kernelKind: null,
  };
  const want = cli.wrapper ?? file.wrapper;
  const wantMoli = cli.kernel ?? file.kernel;
  const candidates = detectKernels(env);
  if (want) cfg.kernel = want, cfg.kernelKind = 'wrapper';
  else if (wantMoli) cfg.kernel = wantMoli, cfg.kernelKind = 'moli';
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

/**
 * 内核启动参数 = `moli serve` 形参（CDP 只绑回环！host 网络下这是硬要求）。
 * kind=wrapper 时收到的也是这组形参——wrapper 必须是 moli 的等价替换（透传或翻译）。
 * --layout --resource = 真排版 + 全资源族，保住面板画面线与页面还原度。
 */
export function browserArgs(cfg, internalPort) {
  const args = [
    'serve',
    '--host', '127.0.0.1',
    '--port', String(internalPort),
    '--layout',
    '--resource',
  ];
  if (cfg.screencastIntervalMs != null) args.push('--screencast-interval-ms', String(cfg.screencastIntervalMs));
  args.push('--profile-dir', cfg.userDataDir);
  return args;
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
