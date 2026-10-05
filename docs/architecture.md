# 架构：DSH `ctx.browser` provider 接线

本插件把 CDP 守护进程接进 DSH 的 browser seam：**插件只注册 provider，工具面沿用内置 `tool-browser` 的 `browser_*` 工具**（不自己定义工具）。v0.4.0 起接缝与工具面都由依赖 `dsh-builtin-browser` 经本包转出，所以只要装一个包。

```
browser_* 工具（dsh-builtin-browser/tool-browser，经本包 plugin/shims/tool-browser.js 转出）
   └─ ctx.browser seam（dsh-builtin-browser/browser，经本包 plugin/shims/browser.js 转出）
        └─ dsh-moli-browser（本仓库 plugin/lib/provider.js，provider id = cdp-daemon）
             └─ playwright-core connectOverCDP → 127.0.0.1:9333（browsersvc 回环代理）
                  └─ moli serve（单发动机内核；moliEnv 注入用户态库 + FONTCONFIG_FILE 字体配置）
```

## 1. 插件

- 目录：`plugin/`（单一交付物 `dsh-moli-browser` 的插件侧源码，见 `plugin/README.md`）——**不再是独立子包**，`plugin/package.json` 已删除，`dsh.bundle` 由根 `package.json` 声明。
- 依赖（根 package.json）：`dsh-builtin-browser`（接缝 + 33 个工具）、`playwright-core`（**不下载浏览器**）；`@deepseek-ai/schemastery`（配置 schema）按官方 peer 规则写成 `peerDependencies` + `devDependencies`，与宿主共享同一实例。
- `plugin/lib/index.js`：`name='browser-moli'`、`inject=['browser']`；`apply` 第一件事是**注册随包技能的内置提供者**（v0.8.2 起：`ctx.inject(['skills'], …)` → `ctx.skills.registerProvider()`，候选带 `source:'bundled'` + rank 600，技能中心里显示「系统内置」，与 `dsh-univer-office` 同形态；正文现读包内 `skills/`，改文件不用重启；配置 `registerSkills` 默认开；宿主没有 `skills` 服务时只记一行日志、绝不影响 provider），紧接着**可选**地把包内 `skills/` 落盘（`syncSkills`，v0.8.2 起默认关 —— 落盘是用户级 rank 400，会盖住内置那份；带归属台账，用户改过的文件跳过；配置 `skillsDir`），然后做**启动期能力探测**（`plugin/lib/compat.js`：动态 import 两个接缝模块 + `inspectSeam()` 校验导出面与宿主版本，不符就打印一句人话并 return；`ctx.browser.registerBrowserProvider` 不存在也报同一类错），探测通过后再动态 `import('playwright-core')`，然后 `ctx.browser.registerBrowserProvider(provider)`，并用 `ctx.effect` 持有 disposer（热加载不留 stale provider）。
- `plugin/lib/compat.js`：导出 `SEAM_PACKAGE` / `TESTED_SEAM` / `TESTED_HOSTS` 与纯函数 `inspectSeam({browserModule, toolModule, hostVersion})`、`readVersions()`、`seamMismatchMessage()`；只做形状与版本判断，不做任何 I/O。
- `plugin/lib/provider.js`：`createProvider({chromium, BrowserError, config, log, autoStart})`，实现 seam 的 `BrowserProvider` 全部成员（`open`/`execute`/`snapshot`/`screenshot`/…；契约见 `dsh-builtin-browser/lib/browser/types.d.ts`）；`defaultAutoStartCommand()` 指向**本包自带**的 `bin/browsersvc.mjs`。P7 起多一个 `setViewport({width,height})`（夹到 640×360 ~ 3840×2160，对已打开的每个页面 `page.setViewportSize` 并统计 `applied`，之后的会话沿用该尺寸，非法值抛 `BROWSER_VIEWPORT_INVALID`）与只读 getter `viewport()`；两处建上下文与截图兜底都改读这份 `#viewport`。
- `plugin/lib/dom.js`：注入页面的纯函数（snapshot/a11y/content/scrape/fillForm/challenge 检测）。**注入函数不能引用任何外部作用域**（序列化后不存在）。
- `plugin/lib/provider.js` 里的**通用追踪**（P3）：`traced()` 返回一个 `Proxy`，把每个公共方法都包一层「跑完记账」（`seq`/`action`/`params`/`ok`/`error`/`ms`）写进 `<root>/ops.jsonl`，以后新增方法自动覆盖。`open`（会话创建）、`reset`（会清空账本）、`history`（读账本本身）与本来就有 `#record` 的方法在 `TRACED_SKIP` 里，不重复记账。`#instrument(page)` 挂在 `#addTab`（页面创建的**唯一漏斗**）上抓控制台与网络。
- `plugin/lib/panel.js`（P3/P4/P5/P6/P7）：网页面板的**宿主半边**——六条 `exact` 路由：只读 `GET /browser-service/panel.json`（只 GET/HEAD、`no-store`、载荷不含本机绝对路径，数据直接读三个 JSONL；P5 起多一块只读 `service`：版本/会话/CDP 地址/保存目录名/标签上限/空闲回收/录制开关/生效取帧参数与分辨率）与实时窗口的 `GET /browser-service/live.jpg?since=N[&quality=&max=&maxh=]`（长轮询等新帧，无帧 204，P5 起按请求参数开流并回 `x-frame-quality`/`x-frame-max`）、`GET /browser-service/live.json`（地址栏/标题/推流状态与生效取帧参数）、`POST|DELETE /browser-service/live`（转发操作 / 停流）、`POST /browser-service/logs`（P6 起：`{action:'clear'|'trim', kind, keep}` 清/裁观测日志，走同一套闸）、`POST /browser-service/viewport`（P7 起：`{width,height}` → `provider.setViewport()`，回 `{ok,viewport,applied}`）；三道闸：只认回环地址、方法白名单、写路由同源校验。P6 还修了「地址栏跳转没反应」：`goto` 时 `normalizeUrl()` 先补 `https://`（空串 400），**一个会话都没有时先 `provider.open('面板地址栏')` 再 `openUrl()`**（回包带 `opened:true`）。通过 `ctx.inject(['webServer'], …)` 挂载，没有 `webServer` 的宿主不挂，插件照常工作。
- `plugin/lib/liveview.mjs`（P4/P5）：**实时窗口**——`class LiveView(page, …)` 包住会话当前页：`Page.startScreencast`（JPEG、最长边 ≤1920）经回环代理订阅帧（**只在画面变化时下发**，逐帧 `screencastFrameAck`；`waitFrame({since})` 长轮询取一帧），`Input.dispatchMouseEvent`/`insertText`/`dispatchKeyEvent`/`mouseWheel` 把点击/滚动/打字/按键打回真页面。CDP 会话懒建（`#session()` 幂等），**不开流也能先转操作**；空闲 30 s 自动停流。P5 起 `start(options)` 接受 `{quality, maxWidth, maxHeight}`：纯函数 `resolveStreamOptions` 把坏值回落、越界夹到安全范围（质量 10..95、宽 320..1920、高 240..1200；默认质量 85、高度上限 1200），参数没变就不重开流（幂等），变了先 `Page.stopScreencast` 再按新参数开，`get options()` 回读当前生效值。P7 修 `clampInt`：**没给**（`null`/空串）回落当前值/默认，而不是按 `Number(null) === 0` 夹到下限 —— 客户端曾只发 `max` 不发 `maxh`，高度上限被算成 240，CDP 把 1920×1080 的页面等比压进 `1920×240` 的框（实际 384×240）再被界面放大，画面就糊；现在客户端把「最大边」同时作为宽高上限（长边上限）发下去。
- `plugin/client.js`（P3/P4/P5/P6/P7/P8/P9/P10）：面板的**客户端半边**——手写、零构建，走 DSH 的 `window.__ModuleLoader__.load({ id, factory })` 协议，只 `require('react')`，`apply` 里 `ctx.slots.inject('shell.overlay', …)` 注册浮动窗口（**默认左上角**的小胶囊）。P5 起窗口可拖动（标题栏）/可缩放（右下角手柄）/双击标题栏或 `⤢` 最大化，几何由纯函数 `clampRect` 夹进视口并记在 `localStorage`（设置里可关）；入口从横排标签改成**左侧一竖排**（网页 / 操作 / 控制台 / 网络 / 设置），设置项由一个纯函数 `normalizeSettings` 统一规整（越界夹取、未知入口回落「网页」）。「网页」入口把帧画成 `<img>`（`URL.createObjectURL` 换帧时 revoke）、按 `屏幕 rect → 帧宽高` 换算坐标后转发鼠标/滚轮/键盘，地址栏回车走 `goto`，取帧请求带上当前设置的 `quality`/`max`；日志入口按设置的间隔轮询 `panel.json`。P6：整套颜色改用宿主设计令牌 `var(--dsw-alias-*, 回退值)` 跟随暗/亮主题；胶囊四角由纯函数 `pillAnchor` 定位（设置里可选，与几何同存 `localStorage`）、地址补协议 `withScheme` 与服务端 `normalizeUrl` 同规则；入口换成 16×16 线描 SVG 并改成带键盘导航的 `role="tablist"`；每个日志入口有两次确认的「清理」（另按设置里的上限自动 `trim`）；取帧错误与动作错误分成 `frameErr`/`actionErr` 两条通道，宿主拒绝的原因显示在地址栏正下方。P7：设置里能选**浏览器窗口分辨率**（`POST /browser-service/viewport`，结果以 `✓ 已生效 W×H（已应用到 N 个页面）` 或红色原因回执）；胶囊可用**水平/垂直偏移**（默认 15/48）挪位，窗口**面板间距**作为 `clampRect` 的第三参（默认 10）参与夹取，**层级基准**决定内联 `z-index`（胶囊 = `zBase`、窗口 = `zBase + 1`）；日志清理与自动清理改走 `postJson()` 返回的 `{ok,status,body,error}`，成败都出成窗口顶部的提示条（404/405 明说「宿主半边是旧版，重启 DSH 后生效」），不再静默。P8：设置页第一段「窗口外观」可自定义**边框颜色**（跟随主题 / 无边框 / 六个预设色 / 取色器自定 `#rrggbb`）、**背景不透明度**（40–100%，用 `color-mix(in srgb, 主题底色 N%, transparent)` 保留主题底色只改实心度）、**玻璃效果**（关 / 毛玻璃 / 液态玻璃），由纯函数 `appearanceStyle(settings, kind)` 换算成 `--bsp-rim`/`--bsp-alpha`/`--bsp-blur`/`--bsp-sat`/`--bsp-glow`（液态玻璃另给含 `inset` 高光的 `--bsp-shadow`）注到窗口与胶囊上；外壳透明后，**内部分区也必须跟着透明**，否则只有最外圈的描边在变，所以另给 `--bsp-card`（＝外壳底色：列表吸顶条/分组标题/保存栏）与 `--bsp-surface`（＝抬升一层的底色：标题栏/左侧入口竖排/底栏/展开行/JSON 块/结果条），以及 `--bsp-divider`（自定义边框色时分隔线＝`color-mix(<色> 45%, transparent)`，跟随主题/无边框时＝宿主的 `border-l1`，`无边框` 只去掉最外圈那条）——样式表里这些 `background`/`border-*` 一律写成 `var(--bsp-*, 旧值)` 兜底，纯函数 `borderOf(raw)` 负责颜色规整（只放行预设值或 `#rrggbb`，其余回落主题色——值会进 CSS 变量，先卡一道）；设置从「即时落盘」改成**草稿 + 显式保存**（改动先按新值渲染，点吸顶栏「保存」才写 `localStorage`，写失败会出红字说明原因；几何自动保存写的是「上次保存的设置」，草稿不会被顺手落盘），`SettingsPane` 的写入口改成传补丁 `onPatch({…})`、父组件用函数式更新合并，避免同一拍连点两个按钮时后一个覆盖前一个；未保存时吸顶栏与入口/胶囊上有提示。 P9：收起后的**胶囊可以直接拖**——`pointerdown` + `setPointerCapture` + rAF 节流只改内联 `left/top`（拖动期加 `.bsp-grabbing` 关掉 hover/active 的位移与过渡），位移 ≤ 4px（`DRAG_SLOP`）算点击、真拖过置 `dragged` 标志吃掉随后的 `click`（原地单击照旧展开）；松手把 `pillPos`/`pillX`/`pillY` 三个字段并进草稿**与已保存基线**并立即写 `localStorage`（不顺手保存其他未保存的草稿），提示成败。位置新增第 5 档 **`自由`**（存储范围 0–10000，贴角档仍 0–400），纯函数 `pillAnchor(pos, offsetX, offsetY, bounds, size)` 在自由档直接给 `left`/`top` 并用 `fitAxis(value, extent, own)` **按视口夹回屏内（只夹不改存）**；新纯函数 `pillPoint(settings, size, bounds)` 把贴角档换算成屏幕坐标，**切到自由档与起拖都以它当起点**，避免位置跳。P10：`DEFAULT_SETTINGS.maxWidth` 默认 1280 → **1920**（与默认视口同长边，客户端 `max=1920&maxh=1920` 正好被服务端 `WIDTH_MAX=1920` 放行）；「开始/停帧」从组件局部 state 提为**模块级记忆 `liveStartedMemory`**（初值 `liveStartedMemory ?? (settings.autoStream !== false)`——本页没决定过才看「打开即取帧」，`useEffect` 每次变化回写），切页签/收起面板重挂 `LivePane` 后自动续帧，手动停帧后回来仍保持停。
- `src/skill-provider.mjs`（v0.8.2）：把随包技能注册成 DSH 的**内置技能提供者**（技能中心显示「系统内置」）——`stripFrontmatter()`、`parseSkillFrontmatter()`（只认单行 `key: value`，读 `description`/`whenToUse`/`disable-model-invocation`）、`readSkill(name)`、`createSkillsProvider({source, names, log})`（返回 `{name, list(), get(candidate)}`；候选带 `provider:'browser-service'`、`source:'bundled'`、`rank:600`（`BUNDLED_SKILL_RANK`）、`resourceBase:{kind:'directory', path:<技能目录>/}`、`locator:<SKILL.md>`；`get()` 返回剥掉 frontmatter 的正文）、`inspectBundledSkills()`。`skills/` 目录不在 `package.json` 的 `files` 之外另有声明——随包发货即可。
- `src/skills.mjs`（v0.8.1；v0.8.2 增 `removeSkills()`）：随包技能与技能根目录之间的**可选落盘**同步层——`listSkillFiles()`（递归、跳过点开头）、`sha256()`、`readMarker()`（坏/缺都当空台账）、`inspectSkills()`（每个文件报 `missing`/`current`/`update`/`modified`/`foreign`）、`syncSkills({source, root, version, force})`（装/升级/已最新/跳过四类 + 台账写回，冲突文件绝不覆盖）、`removeSkills({source, root})`（只删台账里属于本包且内容没被改过的文件，撤净后连台账与空目录一起清）、`defaultSkillsRoot()`（`$DSH_HOME/skills`）。CLI（`browsersvc skills [--install] [--uninstall] [--force] [--dir=…] [--json]`）与插件共用同一份实现。**为什么还要落盘这条路**：DSH 的技能发现只认磁盘目录、`package.json` 的 `dsh` 清单（`DshManifest`）没有技能位，所以「DSH 以外的工具也要读这些文件」时只能落盘；但**技能中心里的身份**（用户级 vs 系统内置）由提供者决定，两者不能并存（同名时 rank 小的先赢）。
- `src/opslog.mjs`（P3/P6）：插件与 CLI 共用的观测落盘层——`ops.jsonl`/`console.jsonl`/`network.jsonl` 环形（1/1/2 MiB，超限保尾部一半），`appendEntry` 的任何 IO 异常都吞掉并返回 `false`（**观测不能把浏览器调用搞挂**），文件 0600。P6 加 `clearEntries(kind, {root, keep})`：清空或只留尾部 keep 条（亲自动手删日志的路径，未知类型抛错）。

