# 更新记录

本文件记录每个版本的变更与**真实缺陷编号**（F = 代码审查/上线验证发现的缺陷，P = 专项（P1 资源/性能 0.5.0、P2 DSH 版本适配 0.5.1、P3 可观测性与交互 0.6.0、P4 实时交互网页窗口 0.7.0、P5 窗口与入口重做 0.8.0、P6 界面美化与体验修补 0.8.1、P7 分辨率与胶囊坐标可调、清理可见化、画面清晰度修复 0.8.1、P8 窗口外观可自定义与设置显式保存 0.8.1、P9 胶囊可拖动与「自由位置」 0.8.3、P10 取帧切回自动续帧与「最大边」默认 1920 0.8.3、S 随包全局技能 0.8.1、S2 技能改「系统内置」提供者 0.8.2、G 窗口几何：去黑边/让开顶栏/默认居中/按真实高度居中 0.8.2），B = 按官方打包文档核对发现的问题，U = v0.4.0 合并交付物的改动，D = 数据/行为对齐，P1 见 v0.5.0，F26 见 v0.4.0）。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

验收计数随版本推进：`verify-daemon` 13 → 26 → 31 → 32 → **35**，`verify-provider` 67 → 77 → 83 → 86 → 88 → 95 → 110 → 116 → 117 → **125**，`verify-bundle` 16 → 23 → 33 → 40 → 41 → 44 → 46 → 50 → 52 → 61 → 65 → 70 → **75**，`verify-data` 45 → 61 → 66 → 77 → 85 → **86**，`verify-matrix` 4 个宿主版本 × 12 项。

## [0.8.3] — 2026-10-04

**主题：收起后的胶囊可以直接拖着放到任意位置。** 只动**客户端半边**（`plugin/client.js`）：不改路由、不加工具，宿主半边与 33 个 `browser_*` 工具面照旧。

**起因**：「药丸能不能改成可拖动，先分析给出处理方案」——先出方案，用户拍板**方案 B（新增「自由位置」档，不吸附）＋ 松手立即落盘 ＋ 只限制在视口内、不避让宿主顶栏**。

**同批追加（用户三条指令）**：「1，优化，当窗口打开时并取帧后切换其他入口再切回网页不用重新点击开始，实时画面最大边默认提到1920 / 2，提交推送发布打包 / 3，@维护者催一次」——前两条是 P10-1、P10-2；后两条是发布动作（推送 + 打包发 npm/GitHub Release + 在 PR #6006 里评论催一次）。

| # | 项 | 处理 |
| --- | --- | --- |
| P9-1 | 位置只有「四个角 + 水平/垂直偏移」，屏幕中间够不着 | 「胶囊位置」新增第 5 档 **「自由」**：位置按屏幕坐标存（`pillX`/`pillY`，自由档存储范围 0–10000；贴角档仍是 0–400），自由档下两行改名「**水平坐标/垂直坐标**」，输入上限跟着当前视口 |
| P9-2 | 想挪位置只能进设置里改数字 | 胶囊可直接拖：`pointerdown` + `setPointerCapture` + `requestAnimationFrame` 节流，拖动期间只改内联 `left/top`（并加 `.bsp-grabbing` 关掉 hover/active 的位移与过渡，避免跟手较劲），松手落成「自由」坐标 |
| P9-3 | 拖动与点击（展开面板）互相打架 | 位移 ≤ **4px**（`DRAG_SLOP`）算点击；真拖过就置 `dragged` 标志吃掉随后的 `click`。真机实测：拖到 (900,620) 后卡片数 `0`（没误弹），原地单击仍能展开 |
| P9-4 | 拖完刷新又回原处 | 松手**立即写盘**：只把 `pillPos`/`pillX`/`pillY` 三个字段合并进草稿与已保存基线，**不顺手保存其他未保存的草稿**（`dirty` 状态不受影响），并提示「✓ 胶囊位置已记住（自由位置 x / y）」；写不进去（无痕模式/站点策略）时红字说明「刷新后会回到原处」 |
| P9-5 | 屏幕变小后胶囊可能跑到屏幕外 | 渲染时按当前视口夹回屏内（新纯函数 `fitAxis`），且**只夹不改存**：视口缩到 700×500 时渲染成 `{551,469}`，`localStorage` 里仍是 826/605，视口放回去它自己就回到原处 |
| P9-6 | 从「角」切到「自由」会跳位置 | 新增纯函数 `pillPoint(settings, size, bounds)`：贴角档按「角 + 偏移 + 自己尺寸」换算出屏幕坐标；**切到「自由」档和起拖都用它当起点**，所以切档/起拖都不跳 |
| P10-1 | 取过帧后切到别的入口（操作/控制台/网络/设置）再切回「网页」，画面停了、还得再点一次「开始」 | 「开始/停帧」状态从组件局部 state 提为**模块级记忆** `liveStartedMemory`：初值 `liveStartedMemory ?? (settings.autoStream !== false)`（本页没决定过才看「打开即取帧」），每次变化回写；切页签/收起面板重挂 `LivePane` 后自动续帧，手动「停帧」后回来仍是停的 |
| P10-2 | 「最大边」默认 1280，1920×1080 的画面先缩到 1280×720 再放大，看着糊 | `DEFAULT_SETTINGS.maxWidth` 默认 1280 → **1920**（与默认视口同长边；客户端发 `max=1920&maxh=1920`，服务端夹取边界 `WIDTH_MAX=1920` 正好放行，不被夹） |

- 验收：`scripts/verify-bundle.mjs` 70 → **75**（P9 三条：自由档 `left/top` + 越界按自身尺寸夹回；`pillPoint` 四组坐标；拖动接线七项——指针事件/指针捕获/释放捕获/自由档与存储范围/拖动阈值/拖动期抓手样式/禁触摸滚动；P10 两条：「最大边」默认 1920 真跑、取帧开关跨页签记忆的接线三处——组件外 `liveStartedMemory` + 初值 `??` 看「打开即取帧」+ 变化回写）；`scripts/lib/client-probe.mjs` 同步新增 `pill.free`/`pill.freeFit`/`pillPoint`/`pillFreeClamp`/`dragWiring`/`defaultMaxWidth`/`resumeWiring`；`verify-provider` 125 / `verify-daemon` 35 / `verify-data` 86 不变。
- 真机 GUI E2E（127.0.0.1:3082，暗色）：胶囊初始 `{15,48,149×31}` → 拖到屏幕 (900,620) 松手后 `{826,604}`（抓取偏移对齐）→ `localStorage` = `pillPos:'free', pillX:826, pillY:605`（`window` 记录仍在）→ 刷新后仍是 `{826,605}` → 原地单击能展开面板且位置不变 → 视口缩到 700×500 渲染 `{551,469}` 而存值不变 → `pageerror` 为空。
- 真机 GUI E2E（P10，127.0.0.1:3082）：打开面板默认「开始」+「未开始取帧」遮罩（「打开即取帧」仍默认关）→ 点「开始」后请求变成 `live.jpg?since=0&quality=70&max=1920&maxh=1920`（新默认 1920 真的随请求下发）→ 网页 → 网络 → 网页 切页签、全程没再点「开始」，画面自动续上（按钮变「停帧」、遮罩消失、请求继续）→ 手动「停帧」后切走再切回仍是停的（按钮「开始」+ 遮罩，记忆不倒贴）→ 收起成胶囊再展开同样自动续上 → 设置页标签显示「取帧 质量 70 · 最大边 1920」→ 页面 `error` / `unhandledrejection` 全程为空。
- 影响面：**只有客户端半边**（`plugin/client.js`）——**刷新页面即可看到，不用重启 DSH**。没拖过胶囊的用户行为完全不变（位置仍是原来的角 + 偏移）。

## [0.8.2] — 2026-10-03

**主题：按用户指定调整默认参数，并按用户反馈修窗口几何。** 不改路由与契约；33 个 `browser_*` 工具面照旧。

**起因（一条默认参数指令 + 三批窗口反馈 + 一个技能身份问题）：**

1. 「更新一些默认参数 / 背景不透明度：40%，玻璃效果：毛玻璃 / 画面质量：70 / 分辨率：1920*1080 / 打开即取帧：关。」——D2-1 ~ D2-5。
2. 「先不发送新版本，统一优化好，我确认后告诉你再去发送新版。」——所以这批先攒在工作区、逐条真机复核完再发布。
3. 「能不能随分辨率收缩窗口大小，去黑边」「窗口过高时收起和拖动点不了」「窗口和胶囊默认位置是右下角」——G-1 ~ G-3；真机复核又发现「贴合后首次打开偏上 ~98px」⇒ G-4。
4. 「技能中心为什么不是和 univer 一样安装后显示系统内置」——S2。

| # | 项 | 旧默认 | 新默认 |
| --- | --- | --- | --- |
| D2-1 | 取帧画面质量（`quality`） | 85 | **70**（省流量） |
| D2-2 | 打开面板是否自动取帧（`autoStream`） | 开 | **关**（打开面板不取帧、不占 CPU/带宽；在「网页」入口点「开始」才取帧） |
| D2-3 | 浏览器窗口分辨率（客户端 `viewport` + 宿主 `viewportWidth`/`viewportHeight`） | 1440×900 | **1920×1080** |
| D2-4 | 窗口背景不透明度（`cardAlpha`） | 95% | **40%** |
| D2-5 | 玻璃效果（`glass`） | 毛玻璃 | **毛玻璃**（不变，本批确认沿用） |

