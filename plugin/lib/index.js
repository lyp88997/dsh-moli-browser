/**
 * dsh-moli-browser 的 provider 插件 —— 把 DSH 的 browser seam 接到自建 CDP 浏览器服务（browsersvc）。
 *
 * 只做一件事：注册一个 BrowserProvider。接缝（ctx.browser）与工具面（33 个 browser_* 工具）
 * 由本包的依赖 dsh-builtin-browser 提供，经本包 ./browser、./tool-browser 转出后由 bundle patch 挂上。
 */
import { exec } from 'node:child_process';
import { resolve } from 'node:path';
import Schema from '@deepseek-ai/schemastery';
import { createProvider } from './provider.js';
import { LIVE_STATE_PATH, LOGS_PATH, PANEL_PATH, VIEWPORT_PATH, registerPanel } from './panel.js';
import { SEAM_PACKAGE, TESTED_HOSTS, inspectSeam, readVersions, seamMismatchMessage } from './compat.js';
import { PACKAGE_VERSION, defaultSkillsRoot, syncSkills } from '../../src/skills.mjs';
import { BUNDLED_SKILL_RANK, PROVIDER_NAME as SKILL_PROVIDER_NAME, SKILL_NAMES, createSkillsProvider } from '../../src/skill-provider.mjs';

export const name = 'browser-moli';

/** seam 服务：`ctx.browser` 由 dsh-builtin-browser/browser 提供。 */
export const inject = ['browser'];

export const Config = Schema.object({
  /** 注册到 seam 的 provider id（配置 browserProvider 时引用它）。 */
  providerId: Schema.string().default('cdp-daemon'),
  /** 守护进程的 CDP 端点（HTTP /json/version 那一侧）。 */
  cdpUrl: Schema.string().default('http://127.0.0.1:9333'),
  /** attach 到 CDP 端点的超时。 */
  connectTimeoutMs: Schema.number().default(10_000),
  /** 元素操作的默认预算（点击/填写/求值）。 */
  actionTimeoutMs: Schema.number().default(30_000),
  /** 导航/刷新预算。 */
  navigationTimeoutMs: Schema.number().default(30_000),
  /** 元素查找与 scrape 的等待预算。 */
  lookupTimeoutMs: Schema.number().default(5_000),
  /** 单次快照最多返回多少个可交互元素。 */
  snapshotMaxElements: Schema.number().default(200),
  /** 单次内容读取的最大字符数。 */
  contentMaxChars: Schema.number().default(200_000),
  /**
   * 单个会话允许的最大标签页数（默认 5，夹在 1..50）。每个标签页在无头内核里是一个独立渲染
   * 进程（实测约 +93 MB），超过上限时 `browser_open {newTab:true}` 报 `BROWSER_TAB_LIMIT`。
   */
  maxTabs: Schema.number().default(5),
  /**
   * P3 观测：把每个标签页的 console / pageerror 追加到 `<root>/console.jsonl`（`browsersvc console` 读回）。
   * 默认开；设 false 就完全不挂监听器。
   */
  captureConsole: Schema.boolean().default(true),
  /**
   * P3 观测：把请求/响应元数据追加到 `<root>/network.jsonl`（`browsersvc network` 读回），并给每个会话
   * 录一份 HAR 到 `<root>/har/`（`browsersvc har` 导出）。只记 URL/状态码/耗时，不落请求体。默认开。
   */
  captureNetwork: Schema.boolean().default(true),
  /** 会话视口尺寸（坐标点击的空间）。 */
  viewportWidth: Schema.number().default(1920),
  viewportHeight: Schema.number().default(1080),
  /**
   * 本包自启守护进程时的空闲回收窗口（毫秒，默认 5 分钟，值会夹到 1000..24h）。最后一个会话
   * 关闭后插件会主动断开 CDP 连接，守护进程再空闲这么久就退出、把约 600 MB 还给系统；下次
   * 调用自动重新拉起。仅在使用默认自启命令时生效（自定义 `autoStartCommand` 请自己带 `--idle-ms`）。
   */
  idleMs: Schema.number().default(300_000),
  /**
   * 可选：CDP 端点不可用时执行一次的自启命令。
   * 默认（不配置）用本包自带的 `bin/browsersvc.mjs start`，即装完本包就能自启（一个包装完）。
   */
  autoStartCommand: Schema.string(),
  /** 自启命令（`browsersvc start` 内含内核冷启动 + 健康检查）的预算，与 attach 超时分开。 */
  autoStartTimeoutMs: Schema.number().default(60_000),
  /**
   * 访问代理端口的 Bearer token。默认（不配置）时自动读 `$DSH_BROWSER_SVC_ROOT|$DSH_HOME/browser-service/service.json`
   * 里的 token（每次守护进程启动随机生成）。
   */
  cdpToken: Schema.string(),
  /**
   * 目标技能根目录（仅在 `syncSkills` 打开时用）。
   * 默认 `$DSH_HOME/skills`，即 DSH 的用户级技能目录（rank 400）。
   */
  skillsDir: Schema.string().default(''),
  /**
   * 是否把随包技能注册成 DSH 的**内置技能**（默认开）。走 `ctx.skills.registerProvider()`，
   * `source:'bundled'` + rank 600，技能中心里显示成「系统内置」，和 dsh-univer-office 一样。
   * 正文现读 `skills/<name>/SKILL.md`，改文件不用重启插件。
   */
  registerSkills: Schema.boolean().default(true),
  /**
   * 可选：把随包技能**同时落盘**到 `skillsDir`（默认关）。落盘是用户级（rank 400），
   * 会在技能中心里盖住内置那份（同一层 rank 小的先赢）⇒ 只为「DSH 以外的工具也要读这些文件」时才开。
   * 带归属台账：只覆盖本包写过且之后没人动过的文件，用户改过的或同名非本包的技能一律跳过。
   */
  syncSkills: Schema.boolean().default(false),
  /**
   * 可选：截图/下载落盘的目录边界。不配置时取系统 Downloads 目录（`XDG_DOWNLOAD_DIR` → 家目录下
   * 存在的 `Downloads`/`下载`/`下載` → `~/Downloads`），与内置 provider 同语义。
   */
  downloadDir: Schema.string(),
});

