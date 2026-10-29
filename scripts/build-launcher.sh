#!/bin/zsh
# 生成「启动 InsPin.app」—— 双击即可运行开发版，不出现终端窗口。
#
# 为什么需要它：这台电脑有公司管控（JAMF + EDR），electron-builder 打出来的
# .app 无法启动；但由终端/脚本直接拉起的 Electron 可以正常运行。
# 这个 AppleScript 小应用做的就是"替你在后台拉起"，绕开被拦的那条启动路径。
#
# 用法：npm run launcher      （生成在项目根目录）
#       npm run launcher -- --desktop   （同时复制一份到桌面）

set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="启动 InsPin.app"
APP_PATH="$PROJECT_DIR/$APP_NAME"
LAUNCHER="$PROJECT_DIR/scripts/launch-dev.sh"

cd "$PROJECT_DIR"
chmod +x "$LAUNCHER"

echo "1/3 生成图标 …"
if [ ! -f build/icon.png ]; then
  node scripts/gen-icon.mjs
fi
ICONSET="$(mktemp -d)/ins-pin.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s build/icon.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) build/icon.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o build/icon.icns

echo "2/3 生成启动器 App …"
rm -rf "$APP_PATH"
osacompile -o "$APP_PATH" -e "on run
	set launcher to \"$LAUNCHER\"
	try
		do shell script \"nohup \" & quoted form of launcher & \" >/dev/null 2>&1 &\"
		display notification \"正在启动，大约十几秒后出现窗口\" with title \"InsPin\"
	on error errMsg
		display dialog \"InsPin 启动失败：\" & errMsg buttons {\"好\"} default button 1 with icon stop
	end try
end run"
cp build/icon.icns "$APP_PATH/Contents/Resources/applet.icns"
touch "$APP_PATH"

echo "3/3 完成：$APP_PATH"
if [ "$1" = "--desktop" ]; then
  rm -rf "$HOME/Desktop/$APP_NAME"
  cp -R "$APP_PATH" "$HOME/Desktop/"
  echo "已复制到桌面：$HOME/Desktop/$APP_NAME"
fi
