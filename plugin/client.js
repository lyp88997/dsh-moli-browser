/**
 * 浏览器服务面板 —— 客户端半边（P3 / 0.6.0 只读看板，P4 / 0.7.0 实时网页窗口，P5 / 0.8.0 可拖动缩放窗口 + 左侧入口 + 设置区，P6/P7/P8 / **0.8.1** 界面美化、分辨率与胶囊坐标、窗口外观与显式保存）。
 *
 * 这是 DSH 网页里的一个浮动窗口，左侧一竖排入口，右侧是内容：
 *   - 「网页」（默认）：**实时画面 + 直接操作**——把宿主半边 `/browser-service/live.jpg` 的 JPEG
 *     帧贴成图片流，窗口里的点击/滚动/打字经 `/browser-service/live` 转发给真浏览器，顶部地址栏可跳转。
 *   - 「操作」/「控制台」/「网络」：只读观测数据，来自 `/browser-service/panel.json`；右上角「清理」
 *     可手动清空该类日志（走 `/browser-service/logs`，需点两次确认），设置区还能配「自动清理」上限。
 *   - 「设置」：取帧画质与最大边（真作用于浏览器取帧）、面板刷新间隔、日志条数、默认入口、
 *     是否打开即取帧、是否记住窗口位置与大小、胶囊贴哪个角、自动清理上限；下面还有一块只读的生效配置。
 *
 * 窗口本身可拖动（标题栏按住拖）、可缩放（右下角手柄拖）、可最大化/还原、可收起成胶囊（四角可配）；
 * 位置与大小记在 localStorage 里（设置里可关）。
 *
 * 观感全部走宿主的 CSS 设计令牌（`--dsw-alias-*`）并带深色回退值：亮色主题下面板跟着变白，
 * 不再是无脑深色卡片。令牌与动效写在一张 `<style>` 里（内联 style 表达不了 :hover / :focus-visible /
 * 媒体查询），依然零构建、零第三方包。
 *
 * 手写、零构建：宿主把本文件按 URL 原样吐给浏览器，只要求它是那段固定协议——
 *   `window.__ModuleLoader__.load({ id, factory: (require) => exports })`
 * 并且裸 `require` 只能点平台种子表里的 9 个词（这里有且只有 `react`）。
 * require('@deepseek-ai/dsh-client-ui-layout') 之类不在种子里，会抛 "missed the module table"，
 * 所以样式一律自己写，不引第三方 UI 包。
 *
 * 插件身份 = 标准 cordis 插件：必填 `apply(ctx)`，可选 `inject`（**cordis 服务名**）与 `name`。
 * 座位用 `shell.overlay`（kind: list / scope: root）——它是 additive 的：新 id 加在既有条目旁边，
 * 不会替换别人。注意该层是 click-through，条目自己接事件，所以根元素必须自成一个小盒子
 * （position: fixed），否则会盖住整个界面。
 */
