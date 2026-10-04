#!/bin/sh
# Chromium 启动包装器：注入用户态运行库 + 字体配置，并以容器内可行的沙箱设置启动。
#
# 用途：任何 CDP 客户端（Playwright / puppeteer-core / dsh-browser-tool）把
#       executablePath / PUPPETEER_EXECUTABLE_PATH 指向本脚本即可，
#       不必修改 dsh 进程环境变量，也不需要在宿主机上 root。
#
# 背景（本机实测）：
#   - 系统缺 libnss3/libgbm/libglib/libX11 等 20 个 .so，已由 setup-libs.sh 解包到 PREFIX；
#   - /dev/shm 仅 64M，Chromium 必须 --disable-dev-shm-usage；
#   - 容器 NoNewPrivs=1 + seccomp 过滤，Chromium 命名空间沙箱不可用（FATAL: No usable sandbox），
#     故必须 --no-sandbox；这意味着页面以本进程权限运行，只访问可信站点。
set -eu

PREFIX="${DSH_BROWSER_PREFIX:-/home/node/DSH/.browser/libs}"
FONTCONF="${DSH_BROWSER_FONTCONF:-/home/node/DSH/.browser/fonts.conf}"
CHROME="${DSH_BROWSER_CHROME:-/home/node/DSH/.browser/chromium/chrome-headless-shell}"

LD_LIBRARY_PATH="$PREFIX/usr/lib/x86_64-linux-gnu:$PREFIX/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export LD_LIBRARY_PATH
[ -f "$FONTCONF" ] && FONTCONFIG_FILE="$FONTCONF" && export FONTCONFIG_FILE

exec "$CHROME" "$@" --no-sandbox --disable-dev-shm-usage