- 顺带修掉一个潜伏的默认值缺陷：`normalizeSettings` 里 `autoStream`/`remember` 写的是 `source.autoStream !== false`，**缺省时永远得到 true**，等于 `DEFAULT_SETTINGS` 里那一项根本不起作用。改成 `source.autoStream === undefined ? DEFAULT_SETTINGS.autoStream : source.autoStream !== false`（`remember` 同样处理），否则「打开即取帧默认关」这条改不动。
- 验收：`scripts/verify-bundle.mjs` **61/61**（断言改为 `viewport === '1920x1080'`、`cardAlpha === 40`，并新增「缺省时 `autoStream` 走默认＝false」）；`scripts/verify-provider.mjs` 116 → **117**（新增「`viewportWidth`/`viewportHeight` 默认 1920×1080」）；`verify-data` 86 / `verify-daemon` 35 / 矩阵 4 宿主 × 12 项 不变（脚本里都传显式配置，不受默认值影响）。
- 影响面：**客户端半边**（`plugin/client.js` 的 `DEFAULT_SETTINGS`）刷新页面即可；**宿主半边**（`plugin/lib/index.js` 的 `Config` 与 `plugin/lib/provider.js` 的 `initialViewport` 兜底）要**重启 DSH**。既有浏览器里 `localStorage` 已存过设置的用户**不受影响**（默认值只在「从没存过这一项」时生效），想回到新默认点「恢复默认」+「保存」。
- 未做：没有改 `maxWidth`（最大边，仍默认 1280）——分辨率 1920×1080 时画面会被按长边 1280 缩到 1280×720 再放大显示；想让画面更清就把设置里的「最大边」也调到 1920（这一项留作用户自选，本版没有改默认）。

**同批修正：随包技能改成「系统内置」身份（S2）。**

| # | 项 | 影响 | 处理 |
| --- | --- | --- | --- |
| S2-1 | v0.8.1 的随包技能是**落盘**到 `$DSH_HOME/skills`（用户级，rank 400），技能中心里显示成「用户级技能」；而宿主自带的 `dsh-univer-office` 用技能提供者接口注册，显示「系统内置」（用户反馈：「技能中心为什么不是和 univer 一样安装后显示系统内置」） | 同一批技能名在**同一层里 rank 小的先赢**：磁盘那份（400）会盖住内置那份（600）⇒ 想显示内置就绝不能同时落盘 | 新增 `src/skill-provider.mjs`：`ctx.skills.registerProvider()` 注册 `browser-service` 提供者，候选带 `source:'bundled'` + `rank:600`（`BUNDLED_SKILL_RANK`）、`resourceBase` 指向包内 `skills/<name>/`、`locator` 指向 `SKILL.md`；正文**现读现剥 frontmatter**（改文件不用重启）。`plugin/lib/index.js` 的 `apply()` 第一件事就是注册它（`ctx.inject(['skills'], …)`；宿主没有 `skills` 服务只记一行日志，绝不影响 provider）；新增配置 `registerSkills`（默认 **true**） |
| S2-2 | 已经落过盘的用户升级后，磁盘那份仍会盖住内置那份 | 升完级技能中心还是「用户级技能」，等于没修 | `syncSkills` 默认改成 **false**（落盘变成可选，只为「DSH 以外的工具也要读这些文件」保留）；`src/skills.mjs` 新增 `removeSkills()`；CLI 新增 `browsersvc skills --uninstall`（只删台账里属于本包且内容没被改过的文件，你改过的保留并说明原因，撤净后连台账与空目录一起清） |
| S2-3 | 文档与技能本身还在讲「必须落盘才有技能」 | 用户照做会又踩一遍 | README「随包技能」一节重写（提供者优先、落盘可选、讲清 rank 覆盖关系与 `--uninstall`）、`docs/architecture.md` 补 `src/skill-provider.mjs`、两份技能同步 |

- 本批验收：`scripts/verify-provider.mjs` 117 → **125**（新增「随包技能提供者（bundled）」8 项）；`scripts/verify-bundle.mjs` 61 → **65**（第 6 段 8 → 11 项：插件源码里 `registerProvider` + `registerSkills`/`syncSkills` 两个默认值、落盘仍可选、`--uninstall` 保留改过的 1 个/撤其余 6 个、撤净后连台账与空目录一起删；tarball 形状再 +1「`src/skill-provider.mjs` 随包发货」）；`verify-daemon` 35 / `verify-data` 86 / 矩阵 4 宿主 × 12 项 不变。
- 生效方式：宿主半边 ⇒ **重启 DSH**；技能正文 ⇒ 改文件即可（提供者现读）。**已落过盘的**：跑一次 `browsersvc skills --uninstall`，再重启 DSH。

**同批新增：窗口几何三项（G）——去黑边、让开宿主顶栏、默认摆正中。**

| # | 项 | 影响 | 处理 |
| --- | --- | --- | --- |
| G-1 | 「能不能随分辨率收缩窗口大小，去黑边」：卡片高度写死 580px、舞台底色写死 `#0b0b0e`，1920×1080 的画面只用掉中间一小块，四周一片黑 | 画面小、黑边大，窗口比例和画面完全对不上 | 新增设置「**贴合画面比例**」（`fitPicture`，默认**开**）：舞台按画面比例（真实帧尺寸优先，没帧时按设置里的分辨率）用 `aspect-ratio` 撑高、卡片 `height:auto`；贴合时右下角手柄**只调宽度**（高度跟着比例走），退出贴合才是自由拖宽高；`.bsp-stage` 底色改成透明 ⇒ 黑边跟随宿主主题 |
| G-2 | 「窗口过高时收起和拖动点不了」：窗口高度能顶到视口下沿，标题栏被顶出屏幕 | 拖不动、收不起，只能刷新页面 | 新增设置「**顶部留白**」（`topInset`，`'auto'` 或 0–200px，默认 `'auto'`）：`clampRect` 新增第四参，窗口上边界、最大高度（视口 − 留白）都受它约束；「自动」时 `collectTopBars()` 实测宿主贴顶的 `fixed`/`sticky` 条（只认宽 ≥ 视口 60%、高 24–200 且 ≤ 视口 40%），`topInsetFromBoxes()` 里取最高的，量不到按 `TOP_INSET_FALLBACK`＝48；设置页可手填覆盖 |
| G-3 | 窗口与胶囊的默认位置是「右下角」，换屏幕/分辨率看着别扭 | 首次打开位置不可预期 | `clampRect` 在没记过位置时改为**摆正中**（水平居中，竖直在留白与视口之间居中）；`x`/`y` 有记录时行为不变 |
| G-4 | 真机复核发现：贴合画面比例后首次打开窗口**偏上 ~98px**（1920×1080 实测窗口高 431px，居中却按名义高度 580px 算 ⇒ y=250 而不是 348） | 看着没居中，用户第一眼就发现 | 贴合且没记过位置时，新增一个 effect 先量一次卡片**真实高度**再摆正中（依赖 `open`/`fitPicture`/`viewport`）；实测修好后窗口 y=351（理想 348，差 3px 是 effect 跑完后卡片又高了 6px） |

- 本批验收：`scripts/verify-bundle.mjs` 65 → **70 通过 0 失败**（5c 段 19 → 24 项：第四参留白下界、`topInsetFromBoxes` 自动量（贴顶 + 够宽 + 高度合理里取最高）、0–200 夹取、`ratioOf` 比例回退、`fitPicture`/`topInset` 两项新默认；旧的「没记过位置贴右下角」断言随 G-3 改成摆正中的 `{x:200,y:150}`）；`scripts/verify-provider.mjs` **125**、`verify-daemon` **35**、`verify-data` **86**、矩阵 4 宿主 × 12 项 不变（这批没碰宿主半边）。
- 影响面：**只在客户端半边**（`plugin/client.js`）⇒ 刷新页面即可，不用重启 DSH。老用户位置若已记过就按记的来（新默认只在没记过时生效）。

## [0.8.1] — 2026-09-30

**主题：收口界面与外观，并让「装完就有全局技能」。** 这是 0.8.0 之后的三批修补（P6/P7/P8）加一个新的交付形态（随包全局技能，S）的合并发布；约束从头到尾没有变：33 个 `browser_*` 工具面是内置接缝的，**零新增工具**——这一版改的全是面板自己与「技能怎么随包落地」。

### 起因（三条真实反馈 + 一个新需求）

1. 「完整分析并美化界面，美化菜单切换和窗口布局渲染效果，胶囊放置左侧上方」；随后又提「网络里共 10812 条，增加手动清理按钮，设置页增加自动清理项」「胶囊位置可自定义」「浏览器输入网址点击跳转无响应」「美化左侧按钮」。
2. 「1，增加分辨率可调设置，2，胶囊设置增加坐标可自定义，例如水平偏移 15，垂直偏移 48，面板间距 10，层级基准 40。3，自动清理似乎未生效，检查优化」，以及「画面还是很模糊」。
3. 「1 增加设置页可自定义调交互窗口边框主题色，透明度，玻璃效果（毛玻璃，液态玻璃）」「2 给设置页增加保存按钮，生效提示，例如已保存刷新页面生效，其他错误提示」「3 疑问，浏览器后端是否有多个标签页？标签页加载的是哪个？」；随后又反馈「主题生效的只是边缘看到线条颜色，侧边栏和底栏顶栏没有生效」。
4. 新增需求：**把「怎么用浏览器工具」做成随包发布的全局技能**（DSH 的技能发现只认磁盘目录，`package.json` 的 `dsh` 清单里没有技能位）。

### P6 界面美化与体验修补