配置项（`Config`，全部有默认值）：`providerId='cdp-daemon'`、`cdpUrl='http://127.0.0.1:9333'`、`connectTimeoutMs`、`actionTimeoutMs`、`navigationTimeoutMs`、`lookupTimeoutMs`、`snapshotMaxElements`、`contentMaxChars`、`captureConsole`/`captureNetwork`（是否录控制台与网络，默认都开）、`maxTabs`（默认 5，夹 1..50）、`viewportWidth/Height`、`idleMs`（自启的空闲回收窗口，默认 300000）、可选 `autoStartCommand`（默认用包内 bin）、`autoStartTimeoutMs`、可选 `cdpToken`（默认自动读 `service.json`）、可选 `downloadDir`（未配置时由 `defaultDownloadDir()` 取系统 Downloads 目录：`XDG_DOWNLOAD_DIR` → 家目录下存在的 `Downloads`/`下载`/`下載` → `~/Downloads`）、`skillsDir`（默认空＝`$DSH_HOME/skills`）、`syncSkills`（默认 true）。完整表见根 README 的「配置」一节（权威定义是 `plugin/lib/index.js` 的 `Config`）。

## 2. 部署（一条命令）

```bash
dsh plugin --profile <name> add <dsh-moli-browser-<v>.tgz 或 Release 资产 URL>
# 校验（应出现本包层、browserProvider: cdp-daemon，且本包三行没有 not found）
dsh --profile <name> --dump-config | grep -E 'patched by|browserProvider|not found'
```

