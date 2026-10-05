# 验收与测试

四条脚本**零依赖**（只用 Node 内置的 `fetch` / `WebSocket` / `http` 与真实 `browsersvc` + 本地站点；`verify-matrix.mjs` 的 `--smoke` 需要能解析外网的 `example.com`）：

```bash
node scripts/verify-daemon.mjs      # M1 守护进程 + CLI 防御：38/38（含新增题⑤⑥）
node scripts/verify-provider.mjs    # M2 provider + P7 分辨率 + 随包技能提供者：130 通过，0 失败（含新增题①②③）
node scripts/verify-bundle.mjs      # 组合包安装（官方 dsh plugin 流程）：75/75
node scripts/verify-data.mjs        # P3 观测面 + P4/P5 实时窗口 + P6 清理跳转 + P7 分辨率/偏移：88 通过，0 失败（含新增题④）
node scripts/verify-matrix.mjs --dsh <bin> --dsh <bin> --smoke   # DSH 版本矩阵：4 个宿主版本 × 12 项
```

> ⚠️ **不要在默认 root 上跑**：脚本会按 pid 收敛自己起的实例并清理临时 root（`rmSync`）。它们默认使用 `/tmp` 下的一次性 `DSH_BROWSER_SVC_ROOT`，请保持默认，不要指向 `$DSH_HOME/browser-service`。

## 各套覆盖什么

**`verify-bundle.mjs`（75 项）** —— 在一次性隔离 `DSH_HOME`（`/tmp`）里真实执行官方安装/移除命令：交付物里只有一个包 → `add <tgz>` 追加依赖与层 → `--dump-config` 里本包层挂出 `browser`（`browserProvider: cdp-daemon`）、`tool-browser` 与 `browser-moli`，且**三行都没有 not found** → 默认自启命令指向装进来的 `bin/browsersvc.mjs` → `./browser` / `./tool-browser` 转出口的导出键与 `dsh-builtin-browser` 源模块**完全一致** → 补出宿主 peer 目录（`scripts/lib/host-peers.mjs`，隔离 home 不会自动生成）后，包入口可 `import`、启动期探测（`plugin/lib/compat.js`）对真实接缝给出 0 error、四种坏形状各报对人、错误文案命中宿主与接缝版本，并静态数出接缝工具面 33 个且含 `browser_a11y` → **P3 客户端半边（5c，29 项）**：tarball 带 `plugin/client.js`、`exports["./client"]` 与 `dsh.client.platform==='web'`、入口走 `window.__ModuleLoader__.load` 且 `id` = 包名、factory 返回标准 cordis 插件（`apply` + `inject: ['slots']`）、`apply` 把看板注册到 `shell.overlay`、组件可渲染、裸 `require` 全在 9 个平台种子里、**P4：客户端引用的三条实时路由与服务端一字不差**、**P5：客户端导出的 `clampInt`/`clampRect`/`normalizeSettings`——几何三态夹取（越界收缩、过小抬到最小、`null` 锚定摆正中）与设置规整（越界夹取、未知入口回落 `live`）**、**P6：新导出的 `pillAnchor`（胶囊四角定位）与 `withScheme`（地址补协议）也真跑一遍，并断言新增设置键 `pillPos`/`autoClean` 的默认与越界回落**、**P7：两条写路由引用（`logs` + `viewport`）与服务端一字不差、`clampRect` 第三参「面板间距」夹取、新设置键（`viewport`/`pillX`/`pillY`/`panelGap`/`zBase`）的默认值与脏输入规整、胶囊自定偏移（`pillAnchor('rt',30,60)`）**、**P8：`appearanceStyle` 的 CSS 变量（自定义色 + 60% + 液态玻璃给 `--bsp-rim`/`--bsp-alpha`/`--bsp-blur`/`--bsp-sat`/`--bsp-glow` 与 `inset` 高光，内部分区的 `--bsp-card`/`--bsp-surface` 同样按 60% 混出、`--bsp-divider` 同色调 45%；无边框 + 100% + 关给透明边/无模糊/无高光、分隔线回落宿主细线）与 `borderOf` 的颜色规整（`javascript:…` 注入串回落 `theme`、`#AABBCC` 归一为 `#aabbcc`、`cardAlpha:0` 夹到 20、`glass:123` 回落 `frost`）**、**G（0.8.2）：`clampRect` 的第四参「顶部留白」——窗口既不许压到宿主顶栏、最大高度也要收在「视口 − 留白」以内，没记过位置时摆正中（`{x:200,y:150}`）；`topInsetFromBoxes` 在「贴顶 + 宽 ≥ 视口 60% + 高 24–200」的条里取最高的、`resolveTopInset('auto')` 量不到按 48、手填 9999 夹到 200；`ratioOf` 真实帧优先、没帧按分辨率、给不出回 `null`；新增设置 `fitPicture`/`topInset` 的默认与越界回落****P9（0.8.3）：胶囊「自由」档与拖动接线——`pillAnchor('free',900,500)` 直接给 `left/top`、越界按自身尺寸夹回（视口 `{w:1200,h:800}` + 胶囊 `{w:150,h:31}` ⇒ 1050/769）、自由档存储范围放宽到 0–10000（贴角档仍夹 0–400）；`pillPoint` 四组坐标（自由 900/500、越界 1050/769、左上 15/48、右下 1035/721）；`dragWiring` 源码扫描七项（指针事件 `onPointerDown:startPillDrag`、`setPointerCapture`、`releasePointerCapture`、自由档 + `PILL_COORD_RANGE`、拖动阈值 `DRAG_SLOP`、抓手样式 `bsp-grabbing`、`touch-action:none`）、**P10（0.8.3）：「最大边」默认 1920（`normalizeSettings({})` 真跑）与取帧开关跨页签记忆——组件外 `liveStartedMemory`、初值 `??` 看「打开即取帧」、每次变化回写**（`scripts/lib/client-probe.mjs` 只读探针） → **第 6 段「随包技能」（v0.8.1 起，v0.8.2 扩到 11 项）**：把装好的 `bin/browsersvc.mjs` 对着临时技能目录跑一遍——空目录时报 7 个「缺失」、`--install` 装进 7 个文件（含 `browser-runtime/scripts/`）、台账写下包版本与 7 条哈希、重复 `--install` 幂等（7 个已最新且不重写盘）、手工改过的那份**跳过 1 且内容保住**、`--force` 才覆盖回随包版本、`skills --json` 的状态与哈希可被脚本消费、`plugin/lib/index.js` 里确实有 `registerProvider` 与 `registerSkills`/`syncSkills` 两个默认值、`--uninstall` **保留用户改过的 1 个、撤掉其余 6 个**（台账留在原地）、再撤一次连台账与空目录一起清掉（技能回到只由内置提供者提供）；交付物形状那一段同时断言 tarball 里带 `skills/browser/SKILL.md`、`skills/browser-runtime/SKILL.md`、`scripts/` 资产与 `src/skill-provider.mjs`（+2 项） → `remove` 同时清掉依赖与层。不碰默认 profile。