| # | 项 | 影响 | 处理 |
| --- | --- | --- | --- |
| P6-1 | 面板配色写死深色，亮色主题下像贴了块黑卡片 | 与宿主界面割裂 | 客户端整套改用宿主设计令牌 `var(--dsw-alias-*, 回退值)`（卡片/文字/边框/悬停/危险色/滚动条），暗亮主题自动跟随；等宽字体只留在日志与 URL 上 |
| P6-2 | 胶囊钉在右下角、压着状态栏，也没法挪 | 挡视线 | 默认移到**左上角**，设置里可换四个角：纯函数 `pillAnchor(pos)` 只给命中角写偏移、其余 `auto`，与窗口几何一起存 `localStorage` |
| P6-3 | 入口图标是 `▣ ✓ ⌨ ⇄ ⚙` 字形（字重不一，部分平台渲染成彩色 emoji）；菜单切换没有键盘可达性 | 观感与可访问性都差 | 换成 5 个 16×16 线描 SVG（描边 `currentColor`）；入口改真 `role="tablist"/"tab"/"tabpanel"` + roving tabindex + `aria-selected`/`aria-controls`/`aria-labelledby` + 方向键/Home/End 环绕；开合/切换/悬停加 120–160 ms 过渡，`prefers-reduced-motion` 下全关；拖动与缩放改 rAF 节流直改 DOM、松手才落状态 |
| P6-4 | 网络日志上万条，只能等文件自己轮转，清不掉 | 想重来一次得手工删文件 | 宿主新增 `POST /browser-service/logs`（`{action:'clear'\|'trim', kind, keep}` → `clearEntries()`，走同一套回环/同源/方法闸）；客户端每个日志入口右上角加「清理」（点两次确认，3 秒不动手自动取消）；设置里加「自动清理」上限（关闭/1000/5000/20000），某类超上限时保留最近一半，只在面板打开时检查 |
| P6-5 | 地址栏输入网址点「跳转」没有任何反应 | 以为功能根本没做 | 真因：一个浏览器会话都没有时宿主回 409，而客户端把失败原因藏了起来。改成宿主按地址栏意图 `provider.open('面板地址栏')` 再 `openUrl()`（**跳转顺便把页面开起来**），客户端补 `https://`（与服务端 `normalizeUrl` 同规则）、把宿主给的原因显示在地址栏正下方 |
| P6-6 | 失败原因设完就消失（真缺陷） | 看起来像「点了没反应」 | 取帧 pump 每次成功都 `setError(null)`，会把刚设置的动作错误瞬间抹掉 ⇒ 拆成 `frameErr`/`actionErr` 两条通道，取帧成功不再动动作错误 |
| P6-7 | 窗口每拖一次缩放手柄就悄悄长 2 px；实时画面点击坐标偏约 1 px（真缺陷） | 窗口越拖越大、点击略偏 | 前者缺 `box-sizing:border-box`（样式写 620px 实渲 622px），后者是舞台 1px 边框让元素框比图片内容框大 2px（改成 inset `box-shadow` 画边框，使两者相等） |

### P7 分辨率与胶囊坐标可调、清理可见化、画面清晰度

| # | 项 | 影响 | 处理 |
| --- | --- | --- | --- |
| P7-1 | 浏览器窗口分辨率只能改插件配置（`viewportWidth`/`viewportHeight`），改一次要重启 DSH | 想按屏幕或页面调大小时没办法 | 设置里新增「浏览器窗口分辨率」（1280×720 / 1440×900 / 1600×900 / 1920×1080）。宿主新增 `POST /browser-service/viewport` → `provider.setViewport({width,height})`：夹到 640×360 ~ 3840×2160，**对已打开的每个页面** `page.setViewportSize` 并回 `applied` 计数（单页失败只记警告），之后新建的会话沿用该尺寸；非法值抛 `BROWSER_VIEWPORT_INVALID`；`panel.json.service.viewport` 回读当前生效值。设置页会显示 `✓ 已生效 1920×1080（已应用到 1 个页面）` |
| P7-2 | 胶囊只能选四个角、离角距离写死；窗口与胶囊的 `z-index` 也写死 | 想挪几个像素躲开宿主左侧栏也做不到；和宿主浮层抢叠压顺序没法调 | 设置里新增「水平偏移」「垂直偏移」（0–400 px，默认 15/48，按选中的角生效）、「面板间距」（0–64 px，默认 10——既是窗口贴边留白，也是自动收回可见范围时用的边距）、「层级基准」（1–2000，默认 40）。胶囊与窗口改用内联 `z-index`（胶囊 = `zBase`，窗口 = `zBase + 1`），CSS 里写死的 `40` 删掉 |
| P7-3 | 「自动清理」设了上限却毫无反应（真缺陷，用户报「似乎未生效」） | 以为功能坏了，只能手工删日志文件 | 真因两条：① 运行中的 DSH 里**宿主半边还是旧版**——实测 `POST /browser-service/logs` 返回 405、`GET` 同路径 404，新路由根本没挂，**必须重启 DSH**（客户端半边改完只刷新页面不够）；② 客户端 `postLogs` 只回布尔、判断 `if (results.some(Boolean)) retry()`，把失败静默吞掉。改成 `postJson()` 返回 `{ok,status,body,error}`，手动清理与自动清理的成败都在窗口顶部出条提示——成功 `已自动清理：网络 12000 → 500`，失败 `清理网络日志不可用：宿主没有这条路由（HTTP 404）——宿主半边是旧版，重启 DSH 后生效`（404/405 专门给人话指引） |
| P7-4 | 实时画面糊：分辨率调大了也不见清楚（真缺陷，用户报「画面还是很模糊」） | 画面像蒙了一层，页面上的字看不清，调设置也没用 | 真因：客户端取帧只发 `?quality=&max=`，**没发 `maxh`**；宿主 `clampInt(null, 240, 1200, …)` 里 `Number(null) === 0` 被当成「给了值」，于是高度上限算成了**下限 240** ——而 CDP 的 `Page.startScreencast` 是「等比缩到 `max × maxh` 的框里」，1920×1080 的页面被压成 384×240，再由界面放大 ⇒ 糊。处理：① `clampInt` 把 `null`/空串一律当**没给**（回落当前值/默认），宿主与客户端同一份语义；② 客户端取帧带上 `maxh=最大边`，让「最大边」真正只是**长边上限**；③ 默认取帧质量 70 → **85**、默认高度上限 800 → 1200，设置页加一句人话说明 |

### P8 窗口外观可自定义、设置显式保存

| # | 项 | 影响 | 处理 |
| --- | --- | --- | --- |
| P8-1 | 窗口的边框与底色只能跟宿主主题走，想调成自己喜欢的颜色/透明度做不到；「玻璃」只是固定的一层模糊 | 想把窗口调得更透、更亮或更暗，或让它不要那么抢眼，都没有入口 | 设置页新增第一段「窗口外观」：**边框颜色**（跟随主题 / 无边框 / 蓝紫绿琥珀红青六个预设色 / 取色器自定任意色，只放行预设值或 `#rrggbb` 形状，别的一律回落主题色——这些值会写进 CSS 变量，所以先卡一道）、**背景不透明度**（40/60/80/95/100%，用 `color-mix(in srgb, 主题底色 N%, transparent)`，所以底色仍随暗/亮主题走，只改实心程度）、**玻璃效果**（关 / 毛玻璃＝`backdrop-filter: blur(10px) saturate(1.15)` / 液态玻璃＝`blur(18px) saturate(1.65)` 再加一道斜向高光与内圈描边光；都是 CSS 近似，不做真折射）。窗口与收起后的胶囊共用同一份外观；纯函数 `appearanceStyle(settings, kind)` 算出四组 CSS 变量，`borderOf` 负责颜色规整 |
| P8-2 | 设置一改就落盘，没有「保存」这个动作，也没有任何回执；万一写不进本地存储，用户完全看不出来 | 改错了没法整体放弃，也不知道自己改的到底存住了没有 | 设置改成**草稿 + 显式保存**：任何改动立刻按新值渲染（预览），但只有点顶部吸顶栏的「保存」才写进 `localStorage`；未保存时栏里是琥珀色 `● 有未保存的改动（窗口外观已先按新值显示）`，左侧「设置」入口与收起后的胶囊上出现小圆点。保存成功绿字 `✓ 已保存：窗口外观立即生效，刷新页面也保留。`；写本地存储失败（无痕模式/站点策略）红字 `保存失败：这个浏览器不让写本地存储（无痕模式或站点策略），改动只在本次打开有效。`，草稿保留。「恢复默认」把外观恢复默认值（同样要先保存才落盘）。几何自动保存改用「上次保存的设置」，草稿不会被顺手落盘 |
| P8-3 | 同一拍里连点两个设置按钮时，后点的会把先点的覆盖掉（写 P8 时在预览工装里实测到） | 手快的人会看到「点了却没变」，以为按钮坏了 | 设置的写入通道从「传整份设置」改成**传补丁**：`SettingsPane` 只 `onPatch({…})`，父组件用 `setSettings((prev) => normalizeSettings({...prev, ...patch}))` 的函数式更新，两个改动都保留。这不是新引入的缺陷，而是 P8 新增外观三件套时暴露出来的旧写法问题 |
| P8-4 | 调了边框色/透明度后**只有最外圈那条线在变**：标题栏、左侧入口竖排、底栏、列表吸顶条各自带着自己的不透明主题色块，把窗口的透明度挡住（用户反馈：「主题生效的只是边缘看到线条颜色，侧边栏和底栏顶栏没有生效」） | 外观设置看起来只改了描边，玻璃效果也几乎看不出来，像是没生效 | 内部分区改用与外壳同一份透明度的分层底色：`appearanceStyle` 除原有四组变量外再产出 `--bsp-card`（＝外壳底色，列表吸顶条/分组标题/保存栏用）、`--bsp-surface`（＝抬升一层的底色，标题栏/左侧入口/底栏/展开行/JSON 块/结果条用）、`--bsp-divider`（**选了自定义边框色时分隔线用同色调 45% 的浅色**；跟随主题/无边框时保持宿主细线——`无边框` 只去掉最外圈那条）；样式表里对应的 `background`/`border-*` 全部改成 `var(--bsp-*, 旧值)` 兜底，所以没挂上变量时观感与以前完全一致 |

