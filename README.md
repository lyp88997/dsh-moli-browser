# dsh-moli-browser

[![npm version](https://img.shields.io/npm/v/dsh-moli-browser)](https://www.npmjs.com/package/dsh-moli-browser)
![license](https://img.shields.io/badge/license-MIT-blue)
![node](https://img.shields.io/badge/node-%3E%3D22.19-brightgreen)
![browser tools](https://img.shields.io/badge/browser__tools-33-informational)
![no root](https://img.shields.io/badge/root-not%20required-success)
![verification](https://img.shields.io/badge/verification-35%2F125%2F70%2F86-success)

**给 DSH 一个能跑在无 root、无 GUI 容器里的浏览器。** 一个包、一条 `dsh plugin add` 装完即用：单例 CDP 守护进程（用户态 `chrome-headless-shell`，只绑回环、带 Bearer token 门）+ 完整的 33 个 `browser_*` 工具面 + `ctx.browser` 接缝的 `cdp-daemon` provider + 一个网页浮动窗口（实时画面可点可打字）+ 两份随包全局技能。不需要 Electron、不需要 GUI 库、不需要 root、没有构建步骤。

> **English TL;DR** — A single-package browser backend for DSH. One tarball ships a singleton CDP daemon (user-space `chrome-headless-shell`, bound to loopback behind a Bearer-token proxy), the full 33-tool `browser_*` surface, the `ctx.browser` seam provider `cdp-daemon`, an in-page floating panel (live interactive view + logs + appearance settings) and two bundled global skills. No root, no GUI libraries, no Electron, no build step.
> ```bash
> dsh plugin --profile web add dsh-moli-browser@latest   # then restart DSH
> ```

---

## 界面预览

**一处入口，一个窗口。** 装完插件、重启一次 DSH，页面左上角就多出一枚小胶囊（贴哪个角、偏多少都能改，也可以直接拖到任意位置）。点开就是浏览器窗口：左边一竖排入口（网页 / 操作 / 控制台 / 网络 / 设置），中间是**能点、能滚、能打字的实时画面**，右下角能拖宽窄，标题栏能拖、双击能最大化。

| 实时画面（默认入口）：能点、能滚、能打字 | 在真 DSH 界面里：居中、贴合画面比例、没有黑边 |
|---|---|
| ![实时画面](https://raw.githubusercontent.com/lyp88997/dsh-moli-browser/main/docs/images/panel-live.jpg) | ![真机效果](https://raw.githubusercontent.com/lyp88997/dsh-moli-browser/main/docs/images/panel-real.jpg) |

| 设置区：分辨率、顶部留白、胶囊偏移、窗口外观 | 网络日志：手动清理 + 自动清理上限 | 收起后的胶囊：位置与外观都跟随设置 |
|---|---|---|
| ![设置区](https://raw.githubusercontent.com/lyp88997/dsh-moli-browser/main/docs/images/panel-settings.jpg) | ![网络日志](https://raw.githubusercontent.com/lyp88997/dsh-moli-browser/main/docs/images/panel-logs.jpg) | ![胶囊](https://raw.githubusercontent.com/lyp88997/dsh-moli-browser/main/docs/images/panel-pill.jpg) |

<details>
<summary>为什么大屏页面也能看清（0.8.2 修掉的「画面糊」）</summary>

<br>

取帧曾经漏发 `maxh`，被服务端当成 0 夹到下限 240，于是 1920×1080 的页面被等比压进 `max×240` 的小框、再被界面放大。0.8.2 起：缺字段沿用当前值、**最大边同时封顶宽高**、大屏页面按原尺寸下发。

![清晰帧](https://raw.githubusercontent.com/lyp88997/dsh-moli-browser/main/docs/images/panel-sharp.jpg)

</details>

## 目录

- [这是什么 / 它解决什么问题](#这是什么--它解决什么问题) ｜ [安装](#安装) ｜ [快速开始](#快速开始起守护进程)
- [CLI 参考](#cli-参考browsersvc) ｜ [工具参考](#工具参考33-个-browser_) ｜ [网页面板与实时窗口](#网页面板与实时窗口)
- [随包技能](#随包技能技能中心里显示系统内置) ｜ [配置](#配置) ｜ [观测与状态文件](#观测与状态文件)
- [环境要求与兼容性](#环境要求与兼容性) ｜ [FAQ](#faq) ｜ [更新记录](#更新记录) ｜ [文档](#文档)

## 这是什么 / 它解决什么问题

| 现状问题 | 本项目的做法 |
|---|---|
| DSH 内置 `dsh-builtin-browser` 的 provider 是自托管 Electron：没有 Electron 二进制、没有 GUI 库、seccomp 下 `No usable sandbox!` | 用系统已有的 `chrome-headless-shell`，`--no-sandbox --disable-dev-shm-usage`，库用用户态目录，不需要 root |
| 每个消费方各起一个浏览器（内存重复） | **一个守护进程**，多客户端通过 CDP 连入，会话用隔离 `BrowserContext` 分开 |
| CDP 端口若对外监听 = 把浏览器（含 cookie）交给主机上任意进程 | 内核只绑 `127.0.0.1:<内部随机端口>`，对外只暴露**本机回环代理**（要求 Bearer token，只放行读元数据与 `/devtools`）；代理顺带精确统计连接数 |
| `dsh-univer-office` 只接受「浏览器可执行文件路径」，无法连远端 CDP | 同一个内核外面套一层包装脚本当 `browserExecutablePath`（同一份二进制与库，不共享进程） |

## 安装

```bash
# 一条命令（推荐；可重复执行）
dsh plugin --profile web add dsh-moli-browser@latest

# 钉版本 / 离线分发（同一个包）：Release 资产或本地 tarball
#   dsh plugin --profile web add https://github.com/lyp88997/dsh-moli-browser/releases/download/v0.8.2/dsh-moli-browser-0.8.2.tgz
#   dsh plugin --profile web add ./dsh-moli-browser-0.8.2.tgz

# 然后重启 DSH（插件在 boot 时 import，热重载不可靠），再校验组合：
dsh --profile web --dump-config | grep -E 'browserProvider|# == dsh-moli-browser|not found'
```

期望看到 `browserProvider: cdp-daemon`、`# == dsh-moli-browser` 层；`browser-electron` / `playwright-browser` 两条守卫行会打印 `not found`（只装本包时这两个 id 不存在，无害）。

**装完这一个包就有什么**

- **33 个 `browser_*` 工具**（`id: tool-browser`）：工具面与接缝来自本包依赖 `dsh-builtin-browser`，经本包 `./browser` / `./tool-browser` 转出口暴露（`plugin/shims/`）。
- **`cdp-daemon` provider**：接到自建守护进程，首次用浏览器时用**本包自带**的 `bin/browsersvc.mjs start` 自动拉起。
- **网页浮动窗口**：实时画面（可点/滚/打字/地址栏）、操作/控制台/网络日志、窗口外观与设置。
- **两份随包技能**：`browser`、`browser-runtime`，由插件注册的**内置技能提供者**提供，技能中心里显示「系统内置」。

**三条不要做的事**

- **不要再单独装 `dsh-builtin-browser`**：它若同时是组合包，`browser`/`tool-browser` 两个 id 会被插两次、33 个工具重名挂两遍。已装过就先 `dsh plugin --profile <name> remove dsh-builtin-browser`。
- **不要用旧名 `dsh-browser-moli` 当裸包名**（v0.4.0 之前子包的名字）：npm 上的 `dsh-browser-moli` 是别人的同名包（drscrewdriver，0.17.4），写了就装到别人家。本包自 2026-09-27 起以 `dsh-moli-browser` 发布，当前版本 **0.8.1**。
- **不要与手写 patch 同时用**：bundle patch 与手写 `profiles/<name>/cordis.patch.yml` 的 `insert` 行会重复（写法见 [`docs/profile-patch.browser-service.yml`](https://github.com/lyp88997/dsh-moli-browser/blob/main/docs/profile-patch.browser-service.yml)，只在改源码时临时用）。

组合（`plugin/cordis.patch.yml`）自动做四件事：插入接缝 `browser`（选 `cdp-daemon`）、插入 `tool-browser`、插入 `browser-moli` provider、关掉内置 `browser-electron` 与 `dsh-playwright-browser`（后者自带 10 个与内置**同名**的 `browser_*` 工具，两个 provider 的工具面不能共存）。

**不需要配置 `autoStartCommand`**：端点不通时插件默认用**本包自带的** `bin/browsersvc.mjs start` 拉起一次（`plugin/lib/provider.js` 的 `defaultAutoStartCommand()`）。想换端口/内核，再在 profile 的 `cordis.patch.yml` 里覆盖（patch 是**整行替换** `config`，要重述 `cdpUrl`）：

```yaml
- id: browser-moli
  config:
    cdpUrl: http://127.0.0.1:9333
    autoStartCommand: node /home/you/dsh-moli-browser/bin/browsersvc.mjs start --port=9333
```

`browsersvc` 默认空闲 15 分钟自杀（`--idle-ms`，上限 24 小时）；插件自启时默认用 5 分钟（配置键 `idleMs`）。**最后一个会话关闭后插件会主动断开 CDP 连接**（P1），守护进程才可能真的空闲退出；下一次调用浏览器会自动把它拉回来（F25，见 [CHANGELOG](https://github.com/lyp88997/dsh-moli-browser/blob/main/CHANGELOG.md)）。

> ⚠️ 改完**必须重启 DSH**（插件在 boot 时 import，热重载不可靠）：运行中的完整 web profile 上 `patchReload: live` 会静默回滚（进程 stdout 归 docker，看不到报错），干净进程里 boot 完全正常。

### 升级与卸载

```bash
# 升级（@latest；钉版本就用 Release 资产 URL 或本地 tgz）
dsh plugin --profile web add dsh-moli-browser@latest

# 卸载（依赖与层一起清）
dsh plugin --profile web remove dsh-moli-browser

# 顺手停掉守护进程（可选）
node "$(dsh --profile web --dump-config >/dev/null 2>&1; echo ~/.dsh/profiles/web/node_modules/dsh-moli-browser)/bin/browsersvc.mjs" stop
```

**版本兼容**：插件与 `browsersvc` 必须同版本升级。v0.3.0 起公开端口要求 `Authorization: Bearer <token>`，旧插件对新守护进程会在 401 上失败。升级顺序：**先换插件（重启 DSH），再 `browsersvc restart`**。

> `@latest` 在「已装版本仍满足依赖范围」时**不会**升级；要确保换版本就用 Release 资产 URL 或本地 tgz 钉住。

**从 0.3.x 升到 0.4.x 及以上**：交付物从「工具包 + 插件子包」变成**一个包**，旧装法留下的两个包要清掉：

```bash
dsh plugin --profile web remove dsh-browser-moli      # 旧子包名（本地 tarball 装的话）
dsh plugin --profile web remove dsh-builtin-browser  # 现在由本包依赖提供
dsh plugin --profile web add dsh-moli-browser@latest
```

## 快速开始：起守护进程

装上之后首次调用浏览器时插件会自动拉起守护进程，所以这一步通常可以跳过；想手动起、或要固定端口/内核时：

```bash
# 1) 看本机能用哪个内核（会依次看环境变量、常见落点、PATH）
node bin/browsersvc.mjs detect

# 2) 起服务（默认端口 9333，root 默认 $DSH_HOME/browser-service）
node bin/browsersvc.mjs start --port=9333 --idle-ms=900000

# 3) 验证
node bin/browsersvc.mjs status
TOKEN=$(node -p 'JSON.parse(require("fs").readFileSync(process.env.DSH_HOME+"/browser-service/service.json","utf8")).token')
curl -s -H "Authorization: Bearer $TOKEN" 127.0.0.1:9333/json/version

# 4) 停
node bin/browsersvc.mjs stop
```

本机（DSH 容器）实测可用的一行：

```bash
node bin/browsersvc.mjs start \
  --wrapper=/home/node/DSH/.browser/chromium-wrapper.sh \
  --port=9333 --idle-ms=900000
```

`--wrapper` 指向的包装脚本负责注入 `LD_LIBRARY_PATH`（用户态 43 个包）、`FONTCONFIG_FILE`（中文渲染）、并追加 `--no-sandbox --disable-dev-shm-usage`。没有包装脚本时，用 `--kernel=/path/to/chrome-headless-shell` 直接指定内核，但**必须**保证系统库与字体可用（否则截图纯白、中文变方块）。

### 给 `dsh-univer-office` 用

```yaml
- id: univer
  config:
    browserExecutablePath: /home/node/DSH/.browser/chromium-wrapper.sh
```

保持现状即可：univer 用同一份二进制与库，自己起临时实例（它没有 `connectOverCDP` 能力，分析见 [`docs/design-notes.md`](https://github.com/lyp88997/dsh-moli-browser/blob/main/docs/design-notes.md)）。

## CLI 参考（`browsersvc`）

| 命令 | 说明 |
|---|---|
| `detect` | 打印候选内核与已解析配置 |
| `start` | 后台拉起守护进程并等到 CDP 就绪（已运行且健康则直接返回） |
| `stop` | 先停 supervisor，再兜底清理浏览器进程与状态文件（动手前校验 pid 身份，`--force` 跳过） |
| `status` | 打印状态；**健康退出码 0，未运行 1**（便于脚本判断） |
| `restart` | stop + start |
| `run` | 前台运行（`start` 内部用它做后台进程） |
| `logs [--lines=60]` | 打印日志尾部 |
| `ops [--lines=20] [--json]` | **最近的操作**（工具动作、耗时、成败、会话/标签、错误原因）——数据来自 `<root>/ops.jsonl` |
| `console [--lines=40] [--json]` | **页面控制台**输出（log/error/warning + `pageerror`）——`<root>/console.jsonl` |
| `network [--lines=40] [--json]` | **网络请求**（method/url/状态码/耗时，不记头与体）——`<root>/network.jsonl` |
| `har [--session=s1] [--out=file]` | 会话关闭后落盘的 **HAR**（`<root>/har/`，只留最近 10 份），`--out` 复制出去 |
| `cookies [--url=…] [--json\|--export=file\|--import=file]` | **cookie + localStorage** 导出/注入到文件（`--export` 0600 且拒绝覆盖；`--import` 需有活会话） |
| `skills [--install] [--uninstall] [--force] [--dir=…] [--json]` | **随包技能**：不带 `--install`/`--uninstall` 只报每个文件的状态；`--install` 落盘（可选，默认 `$DSH_HOME/skills`）；`--uninstall` 撤掉落盘那份——见「随包技能」 |

参数：`--root` `--port`（0 = 自动择取）`--idle-ms` `--kernel` `--wrapper` `--user-data-dir` `--max-restarts` `--start-timeout` `--internal-port-base`，对应环境变量 `DSH_BROWSER_SVC_ROOT` / `DSH_BROWSER_SVC_PORT` / `DSH_BROWSER_SVC_IDLE_MS` / `DSH_BROWSER_CHROME` / `DSH_BROWSER_WRAPPER`，也可写进 `$ROOT/config.json`。优先级：**CLI > 环境变量 > config.json > 自动探测**。`skills` 另有 `--dir` / `--force` / `--json`。

## 工具参考（33 个 `browser_*`）

工具面与内置 `dsh-builtin-browser` **完全一致**（同一份 `tool-browser` 模块，经本包转出口挂出），所以 `browser_*` 的语义、参数与 `target {by: css|text|xpath}` 定位方式都沿用内置文档。按用途分组：

**打开与导航**

| 工具 | 说明 |
|---|---|
| `browser_open` | 打开 URL（只接受 http(s)；首次调用会按需自启守护进程） |
| `browser_wait` | 等到页面就绪：load complete，可等期望 URL 或某个 CSS 选择器出现 |
| `browser_back` / `browser_forward` | 历史后退 / 前进（无历史时是 no-op） |
| `browser_refresh` | 重新加载当前页 |
| `browser_challenge` | 检测人机校验（Cloudflare / reCAPTCHA / hCaptcha / Turnstile）是否挡住当前页 |

**读取页面**

| 工具 | 说明 |
|---|---|
| `browser_a11y` | 读无障碍树（语义角色 / 名称 / 状态，穿透同源 iframe 与 shadow root）——理解页面结构的首选 |
| `browser_snapshot` | 可交互元素快照（带编号，供视觉/文本驱动） |
| `browser_content` | 取页面内容：`html` / `markdown` / `txt` / `json`，可按选择器限定范围 |
| `browser_scrape` | 列表页结构化提取：给容器选择器 + 字段映射（`sel@attr`，`a@href` 取绝对地址）。**`item` 必须是容器**：字段选择器是在 `item` **内部**查找的，所以 `item: img` + `img@src` 取不到值，要写 `item: body` |
| `browser_screenshot` | 截屏（PNG/JPEG、fullPage、等比缩小、可落盘） |
| `browser_get_value` | 读单个输入/文本域/下拉/可编辑区的当前值 |

**操作与表单**

| 工具 | 说明 |
|---|---|
| `browser_click` | 点击：语义定位（css/text/xpath）或视口坐标（配 `browser_screenshot` 用） |
| `browser_type` | 向聚焦元素插入文本（`browser_key` 发 Enter/Tab/方向键等） |
| `browser_set_value` | 设值（原生 setter + input 事件，React/Vue 受控组件也生效） |
| `browser_fill` | 一次填一张表单（`fields[]` 支持 selector / name / label / placeholder，可提交） |
| `browser_check` | 勾选/取消 checkbox、radio |
| `browser_select` | `<select>` 选一项（按 value / 可见文本 / 序号） |
| `browser_clear` | 清空输入框，或取消勾选 |
| `browser_scroll` | 滚动（像素增量 / 滚到某元素 / 到顶到底） |
| `browser_execute` | 在页面里执行 JS（传表达式或函数，可带参数）——驱动页面的主力 |
| `browser_key` | 发送单个命名按键 |

**标签页与会话**

| 工具 | 说明 |
|---|---|
| `browser_list_tabs` | 列出标签页（id / url / title / 是否活动） |
| `browser_switch_tab` | 按 id 切换标签页 |
| `browser_close_tab` | 按 id 关标签页（关活动页会激活下一个） |
| `browser_reset` | 关掉全部标签页，开一个空白页重来 |
| `browser_session` | 查看本任务的浏览器会话（id 与标签页） |
| `browser_reset_session` | 重置本任务的浏览器会话（进程坏了/连不上时的兜底） |

**文件、凭据与调试**

| 工具 | 说明 |
|---|---|
| `browser_download` | 下载 URL 到本地文件（保留会话 cookie 与登录态） |
| `browser_auth` | 导出/恢复 cookies（登录态可保存到私有文件、重启后恢复） |
| `browser_history` | 列出本会话已执行的操作（navigate/execute/click/type，含成功与错误） |
| `browser_replay` | 按历史序号重放某一步 |
| `browser_restrict` | 限制允许的浏览器动作（软护栏，防误点误导航） |

## 网页面板与实时窗口

同一个包还带一个网页浮动窗口（收起时是页面上的小胶囊，点开是卡片）。它**不新增任何工具**，也不改 33 个 `browser_*` 的行为。左侧一竖排入口：**网页 / 操作 / 控制台 / 网络 / 设置**。

### 窗口本身（0.8.0 起）

按住标题栏拖动、拖右下角手柄缩放、双击标题栏或 `⤢` 最大化/还原、`收起` 回到小胶囊（默认左上角，设置里可换到任意一个角或「自由」位置，并可用水平/垂直偏移把它挪开几个像素；**胶囊本身也能直接拖到任意位置**，松手即记住）；位置与大小记在浏览器本地（`localStorage`，设置里可关）。窗口被拉出视口或浏览器窗口缩放时，会自动收回可见范围；胶囊同理——屏幕变小时按当前视口夹回屏内，但**只夹不改存**，视口放回去它自己就回到原处。

### 窗口外观（0.8.1 的 P8，只在客户端半边）

设置页第一段「窗口外观」，三项：

- **边框颜色**：默认「跟随主题」，也可选「无边框」或蓝/紫/绿/琥珀/红/青六个预设色，或用取色器自定任意颜色——只放行预设色或 `#rrggbb` 形状，别的一律回落主题色（这些值会写进 CSS 变量，所以先卡一道）。
- **背景不透明度**：40/60/80/95/100%，越低越透（**默认 40%**，0.8.2 起）。用 `color-mix(in srgb, 主题底色 N%, transparent)`，所以**底色仍随暗/亮主题走，只改实心程度**，不会把界面调成怪色。
- **玻璃效果**：关 / **毛玻璃**（`backdrop-filter: blur(10px) saturate(1.15)`，**默认**）/ 液态玻璃（`blur(18px) saturate(1.65)` 再加一道斜向高光与内圈描边光）。纯 CSS 近似，不做真折射；老浏览器上退化成半透明。

窗口和收起后的胶囊用的是**同一份外观**；**窗口「里面」也在同一份外观里**——标题栏、左侧入口竖排、底栏、列表吸顶条、保存栏都按同一个不透明度透出去，选了自定义边框色时这些分区的**分隔线**也用同色调一层浅的（45%）。「跟随主题」／「无边框」时内部分隔线保持宿主原本的细线，`无边框` **只**去掉最外圈那一条。

> 为什么专门写这一条：只把最外壳做成透明、而里面仍是实心主题底色时，看起来「只有边缘那条线在变」——这是真实反馈过的现象，修法就是把内部分区也接到同一份分层底色变量上。

### 设置是「改完再保存」（0.8.1 的 P8）

改任何一项都会**立刻先按新值显示**（方便预览），但只有点顶部吸顶栏的**「保存」**才写进浏览器本地并长期保留：

- 没保存时栏里是琥珀色 `● 有未保存的改动（窗口外观已先按新值显示）`，同时左侧「设置」入口和收起后的胶囊上有一个小圆点提醒；
- 保存成功出绿字 `✓ 已保存：窗口外观立即生效，刷新页面也保留。`；
- 浏览器不让写本地存储（无痕模式 / 站点策略）时出红字 `保存失败：这个浏览器不让写本地存储（无痕模式或站点策略），改动只在本次打开有效。`，**草稿不会被丢掉**；
- 「恢复默认」把外观各项恢复成默认值，同样要先保存才落盘。

### 「网页」入口 = 实时窗口（0.7.0 起，默认打开）

直接把浏览器当前标签的画面流到卡片里，**你能看到的那个页面就是真页面**——在窗口里点按钮、滚轮滚动、键盘输入、地址栏回车跳转，都会被原样打进真浏览器；对话里助手的调用与你在窗口里的操作作用在同一个页面上。

- **窗口播的是最近活跃会话的当前标签**：后端一个会话里可以有多个标签（`maxTabs` 默认 5，助手用 `browser_open` / `browser_switch_tab` 控制），窗口只显示 `session.active` 指向的那一个——也就是最近被打开/切换/操作的标签；面板目前没有切换标签的按钮，要换标签得让助手切（`live.json` 也暂不回标签清单）。
- 取帧走 [`plugin/lib/liveview.mjs`](https://github.com/lyp88997/dsh-moli-browser/blob/main/plugin/lib/liveview.mjs)：`Page.startScreencast`（JPEG，默认质量 70；「最大边」随请求下发、客户端默认 1920——0.8.3 起与默认视口同长边，0.8.2 及以前是 1280，服务端缺省回退仍 1280；质量默认值在 0.8.2 从 85 下调到 70）经我们的回环代理下发，**只在画面变化时发帧**（静止时零流量，实测一帧约 6.8 KB）；操作走 `Input.dispatchMouseEvent`/`insertText`/`dispatchKeyEvent`/`mouseWheel`。画质与最大边由客户端按当前设置随取帧请求发下去（`?quality=&max=&maxh=`，客户端把「最大边」同时当作宽与高的上限，即**长边上限**；缺字段沿用当前值、越界由服务端夹到安全范围），改完下一次取帧即生效。
  - 注意 CDP 是「等比缩到 `max × maxh` 的框里」，**只给 `max` 不给 `maxh` 会让大屏页面被压扁变小，画面看着就糊**（0.8.1 的 P7 修掉的真缺陷：缺 `maxh` 时高度上限被算成下限 240）。
- **只对本机回环请求开放**：非回环来源 403，跨站 POST 403（校验 `origin`/`referer` 与 Host 同源），方法白名单 405。若你从别的机器直连 DSH Web，日志入口照常、实时窗口会被拦。
- 省电：卡片收起/切换/暂停/页面不可见时客户端发 `DELETE` 停流；宿主半边 30 s 没收到取帧也自动停（`setInterval` 已 `unref`）。

### 日志入口与清理（0.8.1 的 P6/P7）

「操作 / 控制台 / 网络」三个入口的数据就是上面三个 JSONL 的尾巴（`?lines=` 默认 40，上限 200），所以 **CLI 与窗口看到的是同一份真相**；轮询间隔按设置（默认 2.5 s），页面不可见时停轮询，卡片上有「暂停/继续」「清理」与「收起」。

- 列表右上角「清理」点两次确认即清空该类日志（走宿主 `POST /browser-service/logs` 的 `clear`，同样的回环/同源/方法三道闸）；
- 设置里可配「自动清理」上限（关闭 / 1000 / 5000 / 20000），某类超过上限时保留最近一半（`trim`），只在面板打开着的时候检查；
- **成功或失败都会在窗口顶部出条提示**（`已自动清理：网络 12000 → 500` / `清理网络日志不可用：宿主没有这条路由（HTTP 404）——宿主半边是旧版，重启 DSH 后生效`），不会再出现「设了没反应」。

### 地址栏跳转（0.8.1 的 P6）

没写协议会自动补 `https://`（与服务端 `normalizeUrl` 同规则）；**一个浏览器会话都没有时会自己开一个再跳**（以前这条路径只会静默失败）；宿主拒绝的原因会显示在地址栏正下方，不再是「点了没反应」。

### 设置里还能调什么（0.8.0 / 0.8.1 的 P5/P6/P7）

- **画面质量**（40/55/70/85/95，**默认 70**，0.8.2 起；0.8.1 及以前是 85）
- **最大边**＝长边上限（480/800/1280/1600/1920，**默认 1920**——0.8.3 起与默认视口同长边、0.8.2 及以前是 1280；同时作为宽与高的封顶）
- **浏览器窗口分辨率**（1280×720 / 1440×900 / 1600×900 / 1920×1080，**默认 1920×1080**，0.8.2 起；0.8.1 及以前是 1440×900）：走 `POST /browser-service/viewport` 真改浏览器视口，已打开的页面会按新尺寸重排、之后新建的会话也用它，服务端夹在 640×360 ~ 3840×2160 之间；回执是 `✓ 已生效 W×H（已应用到 N 个页面）`
- **打开即取帧**（**默认关**，0.8.2 起；关掉时打开面板不取帧、不占 CPU/带宽，在「网页」入口点一下「开始」才取帧；**0.8.3 起点过一次「开始」后，切到别的入口再切回会自动续上，不用再点，手动「停帧」后回来仍是停的**）、**面板刷新间隔**（1/2.5/5/10 s）、**日志条数**（20/40/100/200）、**默认入口**
- **胶囊位置**：`左上`／`右上`／`左下`／`右下`／**`自由`**（0.8.3 起）五档 + **水平/垂直偏移**（贴角档 0–400 px，默认 15/48，按选中的角生效）；选 `自由` 时这两行改名**水平坐标/垂直坐标**（按屏幕坐标存，上限跟着当前视口），也可以**直接把胶囊拖到任意位置**——松手自动切到「自由」并立即记住，鼠标按住拖动期间是抓手光标，原地单击（位移 ≤ 4px）仍然是展开面板
- **面板间距**（0–64 px，默认 10——既是窗口贴边留白，也是自动收回可见范围时用的边距）
- **层级基准**（1–2000，默认 40——窗口与胶囊相对宿主页面的叠压顺序，胶囊 = `zBase`、窗口 = `zBase + 1`）
- **贴合画面比例**（默认**开**——舞台按画面比例撑高（真实帧尺寸优先，没帧时按上面的分辨率），卡片高度自动；开着时右下角手柄只调宽度，关掉才是自由拖宽高）
- **顶部留白**（`'auto'` 或 0–200px，默认 **`'auto'`**——窗口顶部让开宿主顶栏的高度；「自动」＝实测宿主贴顶的固定/粘性条（量不到按 48），也可手填覆盖）
- **日志自动清理上限**、**是否记住窗口位置与大小**
- 只读的**当前生效服务信息**：版本、会话、CDP 地址、保存目录名、标签上限、空闲回收、控制台/网络录制开关、生效中的取帧参数与分辨率

> **0.8.2** 把默认参数调成了：画面质量 **70**、打开即取帧 **关**、浏览器窗口分辨率 **1920×1080**、背景不透明度 **40%** + **毛玻璃**（宿主的 `viewportWidth`/`viewportHeight` 默认也同步改成 1920×1080），同批还做了**窗口几何三项**：贴合画面比例（默认开，去黑边）、顶部留白（默认自动，窗口让开宿主顶栏）、没记过位置时摆正中。**既有浏览器里已存过的设置不受影响**——默认值只在「从没存过这一项」时生效；想回到默认就在设置页点「恢复默认」再点「保存」。

> **0.8.3** 又调了两处：**「最大边」默认 1280 → 1920**（与默认视口 1920×1080 同长边，画面不再先缩后放）；**取帧开关记住状态**——点过一次「开始」后，切到别的入口再切回会自动续上，手动「停帧」后回来仍是停的。

控制台与网络的录制开关属于**插件配置**（`captureConsole`/`captureNetwork`），改插件配置要重启 DSH。

### 路由、安全与半边归属

宿主半边 [`plugin/lib/panel.js`](https://github.com/lyp88997/dsh-moli-browser/blob/main/plugin/lib/panel.js) 在 `ctx.webServer` 上挂**六条 `exact` 路由**（与面板同源）：

| 路由 | 方法 | 作用 |
|---|---|---|
| `/browser-service/panel.json` | `GET`（`HEAD` 也允许） | 只读数据：日志尾巴 + 服务信息块（`no-store`，载荷不含本机绝对路径，下载目录只回目录名） |
| `/browser-service/live.jpg?since=N[&quality=&max=&maxh=]` | `GET` | 实时帧（长轮询，最多等 1.5 s，只回比 `since` 新的帧，没有新帧回 204） |
| `/browser-service/live.json` | `GET` | 地址栏/标题/推流状态与生效中的取帧参数（每秒同步） |
| `/browser-service/live` | `POST` / `DELETE` | 转发操作（`down`/`up`/`move`/`wheel`/`text`/`key`/`reload`/`goto`）与停流 |
| `/browser-service/logs` | `POST` | `{action:'clear'\|'trim', kind, keep}` 清空/裁剪观测日志 |
| `/browser-service/viewport` | `POST` | `{width,height}` → `provider.setViewport()`，回 `{ok,viewport,applied}` |

`live` / `logs` / `viewport` 是写路由，走同一套三道闸：**只认回环地址**（非本机 403）、**方法白名单**（405）、**写路由同源校验**。没有 `webServer` 的宿主不会挂这些路由，插件照常工作。

客户端半边 [`plugin/client.js`](https://github.com/lyp88997/dsh-moli-browser/blob/main/plugin/client.js) 手写、零构建，走 DSH 的 `window.__ModuleLoader__` 协议，只 `require('react')`（平台种子表内的包），样式全内联，不引第三方 UI 库。窗口几何、设置规整与外观换算都写成纯函数（`clampRect` / `normalizeSettings` / `appearanceStyle` / `borderOf` / `pillAnchor` / `withScheme`），并由 `verify-bundle.mjs` 的客户端探针真跑一遍断言。

**半边归属决定生效方式**：改 `plugin/client.js`（界面、外观、保存按钮）**刷新页面即可**（Ctrl+F5）；改宿主半边（`plugin/lib/panel.js`、`plugin/lib/liveview.mjs`、`plugin/lib/provider.js`、`src/*`、`plugin/lib/index.js`）**必须重启 DSH**。窗口第一次在页面里出现也需要重启一次（客户端插件在启动时收集）。

## 随包技能（技能中心里显示「系统内置」）

包里带**两份全局技能**（`skills/`，共 7 个文件），装完插件就在技能中心里以**系统内置**的身份出现，之后任何会话都能用：

| 技能 | 讲什么 | 文件 |
|---|---|---|
| `browser` | **怎么用**：33 工具速查、实测的 `target` 语法、标准工作流、截图验证法、陷阱表 | `skills/browser/SKILL.md` |
| `browser-runtime` | **怎么修**：`browsersvc` CLI 速查、安装/升级、状态文件与凭据门、排障表、非 root 重建用户态 Chromium 运行时 | `skills/browser-runtime/SKILL.md` + 同目录 `scripts/` 下的 5 个文件（`browse.mjs`、`chromium-wrapper.sh`、`fonts.conf`、`setup-libs.sh`、`verify-cjk.mjs`） |

**身份怎么来的（v0.8.2 起）**：插件用 DSH 的技能提供者接口注册它们——`ctx.skills.registerProvider()`，候选带 `source:'bundled'` 与 `rank:600`（`dsh-skill` 导出的 `BUNDLED_SKILL_RANK`），和 `dsh-univer-office` 的 `univer-skills` 是同一形态，技能中心据此显示成「系统内置」。技能正文是**现读** `skills/<name>/SKILL.md`（改文件不用重启 DSH），配置项 `registerSkills`（默认 `true`）可关。

**默认不再落盘，以及为什么**：v0.8.1 走的是另一条路——把文件写进技能根目录，因为当时还没发现提供者接口。但 DSH 里**同一层的技能按 rank 升序、小的先赢**：磁盘那份是**用户级**（`$DSH_HOME/skills`，rank 400），会盖住插件注册的内置那份（rank 600），技能中心里就显示成「用户级技能」。所以 v0.8.2 起默认只走提供者，落盘改成可选（`syncSkills` 默认 `false`），只在「DSH 以外的工具也要读这些文件」时才打开。**已经落过盘的**：跑一次 `browsersvc skills --uninstall` 就退回内置身份（重启 DSH 后生效）。

**落盘同步机制**（可选；`src/skills.mjs`，CLI 与插件共用同一份实现）：

- **默认目标**：`$DSH_HOME/skills`（DSH 的**用户级**技能根；DSH 未设 `DSH_HOME` 时回落 `~/.dsh/skills`）。可用配置 `skillsDir` 改，或 CLI 的 `--dir=` 指定。
- **归属台账**：目标目录里的 `.dsh-moli-browser.skills.json` 记着「哪些文件是本包写的、当时是什么哈希」。于是逐个文件只有四种结果：
  - 目标不存在 → **装**；
  - 与源逐字节相同 → 记为我们的，**不动**；
  - 与台账里的旧哈希相同 → 是本包的旧版，**覆盖升级**；
  - 其它（你把文件改过，或磁盘上已有同名但不在台账里的文件）→ **跳过并告诉你原因**，要覆盖必须显式 `--force`。
- **幂等**：没有需要写入的改动时不写盘、不更新台账。
- **撤销**：`--uninstall` 只删台账里属于本包、且内容与本包写的那份逐字节相同的文件（你改过的保留并说明原因），撤净后连台账一起删、空目录也清掉。
- **插件启动时也会同步**（仅在 `syncSkills: true` 时）：`plugin/lib/index.js` 的 `apply()` 里执行，**失败只记一行日志，绝不影响 provider**。
- **CLI**：

```bash
browsersvc skills                        # 列每个文件的状态（缺失/已最新/可升级/你改过/非本包）+ 待处理数 + 身份提示
browsersvc skills --install              # 可选：落盘（装 + 升级本包自己的旧版）
browsersvc skills --install --force      # 连「你改过 / 非本包」的同名文件一起覆盖
browsersvc skills --uninstall            # 退回「系统内置」身份：撤掉落盘那份（不动你改过的）
browsersvc skills --dir=/path/skills --json   # 换目标目录 / 给脚本消费
```

装完提示「技能下次会话即可用（重启 DSH 最稳）」；落盘与不落盘，技能正文都来自 `skills/`，只有技能中心里的**身份**不同。

## 配置

配置写在 profile patch 的 `browser-moli` 行 `config:` 下（patch **整行替换** `config`，覆盖时要重述该行需要的每个键）。

| 键 | 默认 | 说明 |
|---|---|---|
| `providerId` | `cdp-daemon` | seam 里注册的 provider 名，要和 patch 里 `browser.browserProvider` 一致 |
| `cdpUrl` | `http://127.0.0.1:9333` | browsersvc 的公开（回环）端点 |
| `connectTimeoutMs` | `10000` | 连 CDP / 首次用浏览器时等守护进程起来的超时 |
| `actionTimeoutMs` | `30000` | 单次元素操作（点击/填写/求值）预算 |
| `navigationTimeoutMs` | `30000` | 导航/刷新预算 |
| `lookupTimeoutMs` | `5000` | 元素查找与 scrape 的等待预算 |
| `snapshotMaxElements` | `200` | `browser_snapshot` 返回的元素上限 |
| `contentMaxChars` | `200000` | `browser_content` 截断长度 |
| `captureConsole` | `true` | 是否把页面控制台（`console.*` / `pageerror`）记进 `<root>/console.jsonl` |
| `captureNetwork` | `true` | 是否把网络请求记进 `<root>/network.jsonl`，并按会话录 HAR（关掉就不录 HAR） |
| `maxTabs` | `5` | 单个会话允许的最大标签页数（夹在 `1..50`）。超过时 `browser_open {newTab:true}` 报 `BROWSER_TAB_LIMIT`——每个标签页是一个独立渲染进程，实测约 +93 MB |
| `viewportWidth` / `viewportHeight` | `1920` / `1080`（0.8.2 起；0.8.1 及以前 `1440` / `900`） | 新页面视口（坐标点击的空间）。面板设置里的「浏览器窗口分辨率」可运行时改这一项 |
| `idleMs` | `300000`（5 分钟） | 本包**自启**守护进程时的空闲回收窗口（夹在 `1000..86400000`）。最后一个会话关闭后插件主动断开连接，守护进程再空闲这么久就退出、把内存还给系统。仅在使用默认 `autoStartCommand` 时生效 |
| `autoStartCommand` | 空 = 用**本包自带**的 `bin/browsersvc.mjs start` | 可选：首次用浏览器时执行的命令；换端口/内核才需要填（自己填的话，`idleMs` 不会自动带上，要自己写 `--idle-ms`） |
| `autoStartTimeoutMs` | `60000` | `autoStartCommand` 的执行超时 |
| `cdpToken` | 空 | 一般不用填：留空时自动读 `<DSH_BROWSER_SVC_ROOT 或 $DSH_HOME/browser-service>/service.json` 里的 `token`（每次 attach 重读，守护进程重启换 token 也能跟上）。只有指向自建/非 browsersvc 的 CDP 端点时才需要显式给 |
| `downloadDir` | 系统 Downloads 目录 | 截图/下载的 `savePath` 必须落在该目录内。不配置时与内置 provider 同语义：`XDG_DOWNLOAD_DIR`（存在才用）→ 家目录下存在的 `Downloads`/`下载`/`下載` → `~/Downloads`（首次写入时建出来）。要存进工作区/别处就显式填一个目录 |
| `skillsDir` | 空 = `$DSH_HOME/skills` | 可选的落盘同步目标技能根目录（仅在 `syncSkills` 打开时用） |
| `syncSkills` | `false`（0.8.2 起；0.8.1 是 `true`） | 插件启动时是否把随包 `skills/` 也**落盘**进 `skillsDir`。默认关：落盘是**用户级**技能（rank 400），会盖住插件注册的**内置**那份（rank 600，技能中心显示「系统内置」）。开启带归属台账，你改过的文件不会被覆盖 |
| `registerSkills` | `true` | 是否把随包技能注册成 DSH 的**内置技能提供者**（`source:'bundled'`、rank 600，与 `dsh-univer-office` 同形态），技能中心里显示「系统内置」。关掉就只剩手动落盘那条路 |

这些键的权威定义在 `plugin/lib/index.js` 的 `Config`（schemastery schema）——**改默认值必须同时改这里和本表**。

> **v0.3.0 起公开端口要求 `Authorization: Bearer <token>`**（token 由 `browsersvc` 生成，落在 0600 的 `service.json`）。插件自动读取它，无需改配置；但 `browsersvc` 与插件必须一起升级——旧插件 + 新守护进程会在 401 上失败（见「升级与卸载」）。

## 观测与状态文件

| 数据 | 位置 | 说明 |
|---|---|---|
| 操作日志 | `<root>/ops.jsonl` | 每次工具动作：`seq`/`action`/`params`/`ok`/`error`/`ms`，由 provider 的**通用追踪器**（`traced()` 返回 `Proxy`）自动覆盖所有公共方法，以后新增方法也不会漏 |
| 页面控制台 | `<root>/console.jsonl` | `console.*` 与 `pageerror`，文本截 500 字 |
| 网络 | `<root>/network.jsonl` | `request`/`response`/`requestfailed` 两阶段，同请求记耗时，**不记头与体** |
| HAR | `<root>/har/<时间戳>-<会话>.har` | 按会话录（playwright-core 的 `recordHar`），只留最近 10 份 |
| 守护进程状态 | `<root>/service.json`（0600） | pid / 端口 / 内核 / 版本 / 本次启动的访问 token；同 uid 可读，故 0600 |
| 守护进程日志 | `<root>/*.log`（0600） | `browsersvc logs` 读它 |

环形上限：ops / console 各 **1 MiB**、network **2 MiB**，超限保尾部一半；日志文件一律 0600；**任何落盘 IO 异常都被吞掉并返回 `false`**——观测出事不能把浏览器调用拖下水。`<root>` 默认 `$DSH_HOME/browser-service`。

## 环境要求与兼容性

| 项 | 要求 |
|---|---|
| DSH | 支持 `dsh plugin` / `dsh.bundle` 的版本（本机在 `0.1.5-rc.3` 实测） |
| Node.js | **≥ 22.19**（`package.json` 的 `engines`；守护进程只用 Node 内置模块，零第三方运行时依赖） |
| 操作系统 | **Linux x86_64**。本项目在 Debian 12 容器（uid 1000、cgroup 只读、`/dev/shm` 64M、无 Xvfb）实测；**macOS / Windows 未测试** |
| 浏览器内核 | 系统已有的 `chrome-headless-shell` / Chromium / Chrome，或用户态目录里的 `chrome-headless-shell` + 包装脚本（注入 `LD_LIBRARY_PATH` 与 `FONTCONFIG_FILE`，见 `bin/browsersvc.mjs detect`） |
| 权限 | **不需要 root**；不需要 GUI 库，不需要 Xvfb。容器里 `NoNewPrivs=1` + seccomp 时 Chromium 沙箱起不来，因此固定加 `--no-sandbox --disable-dev-shm-usage` |
| 网络 | 只监听 **127.0.0.1**（默认公开端口 9333，内核用内部端口）；不依赖外网 |
| 磁盘 | 一个 profile 里的包体量 ≈ 依赖（`playwright-core` 约 14M，只做 CDP 客户端、**不下载浏览器**）；运行时数据在 `$DSH_HOME/browser-service` |

字体/库缺失的症状：截图纯白、中文变方块——用带 `FONTCONFIG_FILE` 的包装脚本，或安装系统字体。

### DSH 兼容矩阵（实测）

`node scripts/verify-matrix.mjs --dsh <bin> … --smoke` 把**同一个 tarball** 分别装进不同版本的 DSH，逐版本验 12 项（不带 `--smoke` 时是 11 项常规检查，第 12 项就是下面这一步真开页面）（`add` → `--dump-config` → 入口可加载 → `apply(桩 ctx)` 注册出 `cdp-daemon` 且启动期探测无 error → 用装进来的 bin 自启守护进程、真开 `example.com` 读回正文）：

| 宿主 DSH | 结果 | 说明 |
|---|---|---|
| `0.1.5-rc.3` | **12/12** ✅ | 本机当前宿主（全局装） |
| `0.1.7-rc.2` | **12/12** ✅ | npm `latest` / `next` |
| `0.1.7-rc.1` | **12/12** ✅ | |
| `0.1.6-alpha.2` | **12/12** ✅ | alpha 通道也验证过 |

- 矩阵用的备版本是 `npm install --prefix /tmp/dsh-mat/<ver> @deepseek-ai/dsh@<ver>` 装的（npm 会把 peer 提升到 `<prefix>/node_modules/@deepseek-ai`，与全局装的层内布局不同，`scripts/lib/host-peers.mjs` 两种都认）。逐版本**串行**跑：一个无头内核约 600 MB，并行会顶到容器内存上限。
- 接缝（依赖 `dsh-builtin-browser`）实测面为 **0.1.22**：`browser` 导出 `default`（函数）/`BrowserError`/`BrowserRuntime`，`tool-browser` 导出 `name`/`apply`/`inject`/`internals`（**无** `default`）。启动期探测就在 boot 时校验这些形状——不符只会打印一句「插件未启用 —— 浏览器接缝与预期不符（接缝 X，宿主 Y）：…」并安静退出，不再抛上游的模块错。
- **不写 `dsh.engines`、也不写 `@deepseek-ai/dsh` 的 semver peer**：前者字段不存在（宿主不读），后者在预发布版本上会给出错误的兼容信号（`>=0.1.5-rc.1 <0.2.0` 只解锁 0.1.5 的预发布，`0.1.7-rc.2` 会被判不符）。版本适配靠「探测 + 人话报错 + 上面这张实测表」。

### 验收与测试

**零依赖、不依赖外网**，脚本直接在仓库里跑：

```bash
node scripts/verify-daemon.mjs      # M1 守护进程 + CLI 防御：35/35
node scripts/verify-provider.mjs    # M2 provider + P7 分辨率 + 随包技能提供者：125 通过，0 失败
node scripts/verify-bundle.mjs      # 组合包安装（官方 dsh plugin 流程）+ 随包技能：75/75
node scripts/verify-data.mjs        # P3 观测面 + P4/P5 实时窗口 + P6 清理跳转 + P7 分辨率/偏移：86 通过，0 失败
node scripts/verify-matrix.mjs --dsh <bin> --dsh <bin> --smoke   # 多版本 DSH 兼容矩阵（见上）
```

| 套件 | 项数 | 覆盖 |
|---|---|---|
| `scripts/verify-daemon.mjs` | **35/35** | 守护进程启停/重启、token 与 401/403 凭据门、只绑回环、上下文隔离、崩溃重启、空闲退出、配置校验、启动失败不留孤儿、`stop` 身份校验、同一连接上的后续请求不免检（F27） |
| `scripts/verify-provider.mjs` | **125 通过 / 0 失败** | 33 个工具的行为与边界（含 `execute`/`a11y`/`scrape`/`form`/`screenshot`/`download`/`auth`）、会话隔离与复活、保存路径准入与默认保存目录（D1）、代理对截断、**P1：`maxTabs` 上限（拒绝后不留半开页）、无会话时释放连接（守护进程按 `idleMs` 回收 + 自愈）、配置默认值（`maxTabs` 5 / `idleMs` 300000 / 视口 1920×1080）** → **P7：窗口分辨率 `setViewport`（配置初值、新页面按配置打开、改尺寸后真页面重排、新会话沿用、越界夹取、非法值报 `BROWSER_VIEWPORT_INVALID`）** → **随包技能提供者（8 项：`list()` 两份候选、`source:'bundled'` + rank 600 + `provider` 名一致、`resourceBase` 目录真实存在、候选形状满足 dsh-skill 校验、`browser-runtime` 保持模型不自动调用、`get()` 返回已剥 frontmatter 的正文、读不到的技能不进候选、`Config` 默认 `registerSkills:true`/`syncSkills:false`）** |
| `scripts/verify-bundle.mjs` | **75/75** | 在一次性隔离 `DSH_HOME` 里跑官方 `add` → `--dump-config` → 转出口形状比对 → **P2：宿主 peer 解析、启动期探测（好/坏形状）、工具面计数 == 33** → **P3：客户端半边（loader 协议、cordis 插件形状、`apply` 注册到 `shell.overlay`、只点平台种子表）** → **P4：客户端引用的三条实时路由与服务端一字不差** → **P5：客户端导出的几何夹取与设置规整纯函数（三态夹取 + 越界回落）** → **0.8.2/G：`clampRect` 第四参「顶部留白」（窗口不许压到宿主顶栏）、`topInsetFromBoxes`/`resolveTopInset` 的自动量（贴顶 + 够宽 + 高度合理里取最高）与 0–200 夹取、`ratioOf` 的画面比例回退、`fitPicture`/`topInset` 两项新默认、没记过位置时摆正中** → **P6：`pillAnchor`（胶囊四角定位）与 `withScheme`（地址补协议）真跑一遍，并断言新增设置键 `pillPos`/`autoClean` 的默认与越界回落** → **P7：客户端的写路由引用（logs + viewport）与服务端一字不差、`clampRect` 的面板间距（第三参）、新设置键（`viewport`/`pillX`/`pillY`/`panelGap`/`zBase`）与脏输入规整、胶囊自定偏移** → **P8：窗口外观纯函数（`appearanceStyle` 的 CSS 变量——外壳的 rim/alpha/blur/sat/glow/solid 与「内部分区也跟着透明」的 `--bsp-card`/`--bsp-surface`、自定义色时分隔线 `--bsp-divider`；`borderOf` 只放行预设色或 `#rrggbb`、注入串回落主题色、不透明度 20–100 与玻璃档位回落）** → **P9：胶囊「自由」档（`left`/`top` 直给、超出视口按自身尺寸夹回、存储范围 0–10000）、`pillPoint` 四组坐标（自由/越界/左上/右下）、拖动接线七项（指针事件、指针捕获与释放、自由档 + 存储范围、拖动阈值 `DRAG_SLOP`、抓手样式 `bsp-grabbing`、`touch-action:none`）** → **P10（0.8.3）：「最大边」默认 1920（`normalizeSettings({})` 真跑）与取帧开关跨页签记忆（组件外 `liveStartedMemory`、初值 `??` 看「打开即取帧」、每次变化回写）** → **随包技能（第 6 段 11 项：空目录报缺失、`--install` 真落盘、台账、重复跑幂等、改过的文件不覆盖、`--force` 才覆盖、`--json` 可被脚本消费、插件源码里确实 `registerProvider` + `registerSkills`/`syncSkills` 两个默认值、落盘仍可选、`--uninstall` 保留改过的 1 个撤其余 6 个、撤净后连台账与空目录一起清掉）** → tarball 形状含两份 `SKILL.md`、`browser-runtime/scripts/` 与 `src/skill-provider.mjs` → `remove`，不碰默认 profile |
| `scripts/verify-data.mjs` | **86 通过 / 0 失败** | **P3：`ops`/`console`/`network`/`har`/`cookies` 五个观测面 + 只读面板路由**——操作日志（含通用追踪覆盖 `snapshot`/`content`/`screenshot`/`listTabs`、失败记 `ok:false` 与原因）、控制台两类、网络两阶段、HAR 落盘与复制、cookie/localStorage 导出注入与权限、`panel.json` 的形状/行数/405/卸载、IO 失败不抛 → **P4：实时窗口四条路由与三道闸**（取帧 JPEG 与帧序号头、无新帧 204、打字/点击/goto 转发、未知动作 400、非本机 403、跨站 403、方法 405、DELETE 停流、无 provider 503、dispose 一起摘掉） → **P5：取帧参数透传与夹取（`x-frame-quality`/`x-frame-max`）、`live.json.options` 回读、`panel.json.service` 只读服务块**（版本/会话/上限/开关一致，且载荷不含本机绝对路径） → **P6：日志清理路由（`clear` 清三类、`trim` 留最近 N 条、未知类型 400、非 POST 405、跨站 403、非回环 403、dispose 摘掉）与「一个会话都没有」时地址栏跳转自动开会话并补 `https`、空网址 400、非跳转动作 409** → **P7：分辨率写路由**（`panel.json.service.viewport`、`POST /browser-service/viewport` 之后真页面视口变为新尺寸并回 `applied`、非法值 400、非 POST 405、跨站 403、非回环 403、无 provider 503、dispose 摘掉；另加「缺 `maxh` 时高度沿用当前值而不是塌到下限」这条画面糊的回归断言） |
| `scripts/verify-matrix.mjs` | **4 个宿主版本 × 12 项** | 把同一个 tarball 装进不同版本的 DSH：`add` → `--dump-config` → 入口可加载 → `apply(桩 ctx)` 注册出 provider 且探测无 error → `--smoke` 用装进来的 bin 自启守护进程、真开页面读回正文 |

完整输出（35 条 PASS 原文、DSH 内端到端日志、未自动化覆盖的部分）见 [`docs/verification.md`](https://github.com/lyp88997/dsh-moli-browser/blob/main/docs/verification.md)。

## 目录结构

```
dsh-moli-browser/
├── package.json            # 单一交付物：dsh.bundle.patch / dsh.client / bin / files
├── bin/browsersvc.mjs      # 守护进程 CLI（start/stop/status/…/skills）
├── src/                    # 守护进程内核：config / daemon / proxy / opslog / skills / skill-provider
├── plugin/
│   ├── cordis.patch.yml    # bundle patch：insert 接缝 + 33 工具 + provider，disable 两个内置
│   ├── lib/                # 宿主半边：index（插件入口）/ provider / panel / liveview / compat / dom
│   ├── client.js           # 客户端半边（手写零构建的网页面板）
│   └── shims/              # ./browser 与 ./tool-browser 转出口（指向依赖 dsh-builtin-browser）
├── skills/                 # 随包全局技能：browser/、browser-runtime/（含 5 个脚本）
├── scripts/                # 五套验收 + 探针（scripts/lib/）
├── tools/seam-probe/       # 诊断用插件（非交付特性）
├── docs/                   # architecture / verification / design-notes / profile-patch
└── README.md · CHANGELOG.md · CONTRIBUTING.md · LICENSE
```

## 开发与发布

**一个包、零构建**（纯 ESM），三条分发路径都实测过：

```bash
chmod 755 bin/browsersvc.mjs                          # bin 必须可执行（POSIX 下 npm 全局 shim 是指向它的符号链接）
chmod -R u+rwX,go+rX .                                # 交付物里的文件权限由本机 umask 决定，打包前统一（F12）
pnpm pack --pack-destination dist                     # dsh-moli-browser-<v>.tgz：唯一交付物（挂 Release 用）
# 发布到 npm（package.json 不能有 "private": true；token 必须是勾了 Bypass 2FA 的 granular token）：
npm publish --access public
```

- **单一交付物**：根 `package.json` 里声明 `"dsh": {"bundle": {"patch": "./plugin/cordis.patch.yml"}, "client": {"platform": "web"}}`，同一个包同时提供 `bin/browsersvc.mjs`（守护进程 CLI）、`plugin/lib/*`（provider + 面板宿主半边）、`plugin/client.js`（面板客户端半边）、`skills/*`（随包全局技能）与 `plugin/shims/*`（接缝/工具面转出口）。装完这一个包，`--dump-config` 里就出现 `# == dsh-moli-browser` 层、`browser`（`browserProvider: cdp-daemon`）、`tool-browser`、`browser-moli` 四行。
- 依赖：`dsh-builtin-browser`（提供 seam 与 33 个工具，转出后面向 profile 生效）、`playwright-core`（只做 CDP 客户端，**不下载浏览器**）。配置 schema 用的 `@deepseek-ai/schemastery` 按官方 peer 规则写成 `peerDependencies` + `devDependencies`（**与宿主共享同一实例**，不再进 `dependencies`）；接缝包需要的其它宿主 peer（`@deepseek-ai/cordis` / `dsh-tools` / `dsh-llm` …）由 DSH 在 boot 时建立的 `$DSH_HOME/profiles/node_modules/@deepseek-ai/*`（240 个入口）提供——profile 内任何包向上查找都能命中，所以不需要把它们写进本包依赖。
- 每个版本在 GitHub Release 挂两份资产：**不带版本号**的 `dsh-moli-browser.tgz`（供 `releases/latest/download/dsh-moli-browser.tgz` 这类**永不过期**的固定地址引用——插件市场条目就用它）与带版本号的 `dsh-moli-browser-<v>.tgz`（文档里建议钉版本用）。
- `dist/` 已 gitignore。**发布记录（按时间）**：`0.4.0`（首版：合并成单一交付物）、`0.4.1`、`0.4.2`（仅刷新 npm 页面上的 README，代码分别同 `0.4.0`、`0.4.1`）、`0.4.3`（默认 `downloadDir` 对齐内置 provider，D1）、`0.4.4`（代理 keep-alive 免检，F27）、`0.5.0`（资源收口：`maxTabs` 上限 + 无会话时释放连接，P1）、`0.5.1`（DSH 版本适配：启动期能力探测 + 多版本实测矩阵，P2）、`0.6.0`（可观测性与网页面板：五个观测面 CLI + 只读浮动看板，P3）、`0.7.0`（实时交互网页窗口，P4）、`0.8.0`（窗口与入口重做，P5）。**`0.8.1` 就是本文档对应的版本**：把 P6（界面美化与体验修补）、P7（分辨率与胶囊坐标可调、清理可见化、画面清晰度修复）、P8（窗口外观可自定义、设置显式保存）与**随包全局技能**一起发出去。
- 踩坑：发布 token 必须是勾了 **Bypass 2FA** 的 granular token 且权限为 Read and write，否则 `npm publish` 报 `403 Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages`。旧名 `dsh-browser-moli` 不能用：npm 上已被 drscrewdriver 的同名包占用（0.17.4）。
- 官方文档提到的 `dsh.engines` / `dsh.compatibility` 元数据本包**没写**：宿主只认 `dsh.bundle`（`@deepseek-ai/dsh-package-manifest` 的 `DshManifest` 里没有这两个字段），它们只被插件市场的发现逻辑读取，宿主既不读也不校验。也**刻意不给 `@deepseek-ai/dsh` 写 semver peer 范围**——semver 的预发布规则下 `>=0.1.5-rc.1 <0.2.0` 这类范围只解锁 `0.1.5` 的预发布，同范围的 `0.1.7-rc.2` 会被判为不符，写了反而给出**错误的兼容信号**；DSH 版本的适配改成「启动期探测 + 人话报错 + 多版本实测矩阵」。

## 安全模型与已知限制

### 安全模型

1. **只绑回环**：本机是 host 网络，`0.0.0.0` 上的 CDP 端口等于把浏览器完全交给主机上任意进程。内核永远带 `--remote-debugging-address=127.0.0.1`，对外只走回环代理；验收脚本会解析 `/proc/net/tcp` 检查这一点。
2. **`--no-sandbox` 是必需的**（容器 `NoNewPrivs=1` + seccomp 下 Chromium 沙箱起不来），因此**只访问可信站点**；需要更强隔离时把浏览器放进独立容器。
3. **`--disable-dev-shm-usage` 必需**（`/dev/shm` 只有 64M）。
4. 会话隔离必须用 incognito `BrowserContext`，不要复用默认上下文。
5. **公开端口要求凭据**：`Authorization: Bearer <token>`（每次守护进程启动随机生成，落在 0600 的 `service.json`）。代理只放行读元数据（`GET /json/version|/json/list|/json/protocol`）与 `/devtools/*`，挡掉 `/json/new|close|activate` 这类控制接口；`/json/version` 里的 `webSocketDebuggerUrl` 会被改写成代理自己的地址并附上 token，所以调用方（provider）不需要额外配置，也绕不开代理。内部内核端口仍只绑回环。**每条连接只认首个请求**：代理只在连接建立时解析一次请求头，所以非 WebSocket 请求一律按 `connection: close` 转发、响应后立刻关闭（否则同一连接上的后续请求就是免检的裸管道，F27）。
6. **保存路径准入**：`browser_screenshot` / `browser_download` 的 `savePath` 必须是绝对路径、不得覆盖已有文件，并且必须落在 `downloadDir` 内（不配置时＝系统 Downloads 目录，见配置表；违规报 `BROWSER_SCREENSHOT_BLOCKED` / `BROWSER_DOWNLOAD_BLOCKED`）。这样接缝工具 schema 里那句「默认写进系统 Downloads 目录」才是真的，提示注入也没法让浏览器工具写任意路径。
7. 状态文件 0600、日志 0600，日志不记录页面内容。
8. **面板的写路由只对本机回环开放且要求同源**：实时窗口能点能打字，等于把浏览器交出去——非回环 403、跨站 403、方法白名单 405。

维护约定（改动这些是安全回归）：上面的 1–4 与 6 请不要为了「能跑通」而放宽；验收脚本里对应断言就是为了拦住这种改动。

### 已知限制

1. **一个 root 一个守护进程**（单例）。多个 profile 想共用内核要显式给同一个 `--root`；否则各自拉起一个。
2. **只监听回环**，同 uid 的其它进程读得到 `service.json` 里的 token（文档权限 0600，但同 uid 可读）。这是本机隔离，不是跨用户隔离。
3. **`--no-sandbox` 是必需项**（容器里 Chromium 沙箱起不来）⇒ 只访问可信站点；需要更强隔离就把浏览器放进独立容器。
4. **改插件代码或 profile patch 后必须重启 DSH**：完整 web profile 上 `patchReload: live` 会静默回滚（实测：探针条目 `applied` 后 6–7 ms 被 `disposed`，插件的 `apply` 根本没被调用；最小 profile 里热重载正常）。
5. **插件与 `browsersvc` 必须同版本升级**：v0.3.0 起公开端口要 Bearer token，旧插件 + 新守护进程会 401（F19 修的是冷启动重读 token）。
6. **工具面取决于依赖版本**：33 个 `browser_*` 来自 `dsh-builtin-browser`，上游增删工具时本包跟着变（本包只保证转出口形状一致、并把它写进验收）。
7. **守护进程会空闲自杀**（守护进程自身默认 15 分钟；本包自启默认 5 分钟，见配置表 `idleMs`；`--idle-ms` 允许 `1000..86400000`，即最长 24 小时）。**只有代理端口上没有任何连接时才会空闲**：所以 0.5.0 起插件在最后一个会话关闭后会**主动断开** CDP 连接——否则那条约 600 MB 的常驻浏览器永远不回收（P1）。DSH 侧下一次调用会自动把它拉回（F25），所以这是省内存的设计而不是故障；连「被下次调用拉起」也不想要，就 `dsh plugin remove` 卸载本包。
8. **`browser_execute` 传的是表达式语境**：传函数体会被当表达式求值并报 `page.evaluate: SyntaxError: Illegal return statement`，请传 `(...) => {...}` 或纯表达式。
9. **`browser_fill` 的 `fields[].selector` 是作用域不是定位器**：定位某个控件请用 `browser_click` / `browser_set_value` / `browser_check` 的 `target`。
10. **macOS / Windows 未测试**；仅 Linux（Debian 12 容器）实测。
11. **截图/下载默认只能写进系统 Downloads 目录**（`XDG_DOWNLOAD_DIR` → 家目录下存在的 `Downloads`/`下载`/`下載` → `~/Downloads`，对齐内置 provider）。要写进工作区或别处，就在 profile patch 的 `browser-moli` 行 `config` 里显式配 `downloadDir`（patch **整行替换** `config`，覆盖时该行其它键要重述）。
12. **单个会话默认最多 5 个标签页**（配置 `maxTabs`，夹 `1..50`）。每个标签页是独立渲染进程，实测约 +93 MB；超限时 `browser_open {newTab:true}` 报 `BROWSER_TAB_LIMIT`，文案会列出当前标签，用 `browser_close_tab` 关掉不用的、或 `browser_reset_session` 清空本会话（P1）。
13. **面板设置存在浏览器本地**（`localStorage`）：换机器/换浏览器要重新调；同一拍里连点两个设置按钮也不会互相覆盖（P8 改成传补丁 + 函数式更新）。
14. **随包技能在技能中心里显示成「系统内置」**：包内 `skills/` 由插件启动时注册的**技能提供者**提供（`source:'bundled'`、rank 600，与 `dsh-univer-office` 同形态），改技能正文不用重启。**同一层里 rank 小的先赢**，所以如果你之前用 `browsersvc skills --install` 落过盘（用户级 rank 400），那份会盖住内置的——跑一次 `browsersvc skills --uninstall` 再重启 DSH 就回到「系统内置」。落盘的同步只覆盖「我们自己写过且之后没人动过」的文件：你手工改过的同名技能会保留，同步会跳过并记一行 warn（要覆盖用 `browsersvc skills --install --force`）。

## FAQ

**装完市场里显示「安装并启用」，但调用浏览器就报「会话内没有可用标签页」？**
重启 DSH。插件只在 boot 时 import，热重载在完整 web profile 上会静默回滚（见「已知限制」4）。

**面板里点「清理」或改分辨率没反应 / 只出个红条？**
红条就是原因。常见的一条是 `宿主没有这条路由（HTTP 404）——宿主半边是旧版，重启 DSH 后生效`：面板的**宿主半边**（`plugin/lib/*`）是 DSH boot 时 import 的，升级插件后**只刷新浏览器页面不够，必须重启 DSH**；客户端半边（`plugin/client.js`）改完刷新页面即可（0.8.1 起清理/自动清理/分辨率都会把成功与失败都显示出来，不再静默）。

**改完外观/设置要保存吗？刷新会丢吗？**
要。窗口外观与几何是「草稿 + 显式保存」：改动立刻按新值显示，点吸顶栏「保存」才写进浏览器本地（成功绿字、失败红字并保留草稿）。刷新页面后保留的是**上次保存**的那份。

**装完没看到 `browser` / `browser-runtime` 技能？**
先看 CLI 报了什么：`node <profile>/node_modules/dsh-moli-browser/bin/browsersvc.mjs skills`。技能由插件启动时同步到 `$DSH_HOME/skills`（默认），要在**装完并重启过 DSH 之后**才落盘；也可以不等插件，直接 `browsersvc skills --install`。如果目标目录里已有同名技能、但不在本包的台账里，会被跳过并说明——要覆盖加 `--force`。

**报 401 / 连接被拒？**
① 旧插件配新守护进程 ⇒ 升级插件后重启 DSH，再 `browsersvc restart`。② 若不配 `cdpToken`，插件会每次 attach 重读 `service.json` 的 token（F19 起），所以冷启动第一次调用也能用。

**报 `browser: 无法连接 CDP 端点 … ECONNREFUSED`？**
守护进程空闲自杀了；下一次调用会自动拉回（F25）。一直失败就手动 `node bin/browsersvc.mjs start` 看 `logs`。

**浏览器占着约 600 MB 内存，什么时候还回来？**
① 单个会话超过 `maxTabs`（默认 5）会报 `BROWSER_TAB_LIMIT` 而不是继续吃内存；② 最后一个会话关闭后插件主动断开连接，守护进程再空闲 `idleMs`（默认 5 分钟）就退出——内核、渲染进程一起收走；③ 想立刻收，`node bin/browsersvc.mjs stop`。会话期间不会回收（这是为了不每次都冷启动 3 秒）。

**`browser_open {newTab:true}` 报 `BROWSER_TAB_LIMIT`？**
本会话标签页到上限了（默认 5）。文案里有当前标签列表；`browser_close_tab` 关掉不用的，或 `browser_reset_session` 清空；确需更多就调大配置 `maxTabs`（上限 50，每个约 +93 MB）。

**面板的实时窗口点不动 / 看不到画面？**
三条闸之一拦住了：非本机回环（从别的机器直连 DSH Web）会 403，跨站 POST 会 403，方法不对会 405。本机访问时如果没画面，让助手切到你要看的标签（窗口只播 `session.active` 那个），或确认宿主半边是重启过的新版。

**要不要单独装 `dsh-builtin-browser`？**
不要。它是本包的依赖，同时当组合包会让 `browser`/`tool-browser` 插两次、33 个工具重名。已装过就 `dsh plugin --profile <name> remove dsh-builtin-browser`。

**能写 `dsh plugin add dsh-browser-moli` 吗？**
不能，npm 上那是别人的同名包（drscrewdriver 0.17.4）。用 `dsh-moli-browser`。

**`browser_execute` 报 `Illegal return statement`？**
它按表达式求值，别传函数体字符串。传 `({title: document.title})` 或 `() => document.title`。

**`browser_fill` 里 `selector` 没起定位作用？**
`fields[].selector` 是**作用域**，不是定位器；定位控件用 `browser_click` / `browser_set_value` 的 `target {by: css|text|xpath}`。

**`browser_scrape` 取不到字段？**
`item` 必须是**容器**（字段选择器在它内部查找）：`item: img` + `img@src` 取不到值，写 `item: body` 或真正的列表项容器。

**`browser_open` 报「只允许 http(s) URL」？**
`data:` / `file:` / `about:` 会被拒绝。本地页面起个 HTTP 服务再用 `http://127.0.0.1:<port>/` 打开。

**截图/下载报 `BROWSER_SCREENSHOT_BLOCKED` / `BROWSER_DOWNLOAD_BLOCKED`？**
`savePath` 必须是绝对路径、不能是已有文件，而且必须落在 `downloadDir` 内。**默认目录＝系统 Downloads**（`XDG_DOWNLOAD_DIR` → 家目录下存在的 `Downloads`/`下载`/`下載` → `~/Downloads`），所以 `savePath: /tmp/x.png` 这类写法默认会被拒——必须显式配 `downloadDir`（见「配置」与「已知限制」11）。

**中文变方块 / 截图纯白？**
内核缺字体或用户态库：用带 `FONTCONFIG_FILE` 与 `LD_LIBRARY_PATH` 的包装脚本启动（`--wrapper=`），或按 `browser-runtime` 技能里的 `setup-libs.sh` 重建运行时。

**改了 patch 没生效？**
重启 DSH。另外手写 patch 与 bundle 路线不要同时用（`insert` 行会重复）。

## 进度

| 里程碑 | 内容 | 状态 |
|---|---|---|
| **M1** | 守护进程 + 回环代理 + 空闲回收 + 崩溃重启 + 35 项验收 | ✅ 完成 |
| **M2** | DSH provider 插件（`inject=['browser']` + `ctx.browser.registerBrowserProvider`），复用接缝包的 33 个 `browser_*` 工具 | ✅ 完成（125 项 + DSH 内端到端） |
| **M6** | 代码审查 18 条缺陷修复（F1–F18） | ✅ 完成（v0.3.0 → v0.3.3） |
| **M7** | 「一个包装完」：单一交付物，接缝与工具面由依赖 `dsh-builtin-browser` 转出 | ✅ 完成（v0.4.0） |
| **P2** | DSH 版本适配：启动期能力探测 + 人话报错（`plugin/lib/compat.js`）、`schemastery` 改 peer、多版本实测矩阵 | ✅ 完成（v0.5.1） |
| **P3** | 可观测性与交互：`ops`/`console`/`network`/`har`/`cookies` 五个 CLI 观测面 + 只读网页面板（`plugin/lib/panel.js` + `plugin/client.js`） | ✅ 完成（v0.6.0） |
| **P4** | 实时交互网页窗口：面板「网页」标签把真页面帧流进 DSH 网页，点击/滚动/打字/地址栏直接作用于真浏览器（`plugin/lib/liveview.mjs` + 三条 live 路由 + 客户端 `LivePane`），零新增工具 | ✅ 完成（v0.7.0） |
| **P5** | 窗口与入口重做：可拖动/可缩放的浮动窗口、左侧一竖排入口、设置区与只读服务信息、取帧参数随请求透传并被服务端夹取 | ✅ 完成（v0.8.0） |
| **P6** | 界面美化与体验修补：整体改用宿主设计令牌（暗/亮主题自动跟随）、胶囊挪到左上并可换角、菜单切换重做（SVG 线描图标 + 标签栏语义 + 键盘导航）、日志清理（手动两次确认 + 自动清理上限）、地址栏跳转修复（无会话自动开会话、失败原因可见） | ✅ 完成（v0.8.1） |
| **P7** | 窗口分辨率与胶囊坐标可调、清理可见化、画面清晰度：设置里选浏览器窗口分辨率（真改视口、已开页面重排、新会话沿用、服务端夹取）、胶囊水平/垂直偏移 + 面板间距 + 层级基准（`z-index`）、清理/自动清理成功与失败都出提示（旧版宿主会被明确告知「重启 DSH 后生效」）；修掉「分辨率调大了画面还是糊」的真缺陷——缺 `maxh` 时高度上限被算成下限 240，现改为缺字段沿用当前值 + 最大边同时封顶宽高 + 默认画质 85 | ✅ 完成（v0.8.1） |
| **P8** | 窗口外观可自定义 + 设置显式保存：设置页新增「窗口外观」（边框颜色＝跟随主题/无边框/六个预设色/取色器自定、背景不透明度 40–100%、玻璃效果＝关/毛玻璃/液态玻璃），窗口与胶囊共用同一份外观且**内部分区一起透明**（自定义色时分隔线用同色调 45%）；设置改成「改完先预览、点保存才落盘」，并有吸顶保存栏（未保存琥珀提示 + 入口/胶囊小圆点、保存成功绿字、写本地存储失败红字说明原因），另有「恢复默认」 | ✅ 完成（v0.8.1） |
| **S1** | 随包全局技能：`skills/browser` + `skills/browser-runtime` 随包发布（共 7 个文件），`src/skills.mjs` 带归属台账同步（用户改过的文件不覆盖）+ `browsersvc skills [--install] [--force]` + 插件启动时自动同步（`skillsDir`/`syncSkills`） | ✅ 完成（v0.8.1） |
| **S2** | 随包技能改成**内置技能提供者**（技能中心显示「系统内置」）：新增 `src/skill-provider.mjs`（`ctx.skills.registerProvider()`；候选带 `source:'bundled'` + rank 600、`resourceBase` 指向包内 `skills/<name>/`、正文现读现剥 frontmatter），`plugin/lib/index.js` 的 `apply()` **先注册提供者**（配置 `registerSkills` 默认开；宿主没有 `skills` 服务只记一行日志，绝不影响 provider），落盘改成可选（`syncSkills` 默认 **false**：落盘是用户级 rank 400，会盖住内置 600），`src/skills.mjs` 新增 `removeSkills()` 与 CLI `browsersvc skills --uninstall`（只删本包写过且没被改过的，撤净后连台账与空目录一起清） | ✅ 完成（v0.8.2） |
| **G** | 窗口几何三项（只在客户端半边）：贴合画面比例（默认开，舞台按画面比例撑高、去黑边、贴合时手柄只调宽度）、顶部留白（默认自动，`clampRect` 第四参管住上边界与最大高度，可手填 0–200）、没记过位置时摆正中；并按真机复核补掉「贴合后首次打开偏上 ~98px」（先量真实高度再居中） | ✅ 完成（v0.8.2） |
| **P9** | 胶囊可拖动与「自由位置」（只在客户端半边）：位置新增 `自由` 档（按屏幕坐标存，贴角档仍是 0–400，自由档 0–10000）；胶囊直接拖（pointer 事件 + 指针捕获 + rAF，拖动期抓手光标并关掉 hover 位移），位移 ≤ 4px 算点击、真拖过吃掉 click；松手立即写盘（只合并 `pillPos`/`pillX`/`pillY`，不顺手保存其他草稿）；渲染按视口夹回屏内但**只夹不改存**；新增 `pillPoint` 保证切档/起拖不跳 | ✅ 完成（v0.8.3） |
| **P10** | 取帧切回自动续帧与「最大边」默认 1920（只在客户端半边）：「开始/停帧」状态提为模块级记忆 `liveStartedMemory`（初值没决定过才看「打开即取帧」，每次变化回写）——切页签/收起面板重挂后自动续上，手动停帧仍是停的；`maxWidth` 默认 1280 → **1920**（与默认视口同长边，不再先缩 1280×720 再放大） | ✅ 完成（v0.8.3） |

未来可能做：面向「任何插件」的通用 HTTP 面（`/fetch` `/screenshot` `/eval`，M4）；CDP-over-pipe 代理，让 univer 也复用守护进程（M5，进阶、未验证）。

## 更新记录

- **[CHANGELOG.md](https://github.com/lyp88997/dsh-moli-browser/blob/main/CHANGELOG.md)** —— v0.8.3 / v0.8.2 / v0.8.1 / v0.8.0 / v0.7.0 / 0.6.0 / 0.5.1 / 0.5.0 / 0.4.4 / 0.4.3 / 0.4.2 / 0.4.1 / 0.4.0 / 0.3.3 / 0.3.2 / 0.3.1 / 0.3.0，含每条真实缺陷（F1–F27、P1–P10、B1–B4、U1–U6、D1）的复现与修复。
- 摘要：`0.8.3` 胶囊可拖动 + 取帧体验两条优化 —— 「胶囊位置」新增 `自由` 档（按屏幕坐标存），胶囊可直接拖到任意位置：松手自动切「自由」并立即写盘（只合并位置三个字段，不动其他未保存草稿），位移 ≤ 4px 仍算点击（原地单击照旧展开面板），渲染时按视口夹回屏内但只夹不改存，`pillPoint` 保证切档/起拖不跳；**取过帧后切到别的入口再切回会自动续上**（不用再点「开始」）、**「最大边」默认提到 1920**。只有客户端半边，刷新页面即可见；验收 35/35、125 通过 0 失败、**75/75**、86 通过 0 失败。
- 摘要：`0.8.2` 调默认参数并按用户反馈修窗口几何 —— 默认参数改成取帧质量 70、打开面板不自动取帧、视口 1920×1080、背景不透明度 40% + 毛玻璃（宿主 `viewportWidth`/`viewportHeight` 同步 1920×1080；顺带修掉 `normalizeSettings` 里 `source.x !== false` 导致布尔默认值形同虚设的潜伏缺陷）＋ **G 窗口几何三项**（贴合画面比例＝按比例撑高去黑边、顶部留白＝窗口让开宿主顶栏且可手填、没记过位置时摆正中；并按真机复核修掉「贴合后首次打开偏上」）＋ **S2 随包技能改内置提供者**（技能中心显示「系统内置」，落盘改成可选，新增 `browsersvc skills --uninstall`）。验收 35/35、125 通过 0 失败、70/70、86 通过 0 失败。
- 摘要：`0.8.1` 收口界面与外观并新增随包技能 —— P6 界面美化与体验修补（整套跟宿主设计令牌走、胶囊可换四角、菜单 SVG 图标与标签栏键盘导航、日志手动/自动清理、地址栏跳转无会话时自动开页且失败可见）＋ P7 窗口分辨率与胶囊坐标可调、清理可见化（分辨率真改浏览器视口、胶囊水平/垂直偏移 + 面板间距 + 层级基准、清理成败都有顶部提示、画面糊的根因已修）＋ P8 窗口外观可自定义与设置显式保存（边框颜色/背景不透明度/玻璃效果，窗口与胶囊共用且内部分区一起透明；改完先预览、点保存才落盘，成败都有提示，同一拍连点不互相覆盖）＋ **随包全局技能**（`browser`、`browser-runtime` 共 7 个文件，装完自动同步到 `$DSH_HOME/skills`，带归属台账：用户改过的文件不覆盖）。全部零新增工具（工具面仍是 33 个）。
- `0.8.0` 窗口与入口重做（可拖动/可缩放的浮动窗口、双击标题栏最大化、左侧一竖排入口、设置区与只读服务信息、取帧画质与最大边随请求透传并在服务端夹取）；`0.7.0` 实时交互网页窗口（面板「网页」标签帧流 + 点击/滚动/打字/地址栏直接作用于真浏览器，只对本机回环开放，零新增工具）；`0.6.0` 可观测性与交互（`ops`/`console`/`network`/`har`/`cookies` 五个 CLI 观测面 + 只读网页面板，零新增工具）；`0.5.1` DSH 版本适配（启动期能力探测 + 人话报错、`schemastery` 改 peer、多版本实测矩阵）；`0.5.0` 资源收口（`maxTabs` 上限 + 无会话时释放连接，让守护进程能按 `idleMs` 回收）；`0.4.4` 修掉代理 keep-alive 免检（F27）；`0.4.3` 默认 `downloadDir` 对齐内置 provider（系统 Downloads，保存路径默认就有范围）；`0.4.2` 按热门插件共性重写 README（纯文档，代码同 0.4.1）；`0.4.1` 修正 npm 页面上的 README（代码同 0.4.0）；`0.4.0` 合并成单一交付物（一个包装完）；`0.3.0`–`0.3.3` 代码审查与按官方文档核对打包（26 条修复）。

## 文档

| 文件 | 内容 |
|---|---|
| [`docs/architecture.md`](https://github.com/lyp88997/dsh-moli-browser/blob/main/docs/architecture.md) | 守护进程 + provider 的设计与实现细节（进程模型、代理、状态文件、接缝契约、面板六条路由、技能同步层） |
| [`docs/design-notes.md`](https://github.com/lyp88997/dsh-moli-browser/blob/main/docs/design-notes.md) | 可行性分析与取舍：为什么不用 Electron、用户态库、seccomp/`/dev/shm`、univer 的接线方式 |
| [`docs/verification.md`](https://github.com/lyp88997/dsh-moli-browser/blob/main/docs/verification.md) | 验收输出原文、DSH 内端到端日志、未自动化覆盖的部分 |
| [`docs/profile-patch.browser-service.yml`](https://github.com/lyp88997/dsh-moli-browser/blob/main/docs/profile-patch.browser-service.yml) | 手写 patch 路线（只有改源码时才用；不要与 bundle 路线同时用） |
| [`plugin/README.md`](https://github.com/lyp88997/dsh-moli-browser/blob/main/plugin/README.md) | 插件侧源码结构与不变量（转出口形状、token 读取时机、patch 语义） |
| [`CHANGELOG.md`](https://github.com/lyp88997/dsh-moli-browser/blob/main/CHANGELOG.md) | 版本变更与缺陷编号 |
| `skills/browser/SKILL.md`、`skills/browser-runtime/SKILL.md` | 随包全局技能：怎么用浏览器工具 / 怎么起停、诊断与重建运行时 |

## 贡献

欢迎 issue / PR。提 PR 前请：

1. 跑完四条验收脚本（`node scripts/verify-daemon.mjs && node scripts/verify-provider.mjs && node scripts/verify-bundle.mjs && node scripts/verify-data.mjs`），并在 PR 里贴计数；动了兼容面（接缝形状/宿主版本/入口导出）再加一遍 `verify-matrix.mjs`。改动行为时**同时补断言**，不要只改实现。
2. 不要把「安全模型」里的约束放宽来让某个用例通过（回环绑定、Bearer token、路径白名单、面板写路由的三道闸、`--no-sandbox` + `--disable-dev-shm-usage`）。
3. 改 `plugin/lib/index.js` 的 `Config` 默认值时必须同步本 README 的配置表；改 `plugin/client.js` 或 `plugin/lib/panel.js` 时注意 `verify-bundle.mjs` 的 5c 段会校验 loader 协议与路由引用。
4. 提交信息写清「修的是什么、怎么复现」——本项目的 `CHANGELOG` 就是按这个格式维护的。

## 许可

MIT © 2026 lyp88997 —— 见 [`LICENSE`](https://github.com/lyp88997/dsh-moli-browser/blob/main/LICENSE)。