**`verify-data.mjs`（86 项）** —— 自己起本地站点 + 真实 `browsersvc run`（临时 root/端口）与真 provider，覆盖 P3 的五个观测面与面板路由：操作日志（`navigate`/`execute` 入账、`ms`/`ok`/会话/标签齐、**通用追踪覆盖 `snapshot`/`content`/`screenshot`/`listTabs`**、失败记 `ok:false` 与错误原因、`open` 不入账、人话表格有汇总行、`--lines` 生效）；控制台（`log`/`error` 两类）；网络（`request`/`response` 两阶段、状态码与耗时、抓到 `/api`、**不记头与体**）；HAR（关闭会话后落盘、报路径与字节、HAR JSON 含本次请求、`--out` 复制、拒绝覆盖、`--session` 挑文件）；cookie/localStorage（导出字段与 0600 权限、`--url` 命中/不命中、注入、新会话隔离）；面板（`panel.json` 三份数据、`?lines=1`、条目是真操作、载荷不含绝对路径、`POST` → 405、卸载后路由消失）；容错（落盘 IO 失败不抛）；**P4/P5 实时窗口**（取帧返回真 JPEG 与 `x-frame-seq/w/h`、无新帧 204、`?quality=&max=&maxh=` 透传并回 `x-frame-quality`/`x-frame-max`、越界夹到安全范围、`live.json.options` 与推流状态、`panel.json.service` 只读服务块的版本/会话/上限/录制开关、下载目录只回目录名且整份载荷不含本机绝对路径、打字/点击/goto 转发进真浏览器、未知动作 400、非回环 403、跨站 403、方法 405、`DELETE` 停流、无 provider 503、dispose 一起摘掉路由）；**P6 日志清理与无会话跳转（11 项）**：`POST /browser-service/logs` 的 `clear` 一次清空三类、`trim` 只留最近 N 条、未知类型 400、非 POST 405、跨站 403、非回环 403、dispose 摘掉；没有任何会话时 `live.json` 仍回 200 并给可操作提示、地址栏 `goto` 会自动开一个会话再导航并补 `https`、空网址 400（不拿空串去导航）、没有画面时非跳转动作 409；**P7 分辨率写路由（9 项）**：`panel.json.service.viewport` 回读、`POST /browser-service/viewport` 200 + `applied` + 真页面视口真的变成新尺寸、非法值 400、非 POST 405、跨站 403、非回环 403、无 provider 503、dispose 一起摘掉，以及「缺 `maxh` 时高度沿用当前值、不塌到下限 240」这条画面糊的回归断言（同脚本内另外三处路由数断言同步从 5 条改 6 条）。