### S 随包全局技能（新的交付形态）

| # | 项 | 影响 | 处理 |
| --- | --- | --- | --- |
| S-1 | 两份技能只存在于开发机的 `$DSH_HOME/skills` 里，别人装完包什么也没有；而 DSH 的技能发现**只认磁盘目录**，`package.json` 的 `dsh` 清单也没有技能位 | 「怎么用浏览器工具」和「坏了怎么修」只对作者可用 | 包内新增 `skills/browser/SKILL.md` 与 `skills/browser-runtime/SKILL.md`（后者还带 `scripts/browse.mjs`、`chromium-wrapper.sh`、`fonts.conf`、`setup-libs.sh`、`verify-cjk.mjs`，共 7 个文件），新增 `src/skills.mjs` 做同步 |
| S-2 | 无脑覆盖会踩掉用户自己改过的技能 | 装个插件把人家写的东西冲掉，是不可接受的行为 | 同步带**归属台账**（目标目录里的 `.dsh-moli-browser.skills.json`）：目标不存在→装；与源逐字节相同→记为我们的、不动；与台账旧哈希相同→是本包旧版、覆盖升级；用户改过的／同名但不在台账里的→**跳过并记日志**，要覆盖必须 `--force`。幂等，重复跑不写盘 |
| S-3 | 装完还得手动敲命令才落盘 | 多一步就有人不做 | 插件启动时自动同步：`plugin/lib/index.js` 的 `apply()` 顶部（早于 provider 注册）执行，**失败只记一行 warn，绝不影响 provider**；新增配置 `skillsDir`（默认空＝`$DSH_HOME/skills`）与 `syncSkills`（默认 true） |
| S-4 | 落盘的东西需要能查状态 | 出了「同名文件被跳过」得知道为什么 | CLI 新增 `browsersvc skills`（列每个文件：缺失/已最新/可升级/你改过/非本包，并给待处理数与冲突数）与 `browsersvc skills --install [--force] [--dir=…] [--json]`，与插件共用同一份实现 |

- 目标目录 `$DSH_HOME/skills` 是 DSH 的**用户级**技能根（rank 400，仅次于宿主自带 bundled），所以装完就是全局可用。
- 验收：`scripts/verify-bundle.mjs` 新增第 6 段 **8 项**（空目录报缺失且退出码 0、`--install` 真落盘且 7 个文件全在、台账写入版本与哈希、重复跑幂等、改过的文件不覆盖、`--force` 才覆盖且内容回到随包版本、`skills --json` 可被脚本消费、配置项 `skillsDir`/`syncSkills` 在 schema 里），并在 tarball 形状断言里加 1 项（含两份 `SKILL.md` 与 `browser-runtime/scripts/`）。

### 验收与影响面

- `scripts/verify-daemon.mjs` **35/35**（不变）；`scripts/verify-provider.mjs` **116 通过 0 失败**（不变，含 P7 的 `setViewport` 段）；`scripts/verify-data.mjs` **86 通过 0 失败**（不变，含 P6 日志清理路由、P7 分辨率写路由与「缺 `maxh` 不塌到下限」的回归断言）；`scripts/verify-bundle.mjs` 52 → **61 通过 0 失败**（P6：46 → 50；P7：50；P8：50 → 52 的 5c 段 17 → 19 项；本轮新增第 6 段随包技能 8 项 + tarball 技能文件断言 1 项）；`scripts/verify-matrix.mjs` **4 个宿主版本 × 12 项**全过。
- 半边归属：P6 的「日志清理路由」与 P7 的「分辨率路由 + 服务信息块」在**宿主半边**（`plugin/lib/panel.js`、`plugin/lib/provider.js`、`src/opslog.mjs`）⇒ 升级后**必须重启 DSH**；P6 的界面、P8 的全部，以及 P7 的设置控件与提示条在**客户端半边**（`plugin/client.js`）⇒ 刷新页面（Ctrl+F5）即可。S 的技能同步发生在插件启动时，重启 DSH 最稳（也可以随时 `browsersvc skills --install`）。
- P7-3 那条「自动清理没反应」正是这个半边差异造成的真实误报：路由没挂时客户端把失败静默吞了；现在失败会明说「宿主半边是旧版，重启 DSH 后生效」。
- 预览工装（`/tmp/panel-preview`，只用于开发）里在真浏览器中逐项复核过：分辨率 200 成功小字 / 403 跨站失败文案、清理 404 红条、`?big=1` 下自动清理成功横幅（真发了 `{action:'trim',kind:'ops'|'network',keep:500}`）、胶囊按 30/60 落位且内联 `z-index` = 120（窗口 121）、P8 三项同拍生效且草稿不落盘、保存写入并刷新保留、`Storage.prototype.setItem` 抛错时红字、取色器 `#ff00aa`、「无边框 + 40% + 关」时四块内部分区底色降到 `... / 0.4` 且分隔线回落宿主细线。
- 未自动化覆盖的部分：上述 DOM 行为（保存栏文案、色块选中、草稿不落盘、失败红字、内部分区实际渲染色）不进 `verify-*`，只在预览工装人工跑过；自动化覆盖的是纯函数、路由契约与 CLI 状态。
- 文档：根 `README.md` 按本轮结构重写（新增「随包全局技能」一节、面板路由表、目录结构），配置表补 `skillsDir`/`syncSkills`，验收计数统一为 35/116/61/86/4×12；`docs/architecture.md`、`docs/verification.md`、`plugin/README.md`、`CONTRIBUTING.md` 同步。

## [0.8.0] — 2026-09-29

**主题：窗口与入口重做。** 起因：用户看过 0.7.0 的实时窗口后提了三条——「窗口可拖动、大小可自由调整」、「增加左侧浏览器入口和功能设置区」、「优化 UI 和布局，窗口效果可借鉴 dsh-univer-office」。约束仍然不变（33 个 `browser_*` 是内置接缝的，**零新增工具**）：这一版改的全是面板自己。

| # | 项 | 影响 | 处理 |
| --- | --- | --- | --- |
| P5-1 | 窗口位置固定、不能缩放，挡着别的界面只能收起 | 一边看页面一边看对话时很别扭 | 客户端窗口重做：按住标题栏拖动、右下角手柄缩放（最小 320×240）、双击标题栏或 `⤢` 最大化/还原（最大化＝视口减 12 px 边距）、`收起` 回到胶囊；几何用纯函数 `clampRect` 夹进视口，浏览器窗口 resize 时自动把窗口拉回可见范围；`localStorage` 记住位置与大小（设置里可关） |
| P5-2 | 四个标签横排，入口越来越多会挤 | 加设置后没地方放 | 入口改成**左侧一竖排**：网页 / 操作 / 控制台 / 网络 / 设置（日志入口带条数），标题栏保留暂停与收起 |
| P5-3 | 没有设置，画质/刷新频率都是写死的 | 网络差或机器弱时没办法调 | 新增「设置」入口：画面质量（40/55/70/85/95）、最大边（480/800/1280/1600/1920）、打开即取帧、面板刷新间隔（1/2.5/5/10 s）、日志条数（20/40/100/200）、默认入口、记住窗口位置；值越界/类型不对由 `normalizeSettings` 统一规整（`tab` 不认识就回落「网页」） |
| P5-4 | 设置项改了什么、当前生效的是什么，看不到 | 不知道有没有生效、要不要重启 | 设置区底部加只读**服务信息**：版本、会话、CDP 地址、保存目录名、标签上限、空闲回收窗口、控制台/网络录制开关、生效中的取帧参数。数据来自宿主 `panel.json` 的 `service` 块（**只回目录名与配置值，不回本机绝对路径**） |
| P5-5 | 画质/最大边要改就得改插件配置并重启 | 调一下画质要重启 DSH，代价太大 | 取帧参数随请求下发：`GET live.jpg?since=&quality=&max=&maxh=`，宿主 `view.start({quality,maxWidth,maxHeight})` 变了就重开流（同一组参数不重开，幂等），越界由 `clampInt` 夹到安全范围（质量 10..95、宽 320..1920、高 240..1200），响应头回 `x-frame-quality` 与 `x-frame-max` 供客户端确认；改完下一次取帧即生效，不用重启 |

