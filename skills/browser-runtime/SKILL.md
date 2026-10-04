---
name: browser-runtime
description: 浏览器工具报错（no usable browser provider / 无法连接 CDP 端点 / 401 / BROWSER_TAB_LIMIT / 会话内没有可用标签页）、截图纯白、中文变方块、重启 dsh 后浏览器失效、面板报 403/404/405 时用；也用于起停与诊断 browsersvc 守护进程、安装/升级到活 profile、重建非 root 用户态 Chromium、改 browser provider 配置、看观测日志与回滚 —— 含 browsersvc CLI 速查、技能 --install/--uninstall、状态文件与凭据门、面板六条路由与状态码、排障表与两条必知机制（bundles 与 patch 双注册）
whenToUse: 浏览器不可用 / 渲染异常 / 面板或路由报错 / dsh 重启后失效 / 需起停或诊断 browsersvc / 需重建运行时、改 provider 配置或回滚时
disable-model-invocation: true
---

# browser-runtime — 浏览器服务、用户态 Chromium 与 dsh 配置运维

> 姊妹技能 `browser` 讲**怎么用**；本技能讲**怎么修、怎么起停、怎么重建、怎么改配置、怎么看观测、怎么回滚**。
> 2026-09-30 实测校正（DSH 0.2.0-rc.2 + `dsh-moli-browser` v0.8.2）。本技能与正文随包发布（`skills/browser-runtime/`），装包时由插件的**内置技能提供者**提供（`source:'bundled'` + rank 600，技能中心显示「系统内置」），不是落盘的用户级技能——详见 §5。
> 同日重启后做的活实例复核（四条全过）：① 自启 cmdline 是 `…/profiles/web/node_modules/dsh-moli-browser/bin/browsersvc.mjs run --idle-ms=300000`；② `maxTabs` 默认 5 真的拦第 6 个 `browser_open{newTab:true}`（报 `BROWSER_TAB_LIMIT`）；③ 关闭会话后 CDP 连接立刻断；④ 守护进程在启动后约 298 秒按 `idle-ms=300000` 退出，11 个内核进程一起回收，cgroup 内存 1814MB → 1181MB。

## 1. 现在的结构

```
33 个 browser_* 工具（内置 dsh-builtin-browser/tool-browser）
  └─ ctx.browser seam（browserProvider = cdp-daemon）
      └─ 插件 dsh-moli-browser（一个包 = provider + 守护进程 CLI + 网页面板 + 两份随包技能）
          └─ playwright-core connectOverCDP → 127.0.0.1:9333（Bearer token）
              └─ browsersvc supervisor（回环代理 + 门禁 + 内核生命周期）
                  └─ chrome-headless-shell 154.0.8037.57（经 chromium-wrapper.sh）
```

- **为什么不用内置 Electron provider**：`dsh-builtin-browser` 的 Electron 探测路径 `profiles/web/node_modules/electron/dist/electron` 从未下载（目录里只有 cli.js / install.js），报 `no usable browser provider is registered`；本机无 root、无 GUI 库，seccomp 下 Chromium 沙箱也起不来。
- **为什么不用 `dsh-playwright-browser`**：它自带 10 个与内置**同名**的 `browser_*` 工具（工具名冲突），必须停用；停用后内置 33 个工具全回来。

## 2. 安装 / 升级到活 profile

```bash
# 三种来源择一（provider + 33 个工具面 + 守护进程 CLI + 面板 + 技能都在这一个包里）
dsh plugin --profile web add dsh-moli-browser@latest     # A) npm
dsh plugin --profile web add https://github.com/lyp88997/dsh-moli-browser/releases/latest/download/dsh-moli-browser.tgz   # B) Release 资产
dsh plugin --profile web add github:lyp88997/dsh-moli-browser                                      # C) 源码（pnpm 现场构建）

# 之后必须重启 DSH（插件模块在 boot 时 import）；再校验组合：
dsh --profile web --dump-config | grep -E 'browserProvider|patched by|not found'
```

