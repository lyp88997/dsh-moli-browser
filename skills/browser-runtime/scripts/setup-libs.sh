#!/bin/bash
# 用户态补齐 headless Chromium 所需的系统运行库（无需 root）。
# 原理：apt-get download 拉 .deb -> dpkg-deb -x 解到本地前缀 -> LD_LIBRARY_PATH 注入。
# 核心库（glibc/libstdc++ 等）不进入前缀，避免 LD_LIBRARY_PATH 覆盖系统版本。
set -euo pipefail

PREFIX="${PREFIX:-/home/node/DSH/.browser/libs}"
DL="${DL:-/tmp/browser-debs}"
APT_LISTS="${APT_LISTS:-/tmp/aptl/lists}"
APT_CACHE="${APT_CACHE:-/tmp/aptl/cache}"
APT_ARCHIVES="${APT_ARCHIVES:-/tmp/aptl/archives}"
SOURCELIST="${SOURCELIST:-/etc/apt/sources.list.d/debian.sources}"

# 不放进前缀的包（系统已有且覆盖会造成 ABI 混乱）
PRUNE_RE='^(libc6|libc6-dev|libgcc-s1|libgcc-.*|libstdc\+\+6|libcrypt1|libz1|zlib1g|libselinux1|libmount1|libblkid1|libuuid1|libpcre2-8-0|libffi8)$'

mkdir -p "$DL" "$PREFIX" "$APT_LISTS/partial" "$APT_CACHE/archives/partial" "$APT_ARCHIVES/partial"

APT=(apt-get
  -o "Dir::State::Lists=$APT_LISTS"
  -o "Dir::Cache=$APT_CACHE"
  -o "Dir::Cache::archives=$APT_ARCHIVES"
  -o "Dir::Etc::sourcelist=$SOURCELIST")

SEEDS=(
  libx11-6 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2
  libasound2 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 libdbus-1-3
  libgbm1 libglib2.0-0 libnspr4 libnss3 libxcb1 libxkbcommon0
  fonts-liberation fonts-noto-cjk   # noto-cjk 必需：否则中文/日文渲染成豆腐块（实测）
)

echo "[1/4] 刷新 apt 索引 (非 root，自定义目录)"
"${APT[@]}" update >/dev/null 2>&1 || true

echo "[2/4] 解析依赖闭包"
PKGS=$(apt-cache -o "Dir::State::Lists=$APT_LISTS" depends --recurse --no-recommends \
  --no-suggests --no-conflicts --no-breaks --no-replaces --no-enhances --no-pre-depends \
  "${SEEDS[@]}" 2>/dev/null \
  | grep -E '^[a-zA-Z0-9]' | sort -u | grep -vE "$PRUNE_RE" | tr '\n' ' ')
echo "      包数: $(echo $PKGS | wc -w)"

echo "[3/4] 下载并解包到 $PREFIX"
cd "$DL"
# shellcheck disable=SC2086
"${APT[@]}" download $PKGS >/dev/null 2>&1 || true
n=0
for f in "$DL"/*.deb; do
  [ -e "$f" ] || continue
  dpkg-deb -x "$f" "$PREFIX" 2>/dev/null && n=$((n+1))
done
echo "      解包: $n 个 .deb"

echo "[4/4] 完成。前缀大小: $(du -sh "$PREFIX" | cut -f1)"
echo "LD_LIBRARY_PATH=$PREFIX/usr/lib/x86_64-linux-gnu:$PREFIX/lib/x86_64-linux-gnu"