/** 执行一次自启命令；超时或非零退出都视为失败。 */
function runCommand(command, timeoutMs) {
  return new Promise((resolve, reject) => {
    exec(command, { timeout: timeoutMs }, (error, _stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim()));
      else resolve();
    });
  });
}

/**
 * 把随包技能注册成 DSH 的内置技能（默认开）。与浏览器接缝无关：接缝坏了、provider 没注册成，
 * 这两份技能在技能中心里照旧是内置可见、照旧可加载 —— 所以放在 apply 的最前面做。
 * 宿主没有 `skills` 服务（老 DSH / 自定义 harness）时只记一行日志，绝不影响 provider。
 */
function registerBundledSkills(ctx, config) {
  if (config.registerSkills === false) return;
  if (typeof ctx.inject !== 'function') {
    ctx.logger?.info?.('browser-moli: 宿主 ctx 没有 inject，跳过内置技能注册（provider 不受影响）');
    return;
  }
  ctx.inject(['skills'], (skillCtx) => {
    if (typeof skillCtx.skills?.registerProvider !== 'function') {
      skillCtx.logger?.warn?.('browser-moli: 宿主没有 ctx.skills.registerProvider，内置技能未注册');
      return;
    }
    const dispose = skillCtx.skills.registerProvider(() => createSkillsProvider({ log: skillCtx.logger }));
    skillCtx.effect(() => () => dispose(), 'browser-moli: bundled skills provider');
    skillCtx.logger?.info?.(
      `browser-moli: 已注册内置技能 "${SKILL_PROVIDER_NAME}"（${SKILL_NAMES.join(' / ')}；source=bundled，rank=${BUNDLED_SKILL_RANK}）`,
    );
  });
}

