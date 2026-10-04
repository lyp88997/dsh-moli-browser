/**
 * 转出 dsh-builtin-browser 的浏览器接缝插件（注册 ctx.browser）。
 *
 * 本包把 dsh-builtin-browser 作为自己的依赖，并从本包转出它的接缝与工具面，
 * 于是 profile 里只装本包就能挂上 `browser` 行（「一个包装完」）。
 * 转出口是 patch 行里 `name: dsh-moli-browser/browser` 指向的东西。
 *
 * 转出形状必须与源模块**完全一致**（loader 挂的是模块本身）：源模块导出
 * `default`（插件函数，带 Config）以及具名 `BrowserError` / `BrowserRuntime`，
 * 所以 `export *` 与 `export { default }` 都要有。
 */
export * from 'dsh-builtin-browser/browser';
export { default } from 'dsh-builtin-browser/browser';