- 验收：`scripts/verify-data.mjs` 61 → **66**（新增 P5 段 5 项：取帧参数透传与响应头、越界夹取、`live.json.options` 回读、`panel.json.service` 只读块内容、下载目录只回目录名且载荷不含绝对路径）；`scripts/verify-bundle.mjs` 41 → **44**（5c 段 8 → 11 项：客户端导出 `clampInt`/`clampRect`/`normalizeSettings`、几何三态夹取、设置规整）。
- 客户端探针（`scripts/lib/client-probe.mjs`）现在还会读 `plugin.internals` 里的纯函数真跑一遍：修 `clampRect` 的 `Number(null) === 0` 坑就是靠它当场暴露的——「没记过位置」（x/y 为 `null`）本意是贴右下角，`Number(null)` 会算成 0 跑到左上角，改成显式判空再夹取。
- 这一版的窗口与布局只改了 **客户端半边**（`plugin/client.js`，刷新页面即可看到），但取帧参数透传与服务信息块在**宿主半边**（`plugin/lib/panel.js`、`plugin/lib/liveview.mjs`）⇒ 要在 DSH 里看到完整效果需要**重启一次**。
- 观感参考 dsh-univer-office（深色半透明圆角卡片、标题栏握把、右下角缩放手柄），但**没有**依赖它的任何内部 API：查证过 univer-office 的客户端 bundle 只 `require('react')` 与 `react/jsx-runtime`，它自己也是手写浮窗（平台另有 `@deepseek-ai/dsh-client-ui-dockkit` 种子模块，但那是 shell 侧边栏内部的停靠引擎，不是给独立浮层用的即插组件，故不用）。

## [0.7.0] — 2026-09-29

起因：用户要的不是「日志看板」，而是**在 DSH 网页里能看到并直接操作的实时网页窗口**（像 dsh-univer-office 的浮动实时窗口，只是内容换成网页）。约束不变：33 个 `browser_*` 工具是内置接缝的，**零新增工具**——实时窗口是网页面板里的第一个标签页。

| # | 项 | 影响 | 处理 |
| --- | --- | --- | --- |
| P4-1 | 面板只能「看日志」，不能在窗口里操作页面 | 想点一下、滚一下、输入一段文字都得回到对话里发指令 | 新增 `plugin/lib/liveview.mjs`：包住会话当前页，用 `Page.startScreencast`（jpeg/quality 70/1280×800）经我们的 CDP 代理取帧——**只在画面变化时下发**（静止零流量，实测帧约 6.8 KB、滚动动画期 13.8 fps）——并用 `Input.dispatchMouseEvent`/`insertText`/`dispatchKeyEvent`/`mouseWheel` 把操作打回真页面。CDP 会话懒建（`#session()` 幂等），不开流也能先转操作 |
| P4-2 | 画面怎么送到浏览器端、操作怎么回来 | —— | `plugin/lib/panel.js` 增加三条 exact 路由（与面板同源）：`GET /browser-service/live.jpg?since=N`（长轮询，最多等 1500ms，只回比 `since` 新的帧，无帧回 204）、`GET /browser-service/live.json`（每秒同步 URL/标题/推流状态）、`POST /browser-service/live`（`down/up/move/wheel/text/key/reload` → `view.input()`；`goto` → `provider.openUrl()`，复用 http(s) 校验与 ops 记账）、`DELETE` 停流 |
| P4-3 | 谁能碰这条通道 | 实时窗口能点能打字，等于把浏览器交出去 | 三道闸：只认**回环地址**（非本机 403）、方法白名单（405）、POST/DELETE 要求 `origin`/`referer` 与 Host 同源（跨站 403；回环来的无 origin 请求放行，便于 curl 与验收） |
| P4-4 | 录屏一直开着会白烧 CPU | 面板收起/切走后没人看画面 | 宿主半边记录最近取帧时间，`setInterval` 5 秒巡检、30 秒没取帧就停流（`unref` 不阻塞退出）；客户端在收起/暂停/卸载时发 `DELETE`；provider 在会话关闭、`reset`、切标签、`#revive` 时都把 `live` 停掉并置空 |
| P4-5 | 客户端半边要能在浏览器里真的跑 | 手写 bundle 协议 + 9 个平台种子词容易被写错 | 面板客户端加「网页」标签（默认）：长轮询取帧 → `URL.createObjectURL` → `<img>`（换帧时 revoke 旧 URL）、鼠标/滚轮/键盘事件按 `屏幕 rect → 帧宽高` 线性换算坐标后转发（**不猜坐标**）、地址栏回车走 `goto`、`live.json` 每秒同步地址栏；`Panel` 默认标签改成「网页」 |

- 验收：`scripts/verify-data.mjs` 45 → **61**：新增「P4 实时窗口：路由与闸门」15 项（四条 exact 路由、`live.json` 报会话与页面状态、取帧回 JPEG 且带 `x-frame-seq`/`x-frame-w`/`x-frame-h`、推流后状态变 `live:true`、无新帧回 204、打字/点击坐标/goto 转发、未知动作 400、跨站 POST 403、非本机 403、方法 405、DELETE 停流、无 provider 503、dispose 一起摘掉），面板段另加 1 项「一次挂上四条路由」。
- `scripts/verify-bundle.mjs` 40 → **41**（5c 段补 1 项：客户端引用的三条实时路由与服务端一字不差——服务端是 `exact` 匹配，写错只会静默 404）。
- 已知限制：实时窗口**只对本机回环请求开放**。若你是从别的机器直连 DSH Web（不是本机 127.0.0.1），面板的日志标签照常，但实时窗口会 403——这是刻意保留的闸门，宁可拦住也不把浏览器交出去。跨站网页仍然只能帧流（不能 iframe 嵌），与 dsh-univer-office 同路子。
- 面板要在 DSH 里**重启一次**才会出现（客户端插件在启动时收集）；改 `plugin/client.js` 不必重启（客户端入口支持热替换），改宿主半边要重启。

## [0.6.0] — 2026-09-28

起因：方案文档 P3 第一批「可观测性 + console/网络抓取 + cookie 导出」。约束是**工具面不是我们的**——33 个 `browser_*` 来自内置接缝包 `dsh-builtin-browser/tool-browser`，我们只在 patch 里覆盖它的行，所以用户面全部走 **CLI + 状态文件**（网页面板只是同一份数据的只读窗口），**零新增工具**。

| # | 项 | 影响 | 处理 |
| --- | --- | --- | --- |
| P3-1 | 出了事只能看 `logs`/`status`，看不到「刚才那次调用做了什么、花了多久、为什么失败」 | 浏览器自动化出问题只能靠复现猜 | 新增 `src/opslog.mjs`（JSONL 环形落盘，插件与 CLI 共用）与 `browsersvc ops`；provider 用**通用追踪器**（`traced()` 返回 `Proxy`，对所有公共方法统一记账：`seq`/`action`/`params`/`ok`/`error`/`ms`）自动覆盖全部方法，以后新增方法也不会漏。`open`（会话创建）、`reset`（会清空账本）、`history`（读账本本身）刻意不记 |
| P3-2 | 页面控制台与网络流量完全不可见 | 前端报错、接口 4xx/5xx、资源加载失败都看不到 | `#instrument(page)` 挂在 `#addTab`（所有页面创建的**唯一漏斗**）：`console`/`pageerror` → `<root>/console.jsonl`（文本截 500 字）；`request`/`response`/`requestfailed` → `<root>/network.jsonl`（同请求记耗时，**不记头与体**）。开关 `captureConsole`/`captureNetwork`（默认都开） |
| P3-3 | 想要 HAR 得自己造 | 交给外部工具分析网络时缺数据 | 直接用 playwright-core 的 `recordHar`（`BrowserContextOptions`）按会话录，落在 `<root>/har/<时间戳>-<会话>.har`，只留最近 10 份；`browsersvc har [--session=s1] [--out=file]` |
| P3-4 | cookie/localStorage 跨会话搬不动 | 登录态无法导出复用或注入调试 | `browsersvc cookies`（导出 0600、拒绝覆盖；注入需有活会话）。实现走**浏览器级 CDP 会话**（`newBrowserCDPSession` + `Target.getBrowserContexts` 的非默认 id + `Storage.getCookies/setCookies`）——实测 `context.cookies()/addCookies()` 写的是**默认上下文**，读不到也写不进我们的隔离上下文；localStorage 走可见页面 `evaluate` |
| P3-5 | 没有任何界面，工具调用过程只能翻日志 | 边跑边看要开终端 | 只读网页面板：宿主半边 `plugin/lib/panel.js` 挂 `GET /browser-service/panel.json`（`exact`、只 GET/HEAD、`no-store`、载荷不含本机绝对路径、没有 `webServer` 的宿主不挂），客户端半边 `plugin/client.js` 手写零构建（`window.__ModuleLoader__` 协议、只 `require('react')`、注册到 `shell.overlay`）。**不注册任何 `tool.call.toolview` 行**，不动出厂通用 tool row |
| P3-6 | 观测日志出事会把浏览器调用拖下水 | 磁盘满/权限异常不该让 `browser_*` 失败 | 所有落盘集中在 `src/opslog.mjs`：IO 异常一律吞掉并返回 `false`；环形上限（ops/console 各 1 MiB、network 2 MiB）超限保尾部一半；文件 0600（含 URL 与 cookie） |