装完重启 DSH 即可：接缝由本包转出，`autoStartCommand` 不需要写（默认用包内 `bin/browsersvc.mjs start`），首次用浏览器时守护进程被自动拉起。

- **不要再装 `dsh-builtin-browser` 组合包**：本包已经把它作为依赖装进 profile 并自己插接缝行；两者同时激活会出现两条 `tool-browser` 行（工具重名）。
- 改源码的临时接线（symlink 工作树 + 手写 patch）见 `docs/profile-patch.browser-service.yml`。
- 本机现状：活 profile（`$DSH_HOME/profiles/web`）自 2026-09-27 起已走 bundle 路线（`dsh plugin --profile web add dsh-moli-browser@latest`），手写 patch 块与 `node_modules/dsh-browser-moli` 软链都已删除，备份留在 profile 目录的 `*.bak-pre-bundle`。

patch 做四件事：insert 接缝 `browser`（选 `cdp-daemon`）、insert `tool-browser`、insert 本 provider、关掉内置 `browser-electron`。

> **`dsh-playwright-browser` 必须关**：它自带 10 个与内置同名的 `browser_*` 工具，两个 provider 的工具面不能共存（本包 patch 里已带该 disable 行，环境里没这个 id 时只会打印 not found 提示）。

## 3. 验收