**P4 实时窗口（同脚本内 16 项）** —— 用假 provider + 桩 view（不真开浏览器）逐条打**四条 `exact` 路由**与**三道闸**：一次 `registerPanel` 挂上四条路由；`live.json` 报会话与页面状态；`live.jpg` 回 JPEG 且带 `x-frame-seq`/`x-frame-w`/`x-frame-h`，没有新帧回 204；推流后状态变 `live:true`；打字、点击坐标、`goto`（走 `provider.openUrl`）都被转发；未知动作 400；`POST` 跨站 403；非本机来源（`remoteAddress: 10.0.0.9`）403；取帧路由 `POST` 405；`DELETE` 停流；没有 provider 503；`dispose` 后四条路由一起摘掉。

**P6 日志清理与无会话跳转（同脚本内 11 项）** —— 仍然用假 provider 打真路由：一次 `registerPanel` 挂上**五条**路由（多了 `POST /browser-service/logs`）；无会话时 `live.json` 回 200 且 reason 是可操作提示；此时地址栏发 `goto` 会先 `provider.open('面板地址栏')` 再 `openUrl()`（断言两个调用与回包 `opened:true`）；空网址 400、非跳转动作 409；清理侧先写 6 条 `network` 再 `trim keep:2`（只留最近 2 条）、`clear` 一次清空三类、未知类型 400、`GET` 405、跨站 403、非回环 403、`dispose` 后一起摘掉。**没覆盖到的**：客户端窗口里的「清理」两次确认、胶囊四角、错误条渲染这些 DOM 行为——它们在开发用的预览工装里人工跑过（见 `CHANGELOG.md` 的 P6 段），不进自动化。

**P7 分辨率写路由（同脚本内 9 项）** —— 同样用假 provider 打真路由：一次 `registerPanel` 现在挂**六条**路由（多了 `POST /browser-service/viewport`）；`panel.json.service.viewport` 回读当前分辨率；`POST` 合法宽高 → 200、回包 `viewport` 与 `applied`、且**真页面**（本地站点，moli 内核真渲染）的视口真的变成新尺寸；`{width:'x'}` → 400（不拿非法值去改页面）；`GET` 405；跨站 403；非回环 403；无 provider 503；`dispose` 后六条一起摘掉；再补一条**画面糊的回归断言**：`live.jpg?quality=85&max=1280`（**不带 `maxh`**）时高度上限必须沿用当前值 600，而不是被 `Number(null) === 0` 塌到下限 240（这一条正是「分辨率调大了画面还是糊」的根因）。**没覆盖到的**：设置页的「分辨率」分段与结果小字、胶囊自定义偏移后的落位、清理成功/失败的顶部提示条——这些 DOM 行为同样只在预览工装里人工跑过（见 `CHANGELOG.md` 的 P7 段）。

