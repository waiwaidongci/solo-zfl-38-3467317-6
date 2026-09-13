#!/usr/bin/env bash
# 为真实浏览器测试准备运行环境：
#   1. 安装 playwright（npm）并下载 chromium
#   2. 无 root 环境下，把 Chromium 需要的系统共享库下载解压到 .browser-libs/
# 用法：bash scripts/setup-browser.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d node_modules/playwright ]; then
  npm i -D playwright
fi
npx playwright install chromium

SHELL_BIN=$(ls -d "$HOME"/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux-*/chrome-headless-shell 2>/dev/null | head -1 || true)
if [ -z "$SHELL_BIN" ]; then
  echo "未找到 chrome-headless-shell，跳过系统库检查"
  exit 0
fi

if ! ldd "$SHELL_BIN" 2>/dev/null | grep -q "not found"; then
  echo "系统库齐全，无需下载"
  exit 0
fi

echo "检测到缺失系统库，下载到 .browser-libs/ ..."
APT_DIR=$(mktemp -d)
mkdir -p "$APT_DIR/lists/partial" "$APT_DIR/cache/archives/partial"
apt-get -o Dir::State::Lists="$APT_DIR/lists" -o Dir::Cache="$APT_DIR/cache" -o APT::Sandbox::User=root update
(
  cd "$APT_DIR/cache/archives"
  apt-get -o Dir::State::Lists="$APT_DIR/lists" -o Dir::Cache="$APT_DIR/cache" download \
    libnspr4 libnss3 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libasound2 \
    libatk1.0-0 libatspi2.0-0 libdbus-1-3 libgbm1 libxkbcommon0 libdrm2 \
    libwayland-server0 libxi6
)
mkdir -p .browser-libs
for f in "$APT_DIR"/cache/archives/*.deb; do
  dpkg-deb -x "$f" .browser-libs
done
rm -rf "$APT_DIR"
echo "完成。运行 npm run test:browser"
