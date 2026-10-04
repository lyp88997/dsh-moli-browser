/**
 * 客户端半边探针（verify-bundle 用）：在隔离 profile 里真的执行 `plugin/client.js`，
 * 验证三件事——① 它发出的是宿主认的那段 loader 协议（`window.__ModuleLoader__.load`，id = 包名）；
 * ② factory 返回标准 cordis 插件（`apply` + `inject: ['slots']`）；③ `apply(fakeCtx)` 会把看板
 * 注册到 `shell.overlay`，且组件能被调用而不炸（没有会话数据时回落到胶囊）。
 *
 * 用法：node client-probe.mjs <installedDir> <pkgName>
 * 只读：不写任何文件，最后把结果以一行 JSON 打到 stdout。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [installed, pkgName] = process.argv.slice(2);
const out = {};
const loaded = [];

// 宿主在浏览器里先装好这个全局，再用它收每个插件包的入口声明——这里用桩替代宿主。
globalThis.window = { __ModuleLoader__: { load: (spec) => loaded.push(spec) } };

try {
  await import(pathToFileURL(join(installed, 'plugin', 'client.js')).href);
  out.imported = 'ok';
} catch (error) {
  out.imported = `ERR ${String(error?.message ?? error).split('\n')[0]}`;
}

out.loads = loaded.map((spec) => ({ id: spec?.id, factory: typeof spec?.factory }));

const spec = loaded[0];
if (spec) {
  // 种子表只给命名空间，不真需要 React 实现：这些桩够走完注册与一次渲染。
  const react = {
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn,
    createElement: () => null,
  };
  try {
    const plugin = spec.factory((name) => {
      if (name === 'react') return react;
      throw new Error(`unexpected require: ${name}`);
    });
    out.apply = typeof plugin?.apply;
    out.inject = Array.isArray(plugin?.inject) ? plugin.inject : null;
    const registrations = [];
    const ctx = {
      slots: {
        inject: (slot, callback) => {
          out.injected = slot;
          return callback();
        },
        register: (options, component) => {
          registrations.push({ options, type: typeof component, render: component });
          return () => {
            out.disposed = true;
          };
        },
      },
    };
    plugin.apply(ctx);
    out.register = registrations[0]?.options ?? null;
    out.component = registrations[0]?.type ?? null;
    try {
      const element = registrations[0]?.render?.();
      out.render = element === null ? 'null' : typeof element;
    } catch (error) {
      out.render = `ERR ${String(error?.message ?? error).split('\n')[0]}`;
    }
    // 纯函数（窗口几何夹取 / 设置规整）：客户端半边唯一有分支逻辑的地方，直接在探针里真跑一遍。
    const inner = plugin?.internals;
    out.internals = inner && typeof inner === 'object' ? Object.keys(inner).sort() : null;
    if (typeof inner?.clampRect === 'function') {
      out.clamp = {
        oversize: inner.clampRect({ x: 9999, y: 9999, w: 9999, h: 9999 }, { w: 800, h: 600 }),
        undersize: inner.clampRect({ x: -50, y: -50, w: 10, h: 10 }, { w: 800, h: 600 }),
        anchored: inner.clampRect({ x: null, y: null, w: 400, h: 300 }, { w: 800, h: 600 }),
        margin: inner.clampRect({ x: 9999, y: 9999, w: 9999, h: 9999 }, { w: 800, h: 600 }, 10),
      };
    }
    if (typeof inner?.normalizeSettings === 'function') {
      const normalized = inner.normalizeSettings({ quality: 999, maxWidth: 1, pollMs: 1, lines: 9999, tab: 'nope' });
      out.settings = {
        quality: normalized.quality,
        maxWidth: normalized.maxWidth,
        pollMs: normalized.pollMs,
        lines: normalized.lines,
        tab: normalized.tab,
        autoStream: normalized.autoStream,
        pillPos: normalized.pillPos,
        autoClean: normalized.autoClean,
        viewport: normalized.viewport,
        pillX: normalized.pillX,
        pillY: normalized.pillY,
        panelGap: normalized.panelGap,
        zBase: normalized.zBase,
        borderColor: normalized.borderColor,
        cardAlpha: normalized.cardAlpha,
        glass: normalized.glass,
      };
      // 越界的像素量必须被拉回范围（不然 localStorage 里一个脏值就能让胶囊飞出屏幕）。
      const dirty = inner.normalizeSettings({ pillX: -20, pillY: 9999, panelGap: -5, zBase: 0, viewport: '640x480' });
      out.settingsClamp = { pillX: dirty.pillX, pillY: dirty.pillY, panelGap: dirty.panelGap, zBase: dirty.zBase, viewport: dirty.viewport };
      // 外观三件套的规整：颜色只认「主题/无/6 位十六进制」，不透明度夹到可读范围，未知玻璃档回落。
      const look = inner.normalizeSettings({ borderColor: 'javascript:alert(1)', cardAlpha: 0, glass: 123 });
      out.appearanceClamp = { borderColor: look.borderColor, cardAlpha: look.cardAlpha, glass: look.glass };
      out.appearanceCustom = inner.normalizeSettings({ borderColor: '#AABBCC' }).borderColor;
      // 窗口几何两项新设置（v0.8.2）：顶部留白 / 贴合画面比例。
      out.geoDefaults = { topInset: inner.normalizeSettings({}).topInset, fitPicture: inner.normalizeSettings({}).fitPicture };
      // 「最大边」默认值（v0.8.3 起 1920：与默认视口同长边，不再先缩后放）。
      out.defaultMaxWidth = inner.normalizeSettings({}).maxWidth;
      out.geoClamp = {
        topInset: inner.normalizeSettings({ topInset: 9999 }).topInset,
        manual: inner.normalizeSettings({ topInset: 96 }).topInset,
        auto: inner.normalizeSettings({ topInset: 'auto' }).topInset,
        fitOff: inner.normalizeSettings({ fitPicture: false }).fitPicture,
      };
    }
    if (typeof inner?.appearanceStyle === 'function') {
      out.appear = {
        liquid: inner.appearanceStyle({ borderColor: '#AABBCC', cardAlpha: 60, glass: 'liquid' }, 'card'),
        plain: inner.appearanceStyle({ borderColor: 'none', cardAlpha: 100, glass: 'none' }, 'pill'),
      };
    }
    if (typeof inner?.pillAnchor === 'function') {
      out.pill = {
        lt: inner.pillAnchor('lt'),
        rb: inner.pillAnchor('rb'),
        custom: inner.pillAnchor('rt', 30, 60),
        bad: inner.pillAnchor('nope'),
        // 「自由」位置（v0.8.3）：直接给 left/top，给了视口 + 自身尺寸就夹进屏内。
        free: inner.pillAnchor('free', 900, 500),
        freeFit: inner.pillAnchor('free', 9000, 9000, { w: 1200, h: 800 }, { w: 150, h: 31 }),
      };
    }
    if (typeof inner?.pillPoint === 'function') {
      // 切到「自由」/ 起拖时的起点换算：贴角按角 + 偏移 + 尺寸算，自由直接读坐标，越界夹回屏内。
      out.pillPoint = {
        free: inner.pillPoint({ pillPos: 'free', pillX: 900, pillY: 500 }, { w: 150, h: 31 }, { w: 1200, h: 800 }),
        freeFar: inner.pillPoint({ pillPos: 'free', pillX: 9000, pillY: 9000 }, { w: 150, h: 31 }, { w: 1200, h: 800 }),
        lt: inner.pillPoint({ pillPos: 'lt', pillX: 15, pillY: 48 }, { w: 150, h: 31 }, { w: 1200, h: 800 }),
        rb: inner.pillPoint({ pillPos: 'rb', pillX: 15, pillY: 48 }, { w: 150, h: 31 }, { w: 1200, h: 800 }),
      };
      out.pillFreeClamp = inner.normalizeSettings({ pillPos: 'free', pillX: 9999, pillY: 9999 }).pillX;
    }
    if (typeof inner?.clampRect === 'function' && typeof inner?.resolveTopInset === 'function') {
      // 顶部留白（v0.8.2）：贴顶 + 够宽 + 高度合理里取最高的；量不到按 48；手填夹到 0~200。
      out.topInset = {
        measured: inner.topInsetFromBoxes([
          { top: 0, width: 800, height: 44, position: 'fixed' },
          { top: 0, width: 700, height: 96, position: 'sticky' },
          { top: 0, width: 200, height: 120, position: 'fixed' },
          { top: 40, width: 800, height: 120, position: 'fixed' },
          { top: 0, width: 800, height: 400, position: 'fixed' },
        ], { w: 800, h: 600 }),
        none: inner.topInsetFromBoxes([], { w: 800, h: 600 }),
        auto: inner.resolveTopInset('auto', [], { w: 800, h: 600 }),
        manual: inner.resolveTopInset(120, [], { w: 800, h: 600 }),
        clamped: inner.resolveTopInset(9999, [], { w: 800, h: 600 }),
        zero: inner.resolveTopInset(0, [], { w: 800, h: 600 }),
      };
      out.clampTop = {
        auto: inner.clampRect({ x: null, y: null, w: 400, h: 300 }, { w: 800, h: 600 }, 10, 48),
        none: inner.clampRect({ x: null, y: null, w: 400, h: 300 }, { w: 800, h: 600 }, 10, 0),
        pinned: inner.clampRect({ x: 5, y: 5, w: 400, h: 300 }, { w: 800, h: 600 }, 10, 60),
        capped: inner.clampRect({ x: 0, y: 0, w: 400, h: 9999 }, { w: 800, h: 600 }, 10, 60),
      };
    }
    if (typeof inner?.ratioOf === 'function') {
      out.ratio = {
        frame: inner.ratioOf({ w: 1920, h: 1080 }, '1280x720'),
        fallback: inner.ratioOf(null, '1920x1080'),
        bad: inner.ratioOf(null, 'bogus'),
      };
    }
    if (typeof inner?.withScheme === 'function') {
      out.scheme = {
        bare: inner.withScheme('example.com'),
        full: inner.withScheme('http://a'),
        empty: inner.withScheme('   '),
      };
    }
  } catch (error) {
    out.factory = `ERR ${String(error?.message ?? error).split('\n')[0]}`;
  }
}

// 裸 require 只能点平台种子表里的 9 个词，否则浏览器侧会抛 "missed the module table"。
// 只看代码、不看注释（注释里会举例提到别的包名）。
const source = readFileSync(join(installed, 'plugin', 'client.js'), 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
out.requires = [...new Set((code.match(/require\(['"]([^'"]+)['"]\)/g) ?? []).map((hit) => hit.replace(/^require\(['"]/, '').replace(/['"]\)$/, '')))];
// 实时窗口的三条路由必须与服务端一字不差（服务端路由是 exact 匹配，写错了只会静默 404）。
out.liveRoutes = ['/browser-service/live.jpg', '/browser-service/live.json', '/browser-service/live'].filter((path) => code.includes(`'${path}'`));
// 两条写路由（清日志 / 改分辨率）同理。
out.writeRoutes = ['/browser-service/logs', '/browser-service/viewport'].filter((path) => code.includes(`'${path}'`));
// 胶囊可拖动（v0.8.3）的接线：指针事件 + 捕获 + 拖动期禁用过渡 + 拖动判定阈值 + 「自由」档。
out.dragWiring = {
  pointerDown: /onPointerDown:\s*startPillDrag/.test(code),
  capture: /setPointerCapture/.test(code),
  release: /releasePointerCapture/.test(code),
  freeMode: /'free'/.test(code) && /PILL_COORD_RANGE/.test(code),
  slop: /DRAG_SLOP/.test(code),
  grabbing: /bsp-grabbing/.test(code),
  touchAction: /touch-action:none/.test(code),
};
// 取帧开关的跨页签记忆（v0.8.3）：状态存在组件外、初值看「打开即取帧」、每次变化回写——切回网页不用再点「开始」。
out.resumeWiring = {
  memory: /let liveStartedMemory/.test(code),
  init: /liveStartedMemory\s*\?\?\s*\(settings\.autoStream !== false\)/.test(code),
  keep: /liveStartedMemory = started/.test(code),
};
out.pkgName = pkgName;

console.log(JSON.stringify(out));