- 期望：`browserProvider: cdp-daemon`、`patched by dsh-moli-browser`；`browser-electron` / `playwright-browser` 两条守卫行打印 `not found`（只装本包时这两个 id 不存在，无害）。
- **新版本发布不满 24 小时时，pnpm 11 的 `minimumReleaseAge`（默认开）会扣住它，`@latest` 会静默解析成旧版**。活 profile 的 `$DSH_HOME/profiles/web/pnpm-workspace.yaml` 里有一份 `minimumReleaseAgeExclude`（实测现值 `dsh-moli-browser@0.4.1 || … || 0.8.1`）：把要装的新版本（如 `0.8.2`）追加进去再装。也可以按精确版本装——pnpm ≥11.1.3 的宽松模式会自动把不成熟版本记进 `minimumReleaseAgeExclude`，或者 `--config.minimumReleaseAge=0` 重试一次。
- 接缝依赖 `dsh-builtin-browser` 已写进本包 `dependencies`（33 个工具经 `./browser`、`./tool-browser` 转出）⇒ **别再单独 `add dsh-builtin-browser`**（会出现两条 `tool-browser` 行、工具重名）。
- **别用旧名 `dsh-browser-moli`**：npm 上同名包是别人的（drscrewdriver 0.17.4）。本包 npm 名就是 `dsh-moli-browser`。
- 插件与 `browsersvc` 必须**同版本**：v0.3.0 起公开端口要 Bearer token，旧插件配新守护进程会 401。升级顺序＝先换插件并重启 DSH，再 `browsersvc restart`。
- `@latest` 在已装版本仍满足依赖范围时不会升级；要强制升级就写精确版本。

## 3. 半边归属：改了什么要重启，什么刷新即可

| 你改的东西 | 归属 | 生效方式 |
| --- | --- | --- |
| `plugin/client.js`（面板界面、外观、几何、设置） | 客户端半边 | **刷新页面**（Ctrl+F5）即可 |
| `plugin/lib/panel.js`、`liveview.mjs`、`provider.js`、`src/*`、`plugin/lib/index.js` | 宿主半边 | **必须重启 DSH** |
| 技能正文 `skills/*/SKILL.md` | 提供者现读 | 不用重启（内置提供者每次现读文件） |
| `cordis.patch.yml` | 组合树 | 完整 web profile 上热重载会**静默回滚**，实际必须重启（见 §7 机制 1） |

- 「自动清理没生效」「面板新功能不见了」这类误报，十有八九就是宿主半边还是旧版：实测旧宿主上 `POST /browser-service/logs` 返回 **405**、`GET` 同路径 **404**（新路由压根没挂）。

## 4. browsersvc CLI 速查

`node <包>/bin/browsersvc.mjs <cmd>`（活 profile 里就是 `…/node_modules/dsh-moli-browser/bin/browsersvc.mjs`）

| 命令 | 说明 |
| --- | --- |
| `status` | 读状态文件 + 探测公开端口；输出 `running/healthy/port/internalPort/pid/browserPid/kernel/browserVersion/wsEndpoint(带 token)/startedAt/idleMs/logFile`。健康 exit 0，未运行 exit 1 |
| `start` | 起后台单例（幂等）；成功打印 `{started:true,…}`，失败 exit 2 |
| `stop [--force]` | 先做身份校验（`/proc/<pid>/cmdline` 含 `browsersvc.mjs`、内核含 `--remote-debugging-port=<内部端口>`）；不匹配就拒绝且**保留**状态文件，`--force` 才强杀 |
| `restart` | 停旧起新，输出 `{restarted:true,stopped:true,started:true,…}`；token 会换新 |
| `logs [--lines=60]` | 打印日志尾部（`--lines` 必须正整数） |
| `ops [--lines=20] [--json]` | 最近 N 次浏览器操作（动作 / 耗时 ms / 成败 / 错误原因 / 会话+标签），读 `ops.jsonl` |
| `console [--lines=40] [--json]` | 控制台输出与 `pageerror`（文本截 500 字），读 `console.jsonl` |
| `network [--lines=40] [--json]` | 请求两阶段（request/response，带状态码与耗时；`requestfailed` 单独标），读 `network.jsonl`（**不记头与体**） |
| `har [--session=s1] [--out=file]` | 会话 HAR（关闭会话时落盘 `har/<时间戳>-<会话>.har`，留最近 10 份）；不带 `--out` 只报路径与字节，带则复制且拒绝覆盖 |
| `cookies [--url=…] [--json\|--export=file\|--import=file]` | cookie/localStorage 导出注入：走浏览器级 CDP + 真实 `browserContextId` + `Storage.getCookies/setCookies`（**不依赖 DSH 会话**）；导出文件 0600、拒绝覆盖 |
| `detect` | 列出探测到的内核候选与解析后的配置 |
| `run` | 前台跑 supervisor（`start` 内部用它） |
| `skills [--install\|--uninstall] [--force] [--dir=…] [--json]` | 随包技能：查看 / 落盘 / 撤销，见 §5 |