export async function apply(ctx, config) {
  // 内置技能：与接缝无关，先注册（详见 registerBundledSkills）。
  registerBundledSkills(ctx, config);

  // 可选：把同一批技能落盘到技能根目录（默认关）。落盘是用户级身份（rank 400），会在技能中心里
  // 盖住上面的内置那份（同一层 rank 小的先赢）；只有「DSH 以外的工具也要读这些文件」时才该打开。
  if (config.syncSkills === true) {
    try {
      const root = config.skillsDir ? resolve(config.skillsDir) : defaultSkillsRoot();
      const result = syncSkills({ root, version: PACKAGE_VERSION });
      if (result.installed.length > 0 || result.updated.length > 0) {
        ctx.logger?.info?.(
          `browser-moli: 随包全局技能已同步到 ${root}（装 ${result.installed.length}、升级 ${result.updated.length}，本包 ${PACKAGE_VERSION}）`,
        );
      }
      if (result.skipped.length > 0 || result.errors.length > 0) {
        const detail = [
          ...result.skipped.map((item) => `${item.path} 跳过（${item.reason}）`),
          ...result.errors,
        ].join('；');
        ctx.logger?.warn?.(`browser-moli: 随包技能没有全部落盘 —— ${detail}。要覆盖用 browsersvc skills --install --force`);
      }
    } catch (error) {
      ctx.logger?.warn?.(`browser-moli: 随包技能同步失败（不影响 provider）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 启动期能力探测：先把「接缝还在不在、形状对不对」说清楚，再谈 provider。
  const versions = readVersions();
  let seamBrowser;
  let seamTools;
  try {
    seamBrowser = await import(`${SEAM_PACKAGE}/browser`);
    seamTools = await import(`${SEAM_PACKAGE}/tool-browser`);
  } catch (error) {
    ctx.logger?.error?.(
      `browser-moli: 插件未启用 —— 加载浏览器接缝 ${SEAM_PACKAGE} 失败（装的是 ${versions.seam ?? '未知'}，宿主 DSH ${versions.host ?? '未知'}）：`
      + `${error instanceof Error ? error.message : String(error)}。`
      + ' 本包依赖该接缝提供 ctx.browser 与 33 个 browser_* 工具；接缝缺失通常意味着依赖没装齐（profile 里 dsh-moli-browser 与 dsh-builtin-browser 应同时存在）或上游改了包名。',
    );
    return;
  }
  const verdict = inspectSeam({ browserModule: seamBrowser, toolModule: seamTools, hostVersion: versions.host });
  if (!verdict.ok) {
    ctx.logger?.error?.(seamMismatchMessage(verdict, versions));
    return;
  }
  for (const warning of verdict.warnings) ctx.logger?.warn?.(`browser-moli: ${warning}`);
  if (typeof ctx.browser?.registerBrowserProvider !== 'function') {
    ctx.logger?.error?.(
      `browser-moli: 插件未启用 —— 宿主没有提供 ctx.browser.registerBrowserProvider（宿主 DSH ${versions.host ?? '未知'}）。`
      + ` 本包实测过的宿主：${TESTED_HOSTS.join(' / ')}。`,
    );
    return;
  }

  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch (error) {
    ctx.logger?.error?.(`browser-moli: 无法加载 playwright-core，未注册 provider：${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const provider = createProvider({
    chromium,
    BrowserError: seamBrowser.BrowserError,
    config,
    log: ctx.logger,
    autoStart: (command, timeoutMs) => runCommand(command, timeoutMs),
  });
  const unregister = ctx.browser.registerBrowserProvider(provider);
  ctx.effect(() => () => {
    unregister();
    void provider.dispose();
  }, 'browser-moli: owned provider lifecycle');
  ctx.logger?.info?.(
    `browser-moli: 已注册 provider "${provider.id}"（${config.cdpUrl}；宿主 DSH ${versions.host ?? '未知'}，接缝 ${versions.seam ?? '未知'}）`,
  );

  // 网页面板的宿主半边：一条只读 JSON 路由，数据直接来自观测日志文件；浏览器工具坏了它也不受影响。
  // 用 ctx.inject(['webServer']) 而不是把它写进 inject —— 无头 profile（没有 Web GUI）里本插件
  // 只做 provider，不会因为缺 webServer 而卡住不启动。面板是可选件，ctx 上没有 inject 时跳过即可，
  // 绝不能让它把 provider 一起带坏（旧宿主/自定义 harness 的 ctx 可能没有 inject）。
  if (typeof ctx.inject !== 'function') {
    ctx.logger?.info?.('browser-moli: 宿主 ctx 没有 inject，跳过网页面板路由（provider 不受影响）');
    return;
  }
  ctx.inject(['webServer'], (webCtx) => {
    const dispose = registerPanel(webCtx, { provider, config });
    webCtx.effect(() => () => dispose(), 'browser-moli: panel routes (read-only + live view + logs/viewport writes)');
    webCtx.logger?.info?.(
      `browser-moli: 面板数据路由已挂到 ${PANEL_PATH}（实时窗口：${LIVE_STATE_PATH}；写操作：${LOGS_PATH}、${VIEWPORT_PATH}）`,
    );
  });
}