**P8 窗口外观与设置保存（只在客户端半边）** —— 这一批没有新增路由，全部落在 `plugin/client.js`：`verify-bundle.mjs` 的客户端探针把两个新纯函数真跑一遍（5c 段 17 → **19** 项）——`appearanceStyle(settings, kind)` 产出的 CSS 变量（自定义色 + 60% + 液态玻璃 ⇒ `--bsp-rim` 为自定义色、`--bsp-alpha` 60%、`--bsp-blur` 18px、`--bsp-sat` 165%、`--bsp-glow` 1 且阴影含 `inset` 高光，内部分区的 `--bsp-card`/`--bsp-surface` 也按 60% 混出、`--bsp-divider`＝`color-mix(<色> 45%, transparent)`；无边框 + 100% + 关 ⇒ 透明边框、`blur(0px)`、无高光，分隔线回落宿主 `border-l1`）与 `borderOf` 的颜色规整（`'javascript:alert(1)'` 回落 `theme`、`'#AABBCC'` 归一成 `'#aabbcc'`、`cardAlpha:0` 夹到 20、`glass:123` 回落 `frost`）。**没覆盖到的**：设置页的「窗口外观」三个控件、吸顶保存栏的三态文案（未保存琥珀 / 保存成功绿字 / 写本地存储失败红字）、草稿不落盘、取色器自定色即时生效、胶囊跟随外观——这些 DOM 行为在预览工装里用真浏览器逐项跑过（见 `CHANGELOG.md` 的 P8 段）

**P9 胶囊可拖动与「自由位置」（只在客户端半边）** —— 同样没有新增路由，全部落在 `plugin/client.js`：`verify-bundle.mjs` 的客户端探针新增三条（5c 段 24 → **27**，总计 70 → **73**）——

- `pillAnchor('free', 900, 500)` ⇒ `{left:'900px', top:'500px', right:'auto', bottom:'auto'}`；同档越界 `pillAnchor('free', 9000, 9000, {w:1200,h:800}, {w:150,h:31})` ⇒ `1050px`/`769px`（＝视口 − 自身尺寸）；`normalizeSettings({pillPos:'free', pillX:9999, pillY:9999}).pillX === 9999`（自由档存储 0–10000，贴角档仍夹 0–400，所以原来那条 `pillY === 400` 的断言不变）。
- `pillPoint` 四组：自由 900/500、越界 1050/769、左上 15/48、右下 1035/721（切档与起拖的起点都用它）。
- `dragWiring` 七项源码扫描：`onPointerDown: startPillDrag`、`setPointerCapture`、`releasePointerCapture`、`'free'` + `PILL_COORD_RANGE`、`DRAG_SLOP`、`bsp-grabbing`、`touch-action:none`。

**没覆盖到的**：真实拖动的手感与几何（拖到哪儿、松手后写什么、原地单击会不会误触发拖动、视口变小时怎么夹）在真机 GUI（`127.0.0.1:3082`）里用 CDP 驱动跑过一遍：胶囊初始 `{15,48,149×31}` → 拖到屏幕 (900,620) 松手后 `{826,604}`、`localStorage` 里 `pillPos:'free', pillX:826, pillY:605`、刷新后仍在 `{826,605}`、原地单击能展开面板（卡片数 1，位置不变）、视口缩到 700×500 渲染成 `{551,469}` 而存值不变、`pageerror` 为空；这一条同样不是自动化（临时脚本用完即删），见 `CHANGELOG.md` 的 P9 段，不进自动化。

**P10 取帧切回自动续帧与「最大边」默认 1920（只在客户端半边）** —— 同样没有新增路由，全部落在 `plugin/client.js`：`verify-bundle.mjs` 的客户端探针新增两条（5c 段 27 → **29**，总计 73 → **75**）——

- 「最大边」默认真跑：`normalizeSettings({}).maxWidth === 1920`（0.8.3 起与默认视口同长边，0.8.2 及以前是 1280）。
- `resumeWiring` 三处源码扫描：组件外 `let liveStartedMemory` 记忆、初值 `liveStartedMemory ?? (settings.autoStream !== false)`（本页没决定过才看「打开即取帧」）、每次变化回写 `liveStartedMemory = started`。

**没覆盖到的**：真机 GUI（`127.0.0.1:3082`）里用 CDP 驱动跑过：默认「开始」+「未开始取帧」遮罩 → 点「开始」后请求带 `max=1920&maxh=1920` → 网页 → 网络 → 网页 切页签自动续上（按钮变「停帧」、遮罩消失、请求继续）→ 手动「停帧」后切走再切回仍是停的 → 收起成胶囊再展开同样自动续上 → 设置页标签显示「最大边 1920」→ 页面 `error` / `unhandledrejection` 为空；这一条同样不是自动化，见 `CHANGELOG.md` 的 P10 段，不进自动化。