- 参数：`--root`（默认 `$DSH_HOME/browser-service`）、`--port`（默认 9333）、`--idle-ms`（CLI 默认 900000，允许 1000..86400000）、`--kernel`、`--wrapper`、`--user-data-dir`、`--start-timeout`、`--internal-port-base`。
- env：`DSH_BROWSER_SVC_ROOT` / `DSH_BROWSER_SVC_PORT` / `DSH_BROWSER_SVC_IDLE_MS` / `DSH_BROWSER_CHROME` / `DSH_BROWSER_WRAPPER`；也可写 `$ROOT/config.json`。优先级 **CLI > env > config.json > 自动探测**；非整数/越界会被拒（`无效的 port：99999（允许 0..65535）`，exit 2）。
- 内核只绑 `127.0.0.1`（本机是 host 网络，**别**把 CDP 端口改到 `0.0.0.0`）。

## 5. 随包技能与「系统内置」身份

- 技能文件在仓库 `skills/` 里（`browser/SKILL.md`、`browser-runtime/SKILL.md` + 后者的 5 个 `scripts/` 文件，共 7 个）。**v0.8.2 起**由 `src/skill-provider.mjs` 用 `ctx.skills.registerProvider()` 注册成**内置提供者**（候选带 `source:'bundled'` + rank 600、`resourceBase` 指向包内目录、正文现读现剥 frontmatter），技能中心显示**「系统内置」**。
- **为什么不再默认落盘**：技能发现按「层内 rank 升序」去重，**rank 小的先赢**。落盘进 `$DSH_HOME/skills` 是用户级（rank 400），会**盖住**内置那份（600）⇒ 想显示「系统内置」就不能同时落盘。落盘保留为可选（配置 `syncSkills: true`，`skillsDir` 换目录），只为「DSH 以外的工具也要读这些文件」。
- 命令：
  - `browsersvc skills`：只报状态（每个文件：缺失/已最新/可升级/你改过/非本包、待处理数、槽位冲突数），并提示磁盘上有没有会盖住内置的副本。
  - `browsersvc skills --install [--force] [--dir=…] [--json]`：幂等落盘；被用户改过的副本跳过（`--force` 才覆盖）；台账写在目标目录的 `.dsh-moli-browser.skills.json`。
  - `browsersvc skills --uninstall [--dir=…] [--json]`：只删台账里属于本包且内容没被改过的文件，你改过的保留并说明原因，撤净后连台账与空目录一起清。**从 v0.8.1 落过盘的，跑这个再重启 DSH 就回到「系统内置」。**
- ⚠️ 直接改 `$DSH_HOME/skills/browser*/SKILL.md`，升级时会被台账识别为「你改过」而跳过——要么把改动提回仓库 `skills/`，要么 `--force` 覆盖（丢弃本地改动）。

## 6. 运行时状态、门禁与自愈

默认 root `$DSH_HOME/browser-service`：

| 路径 | 说明 |
| --- | --- |
| 进程 | supervisor（`browsersvc run`）+ 内核（内核 ppid = supervisor）；空闲 `idleMs` 且**无客户端连接**时 supervisor 自杀（正常行为） |
| `service.json` | 状态 + `token` + `listening`，**0600**；token 每次启动随机生成 |
| `ops.jsonl` / `console.jsonl` / `network.jsonl` | 观测日志，环形上限 1/1/2 MiB（超限保尾部一半），0600；IO 异常一律吞掉 |
| `har/` | 每会话 HAR（`<时间戳>-<会话>.har`，留最近 10 份） |
| `service.log` | supervisor / 内核日志 + 代理拒绝记录，0600 |
| `profile/` | 内核 userDataDir（cookie 明文） |