window.__ModuleLoader__.load({
  id: 'dsh-browser-service',
  factory: (require) => {
    const exports = {};
    const React = require('react');
    /** 手写 createElement 有点长，起个短别名（不改变协议，也不引 jsx-runtime）。 */
    const h = React.createElement;

    /** 与 plugin/lib/panel.js 的 PANEL_PATH 必须一字不差（服务端路由是 exact 匹配）。 */
    const PANEL_PATH = '/browser-service/panel.json';
    /** 实时窗口的三条路由，同样必须与服务端一字不差。 */
    const LIVE_IMAGE_PATH = '/browser-service/live.jpg';
    const LIVE_STATE_PATH = '/browser-service/live.json';
    const LIVE_INPUT_PATH = '/browser-service/live';
    /** 清理观测日志（宿主半边 0.8.1 起）：POST { action:'clear'|'trim', kind, keep }。 */
    const LOGS_PATH = '/browser-service/logs';
    /** 改浏览器窗口分辨率（宿主半边同一批新路由）：POST { width, height }。 */
    const VIEWPORT_PATH = '/browser-service/viewport';

    /** 面板默认拉多少条（服务端上限 200）。 */
    const DEFAULT_LINES = 40;
    /** 默认轮询间隔：数据是本地 JSONL 的尾巴，2.5s 足够新，也不吵。 */
    const DEFAULT_POLL_MS = 2500;
    /** 实时画面：服务端没有新帧（204）时的重试间隔。 */
    const LIVE_RETRY_MS = 250;
    /** 收到一帧之后的最小间隔：动画期间别把主线程和网络占满。 */
    const LIVE_GAP_MS = 40;
    /** 地址栏/状态同步间隔。 */
    const LIVE_STATE_MS = 1000;
    /** 鼠标移动转发节流。 */
    const LIVE_MOVE_MS = 100;
    /** 相对时间（「12 秒前」）的重算节拍：比面板轮询慢，只为暂停时也不至于冻住。 */
    const NOW_TICK_MS = 5000;
    /** 取帧画质与最大边的允许范围（与服务端 liveview 的夹取边界一致）。 */
    const QUALITY_RANGE = [10, 95];
    const WIDTH_RANGE = [320, 1920];
    const POLL_RANGE = [500, 10_000];
    const LINES_RANGE = [5, 200];

    /** 窗口几何的边界与默认值（x/y 为 null 表示贴在右下角）。 */
    const MIN_W = 320;
    const MIN_H = 240;
    const DEFAULT_WINDOW = { x: null, y: null, w: 560, h: 580 };
    const STORAGE_KEY = 'dsh-browser-service:ui';
    const STYLE_ID = 'dsh-browser-service-style';

    /** 左侧入口：id / 名称。 */
    const RAIL = [
      ['live', '网页'],
      ['ops', '操作'],
      ['console', '控制台'],
      ['network', '网络'],
      ['settings', '设置'],
    ];

    /**
     * 入口图标：统一 16×16 线性描边图标，跟随 currentColor。
     * 原来混用 ▣ ✓ ⌨ ⇄ ⚙ 这些字形，字重不一致、部分平台会渲染成彩色 emoji，观感很杂。
     */
    const ICONS = {
      live: [
        ['rect', { x: 2.5, y: 3.5, width: 11, height: 9, rx: 1.5 }],
        ['path', { d: 'M2.5 6.5h11' }],
        ['circle', { cx: 4.6, cy: 5, r: 0.5, fill: 'currentColor', stroke: 'none' }],
      ],
      ops: [['path', { d: 'M3 8.5l3.2 3.2L13 5' }]],
      console: [
        ['path', { d: 'M3.5 4.5L7 8l-3.5 3.5' }],
        ['path', { d: 'M9 11.5h4' }],
      ],
      network: [['path', { d: 'M2 8.5h3.5l2-4 2.5 7 2-3h2' }]],
      settings: [
        ['circle', { cx: 8, cy: 8, r: 2.3 }],
        ['path', { d: 'M8 1.6v2.1M8 12.3v2.1M1.6 8h2.1M12.3 8h2.1M3.5 3.5l1.5 1.5M11 11l1.5 1.5M12.5 3.5L11 5M5 11l-1.5 1.5' }],
      ],
    };

    function Icon({ id }) {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: 16,
        height: 16,
        'aria-hidden': 'true',
        focusable: 'false',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 1.4,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      }, (ICONS[id] ?? []).map(([tag, attrs], index) => h(tag, { key: index, ...attrs })));
    }
    const TAB_IDS = RAIL.map(([id]) => id);
    /** id → 中文名（清理提示里要用）。 */
    const TAB_NAME = Object.fromEntries(RAIL.map(([id, name]) => [id, name]));
    /** 日志型入口（有计数徽标、有「只看异常」）。 */
    const LOG_TABS = ['ops', 'console', 'network'];

    /** 收起成胶囊后贴哪一角（默认左上，跟前一版一致）；「自由」＝直接记坐标，可拖到任意位置。 */
    const PILL_POS = [
      ['lt', '左上'],
      ['rt', '右上'],
      ['lb', '左下'],
      ['rb', '右下'],
      ['free', '自由'],
    ];
    const PILL_IDS = PILL_POS.map(([id]) => id);

    /** 自动清理档位：单类日志条数超过上限就裁到上限的一半（0 = 关闭）。 */
    const AUTO_CLEAN = [
      [0, '关闭'],
      [1000, '1000'],
      [5000, '5000'],
      [20000, '20000'],
    ];
    const AUTO_CLEAN_IDS = AUTO_CLEAN.map(([value]) => value);

    /** 分辨率档位：值与显示名（服务端还会按 640×360 ~ 3840×2160 夹取）。 */
    const VIEWPORTS = [
      ['1280x720', '1280×720'],
      ['1440x900', '1440×900'],
      ['1600x900', '1600×900'],
      ['1920x1080', '1920×1080'],
    ];
    const VIEWPORT_IDS = VIEWPORTS.map(([value]) => value);

    /** 胶囊偏移 / 面板间距 / 层级基准的可调范围（纯像素）。 */
    const OFFSET_RANGE = [0, 400];
    /** 「自由位置」模式下 pillX/pillY 存的是屏幕坐标，范围要够装下任意视口（渲染时再按视口夹）。 */
    const PILL_COORD_RANGE = [0, 10000];
    /** 拖动判定：位移超过这么多像素才算拖动，否则当成点击（要能点开面板）。 */
    const DRAG_SLOP = 4;
    const GAP_RANGE = [0, 64];
    const Z_RANGE = [1, 2000];
    /** 顶部留白：窗口顶部要让开宿主顶栏的高度（'auto' = 自动量，或 0~200 手填）。 */
    const TOP_RANGE = [0, 200];
    const TOP_INSET_FALLBACK = 48;
    const TOP_PRESETS = [['auto', '自动'], [0, '0'], [24, '24'], [48, '48'], [64, '64'], [96, '96']];

    // ---- 窗口外观（P8）：边框颜色 / 背景不透明度 / 玻璃效果 ----

    /** 边框取色的两个特殊档：跟宿主主题、干脆不画。其余档是自定义 #rrggbb。 */
    const BORDER_THEME = 'theme';
    const BORDER_NONE = 'none';
    const BORDER_PRESETS = [
      [BORDER_THEME, '主题'],
      [BORDER_NONE, '无'],
      ['#679efe', '蓝'],
      ['#a78bfa', '紫'],
      ['#4ed17e', '绿'],
      ['#e8c57a', '琥珀'],
      ['#ff8b8b', '红'],
      ['#67e8f9', '青'],
    ];
    const BORDER_IDS = BORDER_PRESETS.map(([value]) => value);
    /** 自定义颜色只认 6 位十六进制 —— 值会原样写进 CSS 变量，先卡住注入。 */
    const HEX = /^#[0-9a-f]{6}$/;

    /** 玻璃效果档 + 各档参数（模糊 / 饱和度 / 高光强度）。都只是 CSS 近似，不做真折射。 */
    const GLASS = [
      ['none', '关'],
      ['frost', '毛玻璃'],
      ['liquid', '液态玻璃'],
    ];
    const GLASS_IDS = GLASS.map(([value]) => value);
    const GLASS_LOOK = {
      none: { blur: 0, sat: 100, glow: 0 },
      frost: { blur: 10, sat: 115, glow: 0 },
      liquid: { blur: 18, sat: 165, glow: 1 },
    };
    /** 背景不透明度（%）：100 = 与旧版一样实心。 */
    const ALPHA_RANGE = [20, 100];

    const DEFAULT_SETTINGS = {
      // 0.8.2 起的新默认值（用户指定）：画质 70（省流量）、不自动取帧（打开面板不占 CPU/带宽）、
      // 视口 1920×1080、外观 40% 不透明 + 毛玻璃。
      quality: 70,
      // 最大边 0.8.3 起默认 1920（用户指定）：与默认视口同长边，画面不再先缩到 1280 再放大。
      maxWidth: 1920,
      pollMs: DEFAULT_POLL_MS,
      lines: DEFAULT_LINES,
      tab: 'live',
      autoStream: false,
      // 窗口贴合画面比例（0.8.2 起默认开）：高度跟着画面比例走，不留黑边。
      fitPicture: true,
      remember: true,
      pillPos: 'lt',
      autoClean: 0,
      // P7（0.8.1 追加）：浏览器窗口分辨率 + 胶囊/面板的像素级位置。
      viewport: '1920x1080',
      pillX: 15,
      pillY: 48,
      panelGap: 10,
      // 顶部留白：'auto' = 量宿主顶栏（量不到按 48），或手填 0~200。
      topInset: 'auto',
      zBase: 40,
      // P8：窗口外观（边框颜色 / 背景不透明度 / 玻璃效果）。
      borderColor: BORDER_THEME,
      cardAlpha: 40,
      glass: 'frost',
    };

    /** 这些键走 CDP 的按键事件（单个可打印字符走文本插入）。 */
    const NAMED_KEYS = new Set([
      'Enter',
      'Tab',
      'Escape',
      'Backspace',
      'Delete',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Home',
      'End',
      'PageUp',
      'PageDown',
      ' ',
    ]);

    /**
     * 宿主设计令牌 + 回退值。全都写成 `var(--dsw-alias-x, 深色回退)`：
     * 宿主给了令牌就跟主题走（亮/暗自动），没给（老版本宿主、隔离环境）就是原来的深色观感。
     */
    const tok = {
      bg: 'var(--dsw-alias-bg-layer-2, rgba(20,20,25,0.95))',
      bg3: 'var(--dsw-alias-bg-layer-3, rgba(255,255,255,0.04))',
      overlay: 'var(--dsw-alias-bg-overlay, rgba(255,255,255,0.06))',
      skel: 'var(--dsw-alias-bg-skeleton, rgba(255,255,255,0.06))',
      border1: 'var(--dsw-alias-border-l1, rgba(255,255,255,0.1))',
      border2: 'var(--dsw-alias-border-l2, rgba(255,255,255,0.16))',
      border3: 'var(--dsw-alias-border-l3, rgba(255,255,255,0.24))',
      fg: 'var(--dsw-alias-label-primary, #e8e8ea)',
      fg2: 'var(--dsw-alias-label-secondary, rgba(232,232,234,0.86))',
      fg3: 'var(--dsw-alias-label-tertiary, rgba(232,232,234,0.7))',
      dim: 'var(--dsw-alias-label-dimmed, rgba(232,232,234,0.45))',
      brand: 'var(--dsw-alias-brand-primary, #e8e8ea)',
      accent: 'var(--dsw-alias-state-business-primary, #679efe)',
      accentBg: 'var(--dsw-alias-interactive-bg-hover-accent, rgba(120,170,255,0.16))',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.07))',
      active: 'var(--dsw-alias-interactive-bg-active, rgba(255,255,255,0.13))',
      fill: 'var(--dsw-alias-button-tool-bar-fill, rgba(255,255,255,0.1))',
      fillHover: 'var(--dsw-alias-button-tool-bar-hover, rgba(255,255,255,0.2))',
      dangerBg: 'var(--dsw-alias-interactive-bg-hover-danger, rgba(242,90,90,0.14))',
      ok: 'var(--dsw-alias-state-success-primary, #4ed17e)',
      warn: 'var(--dsw-alias-state-warn-primary, #e8c57a)',
      err: 'var(--dsw-alias-state-error-primary, #ff8b8b)',
      scroll: 'var(--dsw-alias-scrollbar-bg-l2, rgba(255,255,255,0.2))',
      scrollHover: 'var(--dsw-alias-scrollbar-hover-l2, rgba(255,255,255,0.34))',
    };
    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    const UI = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", Helvetica, Arial, sans-serif';
    const SHADOW = '0 14px 40px rgba(0,0,0,0.26), 0 2px 8px rgba(0,0,0,0.14)';

    /**
     * 面板样式表。类名统一 bsp- 前缀，避免与宿主撞名。
     * 只做 transform / opacity / 背景色过渡：拖动与缩放直接改 DOM style，
     * 所以 left/top/width/height 上绝不能有 transition（否则手感会拖泥带水）。
     */
    const CSS = `
/* 自成一体的盒模型：外框算进宽高里，style 上写的 620px 就是量出来的 620px，
   否则拖拽缩放每松一次手就会悄悄长大 2px（边框）。只作用于自己的子树。 */
.bsp-card,.bsp-card *{box-sizing:border-box}
.bsp-card{position:fixed;display:flex;flex-direction:column;overflow:hidden;outline:none;
  border-radius:12px;border:1px solid var(--bsp-rim,${tok.border2});
  background:var(--bsp-card,color-mix(in srgb,${tok.bg} var(--bsp-alpha,100%),transparent));
  color:${tok.fg};
  box-shadow:var(--bsp-shadow,${SHADOW});
  backdrop-filter:blur(var(--bsp-blur,8px)) saturate(var(--bsp-sat,100%));
  -webkit-backdrop-filter:blur(var(--bsp-blur,8px)) saturate(var(--bsp-sat,100%));
  font:12px/1.5 ${UI};
  animation:bspIn 150ms cubic-bezier(.2,.8,.3,1)}
/* 液态玻璃的高光：一层不吃事件的斜向渐变，强度由 --bsp-glow 决定（非液态时是 0）。 */
.bsp-card::after,.bsp-pill::after{content:'';position:absolute;inset:0;border-radius:inherit;pointer-events:none;
  opacity:var(--bsp-glow,0);transition:opacity 160ms ease;
  background:linear-gradient(135deg,rgba(255,255,255,.30),rgba(255,255,255,0) 40%,rgba(255,255,255,0) 58%,rgba(255,255,255,.16))}
.bsp-pill{position:fixed;display:inline-flex;align-items:center;gap:7px;
  padding:6px 11px 6px 10px;border-radius:999px;border:1px solid var(--bsp-rim,${tok.border2});
  background:color-mix(in srgb,${tok.bg} var(--bsp-alpha,100%),transparent);
  color:${tok.fg};box-shadow:var(--bsp-shadow,0 6px 20px rgba(0,0,0,0.22));
  backdrop-filter:blur(var(--bsp-blur,8px)) saturate(var(--bsp-sat,100%));
  -webkit-backdrop-filter:blur(var(--bsp-blur,8px)) saturate(var(--bsp-sat,100%));
  font:12px/1.4 ${UI};cursor:grab;touch-action:none;user-select:none;
  transition:background-color 130ms ease,transform 130ms ease,border-color 130ms ease;
  animation:bspPop 160ms cubic-bezier(.2,.8,.3,1)}
.bsp-pill:hover{background:var(--bsp-surface,${tok.bg3});border-color:${tok.border3};transform:translateY(-1px)}
.bsp-pill:active{transform:translateY(0) scale(.985)}
/* 正在拖动：别跟手较劲（去掉 hover/active 的位移与过渡），光标也换成抓手。 */
.bsp-pill.bsp-grabbing{cursor:grabbing;transition:none;transform:none}
.bsp-pill.bsp-grabbing:hover{transform:none}
.bsp-pill:focus-visible{outline:2px solid ${tok.accent};outline-offset:2px}
.bsp-pillName{font-weight:600;color:${tok.brand}}
.bsp-pillMeta{color:${tok.fg3}}
.bsp-head{display:flex;align-items:center;gap:7px;padding:7px 8px;border-bottom:1px solid var(--bsp-divider,${tok.border1});
  background:var(--bsp-surface,${tok.bg3});cursor:grab;user-select:none}
.bsp-head:active{cursor:grabbing}
.bsp-grip{font:12px/1 ${MONO};letter-spacing:1px;color:${tok.dim}}
.bsp-title{flex:1;min-width:0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bsp-liveState{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:${tok.fg3};white-space:nowrap}
.bsp-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;padding:3px 8px;border-radius:7px;
  border:1px solid transparent;background:${tok.fill};color:${tok.fg2};font:inherit;cursor:pointer;white-space:nowrap;
  transition:background-color 120ms ease,color 120ms ease,transform 120ms ease}
.bsp-btn:hover{background:${tok.fillHover};color:${tok.fg}}
.bsp-btn:active{transform:translateY(1px)}
.bsp-btn:focus-visible{outline:2px solid ${tok.accent};outline-offset:1px}
.bsp-btn[aria-pressed="true"]{background:${tok.accentBg};color:${tok.fg}}
.bsp-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:999px;
  border:1px solid ${tok.border2};background:transparent;color:${tok.fg3};font:10px/1.7 ${UI};cursor:pointer;
  white-space:nowrap;transition:background-color 120ms ease,color 120ms ease}
.bsp-chip:hover{background:${tok.hover};color:${tok.fg}}
.bsp-chip:focus-visible{outline:2px solid ${tok.accent};outline-offset:1px}
.bsp-chip[aria-pressed="true"]{background:${tok.accentBg};color:${tok.fg};border-color:transparent}
.bsp-chip.danger:hover{background:${tok.dangerBg};color:${tok.err};border-color:${tok.border2}}
.bsp-chip.danger.armed{background:${tok.dangerBg};color:${tok.err};border-color:${tok.err}}
.bsp-rail{display:flex;flex-direction:column;gap:2px;padding:6px;flex:0 0 auto;
  border-right:1px solid var(--bsp-divider,${tok.border1});background:var(--bsp-surface,${tok.bg3})}
.bsp-tab{position:relative;display:flex;flex-direction:column;align-items:center;gap:3px;width:56px;
  padding:7px 2px 6px;border-radius:9px;border:0;background:transparent;color:${tok.fg3};font:10px/1.2 ${UI};
  cursor:pointer;transition:background-color 130ms ease,color 130ms ease}
.bsp-tab:hover{background:${tok.hover};color:${tok.fg}}
.bsp-tab:focus-visible{outline:2px solid ${tok.accent};outline-offset:1px}
.bsp-tab[aria-selected="true"]{background:${tok.accentBg};color:${tok.fg};
  box-shadow:inset 0 0 0 1px ${tok.border2}}
.bsp-tab[aria-selected="true"]::before{content:"";position:absolute;left:-6px;top:50%;margin-top:-9px;
  width:3px;height:18px;border-radius:3px;background:${tok.accent};box-shadow:0 0 8px ${tok.accentBg}}
.bsp-tabIcon{display:flex;align-items:center;justify-content:center;width:18px;height:18px;color:currentColor;
  transition:transform 130ms ease}
.bsp-tabIcon svg{display:block}
.bsp-tab:hover .bsp-tabIcon{transform:translateY(-1px)}
.bsp-tabName{max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bsp-count{min-width:16px;padding:0 5px;height:15px;border-radius:999px;border:1px solid ${tok.border2};
  background:var(--bsp-card,${tok.bg});color:${tok.fg3};font:9px/14px ${MONO};text-align:center}
.bsp-count.bad{background:${tok.err};border-color:transparent;color:#fff}
.bsp-badge{position:absolute;top:1px;right:2px;min-width:15px;padding:0 4px;height:15px;border-radius:999px;
  border:1px solid ${tok.border2};background:var(--bsp-card,${tok.bg});color:${tok.fg3};font:9px/13px ${MONO};text-align:center}
.bsp-badge.bad{background:${tok.err};border-color:transparent;color:#fff}
.bsp-main{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}
.bsp-body{flex:1;min-height:0;overflow:auto;scrollbar-width:thin;scrollbar-color:${tok.scroll} transparent;
  animation:bspPane 140ms ease-out}
.bsp-body.fill{display:flex;flex-direction:column;overflow:hidden}
.bsp-body::-webkit-scrollbar{width:10px;height:10px}
.bsp-body::-webkit-scrollbar-track{background:transparent}
.bsp-body::-webkit-scrollbar-thumb{background:${tok.scroll};border:2px solid transparent;border-radius:8px;
  background-clip:content-box}
.bsp-body::-webkit-scrollbar-thumb:hover{background:${tok.scrollHover};background-clip:content-box}
.bsp-spacer{flex:1}
.bsp-listHead{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:8px;padding:6px 10px;
  background:var(--bsp-card,${tok.bg});border-bottom:1px solid var(--bsp-divider,${tok.border1});
  font-size:11px;color:${tok.fg3}}
.bsp-item{border-bottom:1px solid var(--bsp-divider,${tok.border1})}
.bsp-row{display:flex;align-items:center;gap:8px;width:100%;padding:4px 10px;border:0;background:transparent;
  color:inherit;font:12px/1.7 ${MONO};text-align:left;cursor:pointer;transition:background-color 110ms ease}
.bsp-item>.bsp-row{border-bottom:0}
.bsp-row:hover{background:${tok.hover}}
.bsp-row:focus-visible{outline:2px solid ${tok.accent};outline-offset:-2px}
.bsp-row[aria-expanded="true"]{background:var(--bsp-surface,${tok.bg3})}
.c-time{flex:0 0 54px;color:${tok.dim};font-variant-numeric:tabular-nums}
.c-tag{flex:0 0 auto;max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.c-main{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.c-meta{flex:0 1 auto;max-width:42%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${tok.dim}}
.c-dim{color:${tok.dim}}
.c-ok{color:${tok.ok}}
.c-bad{color:${tok.err}}
.c-warn{color:${tok.warn}}
.bsp-jsonWrap{background:var(--bsp-surface,${tok.bg3});border-top:1px dashed var(--bsp-divider,${tok.border1})}
.bsp-jsonBar{display:flex;align-items:center;gap:8px;padding:6px 10px 0}
.bsp-json{margin:0;padding:6px 10px 10px;max-height:280px;overflow:auto;white-space:pre-wrap;
  overflow-wrap:anywhere;font:11px/1.6 ${MONO};color:${tok.fg2}}
.bsp-banner{display:flex;align-items:center;gap:8px;margin:8px 10px;padding:6px 9px;border-radius:8px;
  border:1px solid ${tok.border2};background:${tok.dangerBg};color:${tok.fg2};font-size:11px}
.bsp-state{display:flex;flex-direction:column;align-items:center;gap:10px;padding:30px 18px;text-align:center;
  color:${tok.dim};font-size:12px}
.bsp-stateIcon{font:20px/1 ${MONO};opacity:.7}
.bsp-skel{height:11px;margin:10px 12px;border-radius:6px;background:linear-gradient(90deg,${tok.skel} 25%,${tok.hover} 37%,${tok.skel} 63%);
  background-size:220% 100%;animation:bspShimmer 1.35s ease-in-out infinite}
.bsp-live{display:flex;flex-direction:column;flex:1;min-height:0}
.bsp-addrRow{display:flex;align-items:center;gap:6px;padding:7px 8px;border-bottom:1px solid var(--bsp-divider,${tok.border1})}
.bsp-input{flex:1;min-width:0;padding:4px 8px;border-radius:7px;border:1px solid ${tok.border2};
  background:${tok.overlay};color:inherit;font:12px/1.6 ${MONO};
  transition:border-color 120ms ease,box-shadow 120ms ease}
.bsp-input::placeholder{color:${tok.dim}}
.bsp-input:focus{outline:none;border-color:${tok.accent};box-shadow:0 0 0 2px ${tok.accentBg}}
/* 边框用 inset 阴影画而不是 border：border 会让「元素外框」比图片实际落位的
   内容框大 2px，坐标映射就会偏一个像素。用 box-shadow 则两者严格重合。 */
.bsp-stage{position:relative;flex:1;min-height:0;margin:8px;display:flex;align-items:center;
  justify-content:center;overflow:hidden;border-radius:9px;
  box-shadow:inset 0 0 0 1px ${tok.border2};
  background:transparent;cursor:crosshair;outline:none;transition:box-shadow 120ms ease}
.bsp-stage:focus-visible{box-shadow:inset 0 0 0 1px ${tok.accent},0 0 0 2px ${tok.accentBg}}
.bsp-stage:fullscreen{margin:0;border-radius:0}
.bsp-shot{display:block;width:100%;height:100%;object-fit:contain;user-select:none;-webkit-user-drag:none}
.bsp-stageMsg{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:8px;padding:18px;text-align:center;font-size:12px;color:#c9ccd2;
  background:rgba(11,11,14,0.55);pointer-events:none}
.bsp-stageMsg .bsp-quiet{color:#8d9099;font-size:11px}
.bsp-liveFoot{display:flex;align-items:center;flex-wrap:wrap;gap:6px 10px;padding:0 10px 8px;
  font-size:11px;color:${tok.fg3}}
.bsp-liveErr{display:flex;align-items:flex-start;gap:6px;margin:0 8px 6px;padding:6px 9px;border-radius:8px;
  border:1px solid ${tok.border2};background:${tok.dangerBg};color:${tok.err};font-size:11px;line-height:1.6;
  overflow-wrap:anywhere} .bsp-liveErr b{font-weight:600;flex:0 0 auto}
.bsp-foot{display:flex;align-items:center;gap:8px;padding:6px 10px;border-top:1px solid var(--bsp-divider,${tok.border1});
  background:var(--bsp-surface,${tok.bg3});font-size:11px;color:${tok.dim}}
.bsp-dot{width:7px;height:7px;flex:0 0 auto;border-radius:999px;background:${tok.dim};
  box-shadow:0 0 0 3px rgba(127,127,127,0.16)}
.bsp-dot.on{background:${tok.ok}}
.bsp-dot.warn{background:${tok.warn}}
.bsp-dot.bad{background:${tok.err}}
.bsp-section{padding:0 10px 10px;border-bottom:1px solid var(--bsp-divider,${tok.border1})}
.bsp-secTitle{position:sticky;top:0;z-index:1;padding:9px 0 7px;font-size:11px;
  background:var(--bsp-card,color-mix(in srgb,${tok.bg} var(--bsp-alpha,100%),transparent));
  font-weight:600;color:${tok.fg3};letter-spacing:.4px}
.bsp-field{display:flex;align-items:center;gap:10px;padding:3px 0;min-height:26px}
.bsp-fieldLabel{flex:0 0 96px;font-size:11px;color:${tok.fg3}}
.bsp-fieldValue{flex:1;min-width:0;font-size:11px;color:${tok.fg2};overflow-wrap:anywhere}
.bsp-seg{display:inline-flex;gap:2px;padding:2px;border-radius:9px;border:1px solid ${tok.border1};
  background:${tok.overlay}}
.bsp-segBtn{padding:2px 8px;border-radius:7px;border:1px solid transparent;background:transparent;
  color:${tok.fg3};font:11px/1.7 ${MONO};cursor:pointer;transition:background-color 120ms ease,color 120ms ease}
.bsp-segBtn:hover{background:${tok.hover};color:${tok.fg}}
.bsp-segBtn:focus-visible{outline:2px solid ${tok.accent};outline-offset:1px}
.bsp-segBtn[aria-pressed="true"]{background:${tok.active};border-color:${tok.border2};color:${tok.fg};
  box-shadow:0 1px 2px rgba(0,0,0,0.14)}
.bsp-note{padding:7px 0 0;font-size:11px;line-height:1.6;color:${tok.dim}}
.bsp-note.ok{color:${tok.ok}}
.bsp-note.err{color:${tok.err}}
/* 数值输入：跟 .bsp-input 一致，只是窄一点、数字右对齐好扫。 */
.bsp-num{flex:0 1 78px;width:78px;text-align:right;font-variant-numeric:tabular-nums}
/* 清理结果条（手动/自动共用）：成功绿、失败红 —— 失败必须看得见，否则就成了「设置了没反应」。 */
.bsp-noteClean{display:flex;align-items:center;gap:8px;margin:6px 8px 0;padding:6px 9px;border-radius:8px;
  font-size:11px;line-height:1.5;border:1px solid ${tok.border2};background:var(--bsp-surface,${tok.bg3});color:${tok.fg3}}
.bsp-noteClean.ok{border-color:${tok.ok};color:${tok.ok}}
.bsp-noteClean.err{border-color:${tok.err};color:${tok.err};background:${tok.dangerBg}}
.bsp-noteClean span{flex:1;min-width:0;overflow-wrap:anywhere}
/* 窗口外观：颜色档位（主题 / 无 / 预设色 / 自定义取色器）。 */
.bsp-swatches{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.bsp-swatch{position:relative;display:inline-flex;align-items:center;justify-content:center;
  width:22px;height:22px;padding:0;border-radius:7px;cursor:pointer;
  border:1px solid ${tok.border2};background:var(--bsp-surface,${tok.bg3});color:${tok.fg2};font:10px/1 ${UI};
  transition:transform 130ms ease,box-shadow 130ms ease,border-color 130ms ease}
.bsp-swatch:hover{transform:translateY(-1px)}
.bsp-swatch:focus-visible{outline:2px solid ${tok.accent};outline-offset:1px}
.bsp-swatch.on{border-color:${tok.accent};box-shadow:0 0 0 2px ${tok.accentBg}}
.bsp-swatch.theme,.bsp-swatch.none{width:auto;padding:0 7px}
.bsp-swatch.theme{background:linear-gradient(135deg,#f4f4f6 0 50%,#2c2c2e 50% 100%);color:${tok.fg}}
.bsp-swatch.none::after{content:'';position:absolute;left:4px;right:4px;top:50%;height:1.5px;
  background:${tok.err};transform:rotate(-18deg);border-radius:1px}
.bsp-swatch.pick{border-color:${tok.border3};
  background:conic-gradient(from 210deg,#ff8b8b,#e8c57a,#4ed17e,#67e8f9,#679efe,#a78bfa,#ff8b8b)}
.bsp-colorInput{position:absolute;inset:0;width:100%;height:100%;padding:0;border:0;opacity:0;cursor:pointer}
/* 保存条：吸在设置区顶部，滚动时也看得见「有未保存的改动」。 */
.bsp-saveBar{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:6px;
  padding:7px 10px;border-bottom:1px solid var(--bsp-divider,${tok.border1});
  background:var(--bsp-card,color-mix(in srgb,${tok.bg} var(--bsp-alpha,100%),transparent))}
.bsp-saveState{flex:1;min-width:0;font-size:11px;line-height:1.5;color:${tok.fg3};overflow-wrap:anywhere}
.bsp-saveState.dirty{color:${tok.warn}}
.bsp-saveState.ok{color:${tok.ok}}
.bsp-saveState.err{color:${tok.err}}
.bsp-btn.primary{border-color:${tok.border3};background:${tok.accentBg};color:${tok.fg};font-weight:600}
.bsp-dirtyDot{width:5px;height:5px;border-radius:999px;background:${tok.warn};flex:0 0 auto}
@keyframes bspIn{from{opacity:0;transform:translateY(6px) scale(.985)}to{opacity:1;transform:none}}
@keyframes bspPop{from{opacity:0;transform:translateY(-6px) scale(.94)}to{opacity:1;transform:none}}
@keyframes bspPane{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@keyframes bspShimmer{from{background-position:-160% 0}to{background-position:260% 0}}
@media (prefers-reduced-motion: reduce){
  .bsp-card,.bsp-pill,.bsp-body,.bsp-skel{animation:none}
  .bsp-pill,.bsp-btn,.bsp-chip,.bsp-tab,.bsp-segBtn,.bsp-row,.bsp-input,.bsp-stage{transition:none}
  .bsp-pill:hover,.bsp-pill:active,.bsp-btn:active{transform:none}
}`;

    /** 数值夹取：坏值回落默认值。 */
    function clampInt(value, min, max, fallback) {
      // `Number(null) === 0`：没给（null/''）就该回落 fallback，别当成 0 夹到下限。
      if (value == null || value === '') return fallback;
      const raw = Number(value);
      if (!Number.isFinite(raw)) return fallback;
      return Math.min(max, Math.max(min, Math.floor(raw)));
    }

    /** 设置对象规整（纯函数）：坏值/越界一律拉回安全范围，方便服务端与本地各用一半。 */
    function normalizeSettings(raw) {
      const source = raw && typeof raw === 'object' ? raw : {};
      // 胶囊位置先定下来：「自由」时 pillX/pillY 是屏幕坐标（范围宽），贴角时是离边偏移（0~400）。
      const pillPos = PILL_IDS.includes(source.pillPos) ? source.pillPos : DEFAULT_SETTINGS.pillPos;
      const pillRange = pillPos === 'free' ? PILL_COORD_RANGE : OFFSET_RANGE;
      return {
        quality: clampInt(source.quality, QUALITY_RANGE[0], QUALITY_RANGE[1], DEFAULT_SETTINGS.quality),
        maxWidth: clampInt(source.maxWidth, WIDTH_RANGE[0], WIDTH_RANGE[1], DEFAULT_SETTINGS.maxWidth),
        pollMs: clampInt(source.pollMs, POLL_RANGE[0], POLL_RANGE[1], DEFAULT_SETTINGS.pollMs),
        lines: clampInt(source.lines, LINES_RANGE[0], LINES_RANGE[1], DEFAULT_SETTINGS.lines),
        tab: TAB_IDS.includes(source.tab) ? source.tab : DEFAULT_SETTINGS.tab,
        autoStream: source.autoStream === undefined ? DEFAULT_SETTINGS.autoStream : source.autoStream !== false,
        fitPicture: source.fitPicture === undefined ? DEFAULT_SETTINGS.fitPicture : source.fitPicture !== false,
        remember: source.remember === undefined ? DEFAULT_SETTINGS.remember : source.remember !== false,
        pillPos,
        autoClean: AUTO_CLEAN_IDS.includes(Number(source.autoClean))
          ? Number(source.autoClean)
          : DEFAULT_SETTINGS.autoClean,
        viewport: VIEWPORT_IDS.includes(source.viewport) ? source.viewport : DEFAULT_SETTINGS.viewport,
        pillX: clampInt(source.pillX, pillRange[0], pillRange[1], DEFAULT_SETTINGS.pillX),
        pillY: clampInt(source.pillY, pillRange[0], pillRange[1], DEFAULT_SETTINGS.pillY),
        panelGap: clampInt(source.panelGap, GAP_RANGE[0], GAP_RANGE[1], DEFAULT_SETTINGS.panelGap),
        topInset: source.topInset === undefined || source.topInset === 'auto'
          ? DEFAULT_SETTINGS.topInset
          : clampInt(source.topInset, TOP_RANGE[0], TOP_RANGE[1], TOP_INSET_FALLBACK),
        zBase: clampInt(source.zBase, Z_RANGE[0], Z_RANGE[1], DEFAULT_SETTINGS.zBase),
        borderColor: borderOf(source.borderColor),
        cardAlpha: clampInt(source.cardAlpha, ALPHA_RANGE[0], ALPHA_RANGE[1], DEFAULT_SETTINGS.cardAlpha),
        glass: GLASS_IDS.includes(source.glass) ? source.glass : DEFAULT_SETTINGS.glass,
      };
    }

    /** 边框颜色规整（纯函数）：主题 / 无 / 6 位十六进制（统一小写），别的都回落到「跟随主题」。 */
    function borderOf(raw) {
      const value = String(raw ?? '').trim().toLowerCase();
      if (BORDER_IDS.includes(value)) return value;
      return HEX.test(value) ? value : DEFAULT_SETTINGS.borderColor;
    }

    /**
     * 外观设置 → 一组 CSS 自定义属性（纯函数）。
     * 只往元素上挂变量，样式表里一律 `var(--bsp-xxx, 旧观感)` 兜底：没挂上（老宿主、隔离环境）
     * 时和以前长得一样。自定义颜色已经在 `borderOf` 里卡成 6 位十六进制，写进 CSS 变量是安全的。
     */
    function appearanceStyle(settings, kind = 'card') {
      const s = normalizeSettings(settings);
      const look = GLASS_LOOK[s.glass] ?? GLASS_LOOK[DEFAULT_SETTINGS.glass];
      const style = {
        '--bsp-alpha': `${s.cardAlpha}%`,
        '--bsp-rim': s.borderColor === BORDER_NONE ? 'transparent'
          : s.borderColor === BORDER_THEME ? tok.border2 : s.borderColor,
        '--bsp-blur': `${look.blur}px`,
        '--bsp-sat': `${look.sat}%`,
        '--bsp-glow': String(look.glow),
        // 窗口「里面」的分区（标题栏 / 左侧入口 / 底栏 / 列表吸顶等）原本用的是不透明的
        // 主题色块：只把外壳调透明，里面那几块还是实心的，看上去就像「只有边框线变了」。
        // 这两组变量让内部分区跟着同一份透明度走（底色仍取主题色，只改实心程度）。
        '--bsp-card': `color-mix(in srgb,${tok.bg} ${s.cardAlpha}%,transparent)`,
        '--bsp-surface': `color-mix(in srgb,${tok.bg3} ${s.cardAlpha}%,transparent)`,
        // 分隔线：跟随主题/无边框时保持宿主原本的细线；选了自定义颜色就同色调一层浅的，
        // 这样顶栏、侧栏、底栏的分界也带上你选的颜色，而不是只在最外圈看到一条。
        '--bsp-divider': s.borderColor === BORDER_THEME || s.borderColor === BORDER_NONE
          ? tok.border1
          : `color-mix(in srgb,${s.borderColor} 45%,transparent)`,
      };
      // 液态玻璃额外压一道内圈高光（描边光），让边缘有「玻璃厚度」。
      if (s.glass === 'liquid') {
        style['--bsp-shadow'] = kind === 'pill'
          ? `0 6px 20px rgba(0,0,0,0.22), inset 0 1px 0 rgba(255,255,255,0.34), inset 0 -1px 0 rgba(0,0,0,0.12)`
          : `${SHADOW}, inset 0 1px 0 rgba(255,255,255,0.34), inset 0 -1px 0 rgba(0,0,0,0.12)`;
      }
      return style;
    }

    /** 一维夹取（纯函数）：给了视口 + 自身尺寸就夹进 [0, 视口 - 自己]；没有视口原样返回。 */
    function fitAxis(value, extent, own) {
      const e = Number(extent);
      if (!Number.isFinite(e) || e <= 0) return value;
      const o = Number(own);
      const room = Math.max(0, Math.round(e - (Number.isFinite(o) ? o : 0)));
      return Math.max(0, Math.min(value, room));
    }

    /**
     * 胶囊贴到哪一角（纯函数）：命中角给偏移像素（默认 15 / 48，设置里可改），其余边给 auto。
     * 偏移量走的是「离屏幕边多远」，所以角不同也读同一对数 —— 改一次四角都跟着走。
     * 「自由」模式给 left/top 坐标；传了 bounds/size 就顺手夹进视口（存的坐标可能来自更大的屏幕）。
     */
    function pillAnchor(pos, offsetX = DEFAULT_SETTINGS.pillX, offsetY = DEFAULT_SETTINGS.pillY, bounds = null, size = null) {
      const id = PILL_IDS.includes(pos) ? pos : DEFAULT_SETTINGS.pillPos;
      const range = id === 'free' ? PILL_COORD_RANGE : OFFSET_RANGE;
      const rawX = clampInt(offsetX, range[0], range[1], DEFAULT_SETTINGS.pillX);
      const rawY = clampInt(offsetY, range[0], range[1], DEFAULT_SETTINGS.pillY);
      if (id === 'free') {
        return {
          left: `${fitAxis(rawX, bounds?.w, size?.w)}px`,
          top: `${fitAxis(rawY, bounds?.h, size?.h)}px`,
          right: 'auto',
          bottom: 'auto',
        };
      }
      const x = `${rawX}px`;
      const y = `${rawY}px`;
      return {
        left: id === 'lt' || id === 'lb' ? x : 'auto',
        right: id === 'rt' || id === 'rb' ? x : 'auto',
        top: id === 'lt' || id === 'rt' ? y : 'auto',
        bottom: id === 'lb' || id === 'rb' ? y : 'auto',
      };
    }

    /**
     * 胶囊当前的绝对屏幕坐标（纯函数）：已经「自由」就直接读坐标，贴角就按角 + 偏移 + 自身尺寸换算。
     * 切到「自由」时拿它当起点，胶囊不会跳；拖动开始时也拿它兜底。
     */
    function pillPoint(settings, size, bounds) {
      const s = normalizeSettings(settings);
      const w = Number(size?.w) > 0 ? Math.round(size.w) : 0;
      const h = Number(size?.h) > 0 ? Math.round(size.h) : 0;
      if (s.pillPos === 'free') return { x: fitAxis(s.pillX, bounds?.w, w), y: fitAxis(s.pillY, bounds?.h, h) };
      const bw = Number(bounds?.w) > 0 ? Math.round(bounds.w) : 0;
      const bh = Number(bounds?.h) > 0 ? Math.round(bounds.h) : 0;
      const x = s.pillPos === 'rt' || s.pillPos === 'rb' ? Math.max(0, bw - s.pillX - w) : s.pillX;
      const y = s.pillPos === 'lb' || s.pillPos === 'rb' ? Math.max(0, bh - s.pillY - h) : s.pillY;
      return { x: fitAxis(x, bounds?.w, w), y: fitAxis(y, bounds?.h, h) };
    }

    /**
     * 地址栏输入的规整（纯函数）：没写协议就按 https 补，跟宿主 normalizeUrl 同一套规则。
     * 空串回 ''（调用方据此不发请求）。
     */
    function withScheme(raw) {
      const text = String(raw ?? '').trim();
      if (!text) return '';
      return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text) ? text : `https://${text}`;
    }

    /**
     * 窗口几何夹取（纯函数）：宽度/高度不小于最小值、不超过视口减去 margin 与顶部留白，
     * x/y 落在可用范围内；x/y 缺失（null）时**摆正中**。
     * margin 是「面板间距」（设置里可调，默认 0）——保证窗口不会紧贴屏幕边。
     * insetTop 是「顶部留白」——宿主顶栏/标题栏盖住的高度，窗口不许压上去（0 = 不避让）。
     */
    function clampRect(rect, bounds, margin = 0, insetTop = 0) {
      const pad = clampInt(margin, GAP_RANGE[0], GAP_RANGE[1], 0);
      const top = clampInt(insetTop, TOP_RANGE[0], TOP_RANGE[1], 0);
      const bw = Number(bounds?.w);
      const bh = Number(bounds?.h);
      const knownW = Number.isFinite(bw) && bw > 0;
      const knownH = Number.isFinite(bh) && bh > 0;
      // 可用区域要扣掉两侧间距与顶部留白；视口太小时不强行扣（否则宽度会小于最小值）。
      const availW = knownW ? Math.max(MIN_W, bw - pad * 2) : DEFAULT_WINDOW.w;
      const availH = knownH ? Math.max(MIN_H, bh - top - pad * 2) : DEFAULT_WINDOW.h;
      const w = Math.min(availW, Math.max(MIN_W, Number(rect?.w) || DEFAULT_WINDOW.w));
      const h = Math.min(availH, Math.max(MIN_H, Number(rect?.h) || DEFAULT_WINDOW.h));
      const maxX = Math.max(pad, (knownW ? bw : w + pad * 2) - w - pad);
      const maxY = Math.max(top + pad, (knownH ? bh : h + top + pad * 2) - h - pad);
      // 注意：Number(null) === 0，所以「没记过位置」必须显式判 null/undefined，否则会跑到左上角。
      const rawX = Number(rect?.x);
      const rawY = Number(rect?.y);
      const hasX = rect?.x !== null && rect?.x !== undefined && Number.isFinite(rawX);
      const hasY = rect?.y !== null && rect?.y !== undefined && Number.isFinite(rawY);
      // 默认摆正中：水平居中；垂直在「顶部留白之下 … 底部间距之上」居中。
      const cx = Math.floor((knownW ? bw : w + pad * 2) / 2 - w / 2);
      const cy = top + Math.floor(((knownH ? bh : h + top + pad * 2) - top) / 2 - h / 2);
      const x = hasX ? Math.min(maxX, Math.max(pad, Math.floor(rawX))) : Math.min(maxX, Math.max(pad, cx));
      const y = hasY ? Math.min(maxY, Math.max(top + pad, Math.floor(rawY))) : Math.min(maxY, Math.max(top + pad, cy));
      return { x, y, w, h };
    }

    /**
     * 屏幕坐标 → 页面坐标（纯函数）。
     * 画面按 object-fit: contain 居中留边，所以必须先减掉留边再线性映射：
     * 直接拿整块舞台的宽高去映射，画面与舞台比例不一致时点击就会偏。
     * 帧的真实宽高来自响应头（meta），不是猜的。
     */
    function mapPoint(box, frame, client) {
      const w = Number(frame?.w);
      const h = Number(frame?.h);
      const bw = Number(box?.width);
      const bh = Number(box?.height);
      if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0 || !(bw > 0) || !(bh > 0)) return null;
      const fit = Math.min(bw / w, bh / h);
      const drawW = w * fit;
      const drawH = h * fit;
      const left = Number(box.left) + (bw - drawW) / 2;
      const top = Number(box.top) + (bh - drawH) / 2;
      return {
        x: Math.round(Math.min(w, Math.max(0, ((Number(client?.x) - left) * w) / drawW))),
        y: Math.round(Math.min(h, Math.max(0, ((Number(client?.y) - top) * h) / drawH))),
      };
    }

    /** 视口尺寸；非浏览器环境（隔离探针）回落到 0，交给 clampRect 走默认值。 */
    function viewport() {
      return {
        w: typeof window === 'undefined' ? 0 : window.innerWidth,
        h: typeof window === 'undefined' ? 0 : window.innerHeight,
      };
    }

    /**
     * 从「贴顶条状元素」的实测值里挑顶部留白（纯函数）：只认贴顶（±2px）、够宽
     * （≥ 视口 60%）、高度合理（24~200px，且不到视口 40%）里最高的那个；量不到回 0。
     */
    function topInsetFromBoxes(boxes, bounds) {
      const bw = Math.max(1, Number(bounds?.w) || 0);
      const bh = Number(bounds?.h) || 0;
      let best = 0;
      for (const box of boxes || []) {
        const top = Number(box?.top);
        const width = Number(box?.width);
        const height = Number(box?.height);
        if (!Number.isFinite(top) || top < -2 || top > 2) continue;
        if (!Number.isFinite(width) || width < bw * 0.6) continue;
        if (!Number.isFinite(height) || height < 24 || height > 200) continue;
        if (bh > 0 && height > bh * 0.4) continue;
        if (height > best) best = height;
      }
      return Math.round(best);
    }

    /** 顶部留白取值（纯函数）：'auto' = 实测（量不到按 48）；数字 = 手填并夹到 0~200。 */
    function resolveTopInset(mode, boxes, bounds) {
      if (mode !== 'auto' && mode !== null && mode !== undefined) {
        return clampInt(mode, TOP_RANGE[0], TOP_RANGE[1], TOP_INSET_FALLBACK);
      }
      const measured = topInsetFromBoxes(boxes, bounds);
      return measured > 0 ? Math.min(TOP_RANGE[1], measured) : TOP_INSET_FALLBACK;
    }

    /** 画面比例（纯函数）：优先用真实帧尺寸，没有帧就按设置里的分辨率；都给不出就不锁比例。 */
    function ratioOf(meta, viewportId) {
      const pair = (w, h) => (Number(w) > 0 && Number(h) > 0 ? `${Math.round(Number(w))} / ${Math.round(Number(h))}` : null);
      if (meta && Number(meta.w) > 0 && Number(meta.h) > 0) return pair(meta.w, meta.h);
      const matched = /^(\d+)x(\d+)$/.exec(String(viewportId ?? ''));
      return matched ? pair(matched[1], matched[2]) : null;
    }

    /**
     * 量宿主顶栏：贴顶的 fixed/sticky 元素（跳过我们自己的 .bsp-* 与面板节点），
     * 只在面板打开或设置变化时跑一次，扫描上限 1500 个节点。
     */
    function collectTopBars(doc, bounds) {
      const out = [];
      const body = doc?.body;
      if (!body?.querySelectorAll) return out;
      const view = doc.defaultView ?? (typeof window === 'undefined' ? null : window);
      const nodes = body.querySelectorAll('*');
      const limit = Math.min(nodes.length, 1500);
      for (let i = 0; i < limit; i += 1) {
        const el = nodes[i];
        const cls = typeof el.className === 'string' ? el.className : '';
        if (cls.includes('bsp-') || el.id === 'dsh-browser-service-panel') continue;
        let style = null;
        try {
          style = view?.getComputedStyle ? view.getComputedStyle(el) : null;
        } catch {
          continue;
        }
        if (!style) continue;
        if (style.position !== 'fixed' && style.position !== 'sticky') continue;
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const rect = el.getBoundingClientRect?.();
        if (!rect || !rect.width || !rect.height) continue;
        out.push({ top: rect.top, width: rect.width, height: rect.height, position: style.position });
      }
      return out;
    }

    /** 用户要求减少动效时不放动画（拖尾、脉冲、骨架闪烁都跳过）。 */
    function prefersReduced() {
      try {
        return Boolean(window?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
      } catch {
        return false;
      }
    }

    /** localStorage 可能被浏览器策略禁掉：读写一律吞异常，坏了就当没存。 */
    function readStore(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
      } catch {
        return fallback;
      }
    }

    /** 写 localStorage：返回是否成功。「保存」按钮要把写失败如实告诉用户，平时调用忽略返回值。 */
    function writeStore(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch {
        /* 存储不可用（无痕模式/站点策略）：调用方决定要不要提示 */
        return false;
      }
    }

    /** 时间戳 → 本地 HH:MM:SS；脏数据不炸。 */
    function clock(value) {
      const at = new Date(value);
      return Number.isFinite(at.getTime()) ? at.toTimeString().slice(0, 8) : '--:--:--';
    }

    /** 时间戳 → 相对描述（纯函数）。绝对时刻照旧写在 title 里，信息不丢。 */
    function relTime(value, now) {
      const at = new Date(value).getTime();
      if (!Number.isFinite(at) || at <= 0) return '—';
      const gap = Math.max(0, (Number(now) || Date.now()) - at);
      if (gap < 1000) return '刚刚';
      if (gap < 60_000) return `${Math.floor(gap / 1000)} 秒前`;
      if (gap < 3_600_000) return `${Math.floor(gap / 60_000)} 分钟前`;
      if (gap < 86_400_000) return `${Math.floor(gap / 3_600_000)} 小时前`;
      return `${Math.floor(gap / 86_400_000)} 天前`;
    }

    function safeJson(value) {
      try {
        return JSON.stringify(value) ?? String(value);
      } catch {
        return String(value);
      }
    }

    function pretty(value) {
      try {
        return JSON.stringify(value, null, 2) ?? String(value);
      } catch {
        return String(value);
      }
    }

    function text(value, max = 240) {
      if (value === undefined || value === null) return '';
      const raw = typeof value === 'string' ? value : safeJson(value);
      return raw.length > max ? `${raw.slice(0, max)}…` : raw;
    }

    function entries(data, kind) {
      const list = data?.[kind]?.entries;
      return Array.isArray(list) ? list : [];
    }

    /** 单条算不算「异常」——过滤按钮与入口徽标共用这一份判断。 */
    function isAlarm(kind, entry) {
      if (!entry) return false;
      if (kind === 'ops') return entry.ok === false;
      if (kind === 'console') return entry.type === 'error' || entry.type === 'warning';
      return entry.phase === 'requestfailed' || (entry.phase === 'response' && Number(entry.status) >= 400);
    }

    /** 胶囊上要醒目提示的异常条数（失败操作 + error/warning 控制台 + 失败请求）。 */
    function alarms(data) {
      return LOG_TABS.reduce((sum, kind) => sum + entries(data, kind).filter((entry) => isAlarm(kind, entry)).length, 0);
    }

    /**
     * POST 一个小 JSON（清理日志 / 改分辨率共用）：永远不抛，回 `{ ok, status, body, error }`。
     * 调用方必须把 !ok 显示出来 —— 0.8.1 之前只回布尔、失败又没人看，于是变成「设置了没反应」。
     */
    async function postJson(path, payload) {
      try {
        const res = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const body = await res.json().catch(() => null);
        return { ok: res.ok, status: res.status, body };
      } catch (error) {
        return { ok: false, status: 0, body: null, error: String(error?.message ?? error) };
      }
    }

    /** 清理日志（宿主 /browser-service/logs）：手动「清理」与自动清理共用。 */
    const postLogs = (payload) => postJson(LOGS_PATH, payload);

    /**
     * 把 POST 失败翻成一句人话。404/405 基本都是「宿主半边是旧版、新路由没挂」——
     * 这正是「自动清理没生效」的真因，所以必须指名道姓地说出来。
     */
    function postErrorText(result, what) {
      const detail = result?.body?.error ?? result?.error;
      if (result?.status === 404 || result?.status === 405) {
        return `${what}不可用：宿主没有这条路由（HTTP ${result.status}）——宿主半边是旧版，重启 DSH 后生效`;
      }
      if (!result?.status) return `${what}不可用：${detail ?? '请求没能发出'}`;
      return `${what}失败：${detail ?? `HTTP ${result.status}`}`;
    }

    function duration(ms) {
      const value = Number(ms);
      if (!Number.isFinite(value) || value <= 0) return '—';
      if (value < 60_000) return `${Math.round(value / 1000)} 秒`;
      if (value < 3_600_000) return `${Math.round(value / 60_000)} 分钟`;
      return `${(value / 3_600_000).toFixed(1)} 小时`;
    }

    /** 长 URL 只留路径部分给右侧窄列，完整地址在 title 与展开的 JSON 里。 */
    function pathOf(value) {
      const raw = String(value ?? '');
      return raw ? raw.replace(/^[a-z]+:\/\/[^/]+/i, '') || '/' : '';
    }

    /** 把样式表挂到 head（只挂一次）。内联 style 表达不了 hover / focus-visible / 媒体查询。 */
    function useStyles() {
      React.useEffect(() => {
        if (document.getElementById(STYLE_ID)) return undefined;
        const el = document.createElement('style');
        el.id = STYLE_ID;
        el.textContent = CSS;
        document.head.appendChild(el);
        return undefined;
      }, []);
    }

    /** 主字段：失败原因 > 返回值 > 入参，展开时给完整 JSON 兜底。 */
    function detailOf(entry) {
      return text(entry?.error ?? entry?.result ?? entry?.params, 400);
    }

    /** 一行日志的三个格子（时间由外壳统一给）：标签 + 主字段（省略号） + 右侧元信息。 */
    function rowCells(kind, entry) {
      if (kind === 'ops') {
        const bad = entry?.ok === false;
        return [
          h('span', { key: 'i', className: bad ? 'c-bad' : 'c-ok' }, bad ? '✗' : '✓'),
          h('span', { key: 'a', className: 'c-tag', title: String(entry?.action ?? '') }, String(entry?.action ?? '?')),
          h('span', { key: 'd', className: 'c-main', title: detailOf(entry) }, detailOf(entry) || '—'),
          h('span', { key: 'm', className: 'c-meta' },
            `${Number.isFinite(entry?.ms) ? `${entry.ms}ms` : '—'} · ${entry?.session ?? '?'}/${entry?.tab ?? '?'}`),
        ];
      }
      if (kind === 'console') {
        const type = String(entry?.type ?? 'log');
        const cls = type === 'error' ? 'c-bad' : type === 'warning' ? 'c-warn' : 'c-dim';
        return [
          h('span', { key: 't', className: `c-tag ${cls}` }, type),
          h('span', { key: 'x', className: 'c-main', title: String(entry?.text ?? '') }, String(entry?.text ?? '')),
          h('span', { key: 'u', className: 'c-meta', title: String(entry?.url ?? '') }, pathOf(entry?.url)),
        ];
      }
      const phase = entry?.phase;
      const arrow = phase === 'requestfailed' ? '✗' : phase === 'response' ? '←' : '→';
      const cls = isAlarm('network', entry) ? 'c-bad' : phase === 'response' ? 'c-ok' : 'c-dim';
      const tail = phase === 'response'
        ? `${entry?.status ?? '?'} · ${Number.isFinite(entry?.ms) ? `${entry.ms}ms` : '—'}`
        : phase === 'requestfailed'
          ? text(entry?.error ?? '', 60)
          : String(entry?.resource ?? '');
      return [
        h('span', { key: 'a', className: `c-tag ${cls}` }, `${arrow} ${entry?.method ?? ''}`),
        h('span', { key: 'u', className: 'c-main', title: String(entry?.url ?? '') }, String(entry?.url ?? '')),
        h('span', { key: 'm', className: 'c-meta' }, tail),
      ];
    }

    function Skeleton() {
      return h('div', null, [0, 1, 2, 3, 4, 5].map((index) => h('div', { key: index, className: 'bsp-skel' })));
    }

    function State({ icon, children, action }) {
      return h('div', { className: 'bsp-state' },
        icon ? h('span', { className: 'bsp-stateIcon' }, icon) : null,
        h('span', null, children),
        action ?? null);
    }

    /** 一条可展开的日志：行内只显示关键字段，点开是完整 JSON（字段一个不少）。 */
    function EntryRow({ kind, entry, index, now, open, copied, onToggle, onCopy }) {
      const key = `${kind}-${index}`;
      return h('div', { className: 'bsp-item' },
        h('button', {
          type: 'button',
          className: 'bsp-row',
          'aria-expanded': open ? 'true' : 'false',
          title: open ? '收起完整字段' : '展开完整字段',
          onClick: () => onToggle(open ? null : key),
        },
          h('span', { className: 'c-time', title: clock(entry?.at) }, relTime(entry?.at, now)),
          ...rowCells(kind, entry)),
        open
          ? h('div', { className: 'bsp-jsonWrap' },
              h('div', { className: 'bsp-jsonBar' },
                h('button', {
                  type: 'button',
                  className: 'bsp-chip',
                  onClick: () => onCopy(pretty(entry), key),
                }, copied === key ? '已复制 ✓' : copied === `err:${key}` ? '复制失败' : '复制 JSON'),
                h('span', { className: 'c-dim' }, `${Object.keys(entry ?? {}).length} 个字段`)),
              h('pre', { className: 'bsp-json' }, pretty(entry)))
          : null,
      );
    }

    /**
     * 「操作 / 控制台 / 网络」共用一套列表：吸顶统计条 + 只看异常 + 单行省略（title 给全文）
     * + 相对时间 + 点开完整 JSON；空/加载/出错各有各的样子，出错能重试。
     */
    function ListPane({ kind, data, error, loading, lines, onRetry, onClear, now }) {
      const [onlyAlarm, setOnlyAlarm] = React.useState(false);
      const [openKey, setOpenKey] = React.useState(null);
      const [copied, setCopied] = React.useState(null);
      const [armed, setArmed] = React.useState(false);
      const timer = React.useRef(0);
      const armTimer = React.useRef(0);
      const all = entries(data, kind).slice(-lines);
      const list = onlyAlarm ? all.filter((entry) => isAlarm(kind, entry)) : all;
      const total = Number(data?.[kind]?.total ?? 0);

      React.useEffect(() => () => {
        clearTimeout(timer.current);
        clearTimeout(armTimer.current);
      }, []);

      // 清日志不可逆：先变「确认清理？」，3 秒内不动手就当没点过。
      const clear = () => {
        clearTimeout(armTimer.current);
        if (!armed) {
          setArmed(true);
          armTimer.current = setTimeout(() => setArmed(false), 3000);
          return;
        }
        setArmed(false);
        onClear?.(kind);
      };

      const copy = (value, key) => {
        clearTimeout(timer.current);
        const settle = (ok) => {
          setCopied(ok ? key : `err:${key}`);
          timer.current = setTimeout(() => setCopied(null), 1400);
        };
        try {
          const task = navigator.clipboard?.writeText?.(value);
          if (task && typeof task.then === 'function') task.then(() => settle(true), () => settle(false));
          else settle(false);
        } catch {
          settle(false);
        }
      };

      const head = h('div', { className: 'bsp-listHead' },
        h('span', null, `共 ${data?.[kind]?.total ?? 0} 条`),
        h('span', { className: 'c-dim' }, onlyAlarm ? `异常 ${list.length} 条` : `已载入 ${all.length} 条`),
        h('span', { className: 'bsp-spacer' }),
        total > 0
          ? h('button', {
              type: 'button',
              className: `bsp-chip danger${armed ? ' armed' : ''}`,
              'aria-label': `清理${TAB_NAME[kind] ?? kind}日志`,
              title: armed
                ? `再点一次就清空${TAB_NAME[kind] ?? kind}日志`
                : `清空${TAB_NAME[kind] ?? kind}日志（共 ${total} 条）`,
              onClick: clear,
            }, armed ? '确认清理？' : '清理')
          : null,
        h('button', {
          type: 'button',
          className: 'bsp-chip',
          'aria-pressed': onlyAlarm ? 'true' : 'false',
          onClick: () => setOnlyAlarm((value) => !value),
        }, '只看异常'));

      let body;
      if (!data && loading) {
        body = h(Skeleton, { key: 'loading' });
      } else if (!data && error) {
        body = h(State, {
          key: 'error',
          icon: '⚠',
          action: h('button', { type: 'button', className: 'bsp-btn', onClick: onRetry }, '重试'),
        }, `拿不到面板数据：${error}`);
      } else if (!list.length) {
        body = h(State, { key: 'empty', icon: '∅' },
          all.length ? '没有异常 —— 切回全部看看' : '暂无数据 —— 用 browser_* 工具操作一次再看看');
      } else {
        body = list.map((entry, index) => h(EntryRow, {
          key: `${entry?.seq ?? entry?.at ?? index}-${index}`,
          kind,
          entry,
          index,
          now,
          open: openKey === `${kind}-${index}`,
          copied,
          onToggle: setOpenKey,
          onCopy: copy,
        }));
      }

      return h('div', null,
        head,
        error && data
          ? h('div', { className: 'bsp-banner' },
              h('span', { className: 'c-main' }, `数据可能不是最新：${error}`),
              h('button', { type: 'button', className: 'bsp-chip', onClick: onRetry }, '重试'))
          : null,
        body);
    }

    /** 分段选择器：比裸 select 精致，键盘/读屏也还认得出是「一组互斥选项」。 */
    function Segmented({ label, value, options, onChange }) {
      return h('div', { className: 'bsp-seg', role: 'group', 'aria-label': label },
        options.map(([option, text2]) => h('button', {
          key: String(option),
          type: 'button',
          className: 'bsp-segBtn',
          'aria-pressed': String(option) === String(value) ? 'true' : 'false',
          onClick: () => onChange(option),
        }, String(text2))));
    }

    /**
     * 边框颜色选择器：主题 / 无 / 几个预设色 / 自定义（原生取色器）。
     * 自定义档只在值本身就是十六进制时算选中，其余时候取色器停在一个中性色上。
     */
    function Swatches({ label, value, onChange }) {
      const custom = HEX.test(String(value));
      const pickValue = custom ? String(value) : '#679efe';
      return h('div', { className: 'bsp-swatches', role: 'group', 'aria-label': label },
        BORDER_PRESETS.map(([id, name]) => h('button', {
          key: id,
          type: 'button',
          className: `bsp-swatch${value === id ? ' on' : ''}${id === BORDER_THEME ? ' theme' : ''}${id === BORDER_NONE ? ' none' : ''}`,
          style: id.startsWith('#') ? { background: id, borderColor: 'transparent' } : undefined,
          title: name,
          'aria-label': `边框颜色：${name}`,
          'aria-pressed': value === id ? 'true' : 'false',
          onClick: () => onChange(id),
        }, id === BORDER_THEME || id === BORDER_NONE ? name : null)),
        h('label', {
          className: `bsp-swatch pick${custom ? ' on' : ''}`,
          title: '自定义颜色',
        }, h('input', {
          type: 'color',
          className: 'bsp-colorInput',
          value: pickValue,
          'aria-label': '自定义边框颜色',
          onChange: (event) => onChange(borderOf(event.target.value)),
        })));
    }

    function Field({ label, children }) {
      return h('div', { className: 'bsp-field' },
        h('span', { className: 'bsp-fieldLabel' }, label),
        h('span', { className: 'bsp-fieldValue' }, children));
    }

    function Toggle({ label, value, onText = '开', offText = '关', onChange }) {
      return h('button', {
        type: 'button',
        className: 'bsp-btn',
        'aria-pressed': value ? 'true' : 'false',
        'aria-label': label,
        onClick: () => onChange(!value),
      }, value ? onText : offText);
    }

    /**
     * 数值输入（设置里几个像素量用）：本地草稿 + 失焦/回车才提交。
     * 不这么做的话，每敲一个数字都会写 localStorage、重排窗口、重发请求。
     */
    function NumberField({ label, value, min, max, suffix = 'px', onChange }) {
      const [draft, setDraft] = React.useState(String(value));
      React.useEffect(() => setDraft(String(value)), [value]);
      const commit = () => {
        const next = clampInt(draft, min, max, value);
        setDraft(String(next));
        if (next !== value) onChange(next);
      };
      return h('input', {
        className: 'bsp-input bsp-num',
        type: 'number',
        inputMode: 'numeric',
        min,
        max,
        step: 1,
        'aria-label': suffix ? `${label}（${suffix}）` : label,
        title: `${label}：${min} ~ ${max}${suffix}`,
        value: draft,
        onChange: (event) => setDraft(event.target.value),
        onBlur: commit,
        onKeyDown: (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
            event.currentTarget.blur();
          } else if (event.key === 'Escape') {
            // 不要让 Escape 冒泡到窗口收起：先撤销这次编辑。
            event.stopPropagation();
            setDraft(String(value));
            event.currentTarget.blur();
          }
        },
      });
    }

    /**
     * 「设置」入口：能调的都能真的作用下去（画质/最大边随取帧请求发给服务端，
     * 分辨率走 POST /browser-service/viewport，刷新间隔/条数/默认入口/胶囊偏移是本地的），
     * 下面再放一块只读的生效配置。
     * 服务信息一律「有才显示，没有给 —」：0.7.0 时代的宿主没有 service/options 块也不能崩。
     */
    function SettingsPane({ settings, onPatch, service, options, onReset, dirty, saveNote, onSave, onDefaults, pillPoint }) {
      // 用「补丁」而不是「整份设置」：同一拍里连点两个按钮时，后一个不会把前一个覆盖掉。
      const set = (patch) => onPatch(patch);
      const frame = service?.live ?? options;
      // 「自由」模式下 pillX/pillY 是屏幕坐标：标签、上限都跟着变（上限按当前视口）。
      const free = settings.pillPos === 'free';
      const bounds = viewport();
      // 改分辨率是服务端动作（换窗口大小会让已开页面重排），成败都要看得见。
      const [vpNote, setVpNote] = React.useState(null);
      const applyViewport = async (id) => {
        set({ viewport: id });
        const [width, height] = String(id).split('x').map((part) => Number(part));
        setVpNote({ tone: '', text: `正在改成 ${width}×${height}…` });
        const result = await postJson(VIEWPORT_PATH, { width, height });
        if (result.ok) {
          const applied = result.body?.viewport ?? {};
          const count = Number(applied.applied);
          setVpNote({
            tone: 'ok',
            text: `✓ 已生效 ${applied.width ?? width}×${applied.height ?? height}${Number.isFinite(count) ? `（已应用到 ${count} 个页面）` : ''}`,
          });
        } else {
          setVpNote({ tone: 'err', text: postErrorText(result, '改分辨率') });
        }
      };
      return h('div', null,
        // 保存条吸在顶部：改了什么还没存，一眼能看见；存/恢复默认都在手边。
        h('div', { className: 'bsp-saveBar' },
          h('span', {
            className: `bsp-saveState${saveNote?.tone ? ` ${saveNote.tone}` : dirty ? ' dirty' : ''}`,
            role: 'status',
          }, saveNote?.text ?? (dirty ? '● 有未保存的改动（窗口外观已先按新值显示）' : '已保存（改动立即生效，刷新页面也保留）')),
          h('button', { type: 'button', className: 'bsp-btn primary', onClick: onSave }, '保存'),
          h('button', { type: 'button', className: 'bsp-btn', title: '把这一页的设置全部恢复默认值', onClick: onDefaults }, '恢复默认')),
        h('div', { className: 'bsp-section' },
          h('div', { className: 'bsp-secTitle' }, '窗口外观'),
          h(Field, { label: '边框颜色' }, h(Swatches, {
            label: '边框颜色',
            value: settings.borderColor,
            onChange: (borderColor) => set({ borderColor }),
          })),
          h(Field, { label: '背景不透明度' }, h(Segmented, {
            label: '背景不透明度（百分比）',
            value: settings.cardAlpha,
            options: [[40, '40%'], [60, '60%'], [80, '80%'], [95, '95%'], [100, '100%']],
            onChange: (cardAlpha) => set({ cardAlpha }),
          })),
          h(Field, { label: '玻璃效果' }, h(Segmented, {
            label: '玻璃效果',
            value: settings.glass,
            options: GLASS,
            onChange: (glass) => set({ glass }),
          })),
          h('div', { className: 'bsp-note' },
            '不透明度＝窗口本身的实心程度（越低越透，能看见后面的页面，配合玻璃效果更好看）。毛玻璃＝背景模糊；液态玻璃＝更强的模糊 + 饱和度 + 一道斜向高光。都是 CSS 近似效果，老浏览器上会退化成半透明。')),
        h('div', { className: 'bsp-section' },
          h('div', { className: 'bsp-secTitle' }, '实时画面'),
          h(Field, { label: '画面质量' }, h(Segmented, {
            label: '画面质量',
            value: settings.quality,
            options: [[40, '40'], [55, '55'], [70, '70'], [85, '85'], [95, '95']],
            onChange: (quality) => set({ quality }),
          })),
          h(Field, { label: '最大边' }, h(Segmented, {
            label: '最大边（像素）',
            value: settings.maxWidth,
            options: [[480, '480'], [800, '800'], [1280, '1280'], [1600, '1600'], [1920, '1920']],
            onChange: (maxWidth) => set({ maxWidth }),
          })),
          h('div', { className: 'bsp-note' },
            '最大边＝画面长边的上限（宽和高都按它封顶，等比不压扁）。想看清楚就把「最大边」和「分辨率」都调大，质量选 85/95。'),
          h(Field, { label: '分辨率' }, h(Segmented, {
            label: '浏览器窗口分辨率',
            value: settings.viewport,
            options: VIEWPORTS,
            onChange: applyViewport,
          })),
          h('div', { className: `bsp-note${vpNote?.tone ? ` ${vpNote.tone}` : ''}` },
            vpNote?.text ?? '改分辨率立刻生效：已打开的页面会按新尺寸重排，之后新建的会话也用它（服务端夹取 640×360 ~ 3840×2160）。'),
          h(Field, { label: '贴合画面比例' }, h(Toggle, {
            label: '窗口贴合画面比例（不留黑边）',
            value: settings.fitPicture,
            onChange: (fitPicture) => set({ fitPicture }),
          })),
          h('div', { className: 'bsp-note' },
            '开着时窗口高度跟着画面比例走 ⇒ 上下不留黑边，右下角手柄只调宽度（高度自己算）。关掉就回到「宽高随意拖」。'),
          h(Field, { label: '打开即取帧' }, h(Toggle, {
            label: '打开即取帧',
            value: settings.autoStream,
            onChange: (autoStream) => set({ autoStream }),
          }))),
        h('div', { className: 'bsp-section' },
          h('div', { className: 'bsp-secTitle' }, '面板'),
          h(Field, { label: '刷新间隔' }, h(Segmented, {
            label: '刷新间隔',
            value: settings.pollMs,
            options: [[1000, '1s'], [2500, '2.5s'], [5000, '5s'], [10000, '10s']],
            onChange: (pollMs) => set({ pollMs }),
          })),
          h(Field, { label: '日志条数' }, h(Segmented, {
            label: '日志条数',
            value: settings.lines,
            options: [[20, '20'], [40, '40'], [100, '100'], [200, '200']],
            onChange: (lines) => set({ lines }),
          })),
          h(Field, { label: '默认入口' }, h(Segmented, {
            label: '默认入口',
            value: settings.tab,
            options: RAIL.map(([id, name]) => [id, name]),
            onChange: (tab) => set({ tab }),
          })),
          h(Field, { label: '胶囊位置' }, h(Segmented, {
            label: '胶囊位置',
            value: settings.pillPos,
            options: PILL_POS,
            onChange: (pillPos) => {
              // 切到「自由」时以当前实际位置为起点（按角 + 偏移换算），胶囊不会跳。
              if (pillPos === 'free') {
                const at = pillPoint?.();
                if (at) {
                  set({ pillPos, pillX: at.x, pillY: at.y });
                  return;
                }
              }
              set({ pillPos });
            },
          })),
          h(Field, { label: free ? '水平坐标' : '水平偏移' }, h(NumberField, {
            label: free ? '胶囊水平坐标' : '胶囊水平偏移',
            value: settings.pillX,
            min: 0,
            max: free ? Math.max(1, Math.round(bounds.w)) : OFFSET_RANGE[1],
            onChange: (pillX) => set({ pillX }),
          })),
          h(Field, { label: free ? '垂直坐标' : '垂直偏移' }, h(NumberField, {
            label: free ? '胶囊垂直坐标' : '胶囊垂直偏移',
            value: settings.pillY,
            min: 0,
            max: free ? Math.max(1, Math.round(bounds.h)) : OFFSET_RANGE[1],
            onChange: (pillY) => set({ pillY }),
          })),
          h(Field, { label: '面板间距' }, h(NumberField, {
            label: '面板间距',
            value: settings.panelGap,
            min: GAP_RANGE[0],
            max: GAP_RANGE[1],
            onChange: (panelGap) => set({ panelGap }),
          })),
          h(Field, { label: '顶部留白' }, h(Segmented, {
            label: '顶部留白',
            value: settings.topInset,
            options: TOP_PRESETS,
            onChange: (topInset) => set({ topInset }),
          })),
          h(Field, { label: '留白手填' }, h(NumberField, {
            label: '顶部留白手填',
            value: settings.topInset === 'auto' ? TOP_INSET_FALLBACK : settings.topInset,
            min: TOP_RANGE[0],
            max: TOP_RANGE[1],
            onChange: (topInset) => set({ topInset }),
          })),
          h(Field, { label: '层级基准' }, h(NumberField, {
            label: '层级基准',
            value: settings.zBase,
            min: Z_RANGE[0],
            max: Z_RANGE[1],
            suffix: '',
            onChange: (zBase) => set({ zBase }),
          })),
          h(Field, { label: '自动清理' }, h(Segmented, {
            label: '自动清理（条数上限）',
            value: settings.autoClean,
            options: AUTO_CLEAN,
            onChange: (autoClean) => set({ autoClean }),
          })),
          h(Field, { label: '记住窗口' }, h(Toggle, {
            label: '记住窗口位置与大小',
            value: settings.remember,
            onChange: (remember) => set({ remember }),
          })),
          h(Field, { label: '窗口' },
            h('button', { type: 'button', className: 'bsp-btn', onClick: onReset }, '恢复默认大小')),
          h('div', { className: 'bsp-note' },
            '收起后的胶囊可以直接拖到任意位置（松手就记住，自动切到「自由」；拖回贴角就在上面选四角之一）。「自由」时水平/垂直坐标就是屏幕坐标，拖完会自己更新。面板间距是窗口/最大化/居中时留出的边距；顶部留白＝窗口顶部让开宿主顶栏的高度（「自动」＝实测宿主顶栏，量不到按 48，也可手填 0~200）；层级基准＝和宿主页面的叠压顺序（越大越靠前）。自动清理＝某类日志超过上限时保留最近一半，在面板打开着的时候检查（列表右上角的「清理」随时可手动清空）。')),
        h('div', { className: 'bsp-section' },
          h('div', { className: 'bsp-secTitle' }, '服务信息（只读）'),
          h(Field, { label: '版本' }, service?.version || '—'),
          h(Field, { label: '会话 / 标签' }, service?.session || '—'),
          h(Field, { label: 'CDP 地址' }, service?.cdpUrl || '—'),
          h(Field, { label: '保存目录' }, service?.downloadDir ? `${service.downloadDir}/` : '—'),
          h(Field, { label: '标签上限' }, service?.maxTabs == null ? '—' : `${service.maxTabs} 个`),
          h(Field, { label: '空闲回收' }, service?.idleMs == null ? '—' : duration(service.idleMs)),
          h(Field, { label: '录制内容' }, service
            ? `${service.captureConsole === false ? '控制台：关' : '控制台：开'} · ${service.captureNetwork === false ? '网络：关' : '网络：开'}`
            : '—'),
          h(Field, { label: '取帧参数' }, frame
            ? `质量 ${frame.quality ?? '—'} · 最大边 ${frame.maxWidth ?? '—'}${frame.maxHeight ? `×${frame.maxHeight}` : ''}`
            : '—'),
          h(Field, { label: '分辨率' }, service?.viewport
            ? `${service.viewport.width}×${service.viewport.height}`
            : settings.viewport.replace('x', '×')),
          h('div', { className: 'bsp-note' },
            '画质与最大边改完会在下一次取帧时生效；控制台/网络的开关在插件配置里（captureConsole / captureNetwork）。')));
    }

    /**
     * 「网页」入口：实时画面 + 直接操作。
     * 画面走长轮询（服务端把「等新帧」放在自己那边，静止时零流量），
     * 点击/滚动/打字转发给真浏览器；收起或暂停时告诉服务端停流（省 CPU）。
     */
    /**
     * 「开始/停帧」的当前值记在模块级（组件外）：切页签、收起面板再展开都会重挂 LivePane，
     * 记在这里回来就自动续上，不用用户再点一次「开始」（0.8.3）。null = 本页还没决定过，看「打开即取帧」。
     */
    let liveStartedMemory = null;

    function LivePane({ paused, settings, onStreamingChange, onState }) {
      const [frame, setFrame] = React.useState(null); // 当前帧的 object URL
      const [meta, setMeta] = React.useState({ w: 0, h: 0 });
      const [page, setPage] = React.useState(null);
      const [frameErr, setFrameErr] = React.useState(null);
      /** 动作（跳转/打字/点击）失败的原因：与取帧错误分开，免得取帧成功把它抹掉。 */
      const [actionErr, setActionErr] = React.useState(null);
      const error = actionErr ?? frameErr;
      const [addr, setAddr] = React.useState('');
      // 初值优先用模块级记忆（上次是开着就续上），本页还没决定过才看「打开即取帧」。
      const [started, setStarted] = React.useState(() => liveStartedMemory ?? (settings.autoStream !== false));
      React.useEffect(() => {
        liveStartedMemory = started;
      }, [started]);
      const [full, setFull] = React.useState(false);
      /** 提交过一次跳转就 +1，让地址/标题/会话号立刻同步（不等下一秒轮询）。 */
      const [refresh, setRefresh] = React.useState(0);
      const [opening, setOpening] = React.useState(false);
      const editing = React.useRef(false);
      const stage = React.useRef(null);
      const lastMove = React.useRef(0);
      const quality = settings.quality;
      const maxWidth = settings.maxWidth;

      React.useEffect(() => {
        onStreamingChange?.(started && !paused);
      }, [started, paused, onStreamingChange]);

      // 把实时状态顺手交给面板（设置区的「取帧参数」用），不改轮询节奏。
      React.useEffect(() => {
        onState?.(page);
      }, [page, onState]);

      React.useEffect(() => {
        const onChange = () => setFull(Boolean(document.fullscreenElement));
        document.addEventListener('fullscreenchange', onChange);
        return () => document.removeEventListener('fullscreenchange', onChange);
      }, []);

      React.useEffect(() => {
        if (paused || !started) return undefined;
        let alive = true;
        let since = 0;
        let current = null; // 上一帧的 object URL：换帧时立刻释放，免得内存越滚越大
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const pump = async () => {
          // 每轮都带上当前设置：质量/最大边改了，服务端会在下一帧按新参数重开流。
          // maxh 必须一起给：CDP 的取帧是「按 max × maxh 等比缩到框内」，只给 max 时
          // 服务端会按缺省高度设上限 —— 大屏页面会被压扁（这就是「画面糊」的根源）。
          const url = `${LIVE_IMAGE_PATH}?since=${since}&quality=${quality}&max=${maxWidth}&maxh=${maxWidth}`;
          while (alive) {
            try {
              const res = await fetch(url, { cache: 'no-store' });
              if (!alive) return;
              if (res.status === 204) {
                await wait(LIVE_RETRY_MS);
                continue;
              }
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const seq = Number(res.headers.get('x-frame-seq')) || since;
              // 真实帧宽高只认响应头：坐标映射必须按它算，不能拿图片显示尺寸猜。
              const w = Number(res.headers.get('x-frame-w')) || 0;
              const hh = Number(res.headers.get('x-frame-h')) || 0;
              const blob = await res.blob();
              if (!alive) return;
              const next = URL.createObjectURL(blob);
              if (current) URL.revokeObjectURL(current);
              current = next;
              since = seq;
              setFrame(next);
              setMeta({ w, h: hh });
              setFrameErr(null);
              await wait(LIVE_GAP_MS);
            } catch (err) {
              if (!alive) return;
              setFrameErr(String(err?.message ?? err));
              await wait(1000);
            }
          }
        };
        void pump();
        return () => {
          alive = false;
          if (current) URL.revokeObjectURL(current);
        };
      }, [paused, started, quality, maxWidth]);

      // 地址栏与状态：每秒问一次服务端（页面自己跳转时也能同步过来）。
      React.useEffect(() => {
        let alive = true;
        const tick = async () => {
          try {
            const res = await fetch(LIVE_STATE_PATH, { cache: 'no-store' });
            if (!res.ok) return;
            const data = await res.json();
            if (!alive) return;
            setPage(data);
            if (!editing.current) setAddr(String(data?.url ?? ''));
          } catch {
            /* 路由不可用时保留上一次状态 */
          }
        };
        void tick();
        const timer = setInterval(() => {
          if (!document.hidden) void tick();
        }, LIVE_STATE_MS);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [refresh]);

      // 收起窗口（卸载）、暂停、或手动停帧时，告诉服务端不用再录屏了。
      React.useEffect(
        () => () => {
          void fetch(LIVE_INPUT_PATH, { method: 'DELETE' }).catch(() => {});
        },
        [],
      );
      React.useEffect(() => {
        if (paused || !started) void fetch(LIVE_INPUT_PATH, { method: 'DELETE' }).catch(() => {});
      }, [paused, started]);

      const send = React.useCallback(async (action) => {
        try {
          const res = await fetch(LIVE_INPUT_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(action),
          });
          if (!res.ok) {
            const detail = await res.json().catch(() => null);
            setActionErr(detail?.error ?? `HTTP ${res.status}`);
            return false;
          }
          setActionErr(null);
          // 地址栏跳转可能顺手新建会话（宿主在「一个会话都没有」时会自己开一个），
          // 地址/标题/会话号立刻同步一次，不用等下一秒的状态轮询。
          if (action?.kind === 'goto') setRefresh((value) => value + 1);
          return true;
        } catch (err) {
          setActionErr(String(err?.message ?? err));
          return false;
        }
      }, []);

      /** 屏幕坐标 → 页面坐标（帧的真实宽高来自响应头，留边由 mapPoint 减掉）。 */
      const point = (event) =>
        mapPoint(stage.current?.getBoundingClientRect?.(), meta, { x: event.clientX, y: event.clientY });

      const button = (index) => (index === 1 ? 'middle' : index === 2 ? 'right' : 'left');

      const onDown = (event) => {
        const at = point(event);
        if (!at) return;
        event.preventDefault();
        stage.current?.focus?.();
        void send({ kind: 'down', ...at, button: button(event.button) });
      };

      const onUp = (event) => {
        const at = point(event);
        if (!at) return;
        void send({ kind: 'up', ...at, button: button(event.button) });
      };

      const onMove = (event) => {
        const at = point(event);
        if (!at) return;
        const now = Date.now();
        if (now - lastMove.current < LIVE_MOVE_MS) return;
        lastMove.current = now;
        void send({ kind: 'move', ...at });
      };

      const onWheel = (event) => {
        const at = point(event) ?? { x: 0, y: 0 };
        void send({ kind: 'wheel', ...at, deltaX: Math.round(event.deltaX), deltaY: Math.round(event.deltaY) });
      };

      const onKeyDown = (event) => {
        // 宿主快捷键（Ctrl/Meta/Alt 组合）留给 DSH 自己，别喂给页面。
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        if (event.key.length === 1) {
          event.preventDefault();
          event.stopPropagation(); // 别让 Esc 之类的按键再冒泡到面板的「收起」监听
          void send({ kind: 'text', text: event.key });
          return;
        }
        if (NAMED_KEYS.has(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          void send({ kind: 'key', key: event.key });
        }
      };

      const submit = (event) => {
        event.preventDefault();
        editing.current = false;
        // 没写协议就按 https 补（与宿主 normalizeUrl 同一套规则），空串直接不提交。
        const url = withScheme(addr);
        if (!url || opening) return;
        setOpening(true);
        void send({ kind: 'goto', url }).then(() => {
          setOpening(false);
          setAddr(url);
        });
      };

      const fullscreen = () => {
        try {
          if (document.fullscreenElement) void document.exitFullscreen?.();
          else void stage.current?.requestFullscreen?.();
        } catch {
          /* 不支持全屏就算了，不影响取帧与操作 */
        }
      };

      const status = page?.live
        ? `正在推流 · ${page?.title || page?.url || '—'}`
        : (page?.reason ?? (paused ? '已暂停' : started ? '等待浏览器会话' : '未开始取帧'));
      const size = meta.w && meta.h
        ? `${meta.w}×${meta.h}`
        : (page?.width && page?.height ? `${page.width}×${page.height}` : '—');
      // 有帧就一直显示（暂停时留着最后一帧），遮罩只作提示。
      // 没有会话时别写「连接中…」——那句会让人一直等下（等不来），直接说清楚怎么开页面。
      const noSession = page?.live === false;
      const overlay = !frame
        ? (paused
            ? '已暂停'
            : !started
              ? '未开始取帧（点「开始」）'
              : noSession
                ? (page?.reason || '还没有打开的页面')
                : '连接中…等待第一帧')
        : paused ? '已暂停' : started ? null : '已停帧';
      const quiet = noSession ? '输入网址后点「跳转」，会自动打开页面' : '画面来自真实浏览器，可直接点击/滚动/打字';
      // 贴合画面比例（默认开）：舞台自带比例 ⇒ 舞台内不留黑边，窗口高度也跟着它走。
      const ratio = ratioOf(meta, settings.viewport);
      const fit = settings.fitPicture !== false && Boolean(ratio);

      return h('div', { className: 'bsp-live' },
        h('form', { className: 'bsp-addrRow', onSubmit: submit },
          h('input', {
            className: 'bsp-input',
            value: addr,
            placeholder: '输入网址后回车',
            spellCheck: false,
            'aria-label': '网址',
            onFocus: () => {
              editing.current = true;
            },
            onBlur: () => {
              editing.current = false;
            },
            onChange: (event) => {
              editing.current = true;
              setAddr(event.target.value);
            },
          }),
          h('button', {
            type: 'submit',
            className: 'bsp-btn',
            'aria-busy': opening ? 'true' : 'false',
          }, opening ? '打开中…' : '跳转'),
          h('button', { type: 'button', className: 'bsp-btn', onClick: () => void send({ kind: 'reload' }) }, '刷新'),
          h('button', {
            type: 'button',
            className: 'bsp-btn',
            'aria-pressed': started ? 'true' : 'false',
            onClick: () => setStarted((value) => !value),
          }, started ? '停帧' : '开始')),
        // 失败原因紧贴地址栏（以前贴在页脚，被画面挤到看不见，看着就像「点了没反应」）。
        error
          ? h('div', { className: 'bsp-liveErr', title: error },
              h('b', null, '⚠'), h('span', null, error))
          : null,
        h('div', {
          ref: stage,
          tabIndex: 0,
          className: fit ? 'bsp-stage bsp-stageFit' : 'bsp-stage',
          style: fit ? { aspectRatio: ratio, flex: '0 1 auto' } : null,
          'aria-label': '浏览器实时画面（可直接点击、滚动、打字）',
          onMouseDown: onDown,
          onMouseUp: onUp,
          onMouseMove: onMove,
          onWheel,
          onKeyDown,
        },
          frame ? h('img', { className: 'bsp-shot', src: frame, alt: '浏览器实时画面', draggable: false }) : null,
          overlay
            ? h('div', { className: 'bsp-stageMsg' },
                h('span', null, overlay),
                h('span', { className: 'bsp-quiet' }, quiet))
            : null),
        h('div', { className: 'bsp-liveFoot' },
          h('span', { className: `bsp-dot ${page?.live ? 'on' : error ? 'bad' : 'off'}` }),
          h('span', { className: 'c-main', title: status }, status),
          h('span', { className: 'bsp-spacer' }),
          h('span', null, `画面 ${size}`),
          h('span', null, page?.session ? `会话 ${page.session}` : '会话 —'),
          h('button', { type: 'button', className: 'bsp-btn', onClick: fullscreen }, full ? '退出全屏' : '全屏')));
    }

    function Panel() {
      // 入场只读一次存储：settings 与 geometry 两个 state 要用同一份（夹取间距得一致）。
      const stored = React.useRef(null);
      if (!stored.current) stored.current = readStore(STORAGE_KEY, {});
      const [open, setOpen] = React.useState(false);
      const [settings, setSettings] = React.useState(() => normalizeSettings(stored.current.settings));
      // 已保存的那份（写盘用的就是它）：draft 与它不一致就是「有未保存的改动」。
      const saved = React.useRef(normalizeSettings(stored.current.settings));
      const [saveNote, setSaveNote] = React.useState(null);
      const [geometry, setGeometry] = React.useState(() =>
        clampRect(stored.current.window, viewport(), normalizeSettings(stored.current.settings).panelGap, 0));
      const [tab, setTab] = React.useState(settings.tab);
      const [paused, setPaused] = React.useState(false);
      const [streaming, setStreaming] = React.useState(false);
      const [snapshot, setSnapshot] = React.useState({ data: null, error: null, loading: true });
      const [nonce, setNonce] = React.useState(0);
      const [now, setNow] = React.useState(() => Date.now());
      const card = React.useRef(null);
      const rail = React.useRef(null);
      const pill = React.useRef(null);
      // 胶囊拖动：拖动期间用 dragPos 接管位置（松手才换算成设置 + 落盘），dragged 用来吃掉拖动后的那次 click。
      const [dragPos, setDragPos] = React.useState(null);
      const [pillSize, setPillSize] = React.useState(null);
      const dragged = React.useRef(false);
      // 视口变化时 bump 一下，逼胶囊按新视口重排（自由坐标可能落在屏幕外）。
      const [, setTick] = React.useState(0);
      const live = React.useRef(null); // 最近一次的 live.json（设置区读 options 用，不进 state）
      // 夹取要用当前「面板间距」，但不该让 resize/拖拽的 effect 每次改设置都重建 ⇒ 用 ref 跟。
      const settingsRef = React.useRef(settings);
      settingsRef.current = settings;
      // 顶部留白同理：拖拽/缩放/最大化都要用同一个值（'auto' 量出来的结果）。
      const insetRef = React.useRef(TOP_INSET_FALLBACK);
      const [topInset, setTopInset] = React.useState(TOP_INSET_FALLBACK);
      /** 贴合画面比例（默认开）：开着时高度由内容决定，右下角手柄只调宽度。 */
      const fitPicture = settings.fitPicture !== false;

      /** 有未保存的改动？（草稿 vs 上次保存的那份） */
      const dirty = safeJson(settings) !== safeJson(saved.current);

      /** 设置改动只进草稿（patch 形式，见 SettingsPane）：窗口外观立刻按新值渲染，「保存」才写盘。 */
      const patchSettings = React.useCallback((patch) => {
        setSettings((prev) => normalizeSettings({ ...prev, ...patch }));
        setSaveNote(null);
      }, []);

      /** 显式保存：写盘成功才更新「已保存的那份」，失败如实报出来（无痕模式会踩到）。 */
      const saveSettings = () => {
        const window_ = settings.remember ? geometry : null;
        if (!writeStore(STORAGE_KEY, { settings, window: window_ })) {
          setSaveNote({ tone: 'err', text: '保存失败：这个浏览器不让写本地存储（无痕模式或站点策略），改动只在本次打开有效。' });
          return;
        }
        saved.current = settings;
        setSaveNote({ tone: 'ok', text: '✓ 已保存：窗口外观立即生效，刷新页面也保留。' });
      };

      /** 恢复默认值：先只改草稿（外观立刻回默认），点「保存」才落盘。 */
      const applyDefaults = () => {
        setSettings(DEFAULT_SETTINGS);
        setSaveNote({ tone: 'dirty', text: '已恢复默认值 —— 点「保存」后正式生效（窗口外观已经先按默认显示了）。' });
      };

      /**
       * 把胶囊摆到某个屏幕坐标（拖动松手时用）：改成「自由」模式 + 记坐标，**立刻落盘**。
       * 只把这三个字段并进「已保存的那份」，别的未保存草稿继续留着不动 —— 拖一下不该替用户点保存。
       */
      const placePill = (point) => {
        const patch = { pillPos: 'free', pillX: point.x, pillY: point.y };
        setSettings((prev) => normalizeSettings({ ...prev, ...patch }));
        const base = normalizeSettings({ ...saved.current, ...patch });
        saved.current = base;
        if (writeStore(STORAGE_KEY, { settings: base, window: base.remember ? geometry : null })) {
          setSaveNote({ tone: 'ok', text: `✓ 胶囊位置已记住（自由位置 ${point.x} / ${point.y}）` });
        } else {
          setSaveNote({ tone: 'err', text: '位置没能写入本地存储：刷新后会回到原处（无痕模式或站点策略）。' });
        }
      };

      /** 拖动胶囊：指针事件 + 捕获，实时只改 dragPos，松手才换算落盘；位移 ≤ DRAG_SLOP 当点击。 */
      const startPillDrag = (event) => {
        if (event.button !== 0) return;
        const node = pill.current;
        const box = node?.getBoundingClientRect?.();
        if (!node || !box) return;
        const size = { w: Math.round(box.width), h: Math.round(box.height) };
        const grab = { x: event.clientX - box.left, y: event.clientY - box.top };
        const from = { x: event.clientX, y: event.clientY };
        const limit = (point) => ({
          x: fitAxis(Math.round(point.x), viewport().w, size.w),
          y: fitAxis(Math.round(point.y), viewport().h, size.h),
        });
        let moved = false;
        let frameId = 0;
        let next = null;
        const flush = () => {
          frameId = 0;
          if (next) setDragPos(next);
        };
        const onMove = (moveEvent) => {
          if (!moved && Math.hypot(moveEvent.clientX - from.x, moveEvent.clientY - from.y) > DRAG_SLOP) moved = true;
          if (!moved) return;
          next = limit({ x: moveEvent.clientX - grab.x, y: moveEvent.clientY - grab.y });
          if (!frameId) frameId = requestAnimationFrame(flush);
        };
        const onEnd = () => {
          if (frameId) cancelAnimationFrame(frameId);
          node.removeEventListener('pointermove', onMove);
          node.removeEventListener('pointerup', onEnd);
          node.removeEventListener('pointercancel', onEnd);
          if (node.hasPointerCapture?.(event.pointerId)) node.releasePointerCapture(event.pointerId);
          document.body.style.userSelect = '';
          setDragPos(null);
          if (!moved) return;
          dragged.current = true;
          placePill(next ?? limit({ x: box.left, y: box.top }));
        };
        // 拖动期间别选中文字；指针捕获让指针移出窗口也不丢事件（触摸/触控笔一并支持）。
        document.body.style.userSelect = 'none';
        node.addEventListener('pointermove', onMove);
        node.addEventListener('pointerup', onEnd);
        node.addEventListener('pointercancel', onEnd);
        try {
          node.setPointerCapture(event.pointerId);
        } catch { /* 老浏览器没有指针捕获：退回节点上的普通事件 */ }
      };

      useStyles();

      // 视口变了（浏览器窗口缩放）就把窗口拉回可见范围，并让胶囊按新视口重排。
      React.useEffect(() => {
        const onResize = () => {
          setGeometry((prev) => clampRect(prev, viewport(), settingsRef.current.panelGap, insetRef.current));
          setTick((n) => n + 1);
        };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
      }, []);

      // 量一次胶囊尺寸（有则留着，收起状态才有节点）：自由坐标按视口夹取要用它。
      React.useEffect(() => {
        const node = pill.current;
        if (!node) return;
        const w = node.offsetWidth;
        const h = node.offsetHeight;
        setPillSize((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
      });

      // 顶部留白：打开面板（或改了这项设置）时量一次宿主顶栏，把窗口拉回它下面。
      React.useEffect(() => {
        if (!open) return undefined;
        const bounds = viewport();
        const boxes = settings.topInset === 'auto' ? collectTopBars(document, bounds) : [];
        const inset = resolveTopInset(settings.topInset, boxes, bounds);
        insetRef.current = inset;
        setTopInset(inset);
        setGeometry((prev) => clampRect(prev, bounds, settingsRef.current.panelGap, inset));
        return undefined;
      }, [open, settings.topInset]);

      // 贴合画面比例时卡片高度由内容决定，而夹取用的是记下来的高度（默认 580）——
      // 首次打开（没记过位置）时先量一次真实高度再摆正中，否则窗口看着偏上。
      React.useEffect(() => {
        if (!open || !fitPicture) return undefined;
        const record = stored.current.window;
        if (record && Number.isFinite(record.x) && Number.isFinite(record.y)) return undefined;
        const node = card.current;
        if (!node) return undefined;
        const h = Math.round(node.getBoundingClientRect().height);
        if (!(h > 0)) return undefined;
        setGeometry((prev) => clampRect({ x: null, y: null, w: prev.w, h }, viewport(), settingsRef.current.panelGap, insetRef.current));
        return undefined;
      }, [open, fitPicture, settings.viewport]);

      // 记住窗口位置与大小（设置里可关）：入场先读，改了就写。
      // 写的是「已保存的设置 + 当前几何」——没点保存的草稿不该被顺手写进存储。
      React.useEffect(() => {
        if (!settings.remember) return;
        writeStore(STORAGE_KEY, { settings: saved.current, window: geometry });
      }, [settings.remember, geometry]);

      // 相对时间（「12 秒前」）自己走一个慢节拍，暂停轮询时也不会冻住。
      React.useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), NOW_TICK_MS);
        return () => clearInterval(timer);
      }, []);

      // Esc 收起（实时画面里按 Esc 会被画面自己吃掉，不会误收面板）。
      React.useEffect(() => {
        if (!open) return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [open]);

      React.useEffect(() => {
        let alive = true;
        let busy = false;
        const load = async () => {
          if (busy) return;
          busy = true;
          try {
            const res = await fetch(`${PANEL_PATH}?lines=${settings.lines}`, { headers: { accept: 'application/json' } });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (alive) setSnapshot({ data, error: null, loading: false });
          } catch (error) {
            // 路由没挂（例如无头 profile 没有 webServer）时别每几秒刷控制台：只记住最后一次错误。
            if (alive) setSnapshot((prev) => ({ ...prev, error: String(error?.message ?? error), loading: false }));
          } finally {
            busy = false;
          }
        };
        void load();
        const timer = setInterval(() => {
          if (!paused && !document.hidden) void load();
        }, settings.pollMs);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [paused, settings.pollMs, settings.lines, nonce, open]);

      const data = snapshot.data;
      const badge = alarms(data);
      const retry = () => setNonce((value) => value + 1);

      // 自动清理：某类日志超过上限就裁到上限的一半（面板打开着时检查一遍，收敛即止）。
      // 成败都落进 cleanNote —— 只做不说的时代，失败会被当成「设置没生效」。
      const [cleanNote, setCleanNote] = React.useState(null);
      const cleaning = React.useRef(false);
      React.useEffect(() => {
        const limit = Number(settings.autoClean) || 0;
        if (!limit || !data || cleaning.current) return;
        const over = LOG_TABS.filter((kind) => Number(data?.[kind]?.total ?? 0) > limit);
        if (!over.length) return;
        cleaning.current = true;
        const keep = Math.max(1, Math.floor(limit / 2));
        const before = Object.fromEntries(over.map((kind) => [kind, Number(data?.[kind]?.total ?? 0)]));
        void Promise.all(over.map((kind) => postLogs({ action: 'trim', kind, keep }).then((result) => ({ kind, result }))))
          .then((settled) => {
            const failed = settled.filter((item) => !item.result.ok);
            if (failed.length) {
              const first = failed[0];
              setCleanNote({ tone: 'err', text: postErrorText(first.result, `自动清理${TAB_NAME[first.kind] ?? first.kind}日志`) });
            } else {
              const parts = settled.map(({ kind, result }) => {
                const total = Number(result.body?.result?.[kind] ?? keep);
                return `${TAB_NAME[kind] ?? kind} ${before[kind]} → ${total}`;
              });
              setCleanNote({ tone: 'ok', text: `已自动清理：${parts.join('，')}` });
            }
            retry();
          })
          .finally(() => {
            cleaning.current = false;
          });
      }, [data, settings.autoClean]);

      /** 手动清空某一类日志（列表右上角的「清理」，前面已确认过一次）。 */
      const clearKind = React.useCallback(async (kind) => {
        const result = await postLogs({ action: 'clear', kind });
        const name = TAB_NAME[kind] ?? kind;
        setCleanNote(result.ok
          ? { tone: 'ok', text: `已清空${name}日志（剩 ${Number(result.body?.result?.[kind] ?? 0)} 条）` }
          : { tone: 'err', text: postErrorText(result, `清理${name}日志`) });
        retry();
      }, []);

      const pillTitle = [
        snapshot.error ? `面板数据路由不可用：${snapshot.error}` : '打开浏览器服务面板',
        data ? `更新于 ${clock(data.generatedAt)}` : '尚未取到数据',
      ].join('\n');

      if (!open) {
        const bounds = viewport();
        return h('button', {
          type: 'button',
          ref: pill,
          className: `bsp-pill${dragPos ? ' bsp-grabbing' : ''}`,
          style: {
            ...(dragPos
              ? { left: `${dragPos.x}px`, top: `${dragPos.y}px`, right: 'auto', bottom: 'auto' }
              : pillAnchor(settings.pillPos, settings.pillX, settings.pillY, bounds, pillSize)),
            ...appearanceStyle(settings, 'pill'),
            zIndex: Number(settings.zBase),
          },
          title: dirty ? `${pillTitle}\n设置有未保存的改动` : `${pillTitle}\n可以直接拖到任意位置`,
          'aria-label': '打开浏览器服务面板',
          onPointerDown: startPillDrag,
          onClick: () => {
            // 拖完会跟着来一次 click：吃掉它，别顺手把面板弹开。
            if (dragged.current) {
              dragged.current = false;
              return;
            }
            setOpen(true);
          },
        },
          h('span', { className: `bsp-dot ${snapshot.error ? 'bad' : badge ? 'warn' : 'on'}` }),
          h('span', { className: 'bsp-pillName' }, '浏览器'),
          h('span', { className: 'bsp-pillMeta' },
            snapshot.error ? '不可用' : data ? `${data?.ops?.total ?? 0} 操作` : '连接中…'),
          badge ? h('span', { className: 'bsp-count bad' }, String(badge)) : null,
          dirty ? h('span', { className: 'bsp-dirtyDot', title: '有未保存的设置改动' }) : null);
      }

      /** 拖标题栏移动窗口：拖动期间只改 DOM style（rAF 节流），松手才落 state。 */
      const startDrag = (event) => {
        if (event.button !== 0) return;
        const box = card.current?.getBoundingClientRect?.();
        if (!box) return;
        event.preventDefault();
        const offset = { x: event.clientX - box.left, y: event.clientY - box.top };
        let frameId = 0;
        let next = null;
        const flush = () => {
          frameId = 0;
          if (!next) return;
          next = clampRect({ x: next.x, y: next.y, w: box.width, h: box.height }, viewport(), settingsRef.current.panelGap, insetRef.current);
          if (card.current) {
            card.current.style.left = `${next.x}px`;
            card.current.style.top = `${next.y}px`;
          }
        };
        const onMove = (moveEvent) => {
          next = { x: moveEvent.clientX - offset.x, y: moveEvent.clientY - offset.y };
          if (!frameId) frameId = requestAnimationFrame(flush);
        };
        const onUp = () => {
          if (frameId) cancelAnimationFrame(frameId);
          flush();
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          document.body.style.userSelect = '';
          if (next) setGeometry((prev) => ({ ...prev, x: next.x, y: next.y }));
        };
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      };

      /** 拖右下角手柄缩放：同样只改 DOM style，松手落 state。 */
      const startResize = (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const box = card.current?.getBoundingClientRect?.();
        if (!box) return;
        const fitting = settingsRef.current.fitPicture !== false;
        const start = { x: event.clientX, y: event.clientY, w: box.width, h: box.height };
        let frameId = 0;
        let next = null;
        const flush = () => {
          frameId = 0;
          if (!next) return;
          const rect = clampRect({ x: box.left, y: box.top, w: next.w, h: next.h }, viewport(), settingsRef.current.panelGap, insetRef.current);
          next = { w: rect.w, h: rect.h };
          if (card.current) {
            card.current.style.width = `${rect.w}px`;
            card.current.style.height = `${rect.h}px`;
          }
        };
        const onMove = (moveEvent) => {
          // 贴合画面比例时只认横向拖动：高度由画面比例决定。
          next = fitting
            ? { w: start.w + (moveEvent.clientX - start.x), h: box.height }
            : { w: start.w + (moveEvent.clientX - start.x), h: start.h + (moveEvent.clientY - start.y) };
          if (!frameId) frameId = requestAnimationFrame(flush);
        };
        const onUp = () => {
          if (frameId) cancelAnimationFrame(frameId);
          flush();
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          document.body.style.userSelect = '';
          if (next) setGeometry((prev) => clampRect({ x: prev.x, y: prev.y, w: next.w, h: next.h }, viewport(), settingsRef.current.panelGap, insetRef.current));
        };
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      };

      /** 最大化/还原：几何是硬跳，给一记轻脉冲让人知道"窗口变了"，不动 left/top/width/height。 */
      const pulse = () => {
        const el = card.current;
        if (!el?.animate || prefersReduced()) return;
        try {
          el.animate([{ opacity: 0.55 }, { opacity: 1 }], { duration: 150, easing: 'ease-out' });
        } catch {
          /* 动画不可用就静默跳过 */
        }
      };

      const maximize = () => {
        setGeometry((prev) => {
          const bounds = viewport();
          const pad = settingsRef.current.panelGap;
          const inset = insetRef.current;
          const full = { w: Number(bounds.w) - pad * 2, h: Number(bounds.h) - inset - pad * 2 };
          const isFull = Math.abs(prev.w - full.w) < 40 && Math.abs(prev.h - full.h) < 40;
          return isFull
            ? clampRect({ x: null, y: null, w: DEFAULT_WINDOW.w, h: DEFAULT_WINDOW.h }, bounds, pad, inset)
            : clampRect({ x: pad, y: inset + pad, ...full }, bounds, pad, inset);
        });
        pulse();
      };

      const resetGeometry = () => {
        setGeometry(clampRect({ x: null, y: null, w: DEFAULT_WINDOW.w, h: DEFAULT_WINDOW.h }, viewport(), settingsRef.current.panelGap, insetRef.current));
        pulse();
      };

      /** 左右/上下方向键在入口之间走（标准的自动激活式 tablist）。 */
      const onRailKey = (event) => {
        const index = TAB_IDS.indexOf(tab);
        let next = -1;
        if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % TAB_IDS.length;
        else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index - 1 + TAB_IDS.length) % TAB_IDS.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = TAB_IDS.length - 1;
        if (next < 0) return;
        event.preventDefault();
        const id = TAB_IDS[next];
        setTab(id);
        rail.current?.querySelector?.(`[data-tab="${id}"]`)?.focus?.();
      };

      const tabBadge = (id) => {
        if (!LOG_TABS.includes(id)) return null;
        if (id === 'ops') return entries(data, 'ops').filter((entry) => isAlarm('ops', entry)).length;
        if (id === 'console') return entries(data, 'console').filter((entry) => isAlarm('console', entry)).length;
        return entries(data, 'network').filter((entry) => isAlarm('network', entry)).length;
      };

      const pane = tab === 'live' || tab === 'settings'
        ? null
        : h(ListPane, {
            kind: tab,
            data,
            error: snapshot.error,
            loading: snapshot.loading,
            lines: settings.lines,
            onRetry: retry,
            onClear: clearKind,
            now,
          });

      return h('div', {
        ref: card,
        className: 'bsp-card',
        role: 'region',
        tabIndex: -1,
        'aria-label': '浏览器服务面板',
        style: {
          left: `${geometry.x}px`,
          top: `${geometry.y}px`,
          width: `${geometry.w}px`,
          // 贴合画面比例（默认开）：高度交给内容（舞台自带比例），只留一个「不超出视口」的上限。
          height: fitPicture ? 'auto' : `${geometry.h}px`,
          maxHeight: `calc(100vh - ${geometry.y + settings.panelGap}px)`,
          // 层级基准（设置里可调）：胶囊 zBase、卡片 zBase+1，保证卡片永远压在胶囊上面。
          zIndex: Number(settings.zBase) + 1,
          // 窗口外观（边框颜色 / 背景不透明度 / 玻璃效果）——纯 CSS 变量，改设置立刻见。
          ...appearanceStyle(settings, 'card'),
        },
      },
        h('div', { className: 'bsp-head', onMouseDown: startDrag, onDoubleClick: maximize },
          h('span', { className: 'bsp-grip' }, '⠿'),
          h('span', { className: 'bsp-title' }, '浏览器服务面板'),
          h('span', { className: 'bsp-liveState' },
            h('span', { className: `bsp-dot ${streaming ? 'on' : 'off'}` }),
            streaming ? '实时' : '停帧'),
          h('button', {
            type: 'button',
            className: 'bsp-btn',
            'aria-pressed': paused ? 'true' : 'false',
            title: paused ? '继续轮询与取帧' : '暂停轮询与取帧',
            onClick: () => setPaused((value) => !value),
          }, paused ? '继续' : '暂停'),
          h('button', { type: 'button', className: 'bsp-btn', title: '最大化 / 还原', 'aria-label': '最大化或还原', onClick: maximize }, '⤢'),
          h('button', { type: 'button', className: 'bsp-btn', title: '收起成胶囊（Esc）', onClick: () => setOpen(false) }, '收起')),
        cleanNote
          ? h('div', { className: `bsp-noteClean${cleanNote.tone ? ` ${cleanNote.tone}` : ''}`, role: 'status' },
              h('span', null, cleanNote.text),
              h('button', { type: 'button', className: 'bsp-chip', onClick: () => setCleanNote(null) }, '知道了'))
          : null,
        h('div', { style: { display: 'flex', flex: 1, minHeight: 0 } },
          h('div', {
            ref: rail,
            className: 'bsp-rail',
            role: 'tablist',
            'aria-orientation': 'vertical',
            'aria-label': '面板入口',
            onKeyDown: onRailKey,
          },
            RAIL.map(([id, name]) => {
              const count = id === 'live' || id === 'settings' ? 0 : data?.[id]?.total ?? 0;
              const alarmsOnTab = tabBadge(id);
              return h('button', {
                key: id,
                type: 'button',
                role: 'tab',
                id: `bsp-tab-${id}`,
                'data-tab': id,
                'aria-selected': tab === id ? 'true' : 'false',
                'aria-controls': 'bsp-pane',
                tabIndex: tab === id ? 0 : -1,
                className: 'bsp-tab',
                title: name,
                onClick: () => setTab(id),
              },
                h('span', { className: 'bsp-tabIcon' }, h(Icon, { id })),
                h('span', { className: 'bsp-tabName' }, name),
                id === 'settings' && dirty
                  ? h('span', { className: 'bsp-dirtyDot', title: '有未保存的设置改动' })
                  : null,
                count ? h('span', { className: `bsp-badge${alarmsOnTab ? ' bad' : ''}` }, String(count)) : null);
            })),
          h('div', { className: 'bsp-main' },
            h('div', {
              key: tab,
              id: 'bsp-pane',
              role: 'tabpanel',
              'aria-labelledby': `bsp-tab-${tab}`,
              tabIndex: -1,
              className: tab === 'live' ? 'bsp-body fill' : 'bsp-body',
            },
              tab === 'live'
                ? h(LivePane, {
                    paused,
                    settings,
                    onStreamingChange: setStreaming,
                    onState: (value) => {
                      live.current = value;
                    },
                  })
                : tab === 'settings'
                  ? h(SettingsPane, {
                      settings,
                      onPatch: patchSettings,
                      service: data?.service,
                      options: live.current?.options,
                      onReset: resetGeometry,
                      dirty,
                      saveNote,
                      onSave: saveSettings,
                      onDefaults: applyDefaults,
                      // 切到「自由」时的起点：按当前角 + 偏移 + 实测尺寸换算，胶囊不会跳。
                      pillPoint: () => pillPoint(settings, pillSize, viewport()),
                    })
                  : pane),
            h('div', { className: 'bsp-foot' },
              h('span', { className: `bsp-dot ${snapshot.error ? 'bad' : paused ? 'off' : 'on'}` }),
              h('span', null, snapshot.error ? '未连接' : paused ? '已暂停' : '已连接'),
              h('span', { title: data ? clock(data.generatedAt) : '' },
                `更新于 ${data ? relTime(data.generatedAt, now) : '—'}`),
              h('span', { className: 'bsp-spacer' }),
              h('span', null, `取帧 质量 ${settings.quality} · 最大边 ${settings.maxWidth}`)))),
        h('div', {
          style: fitPicture ? { ...toneResize, cursor: 'ew-resize' } : toneResize,
          onMouseDown: startResize,
          title: fitPicture ? '拖动调整宽度（高度按画面比例）' : '拖动调整大小',
        }));
    }

    /** 右下角缩放手柄（内联，因为它纯粹是这块小三角的几何）。 */
    const toneResize = {
      position: 'absolute',
      right: 0,
      bottom: 0,
      width: '16px',
      height: '16px',
      cursor: 'nwse-resize',
      background: `linear-gradient(135deg, transparent 45%, ${tok.dim} 45%, ${tok.dim} 55%, transparent 55%, transparent 70%, ${tok.dim} 70%, ${tok.dim} 80%, transparent 80%)`,
    };

    function apply(ctx) {
      // shell.overlay 是 kind:list / scope:root 的 additive 座位；注册新 id 不动别人。
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'browser-service-panel', order: 200 }, Panel));
    }

    exports.name = 'browser-service-panel';
    exports.inject = ['slots'];
    exports.apply = apply;
    // 纯函数导出：给隔离验收脚本断言几何夹取、设置规整与坐标映射（浏览器侧不会用到）。
    exports.internals = { clampInt, clampRect, fitAxis, topInsetFromBoxes, resolveTopInset, ratioOf, collectTopBars, normalizeSettings, mapPoint, relTime, isAlarm, pillAnchor, pillPoint, withScheme, appearanceStyle, borderOf, DEFAULT_WINDOW, STORAGE_KEY, DEFAULT_SETTINGS };
    return exports;
  },
});