### 3.1 provider 层（125 项，零依赖、不碰外网）

```bash
node scripts/verify-provider.mjs      # 结果：125 通过，0 失败
```

自己起本地 http 站点 + 真实 `browsersvc run`（临时 root/端口），逐项覆盖：`available`、session/tab 生命周期、`navigate` 拒非 http(s)、`execute`（表达式/参数/页面异常/超时）、`snapshot`/`a11y`/`content`（4 种格式）/`scrape`（含 `@attr`）、`waitFor` 三态、`click`/`type`/`setValue`/`check`/`getValue`/`clearField`/`selectOption`/`scroll`/`key`、`fillForm`、`screenshot`（含等比缩小/fullPage-jpeg）、`download`、`back/forward/reload`、`history`/`replay`、`detectChallenge`、`flushAuth`/`restoreAuth`、session 隔离、`reset`/`close`、保存路径准入（F1）与默认保存目录（D1）、掉线后会话复活（F22）、默认自启命令。

守护进程/CLI 层：`node scripts/verify-daemon.mjs`（35 项）；组合包安装路径：`node scripts/verify-bundle.mjs`（75 项）；观测面与实时窗口：`node scripts/verify-data.mjs`（86 项）；DSH 版本矩阵：`node scripts/verify-matrix.mjs --dsh <bin> … --smoke`（4 个宿主版本 × 12 项）。