公开端口门禁：必须 `Authorization: Bearer <token>`；只放行 `GET /json/version|/json/list|/json/protocol` 与 `/devtools/*`（`/json/new|close|activate` 一律 403）；`/json/version` 的 `webSocketDebuggerUrl` 被改写成代理地址并附 token，调用方绕不开代理；**同一条连接上的后续请求不免检**（只有 CDP WebSocket 保长连接，其余请求按 `connection: close` 转发、响应后即关 —— F27）。

自愈行为（v0.3.1/v0.3.2 起，**别当故障报**）：

- 守护进程不在时插件按 `autoStartCommand` 自启一次（失败不反复拉起）；连接成功过之后开关复位，所以空闲自杀/崩溃后还能再自启。
- CDP 连接被换掉（守护进程重启、拆线、内核崩溃）后，会话在新连接上**按原 session id 重建**，工具层 session id 继续可用。
- token 每次 attach 重读 `service.json` ⇒ 守护进程换 token 后插件能跟上（冷启动第一次调用也不会 401）。
- 0.5.0 起最后一个会话关闭后插件**主动断开 CDP**，之后 supervisor 才可能按 `idleMs` 空闲自杀（插件自启默认 5 分钟 = 300000ms）；会话期间不回收（避免每次冷启动约 3s）。要立刻释放就 `browsersvc stop`（标签页随之清空）。

## 7. dsh 侧配置

- **正常安装（bundle 路线，别手改）**：包自带 `plugin/cordis.patch.yml`，会 insert `browser-moli` / `browser`（选 `cdp-daemon`）/ `tool-browser` 三行，并给 `browser-electron`、`playwright-browser` 加 `disabled: true`。
- **手写 patch 路线（只用于改本仓库源码）**：前提是 profile 的 `node_modules/` 能解析到片段里的 `name` —— 先 `ln -sfn /home/node/DSH/dsh-moli-browser $DSH_HOME/profiles/web/node_modules/dsh-moli-browser`；片段写在 `$DSH_HOME/profiles/web/cordis.patch.yml` **尾部**。

```yaml
- insert:
    - id: browser-moli
      name: dsh-moli-browser
      config:
        cdpUrl: http://127.0.0.1:9333
        connectTimeoutMs: 30000
        # autoStartCommand 可省：v0.4.0 起默认用包内 bin/browsersvc.mjs 自启
- id: browser
  config: { browserProvider: cdp-daemon }
- id: browser-electron
  disabled: true
- id: playwright-browser
  disabled: true
```

插件侧可配键（权威定义是 `plugin/lib/index.js` 的 `Config`；完整表见仓库根 `README.md` 的「配置」节）：

| 键 | 默认 / 范围 | 作用 |
| --- | --- | --- |
| `providerId` | `cdp-daemon` | seam 里注册的 provider id |
| `cdpUrl` | `http://127.0.0.1:9333` | 守护进程公开端口 |
| `cdpToken` | 空＝自动读 `service.json` | 手工指定 token（一般不用） |
| `connectTimeoutMs` / `actionTimeoutMs` / `navigationTimeoutMs` / `lookupTimeoutMs` | 10000 / 30000 / 30000 / 5000 | 各阶段超时 |
| `autoStartCommand` | 空＝包内 `bin/browsersvc.mjs start` | 自启命令 |
| `autoStartTimeoutMs` | 60000 | 自启等待 |
| `snapshotMaxElements` / `contentMaxChars` | 200 / 200000 | 快照元素与内容上限 |
| `viewportWidth` / `viewportHeight` | **1920 / 1080**（0.8.2 起；0.8.1 及以前 1440×900） | 新会话视口；运行时可被 `setViewport` 改，夹 640×360–3840×2160 |
| `captureConsole` / `captureNetwork` | `true` / `true` | 是否录控制台/网络；关网络捕获就不录 HAR |
| `maxTabs` | 5（夹 1..50） | 单会话标签上限，超限 `BROWSER_TAB_LIMIT` |
| `idleMs` | 300000（夹 1000..86400000） | 自启守护进程的空闲回收窗口，仅默认 `autoStartCommand` 时生效 |
| `downloadDir` | 空＝系统 Downloads（`XDG_DOWNLOAD_DIR` → `Downloads`/`下载`/`下載` → `~/Downloads`） | 截图/下载 `savePath` 必须落在其中 |
| `registerSkills` | **true** | 启动时注册内置技能提供者 |
| `skillsDir` | 空＝`$DSH_HOME/skills` | 落盘目标目录 |
| `syncSkills` | **false**（0.8.2 起；v0.8.1 是 true） | 可选的落盘同步（落盘是 rank 400，会盖住内置 600） |

