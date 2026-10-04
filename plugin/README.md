# plugin/ —— dsh-moli-browser 的插件侧源码

这里不是独立子包：**v0.4.0 起本仓库只有一个交付物 `dsh-moli-browser`**（根 `package.json` 就是它），安装、打包与分发见[根 README](../README.md) §3.3 与 §8（npm 短命令：`dsh plugin --profile <name> add dsh-moli-browser@latest`）。本目录只放插件侧的东西：

```
browser_* 工具（33 个，来自依赖 dsh-builtin-browser 的 tool-browser）
   └─ ctx.browser seam（来自同一个依赖的 browser）
        └─ 本目录的 provider（providerId = cdp-daemon）
             └─ playwright-core connectOverCDP → browsersvc 回环代理
                  └─ chrome-headless-shell（用户态库 + 包装脚本）
```

| 路径 | 作用 |
| --- | --- |
| `lib/index.js` | 插件入口：`inject = ['browser']`，先做启动期能力探测（`lib/compat.js`）再注册 provider |
| `lib/compat.js` | 启动期探测：校验接缝导出面（`browser` 的函数默认导出 / `tool-browser` 的 `name`+`apply`+`inject`）、读宿主与接缝版本，不符时打一句人话并安静退出 |
| `lib/provider.js` | `BrowserProvider` 全部成员（seam 契约见 `dsh-builtin-browser/lib/browser/types.d.ts`）；含默认自启 `defaultAutoStartCommand()` |
| `lib/dom.js` | 页面内取快照 / a11y / 表单操作注入的脚本（含 checked 状态、代理对安全截断） |
| `lib/panel.js` | 网页面板的**宿主半边**：四条 `exact` 路由（只读 `panel.json` + 实时窗口 `live.jpg`/`live.json`/`live`）与三道闸（回环地址、方法白名单、POST/DELETE 同源），经 `ctx.inject(['webServer'], …)` 挂载；载荷不含绝对路径 |
| `lib/liveview.mjs` | 实时窗口（P4）：`Page.startScreencast` 取 JPEG 帧（只在画面变化时下发、逐帧 ack）、`waitFrame({since})` 长轮询、`Input.*` 把点击/滚动/打字/按键打回真页面；CDP 会话懒建，空闲 30 s 自动停流 |
| `client.js` | 网页面板的**客户端半边**：手写零构建，走 `window.__ModuleLoader__` 协议、只 `require('react')`，`apply` 注册到 `shell.overlay`（四标签，默认「网页」帧流 + 日志三视图） |
| `shims/browser.js` | `export * from 'dsh-builtin-browser/browser'`（含 default）：把接缝挂进 profile |
| `shims/tool-browser.js` | `export * from 'dsh-builtin-browser/tool-browser'`（**源模块没有 default**）：挂 33 个工具 |
| `cordis.patch.yml` | bundle patch：`insert` 接缝 `browser`（选 `cdp-daemon`）、`tool-browser`、`browser-moli` provider |

转出口的导出键必须与源模块**完全一致**（loader 挂的是模块本身）；少一个 default 或多一个都会在组合期报错，所以 `scripts/verify-bundle.mjs` 会把两者的导出键逐一比对。

## 配置

配置表的权威位置是**根 README 的「配置」一节**（npm 页面只渲染根 README）；键与默认值的权威定义是 `lib/index.js` 的 `Config`（schemastery schema）。改默认值必须**同时**改 schema 与根 README 的配置表——本文件不再复制那张表，以免再出现「文档写 `30000`、代码是 `10000`」这类漂移。

所有键都可写在 profile patch 的 `config:` 下（patch **整行替换** `config`，覆盖时要重述该行需要的每个键）。

> **v0.3.0 起公开端口要求 `Authorization: Bearer <token>`**（token 由 `browsersvc` 生成，落在 0600 的 `service.json`）。插件自动读取它，无需改配置；但 `browsersvc` 与插件必须一起升级——旧插件 + 新守护进程会在 401 上失败。

## 验证

- 插件行为：`node scripts/verify-provider.mjs`（125 项零依赖，真实 `browsersvc` + 本地站点；含 P7 的窗口分辨率 `setViewport`，以及随包技能提供者 8 项）。
- 随包技能（v0.8.2 起在技能中心显示「系统内置」）：`node scripts/verify-bundle.mjs` 第 6 段（11 项）+ `node scripts/verify-provider.mjs` 的「随包技能提供者」段（8 项）+ 手查 `node bin/browsersvc.mjs skills [--install|--uninstall] [--dir=…]`。
- 组合包安装路径（官方 `dsh plugin` 流程）：`node scripts/verify-bundle.mjs`（75 项，一次性隔离 `DSH_HOME`；含启动期探测的四类坏形状、工具面静态计数与客户端半边 5c 段 29 项，含 P7 的写路由引用、面板间距夹取、新设置键与胶囊自定偏移，P8 的外观 CSS 变量与颜色规整，**P9 的胶囊「自由」档定位/视口夹回、`pillPoint` 四组坐标与拖动接线七项**，**P10 的「最大边」默认 1920 与取帧开关跨页签记忆接线**，G 的第四参「顶部留白」、自动量（取最高贴顶条）与 0–200 夹取、画面比例回退、`fitPicture`/`topInset` 新默认；第 6 段的随包技能 11 项（含 `--uninstall` 保留改过的 1 个、撤净后清台账）与 tarball 带 `src/skill-provider.mjs` 的断言）。
- 观测面与实时窗口：`node scripts/verify-data.mjs`（86 项，真实 `browsersvc` + 本地站点；ops/console/network/har/cookies + `panel.json` 路由 + P4/P5 四条 live 路由与三道闸、取帧参数透传与夹取、只读服务信息块、P6 日志清理与无会话跳转自动开页、P7 分辨率写路由与夹取/非法值/三道闸）。
- 守护进程与 CLI：`node scripts/verify-daemon.mjs`（35 项）。
- DSH 版本矩阵：`node scripts/verify-matrix.mjs --dsh <bin> … --smoke`（4 个宿主版本 × 12 项）。

## 许可

MIT（见仓库根 `LICENSE`）