- 验收：新增 **`scripts/verify-data.mjs`（45 通过 / 0 失败）**——五个观测面 + 面板路由：操作日志（含通用追踪覆盖 `snapshot`/`content`/`screenshot`/`listTabs`、失败记 `ok:false` 与原因、`open` 不入账、人话表格与 `--lines`）、控制台、网络（request/response 两阶段、状态码与耗时、不记头体）、HAR（关闭会话后落盘、`--out` 复制、拒绝覆盖、`--session` 挑文件）、cookie/localStorage（导出字段与权限、`--url` 过滤、导入、新会话隔离）、面板（三份数据、`?lines=1`、405、卸载后路由消失）、容错（IO 失败不抛）。
- `scripts/verify-bundle.mjs` 33 → **40**（新增 5c 段 7 项）：tarball 带 `plugin/client.js`、`exports["./client"]` 与 `dsh.client.platform==='web'`、客户端入口走 `__ModuleLoader__` 且 id = 包名、factory 返回标准 cordis 插件（`apply` + `inject: slots`）、`apply` 注册到 `shell.overlay`、组件可渲染（无数据回落胶囊）、客户端只 `require` 平台种子表内的包。
- 连带修复：`verify-provider.mjs` 的 `reset 清空标签与历史` 断言改成先读历史再列标签——通用追踪会把 `listTabs` 也记一行，顺序反了会把那一行算进「reset 之后的历史」（断言强度不变）。
- 面板要在 DSH 里**重启一次**才会出现（客户端插件在启动时收集）；改 `plugin/client.js` 不必重启（客户端入口支持热替换），改宿主半边要重启。

## [0.5.1] — 2026-09-28

起因：方案文档 P2「DSH 版本适配」。目标是**换 DSH 版本或换接缝版本时，失败能自己说清原因**，而不是抛一句没有指向性的模块导出错误；同时把「支持哪些版本」从口头承诺变成可复现的实测矩阵。

| # | 项 | 影响 | 处理 |
| --- | --- | --- | --- |
| P2-1 | 没有兼容性声明与实测矩阵 | 用户不知道该配哪个 DSH；上游一改导出形状，报错看不出是「本插件不适配」 | README 新增「DSH 兼容矩阵」（4 个宿主版本 × 装得上/挂得上/可加载/能浏览）。**不写 `dsh.engines`**——`DshManifest` 里没有该字段（`dsh-package-manifest/lib/types/types.d.ts` 只有 `bundle`/`profile`/`client`/`configTrees`/`moduleFallback`），发明字段只会被忽略 |
| P2-2 | 给 `@deepseek-ai/dsh` 写 semver peer 是**错的兼容信号** | 想省事写个范围反而误导：`>=0.1.5-rc.1 <0.2.0` 在 semver 预发布规则下只解锁 0.1.5 的预发布，同范围的 `0.1.7-rc.2` 会被判不符 | 刻意**不写** dsh 的 peer 范围，改用「启动期探测 + 人话报错 + 实测矩阵」三件套 |
| P2-3 | 启动期没有能力探测 | 接缝改名/导出形状变化时，失败形态是上游的模块错（`does not provide an export named …`），用户不知道是本插件的问题 | 新增 `plugin/lib/compat.js`：`inspectSeam`（`browser` 要有函数默认导出与 `BrowserError`；`tool-browser` 要有 `name`/`apply`/`inject`，且 `inject` 含 `tools`、`browser`）+ `readVersions`（读宿主与接缝版本）。`apply()` 开头先探测：不符就打印「插件未启用 —— 浏览器接缝与预期不符（接缝 X，宿主 Y）：…」并**安静退出**；宿主缺 `ctx.browser.registerBrowserProvider` 也报一句人话；版本不在实测清单只告警，不阻断 |
| P2-4 | 工具面变化没有跟随验证 | 接缝 32 → 33 新增 `browser_a11y` 时，README 与计数会悄悄过期 | `verify-bundle.mjs` 静态数已安装接缝的工具名（`'browser_*'` 去重必须 == 33 且含 `browser_a11y`）——上游加减工具会让我们的验收立刻失败并提示更新文档 |
| P2-5 | `@deepseek-ai/schemastery` 被当普通依赖装 | 与宿主各持一份实例（官方 peer 规则：需要与宿主共享实例的 dsh 包要同时写 `peerDependencies` 与 `devDependencies`） | 从 `dependencies` 移到 `peerDependencies` + `devDependencies`；隔离环境实测仍可解析（走宿主 peer 目录），并由验收锁住「本包不携带自己的 schemastery」 |
| P2-6 | 换版本是否还能用没有可复现证据 | 只能靠嘴说 | 新增 `scripts/verify-matrix.mjs`（+ `scripts/lib/host-peers.mjs`、`scripts/lib/matrix-probe.mjs`）：把**同一个 tarball** 装进多个宿主版本，逐版本验 `add` → `--dump-config` → 入口可加载（宿主 peer 可解析）→ `apply(桩 ctx)` 注册出 `cdp-daemon` 且探测无 error → 用装进来的 bin 自启守护进程**真开一个页面**并读回正文 |

- 验收：`verify-bundle.mjs` 23 → **33**。新增 10 项：隔离 profile 里 `import 'dsh-moli-browser'`（宿主 peer 可解析）、`readVersions()` 读到宿主与接缝版本、真实接缝 `inspectSeam` 0 fatal、四种坏形状各自致命、`seamMismatchMessage` 文案含期望面、静态数工具面 == 33 且含 `browser_a11y`。
- 隔离环境补宿主 peer 目录的做法抽成 `scripts/lib/host-peers.mjs` 的 `linkHostPeers()`：真实部署里 boot 过就有 `$DSH_HOME/profiles/node_modules/@deepseek-ai`（240 项 + 一条 `dsh` 自身软链），隔离 home 没有；这里建实体目录逐项软链，再补 `dsh` 自身。**不能把该目录整体做成指向宿主目录的软链**——那样再往里补 `dsh` 会写进只读的宿主目录（EACCES）。


## [0.5.0] — 2026-09-27

起因：完整测试量出的两条资源事实——① 一个标签页约 623 MB 常驻、每多开一个标签 +92.8 MB（6 个标签全关后回落，不泄漏，但**没有上限**）；② 插件从第一次用浏览器起就挂着 CDP 连接，守护进程的 `idleMs` 空闲回收**永远不会触发**，约 600 MB 的浏览器会常驻到 DSH 进程结束。

| # | 项 | 影响 | 处理 |
| --- | --- | --- | --- |
| P1-1 | 标签页无上限 | 多开时线性吃内存（+92.8 MB/标签），最坏打到 cgroup 上限被 OOM 杀 | 新增配置 `maxTabs`（默认 5，夹 `1..50`）；`#newTab` 先准入再 `newPage`，超限报 `BROWSER_TAB_LIMIT`，文案列出 `maxTabs` 与当前标签，并提示 `browser_close_tab` / `browser_reset_session`；**拒绝时不留半开的页** |
| P1-2 | 插件的 CDP 连接常驻 ⇒ `idleMs` 失效 | 内核 + 渲染进程约 600 MB 在 DSH 整个生命周期内不回收 | 最后一个会话关闭后插件**主动断开**连接（`#releaseIfIdle`，只在没有任何会话时执行）；此后守护进程按 `idleMs` 空闲退出，下一次调用按 F25 自愈拉起 |
| P1-3 | `idleMs` 只能手改 `autoStartCommand` | 想调回收窗口得自己拼命令，容易漏 `--idle-ms` | 新增配置 `idleMs`（默认 300000 = 5 分钟，夹 `1000..86400000`），由 `defaultAutoStartCommand(config)` 拼进自启命令；不配则不带该参数（向后兼容），越界夹住而不是让自启直接失败 |

- 验收：`verify-provider.mjs` 95 → **110**。新增 15 项：① 配置默认值 5 项（`maxTabs` 默认 5、`idleMs` 默认 300000、自启命令带 `--idle-ms`、越界夹到 `1000..24h`、不配不带参数）；② `maxTabs` 6 项（上限内可开、第 4 个报 `BROWSER_TAB_LIMIT`、文案含上限与现有标签 URL、拒绝后标签数不变、关一个后槽位释放、`reset_session` 收回 1 个）；③ 无会话释放连接 4 项（会话活着时不自启、关掉最后一个会话后守护进程在 `idleMs` 内自行退出、内核随后被收走、再次调用自启回来且页面可用）。
- `scripts/verify-provider.mjs` 里共享测试守护进程的 `--idle-ms` 从 120000 提到 3600000：P1-2 修好后，2 分钟的测试实例会在套件中途真的空闲自杀。
- 磁盘：`.browser` 残留清理 504 MB → 389 MB（删掉未被任何配置/脚本引用的 `moli`/`pw`/`profile`/`daemon-profile`；内核、`libs`、字体与包装脚本保留）。
- 测试面：给新增段补上 `actionTimeoutMs`——测试是直接调 `createProvider` 的，漏了它就会得到 `执行超时（undefinedms）`；真实安装走 schema 默认值，不受影响。

## [0.4.4] — 2026-09-27

起因：完整测试（活实例 + 三条验收套件）时，用**复用连接**的 HTTP 客户端发现同一条 TCP 连接上的第二个请求可以绕过凭据门与白名单。

### 修复

- **F27 代理 keep-alive 免检**：代理每条连接只在 `onData` 里解析一次请求头，解析完即 `client.pipe(up); up.pipe(client)` 变成裸管道。于是先带真 token 请求一次 `GET /json/version`（200），再在同一条连接上 `PUT /json/new`（无凭据）也拿到 200（应 403），错 token 同样不被拦。危害有限（要先持有合法 token，而持有 token 本就能走 `/devtools/*`），但「挡掉 `/json/new|close|activate`」的安全承诺不成立。
  - 修法：非 WebSocket（`Upgrade`）请求一律按 `connection: close` 转发；元数据分支回完即 `client.end()`；普通 HTTP 分支改为**单向**转发（不再把客户端接回上游），上游空闲 2s 收尾，连接不留悬挂；CDP WebSocket 长连接仍双向 pipe（F20 的行为不变）。