### ⚠️ 两条必知机制（踩过）

1. **热加载只重读 patch 文件，不重读 `dsh.profile.bundles`**（`profile-boot-*.js` 的 `composeLive()` 用 boot 时冻结的 bundle patches）。改 `cordis.patch.yml` 才可能热生效；改 `bundles`、改插件代码、升级插件版本**都必须重启 dsh**（完整 web profile 上 patchReload 热重载会静默回滚，别信）。
2. **`insert` 不去重**（无 id 的 insert 直接 push）。若 `bundles` 注册了插件、patch 里又 `insert` 同 id，**下次重启会出现两条同 id 条目**。现状：活 profile 自 2026-09-27 起已切 bundle 路线（`dsh.profile.bundles` 含 `dsh-moli-browser`，手写 patch 里的浏览器块已删），`node_modules/dsh-browser-moli` 软链已删；切换前备份 `package.json.bak-pre-bundle`、`cordis.patch.yml.bak-pre-bundle`。两条路线二选一，绝不能同时。

## 8. 排障表（症状 → 原因 → 处置）

| 现象 | 根因与处理 |
| --- | --- |
| `no usable browser provider is registered` | provider 没进组合树 → 查 patch 的 `insert`、插件是否在 `profiles/web/node_modules/`、是否需要重启 dsh |
| `browser: 无法连接 CDP 端点 …ECONNREFUSED…；请先运行 browsersvc start` | 守护进程没起且自启失败 → `status` → `start`，看 `service.log` 尾部，确认 `autoStartCommand` 路径 |
| `Unexpected status 401`（attach 或 `curl /json/version`） | token 不匹配：插件与守护进程升级不同步、或两边 root 不一致 → 先重启 DSH（插件重读状态文件）再 `browsersvc restart`；或显式配 `cdpToken` |
| `EACCES: permission denied, open '…/service.log'` | 从受沙箱限制的 shell 调 `browsersvc start`：写 `$DSH_HOME` 要一次 `danger-full-access` 提权，或干脆让插件自启 |
| `EADDRINUSE … 127.0.0.1:9333` / `no free port from 9300` | 端口被占 → `status`/`logs` 找残留实例，或 `--port` / `--internal-port-base` 换端口 |
| `browser: 会话内没有可用标签页` | 连接被换掉后的旧会话（v0.3.1 起会自愈）→ 仍报就 `browser_reset_session`，或重启 DSH |
| `BROWSER_TAB_LIMIT`（开第 6 个标签） | 超过 `maxTabs`（默认 5）→ 关掉不用的标签或 `browser_reset`；要更多就调 `maxTabs`（夹 1..50）并重启 DSH |
| `BROWSER_SCREENSHOT_BLOCKED` / `BROWSER_DOWNLOAD_BLOCKED` | `savePath` 不是绝对路径、要覆盖已有文件、或不在 `downloadDir` 内 → 改路径/换名；要写工作区就显式配 `downloadDir` 并重启 DSH |
| `BROWSER_VIEWPORT_INVALID` | `POST /browser-service/viewport` 的宽高不是有限正整数（面板一般不会发坏值）→ 传正整数，服务端会夹到 640×360–3840×2160 |
| 面板路由报 404（例如 `POST /browser-service/logs` 返回 404/405） | 宿主半边是旧版，新路由没挂 → **重启 DSH**；客户端会明说「宿主半边是旧版，重启 DSH 后生效」 |
| 面板路由报 403（非本机访问 DSH Web） | 实时窗口只对本机回环开放；换到本机浏览器访问，或只用 `browsersvc` CLI 看观测 |
| `browser: 只允许 http(s) URL` | provider 只接 http(s) → 本地 HTML 起本地 http 服务 |
| `浏览器内核不存在 / 不可执行` | `--kernel` 指错或内核没下全（见 §12）；包装器必须可执行 |
| `error while loading shared libraries: libglib-2.0.so.0`（exit 127） | 直接跑了真二进制 → 必须经 `chromium-wrapper.sh`；或 `libs/` 不全，重跑 `setup-libs.sh` |
| `ldd` 有 `not found` | `LD_LIBRARY_PATH` 必须**两个目录都给**：`libs/usr/lib/x86_64-linux-gnu` **和** `libs/lib/x86_64-linux-gnu` |
| `FATAL:…zygote_host_impl_linux.cc] No usable sandbox!` | 容器 `NoNewPrivs=1` + seccomp ⇒ 必须 `--no-sandbox`（包装器已带） |
| 渲染崩溃 / 共享内存错误 | `/dev/shm` 只有 64M ⇒ 必须 `--disable-dev-shm-usage`（包装器已带） |
| 截图纯白 | 没给 fontconfig ⇒ `FONTCONFIG_FILE=…/fonts.conf`（包装器已带） |
| 中文全方块；两张等长不同汉字截图指纹完全相同 | 缺 CJK 字体 ⇒ `setup-libs.sh` 种子加 `fonts-noto-cjk` 重跑 |
| 重启 dsh 后浏览器又坏 / 出现两条同 id 条目 | `bundles` 与 patch 双注册，见 §7 机制 2 |
| `/tmp` 下的预览工装、`verify-*` 临时 root 消失 | `/tmp` 会被清理；验收脚本本来就该自建临时 root（见 §10），工装（如 `/tmp/panel-preview`）没了重跑即可，不是运行时故障 |
| 图片读不出来（`vision engine failed`） | 与浏览器无关：`npx @liustack/modlens doctor` |