### 3.2 DSH 内端到端（seam → provider → 守护进程 → CDP）

`tools/seam-probe/` 是**诊断用**插件（不是交付特性）：`inject=['browser']`，在 apply 里跑一遍 `open → openUrl → snapshot → content → execute → a11y → listTabs → close` 并写 `/tmp/m2-seam-probe.log`。

做法：一次性的隔离 home + 真实 web 模板 profile（`dsh --profile e2ew --from-default-profile web` 创建，之后 `dsh --profile e2ew --no-open --port 3099` 启动），`dsh plugin --profile e2ew add dist/dsh-moli-browser-<v>.tgz`，再把 `tools/seam-probe` symlink 成 profile 里的 `dsh-m2-seam-probe` 并在 profile 的 `cordis.patch.yml` 里 insert 它、给 `browser-moli` 配一个独立端口（避开活实例的 9333）。实测日志：

```
apply entered
open -> "s1"
snapshot -> url=http://127.0.0.1:9413/ title="M2 夹具" elements=0 first=undefined
content -> "接缝端到端\n\nhi"
execute -> {"ok":true,"value":"接缝端到端"}
a11y -> count=1 nodes=1
listTabs -> [{"id":"t1","url":"http://127.0.0.1:9413/","title":"M2 夹具","active":true}]
closed -> DONE
```