**`verify-matrix.mjs`（4 个宿主版本 × 12 项）** —— 把**同一个 tarball** 分别装进 `--dsh <bin>` 指定的多个 DSH（本机全局 + `npm install --prefix` 装的备版本），每行验 12 项：`add` 退出码 0、依赖指向该 tarball、`dsh.profile.bundles` 追加本包、`--dump-config` 退出码 0、本包层存在且 `browser` 行选中 `cdp-daemon`、`tool-browser` 行存在、没有预期外的 `not found`（只允许 `browser-electron` / `playwright-browser`）、补出宿主 peer、入口可加载并注册出 `cdp-daemon`、启动期探测无 error、探测到的宿主版本与该行一致、`--smoke` 时真开 `example.com` 读回正文。**逐版本串行**（每行一个无头内核，约 600 MB）。

**`verify-provider.mjs`（125 项）** —— 自己起本地站点 + 真实 `browsersvc run`（临时 root/端口），逐项覆盖 session/tab 生命周期、`navigate` 拒非 http(s)、`execute`（表达式/参数/页面异常/超时）、`snapshot`/`a11y`/`content`（4 种格式）/`scrape`（含 `@attr`）、`waitFor` 三态、`click`/`type`/`setValue`/`check`/`getValue`/`clearField`/`selectOption`/`scroll`/`key`、`fillForm`、`screenshot`（含等比缩小/fullPage-jpeg）、`download`、`back`/`forward`/`reload`、`history`/`replay`、`detectChallenge`、`flushAuth`/`restoreAuth`、session 隔离、`reset`/`close`、连接被换掉后会话复活（F22）、自启开关复位（F25）、保存路径准入、默认保存目录（D1：`XDG_DOWNLOAD_DIR` → 本地化 `Downloads` → `~/Downloads` 回落、目录首次写入时建出来、未配置时默认目录之外一律拒绝）、代理对截断、**P1：`maxTabs` 上限与拒绝后不留半开页、无会话时释放连接（守护进程按 `idleMs` 回收 + 自愈）、配置默认值（`maxTabs` 5 / `idleMs` 300000 / `viewportWidth`/`viewportHeight` 默认 1920×1080，0.8.2 起）**，**P7：窗口分辨率 `setViewport`**（配置初值 900×600、新页面按配置打开、`setViewport({1280,720})` 后 `applied===1` 且页面 `window.innerWidth`/`innerHeight` 真的变成 1280/720、之后的会话沿用 1280、越界夹到 640×360、`{width:'x'}` 抛 `BROWSER_VIEWPORT_INVALID`）。**随包技能提供者（v0.8.2，8 项）**：`createSkillsProvider()` 的 `list()`/`get()` 形状（两份候选、`source:'bundled'`、`rank` 600、`provider` 名一致、`resourceBase` 目录真实存在、候选形状满足 `dsh-skill` 校验、`get()` 返回已剥 frontmatter 的正文）、`browser-runtime` 保持模型不自动调用、读不到的技能不进候选（只记日志不抛），以及 `Config` 的 `registerSkills` 默认 `true` / `syncSkills` 默认 `false`。

**`verify-daemon.mjs`（35 项）** —— 只用 Node 内置能力，自己起本地源。凭据门一段额外覆盖「同一条连接上的后续请求不免检」（F27），F20 改在真实 CDP WebSocket 上验证。完整输出：

