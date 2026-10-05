# 自建浏览器服务：开发方案可行性分析

> 目标：自建一个本地浏览器服务，既能被 **DSH 的浏览器工具**调用，也能被 **dsh-univer-office** 这类"要一个浏览器可执行文件"的插件调用。
> 结论基于本机实测（DSH 0.1.5-rc.3 / Debian 12 容器 / 非 root / host 网络 / 内存上限 2G）。
>
> **版本注记（1.0.1）**：本文是立项时代的可行性分析，历史记录原样保留。此后本包已按方案 A 单换 **moli** 内核（`moli serve` 直连、`moliEnv` 注入用户态库与字体、无 Chromium 沙箱参数）；文中 `chrome-headless-shell`、`--remote-debugging-port`、`--no-sandbox`、包装脚本等处均指当时实测，**CDP 单例、多会话隔离、73ms 接入这些核心结论对 moli 同样成立**。

## 0. 结论（先看这个）

**可行，而且这不是逆向工程——DSH 的浏览器 seam 就是为"换 provider"设计的。**

但要先认清一个硬事实：**两类消费方的接入面完全不同**，一个服务没法用同一种方式同时喂饱它们：

| 消费方 | 它能接受什么 | 依据（实测/源码） |
|---|---|---|
| DSH 的 `browser_*` 工具 | `ctx.browser` seam 的 **provider 注册**（或任何能说 CDP 的客户端） | `dsh-builtin-browser/lib/browser/runtime.js` 暴露 `ctx.browser.registerProvider()`；provider 入口 `browser-electron/entry.js` 只有 50 行：`export const inject = ['browser']` + `apply(ctx, config)` |
| dsh-univer-office | **只能给一个浏览器可执行文件路径** | 源码里 `connectOverCDP / browserURL / browserWSEndpoint / wsEndpoint` 命中数 **= 0**；它只走 `browserExecutablePath` / `UNIVER_RENDER_BROWSER` + 自己 `launch`，且自带 `--no-sandbox --disable-gpu --disable-dev-shm-usage` |

⇒ 所以正确形态是 **"一套运行时，两种脸"**：
- **脸 A（守护进程 + CDP 端点）**：给 DSH 侧用，单例浏览器、多会话隔离、客户端 73ms 接入。
- **脸 B（同一个内核二进制 + 包装脚本）**：给 univer 这类 launch 型插件用（现状已经work）。
- 附加 **脸 C（可选，进阶）**：写一个 CDP-over-pipe 代理当"假浏览器可执行文件"，让 univer 也复用守护进程（见 §4.3，未验证但可行）。

## 1. 核心可行性已被我实测证明

单例 `chrome-headless-shell` 起 `--remote-debugging-port`，多客户端隔离复用：

```text
GET http://127.0.0.1:9333/json/version
→ { "Browser": "HeadlessChrome/154.0.8037.57", "Protocol-Version": "1.3", ... }

Playwright connectOverCDP("http://127.0.0.1:9333")
→ { 连接耗时ms: 73, 已有上下文: 3, 新上下文隔离: "ctx1 cookies=1, ctx2 cookies=0", title: "Example Domain" }
→ 单个浏览器树（3 个进程，含 2 个隔离上下文）RSS 合计 172 MB
```

即：**一进程服务多会话 + 上下文级 Cookie 隔离 + 接入 73ms** 都成立，不需要新写浏览器，只用现成的 `chrome-headless-shell`（154.0.8037.57）与已装好的用户态运行库。

## 2. 三层工作量（按性价比排序）

### L1 服务层：CDP 守护 + 监管（低风险，1–2 天）
- 组件：`browsersvc start|stop|status`（Node，约 150–250 行）：spawn 包装脚本 → 轮询 `/json/version` → 暴露 `127.0.0.1:<port>`；空闲回收、崩溃重启、端口自动择取。
- 验收（可直接照搬我这次的验证脚本）：`curl /json/version` 返回 1.3 协议 + `connectOverCDP` 两个上下文互相看不到 cookie。
- 依赖：**零新依赖**（用 `playwright-core`/`puppeteer-core`，两者都已在 profile 里）。

### L2 DSH 接入：两条路
**L2a 复用现成插件（半天，0 代码）**：`dsh-browser-tool` 的 `connected` 模式（`DSH_BROWSER_CDP_URL`）直接指向我们的守护进程。
- 代价：它读的是**进程环境变量** ⇒ 要改容器 env（需要重建容器）；且它自带自己的 `browser` 工具面，不是内置那 33 个。

**L2b 自写 provider（推荐，3–5 天）**：
- 入口 ~50 行（抄 `browser-electron/entry.js` 的结构）：`inject = ['browser']`、`Config`（CDP 地址、并发上限、超时、截图目录）、`apply(ctx, config)` 里 `ctx.browser.registerProvider(...)`，并用 `ctx.effect()` 注册 disposer。
- provider 本体：实现 `dsh-builtin-browser/lib/browser/types.d.ts`（578 行、约 40 个请求/响应接口：navigate / click / type / scroll / key / elementTarget / setValue / check / select / clear / getValue / scrape / fill / wait / screenshot …），每个方法映射到 Playwright 的 1–2 个 API。参考实现 `browser-electron/provider.js` 是 Electron 专用的（1600+ 行，含 host RPC），CDP 直连版会明显更薄。
- **回报**：内置 `tool-browser` 的 33 个 `browser_*` 工具**全部免费复用**（这正是现在被停用的那套），且配置写在 `cordis.patch.yml` 里 → **热加载生效，不需要动容器 env**。
- 需要同时 `disabled: true`：`browser-electron`（否则重复 provider，源码注释提到 `BROWSER_DUPLICATE_PROVIDER`）与 `tool-browser` 的替代关系要想清楚——若走 L2b 且复用内置工具，则**保留 `tool-browser`、只关 `browser-electron`**（与现在的配置正好相反）。