这次实测暴露并修掉了 **F26**：`--internal-port-base`（CLI）被 `src/config.mjs` 静默忽略（只看 config.json），表现为守护进程仍用默认 9300 起（实测 internalPort 9301，因为 9300 被活实例占着）。修复后 CLI 值优先、其次 config.json、最后默认值。

## 4. 已知坑

1. **运行中的完整 web profile 上，patch 热重载会静默回滚**。实测：往 patch 里加一个探针条目，chokidar 触发刷新、探针 `applied` 后 6–7 ms 被 `disposed`，而我们插件的 `apply` 根本没被调用；进程 stdout 归 docker，拿不到报错。同一个 patch 在**干净进程**里 boot 完全正常（`--dump-config` exit 0，隔离实例端到端通过）。⇒ **改完 patch 请重启 DSH**，不要指望 `patchReload: live`。最小 profile 里热重载是生效的（改 `connectTimeoutMs` 后 `apply` 重新执行），所以这是完整 profile 的某个兄弟插件导致的，未定位。
2. **工具重名**：`dsh-playwright-browser` 与内置 `tool-browser` 的 `browser_*` 工具同名，必须二选一（本包 patch 关掉前者）。
3. **不要与 `dsh-builtin-browser` 组合包同时装**（见 §2）。
4. **接缝包的 peer 不在 profile 自己的 `node_modules` 里**：`@deepseek-ai/cordis` 等由 DSH 在 boot 时挂到 `$DSH_HOME/profiles/node_modules/@deepseek-ai/*`（活 home 实测 240 项），profile 内任何包向上查找都能命中。所以「只 `dsh plugin add` 而没有 boot 过」的静止隔离 home 里 import `dsh-builtin-browser/browser` 会报 `Cannot find package '@deepseek-ai/cordis'` —— 不是设计问题。
5. **守护进程的 root 按 `DSH_HOME` 派生**（默认 `$DSH_HOME/browser-service`）。`browsersvc stop/status` 要用同一个 `DSH_HOME`，否则会报 `not running` 而进程还在。
6. 公开端口（默认 9333）**要求 `Authorization: Bearer <token>`**；token 由守护进程生成、写在 0600 的 `service.json` 里，插件自动读取（每次 attach 重读），不要手工在 patch 里配 token。
7. 本方案依赖守护进程的包装脚本与用户态库/字体，卸载包装脚本会退化成白屏/方块。

## 5. 回滚

早期（Playwright provider）方案的 profile patch 备份在 `/home/node/DSH/.browser/cordis.patch.yml.a1-backup`；把 `$DSH_HOME/profiles/web/cordis.patch.yml` 还原成它、`dsh plugin --profile web remove dsh-moli-browser`、重启 DSH 即可回到 Playwright provider。
