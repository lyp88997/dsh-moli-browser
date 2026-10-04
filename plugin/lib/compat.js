/**
 * 启动期能力探测：确认宿主与接缝的模块面还是本包认识的那个形状。
 *
 * 为什么需要：本包不 import 宿主，唯一的运行期耦合点是接缝 `dsh-builtin-browser`（provider
 * 与 33 个 `browser_*` 工具都由它提供，经本包 `./browser`、`./tool-browser` 转出）。上游改了
 * 导出形状或换了 DSH 版本时，默认的失败形态是一句模块导出报错（`does not provide an export
 * named …` / `entry "browser" not found`），对用户没有指向性。这里把探测结果变成一句人话：
 * 缺什么、本包期望什么、实际装的是什么版本。
 *
 * 设计取舍（为什么不是版本区间校验）：
 * - 宿主 `@deepseek-ai/dsh` 在 npm 上只发预发布版（0.1.5-rc.3 / 0.1.6-alpha.x / 0.1.7-rc.x）。
 *   semver 的 `>=0.1.5-rc.1 <0.2.0` 只解锁 0.1.5 的预发布，0.1.7-rc.2 会被判为不符 ⇒ 写一个
 *   peer 范围反而给出**错误**的兼容信号。故不声明 dsh 的 peer 范围，改为：模块面硬校验 +
 *   宿主版本提示（不在实测清单里只 warn，不阻断）。
 * - 探测是纯函数（`inspectSeam`），可在测试里喂好/坏两种形状，不依赖真实安装。
 */
import { createRequire } from 'node:module';

/** 接缝包名（也是本包的依赖）。 */
export const SEAM_PACKAGE = 'dsh-builtin-browser';

/** 本包开发时对接的接缝版本面。 */
export const TESTED_SEAM = '0.1.22';

/** 实测过、行为一致的宿主 DSH 版本（由 scripts/verify-matrix.mjs 的多版本矩阵产出）。 */
export const TESTED_HOSTS = ['0.1.5-rc.3', '0.1.7-rc.1', '0.1.7-rc.2'];

/**
 * 校验接缝的导出面。只读入参、无副作用，便于测试。
 * @param {{browserModule?: object, toolModule?: object, hostVersion?: string}} deps
 * @returns {{ok: boolean, fatal: string[], warnings: string[]}}
 */
export function inspectSeam({ browserModule, toolModule, hostVersion } = {}) {
  const fatal = [];
  const warnings = [];

  if (typeof browserModule?.default !== 'function') {
    fatal.push(`browser 模块没有插件函数默认导出（default 是 ${typeof browserModule?.default}）`);
  }
  if (typeof browserModule?.BrowserError !== 'function') {
    warnings.push('browser 模块没有 BrowserError 类，工具报错会退化为内置实现');
  }
  if (typeof toolModule?.name !== 'string') {
    fatal.push('tool-browser 模块没有 name');
  }
  if (typeof toolModule?.apply !== 'function') {
    fatal.push(`tool-browser 模块没有 apply（${typeof toolModule?.apply}）`);
  }
  if (!Array.isArray(toolModule?.inject)) {
    fatal.push('tool-browser 模块没有 inject 列表');
  } else {
    const missing = ['tools', 'browser'].filter((service) => !toolModule.inject.includes(service));
    if (missing.length > 0) fatal.push(`tool-browser 的 inject 缺 ${missing.join(' / ')}`);
  }

  if (!hostVersion) {
    warnings.push('读不到宿主 DSH 版本，跳过兼容性提示');
  } else if (!TESTED_HOSTS.includes(hostVersion)) {
    warnings.push(`宿主 DSH ${hostVersion} 不在实测清单（${TESTED_HOSTS.join(' / ')}）内，行为可能不同`);
  }
  return { ok: fatal.length === 0, fatal, warnings };
}

/** 尽力读取宿主 DSH 与接缝的版本号（读不到就返回 undefined，不影响功能）。 */
export function readVersions() {
  const require = createRequire(import.meta.url);
  const readVersion = (spec) => {
    try {
      return require(`${spec}/package.json`).version ?? undefined;
    } catch {
      return undefined;
    }
  };
  return { host: readVersion('@deepseek-ai/dsh'), seam: readVersion(SEAM_PACKAGE) };
}

/** 探测失败时给用户看的一句话（含期望形状）。 */
export function seamMismatchMessage(verdict, versions = {}) {
  const fatal = verdict.fatal.join('；');
  return `browser-moli: 插件未启用 —— 浏览器接缝与预期不符（接缝 ${versions.seam ?? '未知'}，宿主 DSH ${versions.host ?? '未知'}）：${fatal}。`
    + ` 本包对接的接缝是 ${SEAM_PACKAGE}@${TESTED_SEAM} 的面：browser 需 default（插件函数）与 BrowserError，`
    + ' tool-browser 需 name/apply/inject（含 tools、browser）。请确认装的是配套版本（dsh-moli-browser 与 dsh-builtin-browser 都由本包依赖拉齐）。';
}
