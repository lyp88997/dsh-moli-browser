# 贡献

规则只有一句话：**改了行为，就补上能拦住回归的断言**。详细约定在根 [`README.md` 的「贡献」一节](README.md#贡献)。

提 PR 前请跑：

```bash
node scripts/verify-daemon.mjs && node scripts/verify-provider.mjs && node scripts/verify-bundle.mjs && node scripts/verify-data.mjs
# 动了兼容面（接缝形状/宿主版本/入口导出）时再加一遍矩阵（逐个宿主串行跑，每行一个无头内核）：
# node scripts/verify-matrix.mjs --dsh dsh --smoke
```

并在 PR 描述里贴上计数（当前基线：35/35、125 通过 0 失败、75/75、86 通过 0 失败；矩阵 4 个宿主版本 × 12 项）。

四条硬约束：

1. 不要为了「让用例通过」放宽安全约束（只绑回环、Bearer token、路径白名单、`--no-sandbox` + `--disable-dev-shm-usage`、`savePath` 准入、观测日志 0600 与面板只读）。
2. 改 `plugin/lib/index.js` 的 `Config` 默认值必须同步根 README 的配置表；改 `dsh.bundle` / 转出口形状必须同步 `scripts/verify-bundle.mjs` 的断言。
3. 改 `plugin/lib/compat.js` 的期望形状（接缝导出面）时，必须同步 README 的「DSH 兼容矩阵」并重跑矩阵——那是对外声明的兼容性依据。
4. 改 `plugin/client.js` 或 `plugin/lib/panel.js` 时，`scripts/verify-bundle.mjs` 的 5c 段会校验 loader 协议、`apply` 注册与「只 require 平台种子表内的包」；新增裸 `require` 前先确认它在种子表里（否则要写进 `dsh.client.inject`/`external` 或打包进去）。