```
PASS  守护进程启动  — 公开端口 34535 → 内部端口 9300
PASS  状态文件含 token 且不对外开放  — mode=600
PASS  无 token 访问公开端口被拒 (401)  — status=401
PASS  白名单外的路径被拒 (403)  — status=403
PASS  CDP /json/version  — Browser=HeadlessChrome/154.0.8037.57
PASS  元数据 ws 地址被改写为走代理并带 token  — ws://127.0.0.1:34535/devtools/browser/eac5b966-e72e-4afa-9b7e-f543aa5332f2?token=04f61976-84af-470a-9f75-2c55556b07c1
PASS  首个请求正常 200（同一条连接复用前的基线）  — first="HTTP/1.1 200 OK"
PASS  同一连接上的第二个请求（无凭据 PUT /json/new）拿不到 200（F27）  — 未收到第二个响应
PASS  代理在响应后主动收掉非升级连接（不悬挂、不占连接计数）  — closed=true
PASS  CDP WebSocket 空闲 11s 后仍可用（F20，真正长连接路径）  — HeadlessChrome/154.0.8037.57
PASS  公开端口只绑 127.0.0.1  — 监听=0100007F(tcp)
PASS  内部端口只绑 127.0.0.1  — 监听=0100007F(tcp)
PASS  两个隔离上下文（不同 browserContextId）  — 6509AA01 vs 9200BE45
PASS  上下文 A 能写 cookie  — A="iso=ctx1"
PASS  上下文 B 看不到 A 的 cookie（隔离生效）  — B=""
PASS  页面真实渲染  — title="iso"
PASS  浏览器被杀后自动重启  — browserPid 3812 → 3884
PASS  重启后代理仍可用（自动改指向）  — 内部端口 9300
PASS  空闲后自动退出  — exitCode=0
PASS  退出后清理状态文件
PASS  退出后端口释放
PASS  越界 --port 被配置校验拒绝 (exit 2)  — code=2 out={
  "error": "无效的 port：99999（允许 0..65535）",
  "usage": "browsersvc start|stop|status|restart|run|logs|detect [--port=933
PASS  --internal-port-base 覆盖默认 9300  — internalPort=19700 期望=19700
PASS  --lines=0 被拒 (exit 2)  — code=2
PASS  内核不存在时启动失败且不留状态文件  — code=2 out={
  "error": "浏览器内核不存在：/nonexistent/chrome",
  "usage": "browsersvc start|stop|status|restart|run|logs|detect [--port=9333] [--idle-ms=90000
PASS  内核不可执行时启动失败且不留状态文件  — code=2 out={
  "error": "浏览器内核不可执行：/tmp/browsersvc-verify-stuck-mnDyHl/fake-kernel.mjs",
  "usage": "browsersvc start|stop|status|restart|run|logs|dete
PASS  内核未就绪时启动失败（不静默成功）  — code=2 out={
  "error": "浏览器在 1500ms 内未就绪（见 /tmp/browsersvc-verify-stuck-mnDyHl/service.log）",
  "usage": "browsersvc start|stop|status|restart|run|log
PASS  启动失败后不留孤儿内核  — kernelPid=4055 alive=false
PASS  启动失败后不留状态文件
PASS  stop 身份校验：拒绝杀不匹配的进程  — code=1 alive=true
PASS  stop --force 可强制清理  — code=0
PASS  restart 前置：隔离实例可启动  — code=0 {
  "started": true,
  "pid": 4091,
  "browserPid": 4098,
  "port": 32985,
  "browserVersion": "HeadlessChrome/154.0.803
PASS  restart 真的停旧起新（F23）  — code=0 {
  "restarted": true,
  "stopped": true,
  "started": true,
  "pid": 4160,
  "browserPid": 4167,
  "port": 44693,
  "browserVersion": "HeadlessChrome/154.0.803
PASS  restart 后 token 换新  — f73cc755 → a14e7475
PASS  restart 后的实例可正常 stop  — code=0

35/35 通过
```

## 真实 DSH 内端到端（手动，不属于自动验收）

在隔离 `DSH_HOME` 里建一个 web 模板 profile → `dsh plugin add` 本包 → 重启该实例，`tools/seam-probe` 会通过 `ctx.browser` 跑完 open → openUrl → snapshot → content → execute → a11y → listTabs → close，日志落在 `/tmp/m2-seam-probe.log`：

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

## npm 短命令实测

`dsh plugin --profile <n> add dsh-moli-browser@latest` 同样在一次性隔离 `DSH_HOME` 里实测通过：pnpm 直连 registry 安装最新版，`dsh.profile.bundles` 追加本包，`--dump-config` 出现 `# == dsh-moli-browser` 层与 `browserProvider: cdp-daemon`。

## 未被自动化覆盖的部分

- `/proc` 身份校验类断言只在 Linux 上有意义（本项目的目标平台就是 Linux 容器）。
- `EADDRINUSE` 分支需要一个真实的端口占位者；代理半关闭时序、tgz 内文件模式（依赖 npm/pnpm 版本）、孤儿进程断言（依赖 `pgrep`/`ps` 行为）都没有进自动验收集。
- macOS / Windows 完全未测试。