## 9. 面板六条路由与状态码（宿主半边 `plugin/lib/panel.js`）

| 路由 | 方法 | 作用 | 常见状态码 |
| --- | --- | --- | --- |
| `/browser-service/panel.json` | GET/HEAD | 只读日志尾巴 + 服务信息块（`no-store`，不含绝对路径，下载目录只回目录名） | 其他方法 405；这一条**不走回环闸**（只读） |
| `/browser-service/live.jpg?since=N[&quality=&max=&maxh=]` | GET/HEAD | 取最新帧；长轮询最多等 1.5s，没有新帧回 **204** | 无 view 204；无 provider 503；方法 405 |
| `/browser-service/live.json` | GET/HEAD | 地址栏/标题/推流状态/生效取帧参数 | 无 view 回 **200** `{live:false,reason:"当前没有打开的页面 …"}`；无 provider 503 |
| `/browser-service/live` | POST/DELETE | 动作 `down/up/move/wheel/text/key/reload/goto`；DELETE 停流 | 非 POST/DELETE **405**；跨站 **403**；无 view 且非 goto **409**；未知动作 **400**；空网址 400；goto 无会话会先 `provider.open('面板地址栏')` 再导航，回 `{ok,url,session,opened:true}` |
| `/browser-service/logs` | POST | `{action:'clear'\|'trim',kind,keep}` 清/裁观测日志 | 未知 kind **400**；GET **405**；跨站 **403** |
| `/browser-service/viewport` | POST | `{width,height}` → `provider.setViewport()`，回 `{ok:true,viewport:{width,height,applied},at}` | 非法值 / body 不可解析 **400**；无 provider **503**；非 POST 405；跨站 403 |