- 验收：`verify-daemon.mjs` 32 → **35**。原来那条「`/json/protocol` 长连接空闲 11s 仍存活」的 F20 断言（F27 修好后本就不该再成立）换成「**CDP WebSocket** 空闲 11s 后仍可用」，并新增「同一连接上的第二个请求拿不到 200」「代理在响应后主动收掉非升级连接」。

## [0.4.3] — 2026-09-27

起因：接缝工具 schema（来自依赖 `dsh-builtin-browser`，作用在**所有** provider 上）对 `browser_screenshot` / `browser_download` 的 `savePath` 写的是「必须落在 configured `downloadDir` 内（默认＝系统 Downloads 目录）」，而本 provider 在 `downloadDir` 未配置时**不做任何目录限制**——描述与行为不一致，且提示注入能诱导浏览器工具写任意绝对路径。

| # | 项 | 影响 | 处理 |
| --- | --- | --- | --- |
| D1 | `downloadDir` 未配置＝目录不设限（描述与行为不一致、且可被提示注入利用） | `#admitSavePath` 只拦「相对路径 + 覆盖已有文件」；模型按 schema 的说明以为写进了 Downloads，实际写到了任意位置 | 新增 `defaultDownloadDir()`（与内置 `ElectronBrowserProvider` 完全同语义：存在的 `XDG_DOWNLOAD_DIR` 优先 → 家目录下存在的 `Downloads`/`下载`/`下載` → 回落 `~/Downloads`，目录在首次写入时由 `mkdir(recursive)` 建出来）；`downloadDir` 现在恒有值，准入从「配了才限范围」变成「始终限范围」，去掉 `#admitSavePath` 里 `undefined` 的分支 |

- 验收：`verify-provider.mjs` 88 → **95**。新增 7 项：默认目录的四条解析规则（都不存在 → `~/Downloads`／本地化目录优先／存在的 `XDG_DOWNLOAD_DIR` 最优先／不存在的 `XDG_DOWNLOAD_DIR` 被忽略）、未配置 `downloadDir` 时默认目录之外被拒（截图与下载两条）、默认目录内可写入且目录被建出来。
- **升级必读（行为变化）**：`savePath` 默认只能写进系统 Downloads 目录，`savePath: /tmp/x.png` 这类写法现在会被拒（`BROWSER_SCREENSHOT_BLOCKED` / `BROWSER_DOWNLOAD_BLOCKED`）。要写进工作区或别处，就在 profile patch 的 `browser-moli` 行 `config` 里显式配 `downloadDir`（patch **整行替换** `config`，覆盖时该行其它键要重述）。

## [0.4.2] — 2026-09-27

**纯文档版：代码与 0.4.1 完全相同**，只为让 npm 页面与仓库首页用上对齐生态后的 README（npm 只渲染已发布 tarball 里的 README）。

- README 按同类热门插件（Tencent/BrowserSkill、dsh-web、dsh-browser 等 15 个抽样）的共性重写：徽章 + 英文 TL;DR + 语义化章节（这是什么 / 快速开始 / 环境要求与兼容性 / 工具参考 / 配置 / 架构 / 已知限制 / FAQ / 升级与卸载 / 进度 / 更新记录 / 文档 / 贡献 / 许可），编号章节退场。
- 新增 **33 个 `browser_*` 工具参考表**与 **13 个配置键的完整表**。原表只在 `plugin/README.md`，且其中 `connectTimeoutMs` 写作 `30000`、`actionTimeoutMs` 写作 `15000`，与 `plugin/lib/index.js` 的 `10000` / `30000` 不符（本轮一并修正，并把配置表的归属收敛到根 README）。
- 版本变更史从 README 抽出为 `CHANGELOG.md`（Keep a Changelog 风格）；32 条验收 PASS 原文与 seam-probe 端到端日志移到新增的 `docs/verification.md`。
- docs 去内部代号并改名：`provider-m2.md` → `architecture.md`、`feasibility.md` → `design-notes.md`、`profile-patch.browser-moli.yml` → `profile-patch.browser-service.yml`（用 `git mv` 保留历史）。
- 新增 `CONTRIBUTING.md`；README 里指向包内文件的链接全部改为绝对 GitHub URL（npm 侧对相对链接的重写行为未能实测，Cloudflare 拦截 npm 页面）。

## [0.4.1] — 2026-09-27

- **只为修正 npm 页面上的 README**（0.4.0 的 tarball 里是发布前的文本，还写着「没有走 npm、名字还空着」）。**代码与 0.4.0 完全相同。**
- `scripts/verify-bundle.mjs` 修掉一处会随版本腐烂的写法：默认 tarball 路径原本把 `0.4.0` 写死在脚本里，改为从根 `package.json` 读 `version`。不改这里，下次改版本号验收就会去打包不存在的文件。

## [0.4.0] — 2026-09-27

起因：插件市场（[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)）的一键安装只能装**一个**包，而 v0.3.3 的形态是「工具包 + 插件子包」两个交付物、且必须先把第三方接缝包 `dsh-builtin-browser` 装成组合包才生效 ⇒ 市场里装到的只是 provider，**装完即坏，且没有任何报错**。v0.4.0 把三者合成一个包。

| # | 项 | 做法 |
| --- | --- | --- |
| U1 | 合并交付物 | 删除 `plugin/package.json`（子包不再存在）；根 `package.json` 声明 `dsh.bundle.patch`，`exports` 暴露 `.`（provider）、`./browser`、`./tool-browser`（转出口）、`./cordis.patch.yml`、`./package.json` |
| U2 | 自己挂接缝 | 新增 `plugin/shims/browser.js` 与 `plugin/shims/tool-browser.js`，从依赖 `dsh-builtin-browser` 转出 seam 插件与 33 个工具；patch 改为 `insert` 三行（`browser` 选 `cdp-daemon`、`tool-browser`、`browser-moli`），不再依赖别的组合包先插入 |
| U3 | 默认自启 | `plugin/lib/provider.js` 新增 `defaultAutoStartCommand()`：未配 `autoStartCommand` 时用**本包自带的** `bin/browsersvc.mjs`（`new URL('../../bin/browsersvc.mjs', import.meta.url)`），装完重启 DSH 即用 |
| U4 | 转出口形状 bug（自查发现） | `dsh-builtin-browser/tool-browser` **没有 default 导出**（只有具名 `name`/`apply`/`inject`），最初写成 `export { default }` 会在组合期报 `does not provide an export named 'default'`；改为 `export *`（`browser` 侧两个都留），并在 `verify-bundle.mjs` 里加「转出口导出键 ≡ 源模块」断言 |
| U5 | **F26**：`--internal-port-base` 被静默忽略 | `src/config.mjs` 里该键只读 `config.json`，CLI 传了没用（USAGE 却宣传了它）⇒ 改为 `CLI > config.json > 默认`，并补验收（`internalPort === 19700`） |
| U6 | 发布到 npm | 2026-09-27 发布 `dsh-moli-browser@0.4.0`，同日重发 `@0.4.1`（见上）。在一次性隔离 `DSH_HOME` 里实测短命令 `dsh plugin --profile np add dsh-moli-browser@latest`：bundles 追加本包、`--dump-config` 出 `# == dsh-moli-browser` 层与 `browser`（`browserProvider: cdp-daemon`）/`tool-browser`/`browser-moli` 三行，装进来的 `bin/browsersvc.mjs` 为 755 |

验收：`verify-daemon.mjs` 31 → **32**、`verify-provider.mjs` 86 → **88**、`verify-bundle.mjs` 重写为 **23 项**（+ npm 短命令安装实测）：单一交付物形状、`add` 后 `--dump-config` 四行齐全且无 `not found`、默认自启指向包内 bin、转出口形状比对、`remove` 清理。隔离 web 模板 profile 里跑通了真实的 DSH 内端到端。

## [0.3.3] — 2026-09-27

按 DSH 官方《打包与安装插件》（官方仓库 `deepseek-ai/deepseek-harness` 的 `docs/user/develop/basic/publish.zh.md`）逐条核对本包的打包/安装路径，修掉 4 处不符合、未文档化或写错的地方。

| # | 项 | 影响 | 处理 |
| --- | --- | --- | --- |
| B1 | 文档里的安装命令语法错误 | `dsh plugin add <pkg>` 少了必需的 `--profile`（`dsh plugin --help` 里 `--profile <name>` 是 required）⇒ 照抄必然失败 | 改为官方形式 `dsh plugin --profile <name> add <包名\|tarball>`，并写明 tarball 是官方推荐的「免构建授权」交付形式 |
| B2 | 组合包的**安装顺序**是硬要求，但此前只写在内部分析里 | `browser`/`browser-electron`/`tool-browser` 三行由第三方组合包 `dsh-builtin-browser` 插入，当时的插件子包 patch 第 2/3 条按 id 覆盖它们；子包的层若排在 seam 包之前，loader 只打印 `patch: entry "browser" not found` 并静默丢弃覆盖行 ⇒ seam 仍选内置 Electron provider（「装上了但没生效」，没有任何报错） | patch 头注释与安装文档写清前提与校验期望；v0.4.0 起改为**本包自己插入这三行**（见 0.4.0），顺序问题随之消失 |
| B3 | `@deepseek-ai/cordis` 声明为可选 peer，但从未使用 | 官方 peer 规则是「需要与宿主共享实例」才声明；本插件零 import cordis，loader 也不校验范围 ⇒ 纯噪声 | 删除 `peerDependencies` / `peerDependenciesMeta` |
| B4 | 工具数一度被改回 32（**自我回归**） | 数工具的命令 `grep -o "name: 'browser_[a-z_]*'"` 的字符类漏了数字，`browser_a11y` 被静默漏掉 ⇒ 32；照这个数改文档，就把上一轮 `dd45fca` 的正确修正又翻了回去 | 以**运行期**实测为准：用 stub `ctx` 跑 `tool-browser` 的 `apply()`，`ctx.tools.register` 收到 **33** 个 `browser_*` 工具（含 `browser_a11y`）；全文统一为 33，并记下这个陷阱 |

