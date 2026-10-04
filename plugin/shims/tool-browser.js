/**
 * 转出 dsh-builtin-browser 的 browser_* 工具插件（33 个工具）。
 *
 * 与 ./browser.js 同理：让本包自己带齐工具面，profile 里不需要单独安装接缝组合包。
 * 转出口是 patch 行里 `name: dsh-moli-browser/tool-browser` 指向的东西。
 *
 * 注意源模块**没有 default 导出**（只有具名 `name` / `apply` / `inject` / `internals`），
 * 所以这里只能 `export *`；写 `export { default }` 会在组合期报
 * "The requested module 'dsh-builtin-browser/tool-browser' does not provide an export named 'default'"。
 */
export * from 'dsh-builtin-browser/tool-browser';