### L3 univer 接入（0 代码；或进阶写代理）
- 现状：`- id: univer / config: { browserExecutablePath: <包装脚本> }` 已经验证可用（截图出图、打印 PDF 同理）。
- 想让 univer **也复用守护进程**，只有一条路：写一个"假浏览器可执行文件"——puppeteer-core 用 `--remote-debugging-pipe` 拉起它并读写 fd 3/4，这个 shim 把管道 CDP 转发到守护进程的 WebSocket。技术上可行（CDP 消息就是 `\0` 分隔的 JSON），规模约 150–250 行，但**版本握手、会话映射、错误透传**都要处理，风险中等。**未验证**，建议作为可选里程碑而不是 MVP。
- 否则：univer 继续自己启动一个临时实例，**只共享内核二进制与库目录**（不共享进程）——内存代价是多一份约 100–170MB（在 2G 上限下可接受，且它用完即退）。

## 3. 必须写进设计的硬约束（都是踩过的坑）

1. **CDP 端口只能绑回环**：本容器是 **host 网络**，CDP 端口若暴露在 0.0.0.0 等于把"完全操控浏览器（含读 cookie）"开放给主机上任意进程。用 `--remote-debugging-address=127.0.0.1` + 随机端口 + 可选一次性 token。
2. **`--no-sandbox` 仍必须**（`NoNewPrivs=1` + seccomp 已实测 `No usable sandbox!`），`--disable-dev-shm-usage` 也仍必须（`/dev/shm` 只有 64M）。
3. **字体**：`FONTCONFIG_FILE` 指向 `.browser/fonts.conf`；不配则截图纯白、中文变方块（已实测）。
4. **运行库**：沿用现有 `/home/node/DSH/.browser/libs`（43 包/124MB）——**这是整套方案唯一的"外部依赖"**，但它是本机用户态产物，不依赖任何外部服务。
5. **会话隔离必须用 incognito context**（`Target.createBrowserContext` / Playwright `newContext()`），不能共用默认上下文（实测隔离有效）。
6. **热加载语义**：`cordis.patch.yml` 改动热加载生效；`dsh.profile.bundles` 改动要重启；`insert` 不去重（bundles + patch 双注册会变成两条同 id → 已知坑）。
7. **故障域**：单例守护进程崩掉会波及所有会话 ⇒ 监管必须"重启 + 会话重建"，provider 侧要有重连与幂等。

## 4. 建议的落地顺序与验收

| 里程碑 | 内容 | 验收（可执行） |
|---|---|---|
| 守护进程 | `browsersvc` 守护 + 监管 | `curl 127.0.0.1:<port>/json/version` = Protocol-Version 1.3；两个上下文 cookie 互不可见；kill 后自动重启 |
| provider | `browser-moli` provider 插件（自写）+ 关掉 `browser-electron`，保留 `tool-browser` | 33 个 `browser_*` 工具在守护进程上跑通（含截图、多标签、表单） |
| M3 | univer 指向包装脚本（现状） | `univer_screenshot` 出图；打印 PDF 出文件 |
| M4（可选） | 给服务加通用 HTTP 面：`/fetch`、`/screenshot`、`/eval`（Moli 风格） | 任何插件不需要懂 CDP 也能用 |
| M5（进阶） | CDP-over-pipe 代理，让 univer 复用守护进程 | univer 渲染时不再新增浏览器进程 |

## 5. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| CDP / Playwright 版本漂移 | provider 与内核协议不匹配 | 锁定内核版本（现 154.0.8037.57）+ 固定 `playwright-core` 版本；保留 patchright 备选 |
| 重复 provider / 重复 loader id | 启动失败或工具重复注册 | 关 `browser-electron`；沿用"bundles 与 patch 只留一个来源"的既有结论 |
| 单进程故障域 | 全会话断 | 监管重启 + 自动重建上下文；provider 侧有界重试 |
| 内存（上限 2G） | 共享反而累积 | 每上下文空闲回收；限制并发上下文数（建议 ≤4）；守护进程空闲 N 分钟自杀 |
| 安全（host 网络 + --no-sandbox） | 页面逃逸/端口暴露 | 只绑 127.0.0.1、随机端口、只访问可信站点、必要时把浏览器放进独立容器 |
| univer 无法复用守护进程 | 多一份内存 | 接受；或走 M5 代理 |

## 6. 结论与推荐

- **纯技术可行性：高。** 关键机制（单例 + 多会话隔离 + 73ms 接入 + 现成 seam 扩展点）都已实测，不需要魔改 DSH，也不需要 root。
- **推荐路径：L1 + L2b（3–5 个工作日）**，换来：内置 33 个浏览器工具全部回归、配置热加载、不依赖容器 env、比现状少一份浏览器进程。L2a 是"半天上线但要走 env"的替代；L3 的管线代理留作后续。
- **真正的成本不在"能不能接"，而在长期维护**：provider 要跟着 `types.d.ts` 与内核版本走。如果目标只是"univer 能渲染 + agent 能读页面"，那 Moli / 现状方案更省事；如果目标是"自建可复用、可控、可共享的浏览器底座"，这份方案成立。

> 备注：本文所有 `dsh-univer-office` 行为结论来自其 `lib/index.js`（5.2MB，minified）的关键字取证；seam 结构来自 `dsh-builtin-browser/lib/browser/{types.d.ts,runtime.js,browser-electron/entry.js}`。M5 的管线代理为设计推断，**未实测**。