新增验收：`scripts/verify-bundle.mjs`（16 项起）—— 一次性隔离 `DSH_HOME` 里跑官方流程。打包命令改为官方推荐的 `pnpm pack`。

## [0.3.2] — 2026-09-27

v0.3.1 上线后按「停掉守护进程 → 再调用浏览器」验证，发现最后一条只在运行进程里才会暴露的缺陷：

| # | 缺陷 | 复现/影响 | 修复 |
| --- | --- | --- | --- |
| F25 | 自启「每进程只允许一次」的开关连上之后不复位 | 守护进程消失（按 `idleMs` 空闲自杀、崩溃、被 OOM 杀、手动 `browsersvc stop`）而 DSH 还活着时，provider 直接报 `browser: 无法连接 CDP 端点 http://127.0.0.1:9333（… ECONNREFUSED …）；请先运行 browsersvc start`，**再也不自启** ⇒ 浏览器一直不可用，直到重启 DSH | 连接成功后把 `#autoStarted` 复位。防风暴不受影响：同一轮失败仍只自启一次（自启后仍连不上就保持锁定，不会反复拉起） |

新增验收：`verify-provider.mjs` 83 → **86**（冷启动自启一次后连上、守护进程消失后能再次自启、自启仍失败时不反复拉起）。三条断言都先在修复前跑过并确认会失败（旧代码 `autoStart` 只被调用 1 次）。

## [0.3.1] — 2026-09-27

v0.3.0 装进运行实例后按「重启 → 真实调用浏览器」验证，又暴露出 4 条只有活实例才能撞到的缺陷，以及 1 条验收脚本自身的残留：

| # | 缺陷 | 复现/影响 | 修复 |
| --- | --- | --- | --- |
| F19 | provider 自启后重试不带新 token | 冷启动（状态文件里还没有 token）时第一次 `connectOverCDP` 失败 → `autoStartCommand` 拉起守护进程并写入新 token → 重试仍用**旧**（空）token ⇒ 必 401，浏览器冷启动后第一次调用不可用 | token 读取移进每次 `connectOverCDP` 尝试内部（`#attach` 的 `attach()` 闭包），每次重试重读状态文件 |
| F20 | 请求头超时定时器未撤，10s 后拆掉长连接 | 连接建立 10s 后 `proxy: 408 request headers timeout` → `settle()` → `destroyBoth()`，CDP WebSocket 长连接被误杀；表现为「会话内没有可用标签页」、`/json/list` 只剩 about:blank | 请求头解析成功后立刻 `clearTimeout(headTimer)` |
| F22 | 连接被换掉后会话永久失效 | 守护进程重启 / F20 拆线 / 内核崩溃后，旧 context/page 随旧连接失效，而内置工具层按 task **永久缓存** session id 且从不重开（`ensureSession`）⇒ 之后每一次 `browser_*` 调用都报「会话内没有可用标签页」，直到人工 `browser_reset_session` 或重启 DSH | 所有会话操作前先走 `#liveSession(id)`：连接不是同一条、或当前标签页已死时，在新连接上按原 session id 重建 context+page（审计历史 `history` 保留） |
| F23 | `browsersvc restart` 变成「只停不起」 | `print()` 内部 `process.exit()`，`restart` 里 `await stop(...)` 打完 JSON 就退出，`start` 永不执行：实例被停掉却报 `stopped: true` 收场 | `start`/`stop` 增 `quiet` 模式（返回结果而不打印/退出，成功后**立即返回**而不是继续轮询到超时），`restart` 用 quiet 跑两步再统一输出 `{restarted, stopped, started}` |
| F24 | 验收脚本 restart 后收不干净 | `verify-provider.mjs` 的 `shutdown()` 只杀自己 spawn 的子进程，F22 用例重启出来的实例不是它 ⇒ 残留守护进程占着端口（下次运行 `EADDRINUSE`）+ 残留内核 | `shutdown()` 末尾再走一次 CLI `stop --root=<root>`（带 F3 身份校验），覆盖重启出来的实例 |

新增验收：`verify-provider.mjs` 77 → **83**（守护进程 restart 真的停旧起新、token 换新、重启后同一个 session id 仍可 execute/导航、连接重建后会话复活），`verify-daemon.mjs` 26 → **31**（隔离 root 真实跑 `start → restart → stop`、restart 后 token 换新、restart 后的实例可正常 stop）。

## [0.3.0] — 2026-09-27

独立代码审查（隔离脚本 + 复核）逐条复现后修复，按严重度：

| # | 缺陷 | 复现/影响 | 修复 |
| --- | --- | --- | --- |
| F1 | `savePath` 无准入门（严重） | 任意绝对路径写入、`../` 逃逸并自动建目录、静默覆盖已有文件 | provider 加 `#admitSavePath`（镜像内置语义：绝对路径 / `downloadDir` 内 / 不覆盖），截图与下载都走它 |
| F2 | 启动失败泄漏内核（严重） | `EADDRINUSE` 后孤儿 chromium 存活、无状态文件可回收 | 启动主流程包 `try/catch` → `shutdown('startup-failed')`；`spawn` error 钩子；未就绪先杀内核再抛 |
| F3 | `stop` 无身份校验（严重） | pid 复用/陈旧状态文件时可向陌生进程发 SIGKILL | `stop` 先读 `/proc/<pid>/cmdline` 校验（supervisor 含 `browsersvc.mjs`、内核含 `--remote-debugging-port=<内部端口>`），不匹配则拒绝并保留状态文件，`--force` 才强杀 |
| F4 | 内核不可执行时行为不明 | 崩栈/静默 | `assertKernelExecutable`（存在 + 普通文件 + `X_OK`），在 spawn 之前 |
| F5 | 连接计数被半关连接卡住 | 上游 `allowHalfOpen` 时 `connections` 恒 ≥1 ⇒ 空闲回收永不触发 | 计数改由首次认证通过时 +1、任一侧 close/error 一次性释放（幂等）+ 5s 兜底强拆 |
| F6 | 并发 `open` 重复握手 | 旧连接被覆盖后不再关闭；旧连接迟到的 `disconnected` 会清掉新连接 | `#connecting` 单飞 + `#conns` 集合，`disconnected` 只清自己那条，`dispose` 关闭全部 |
| F7 | 公开端口无凭据、无路径白名单（中等） | 同机任意进程可完全操控浏览器、读 cookie | Bearer token 门 + 方法/路径白名单（`/json/new\|close\|activate` 一律 403）+ 改写 `webSocketDebuggerUrl` 走代理 |
| F8 | `#terminate` 泄漏 CDPSession | 每次卡死重建标签页都漏一个 session | `.finally(() => cdp.detach())` |
| F9 | 数值配置无校验 | `--port=99999` / 负数 / 非整数静默生效 | `src/config.mjs` 的 `LIMITS` + `num(v, key)`，越界即报错并回 JSON+exit 2 |
| F10 | `start` 成功判据不严 | 陈旧状态文件可被误报为「已启动」 | 判据同时要求 `listening === true && supervisorPid === child.pid && port` |
| F11 | `logs --lines` 未校验 | `--lines=0`/负数行为未定义 | 必须正整数，否则 JSON 报错 + exit 2 |
| F12 | 打包保留本机 umask 权限 | 仓库里是 100644，打出的 tgz 里出现 0600（`bin/browsersvc.mjs` 还会因为不可执行而让 POSIX 下的全局 shim 失效） | 打包前 `chmod -R u+rwX,go+rX`，并把 `bin/browsersvc.mjs` 置为 100755 |
| F13 | `content` 截断切开代理对 | `maxChars` 落在 emoji 中间时输出半个字符 | 截断点回退一个 UTF-16 单位（不在高代理处切） |
| F14 | `open()` 失败泄漏 BrowserContext | `newPage()` 抛错时上下文不关 | 失败路径 `await context.close()` |
| F15 | `autoStartCommand` 超时不可配 / 经 shell | 超时写死，命令经 shell 解释 | `autoStartTimeoutMs`（默认 60s）+ `shell: false` |
| F16 | 日志文件随 umask | 可能 0644 | `openSync(logFile,'a',0o600)`；`ensureRoot` 对已存在目录/日志显式 `chmod` |
| F17 | CLI 未透传 `--start-timeout` / `--internal-port-base` | 只能靠环境变量 | `toCfg` 补两个参数 |
| F18 | 验收脚本失败时留进程/临时目录 | 中断即留残余 | `process.on('exit')` 清理（内核 + 所有临时 root） |

同批新增/加强的验收断言（`verify-daemon.mjs` 13 → **26**，`verify-provider.mjs` 67 → **77**）：401/403 凭据门、ws 地址改写、状态文件权限、越界 `--port`、`--lines=0`、内核不存在/不可执行/未就绪三种启动失败 + 不留孤儿与状态文件、`stop` 身份校验与 `--force`、错误 token 无法 attach、`savePath` 准入 6 项、4 路并发 attach、代理对截断。

## 0.3.0 之前

0.1.x / 0.2.x 是本项目自己的内部迭代（守护进程雏形 → 回环代理与空闲回收），没有对外发布，未在此记录。