- 三道闸：只认回环地址（非本机 **403**「实时窗口只对本机开放」）、方法白名单（**405**）、写路由同源校验（跨站 **403**；没有 `Origin`/`Referer` 的请求放行）。
- 没有 `webServer` 的宿主不挂这些路由，插件照常工作（provider 不受影响）。
- 写路由与 `panel.json` 的服务信息块都在宿主半边 ⇒ 改完**必须重启 DSH**；客户端半边（`plugin/client.js`）刷新页面即可。
- 胶囊位置（**客户端半边**，0.8.3 起）：设置里「胶囊位置」五档（左上/右上/左下/右下/**自由**）+ 水平/垂直偏移（贴角档 0–400 px；自由档按屏幕坐标 0–10000，两行改名「水平/垂直坐标」）；胶囊可**直接用鼠标拖**到任意位置（`pointerdown` + 指针捕获 + rAF，拖动期抓手光标），松手自动切「自由」并**立即写** `localStorage`（只合并 `pillPos`/`pillX`/`pillY`，不动其他未保存草稿），位移 ≤ 4px（`DRAG_SLOP`）仍算点击、照旧展开面板；视口变小时渲染按屏内夹回但**只夹不改存**。只有 `plugin/client.js` ⇒ 改完刷新页面即可。
- 取帧与清晰度（**客户端半边**，0.8.3 起）：「开始/停帧」状态记在组件外（`liveStartedMemory`）——取过帧后切到别的入口（操作/控制台/网络/设置）再切回「网页」会**自动续上，不用再点「开始」**；手动「停帧」后回来仍是停的，首开仍看「打开即取帧」设置。取帧「最大边」**默认 1920**（0.8.2 及以前默认 1280，画面先缩到 1280×720 再放大、看着糊；0.8.3 起与默认视口 1920×1080 同长边）。

## 10. 改完代码 / 配置怎么验

```bash
cd /home/node/DSH/dsh-moli-browser
node scripts/verify-daemon.mjs     # 守护进程 + CLI：35/35
node scripts/verify-provider.mjs   # provider + P7 分辨率 + 随包技能提供者：125 通过 0 失败
node scripts/verify-bundle.mjs     # 组合包安装 + 客户端半边（5c 29 项）+ 随包技能：75/75
node scripts/verify-data.mjs       # 观测面 + 实时窗口（六条路由与三道闸）：86 通过 0 失败
node scripts/verify-matrix.mjs --dsh dsh --smoke   # DSH 版本矩阵：4 个宿主版本 × 12 项
node bin/browsersvc.mjs status     # running/healthy + wsEndpoint 带 token
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9333/json/version   # 期望 401
ps -eo pid,ppid,args | grep -m1 '[c]hrome-headless-shel[l]'   # 内核 ppid = supervisor
```

- 四套脚本都用 `/tmp` 下的一次性 root/端口，**别指向 `$DSH_HOME/browser-service`**（脚本会按 pid 收敛实例并 `rmSync` 临时 root）。
- 验证顺序：改插件代码 → 跑对应 verify → **重启 DSH** 才进活实例；只改客户端半边 → 刷新页面。

## 11. 运行时目录清单（`/home/node/DSH/.browser/`，2026-09-28 清理后实测 389MB）

| 路径 | 作用 | 大小 |
| --- | --- | --- |
| `chromium-wrapper.sh` | 启动包装器：export `LD_LIBRARY_PATH` + `FONTCONFIG_FILE`，exec 真二进制并追加 `--no-sandbox --disable-dev-shm-usage` | 1KB |
| `chromium/chrome-headless-shell` | 稳定符号链接 → `puppeteer/…/chrome-headless-shell` | — |
| `libs/` | 用户态系统库前缀（43 个 .deb 解包，含中文字体） | 126MB |
| `fonts.conf` | fontconfig：`<dir>`→`libs/usr/share/fonts`，`<cachedir>`→`fontcache` | 小 |
| `puppeteer/` | `@puppeteer/browsers` 下载的 chrome-headless-shell | 263MB |
| `screenshots/` | 历史截图落盘目录 | 284KB |
| `setup-libs.sh` | 重建脚本（apt-get download → dpkg-deb -x，非 root） | 2KB |
| `cordis.patch.yml.a1-backup` | 回到旧 A1 方案（`dsh-playwright-browser`）的 patch 备份 | 4.6KB |
| `browse.mjs`、`verify-cjk.mjs`、`verify-daemon.mjs` | 逃生舱与验证脚本（包内 `skills/browser-runtime/scripts/` 下有副本） | 小 |

- 包装器可被覆盖：`DSH_BROWSER_PREFIX` / `DSH_BROWSER_FONTCONF` / `DSH_BROWSER_CHROME`。
- 内核 userDataDir 归守护进程管（`$ROOT/profile`，默认 `$DSH_HOME/browser-service/profile`）。
- `moli/`（早期浏览器）、`profile/`/`daemon-profile/`/`pw/`（早期残留）2026-09-28 已删。

## 12. 重建 / 迁移（无 root）

```bash
cd /home/node/DSH/.browser
./setup-libs.sh                       # 1) 用户态系统库（42–43 包，约 124MB，含中文）
cd /home/node/.dsh/profiles/web/node_modules/.bin
./browsers install chrome-headless-shell@stable --path /home/node/DSH/.browser/puppeteer   # 2) 内核
ln -sfn /home/node/DSH/.browser/puppeteer/chrome-headless-shell/linux-<版本>/chrome-headless-shell-linux64/chrome-headless-shell \
        /home/node/DSH/.browser/chromium/chrome-headless-shell
# 3) 校验
W=/home/node/DSH/.browser
LD_LIBRARY_PATH=$W/libs/usr/lib/x86_64-linux-gnu:$W/libs/lib/x86_64-linux-gnu \
  ldd $W/chromium/chrome-headless-shell | grep -c 'not found'      # 期望 0
$W/chromium-wrapper.sh --dump-dom https://example.com | grep -o '<title>.*</title>'
node $W/verify-cjk.mjs                                             # 期望「纯汉字截图互不相同」
```

`setup-libs.sh` 要点：非 root 走 `apt-get -o Dir::State::Lists=/tmp/aptl/lists -o Dir::Cache=… -o Dir::Cache::archives=… download` + `dpkg-deb -x`；种子含 `libnss3/libgbm1/libglib2.0-0/libX11…` + `fonts-liberation` + **`fonts-noto-cjk`（必需，否则中文是豆腐块）**；`PRUNE_RE` 排除 `libc6/libgcc-s1/libstdc++6` 等，**避免 `LD_LIBRARY_PATH` 覆盖系统 ABI**。

## 13. 回滚 / 清理

```bash
# 彻底移除自建 provider
node /home/node/DSH/dsh-moli-browser/bin/browsersvc.mjs stop
dsh plugin --profile web remove dsh-moli-browser
# 回到旧 A1 方案（dsh-playwright-browser + 用户态内核）
cp /home/node/DSH/.browser/cordis.patch.yml.a1-backup /home/node/.dsh/profiles/web/cordis.patch.yml
# 从 bundle 路线退回手写 patch 路线（用 2026-09-27 切换前的备份）
cd /home/node/.dsh/profiles/web
cp -a package.json.bak-pre-bundle package.json
cp -a cordis.patch.yml.bak-pre-bundle cordis.patch.yml
dsh plugin --profile web add dsh-builtin-browser && dsh plugin --profile web add dsh-playwright-browser
ln -sfn /home/node/DSH/dsh-moli-browser node_modules/dsh-moli-browser
```

`libs/`、`chromium/`、`chromium-wrapper.sh`、`fonts.conf` 是运行必需；`pw/`（仅验证用）、`univer-probe*.univer` 可删。

## 14. 安全与边界

- 公开端口只绑回环并要求 Bearer token；但同机同 uid 仍能读 `service.json` 拿 token ⇒ token 是防误连/防盗用，**不是**多租户边界。
- `--no-sandbox` ⇒ 页面以 dsh 进程权限运行；只访问可信站点，别在共享 `profile/` 里登录敏感账号（cookie 明文）。
- 写 `$DSH_HOME` / `/home/node/DSH/.browser` 超出默认 workspace-write 沙箱 ⇒ 需要一次 `danger-full-access` 提权；且**不能从承载当前会话的进程里重启 dsh 自己**。
- 版本适配：启动期由 `plugin/lib/compat.js` 校验接缝导出面，不符只打印一句人话并安静退出。已实测矩阵（每版本 12 项、含真开 example.com）：**0.1.5-rc.3 / 0.1.7-rc.1 / 0.1.7-rc.2 / 0.1.6-alpha.2 全 12/12**；接缝 `dsh-builtin-browser` 实测面 0.1.22。未复测更早的 0.1.0-rc.x 与 macOS / Windows。
- **网页面板是可选件**：用 `ctx.inject(["webServer"], …)` 挂路由，没有 `webServer` 或 ctx 上没有 `inject` 时只打一行 info 就跳过，**provider 不受影响**。挂载要重启 DSH；之后只改 `plugin/client.js` 不必重启。
- 随包技能只提供文本与脚本，不新增任何 `browser_*` 工具（工具面恒为 33 个）。
