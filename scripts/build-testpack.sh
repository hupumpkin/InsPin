#!/bin/zsh
# 生成「InsPin 内部测试包」：一个自带运行环境的 .app，同事双击即可启动。
#
# 为什么这样做：
#   1. 公司电脑会拦截“双击启动的 Electron 应用”，但由脚本拉起的 Electron 正常，
#      所以用 AppleScript 小应用去拉起。
#   2. 同事机器上没有 Node/npm，所以包里**自带 Electron 运行时**。
#   3. macOS 会把从网络下载、未公证的应用放进一个临时只读目录运行
#      （App Translocation），旁边的文件夹全都看不见。这里把运行环境、应用代码
#      和启动脚本都放进 InsPin.app/Contents/Resources，无论从哪里启动都找得到。
#
# 用法：npm run testpack                    生成文件夹
#       npm run testpack -- --zip           同时打 zip 并生成 SHA-256
#       npm run testpack -- --zip --allow-dirty   临时测试用，不要求工作区干净

set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT_ROOT="$PROJECT_DIR/dist-testpack"
RUNTIME_SRC="$PROJECT_DIR/node_modules/electron/dist/Electron.app"
RUNNER_SRC="$PROJECT_DIR/scripts/testpack/run.sh"

WANT_ZIP=0
ALLOW_DIRTY=0
for arg in "$@"; do
  case "$arg" in
    --zip) WANT_ZIP=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    *) echo "未知参数：$arg"; exit 1 ;;
  esac
done

cd "$PROJECT_DIR"

VERSION="$(node -p "require('./package.json').version")"
PACK_NAME="InsPin-${VERSION}-mac-arm64-testpack"
PACK="$OUT_ROOT/$PACK_NAME"
APP_BUNDLE="$PACK/InsPin.app"
RES="$APP_BUNDLE/Contents/Resources"
COMMIT="$(git -C "$PROJECT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
CHANGES="$(git -C "$PROJECT_DIR" status --porcelain --untracked-files=no -- . || true)"

if [ -n "$CHANGES" ] && [ "$ALLOW_DIRTY" -ne 1 ]; then
  echo "工作区还有未提交的改动，发布包必须从固定提交构建："
  echo "$CHANGES"
  echo ""
  echo "先提交，或用 --allow-dirty 只做临时测试。"
  exit 1
fi

echo "版本 $VERSION（提交 $COMMIT）"
if [ -n "$CHANGES" ]; then
  echo "⚠️ 工作区不干净（--allow-dirty），这个包只能临时测试，不能外发。"
fi

echo "1/5 构建应用 …"
bash scripts/build-subject-lift.sh
npx electron-vite build

if [ ! -d "$RUNTIME_SRC" ]; then
  echo "找不到 Electron 运行时：$RUNTIME_SRC"
  exit 1
fi

echo "2/5 创建启动器骨架 …"
rm -rf "$PACK"
mkdir -p "$PACK"
osacompile -o "$APP_BUNDLE" -e "on run
	set myPath to POSIX path of (path to me)
	if myPath ends with \"/\" then set myPath to text 1 thru -2 of myPath
	set runner to myPath & \"/Contents/Resources/run.sh\"
	if (do shell script \"test -f \" & quoted form of runner & \" && echo yes || echo no\") is not \"yes\" then
		display dialog \"InsPin 启动器不完整。请重新解压整个测试包，不要单独拖出某个文件。\" buttons {\"好\"} default button 1 with icon caution
		return
	end if
	try
		do shell script \"nohup \" & quoted form of runner & \" >/dev/null 2>&1 &\"
		display notification \"InsPin 已启动，大约十几秒\" with title \"InsPin\"
	on error errMsg
		display dialog \"启动失败：\" & errMsg buttons {\"好\"} default button 1 with icon stop
	end try
end run"
# osacompile 生成的 Assets.car 里是系统默认的脚本图标，优先级高于 applet.icns；
# 不删掉它，Finder 永远显示那个“卷轴”图标。
rm -f "$RES/Assets.car"

echo "3/5 放入运行环境（约 290MB，稍等）…"
mkdir -p "$RES/运行环境"
# 复制后改名为 InsPin.app，并改掉应用身份和图标；否则程序坞里显示的是 Electron。
BUNDLE="$RES/运行环境/InsPin.app"
cp -R "$RUNTIME_SRC" "$BUNDLE"

# 体积优化：Electron 自带 220 份语言资源，每份一个 locale.pak，加起来约 49MB。
# 本产品面向中文用户，保留英文兜底和中文（简/繁/港），其余删掉。
# 系统语言不在保留列表时，macOS / Chromium 会回退到英文，不影响功能。
echo "3.5/5 精简运行时语言资源 …"
shopt -s nullglob
for RESOURCE_DIR in \
  "$BUNDLE/Contents/Resources" \
  "$BUNDLE/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources"; do
  [ -d "$RESOURCE_DIR" ] || continue
  for LOCALE_DIR in "$RESOURCE_DIR"/*.lproj; do
    case "$(basename "$LOCALE_DIR")" in
      Base.lproj|en.lproj|en_GB*.lproj|zh_CN*.lproj|zh_TW*.lproj|zh_HK*.lproj) ;;
      *) rm -rf "$LOCALE_DIR" ;;
    esac
  done
done
shopt -u nullglob

echo "4/5 放入应用与启动脚本 …"
mkdir -p "$RES/InsPin/native/SubjectLift"
cp -R "$PROJECT_DIR/out" "$RES/InsPin/out"
cp "$PROJECT_DIR/native/SubjectLift/subject-lift" "$RES/InsPin/native/SubjectLift/subject-lift"
cat > "$RES/InsPin/package.json" <<EOF
{
  "name": "ins-pin",
  "productName": "InsPin 内测版",
  "version": "$VERSION",
  "main": "out/main/index.js"
}
EOF

cp "$RUNNER_SRC" "$RES/run.sh"
chmod +x "$RES/run.sh"
cp "$PROJECT_DIR/scripts/testpack/测试指南.txt" "$PACK/测试指南.txt"

cat > "$PACK/版本信息.txt" <<EOF
InsPin 内部测试包
版本: $VERSION
渠道: internal
Git 提交: $COMMIT
构建时间: $(date '+%Y-%m-%d %H:%M:%S %z')
构建机器: macOS $(sw_vers -productVersion) / $(uname -m)
Electron: $(node -p "require('electron/package.json').version")
Node: $(node -v)
结构: 自包含（运行环境与应用代码在 InsPin.app 内）
EOF
if [ -n "$CHANGES" ]; then
  echo "注意: 工作区有未提交改动（--allow-dirty），不可外发" >> "$PACK/版本信息.txt"
fi

echo "5/5 生成图标、定制身份并签名 …"
node scripts/gen-icon.mjs
ICONSET="$(mktemp -d)/ins-pin.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s build/icon.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) build/icon.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o build/icon.icns
# 开发版/测试包的运行时图标兜底：main 进程会优先从这里读
cp build/icon.png "$RES/InsPin/icon.png"

# 改掉运行时自己的身份：程序坞和活动监视器里显示 InsPin，而不是 Electron。
PLIST="$BUNDLE/Contents/Info.plist"
cp build/icon.icns "$BUNDLE/Contents/Resources/InsPin.icns"
/usr/libexec/PlistBuddy -c 'Set :CFBundleName InsPin' "$PLIST"
/usr/libexec/PlistBuddy -c 'Set :CFBundleDisplayName InsPin 内测版' "$PLIST"
/usr/libexec/PlistBuddy -c 'Set :CFBundleIdentifier com.inspin.internal' "$PLIST"
/usr/libexec/PlistBuddy -c 'Set :CFBundleIconFile InsPin.icns' "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString ${VERSION%%-*}" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion ${VERSION%%-*}" "$PLIST"
# 改过 Info.plist 后原签名失效；Apple 芯片上不重签会直接启动失败。
xattr -cr "$BUNDLE"
codesign --force --deep --sign - "$BUNDLE"
codesign --verify --deep --strict "$BUNDLE"

# 启动器身份与图标
APPLET_PLIST="$APP_BUNDLE/Contents/Info.plist"
cp build/icon.icns "$RES/applet.icns"
/usr/libexec/PlistBuddy -c 'Delete :CFBundleIconName' "$APPLET_PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c 'Set :CFBundleIconFile applet.icns' "$APPLET_PLIST"
/usr/libexec/PlistBuddy -c 'Set :CFBundleName InsPin' "$APPLET_PLIST"
for pair in 'CFBundleDisplayName:InsPin' 'CFBundleIdentifier:com.inspin.launcher'; do
  key="${pair%%:*}"
  value="${pair#*:}"
  /usr/libexec/PlistBuddy -c "Set :$key $value" "$APPLET_PLIST" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :$key string $value" "$APPLET_PLIST"
done
# 依赖已经放进 app 内部，最后整体清隔离并重签。
xattr -cr "$APP_BUNDLE"
codesign --force --deep --sign - "$APP_BUNDLE"
codesign --verify --deep --strict "$APP_BUNDLE"
touch "$APP_BUNDLE"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP_BUNDLE" >/dev/null 2>&1 || true

echo "完成"
echo ""
echo "测试包位置：$PACK"
du -sh "$PACK"

if [ "$WANT_ZIP" -eq 1 ]; then
  echo ""
  echo "打包 zip（约 1 分钟）…"
  ZIP="$OUT_ROOT/$PACK_NAME.zip"
  rm -f "$ZIP" "$ZIP.sha256"
  ditto -c -k --sequesterRsrc --keepParent --zlibCompressionLevel 9 "$PACK" "$ZIP"
  (cd "$OUT_ROOT" && shasum -a 256 "$PACK_NAME.zip" > "$PACK_NAME.zip.sha256")
  du -sh "$ZIP"
  echo "SHA-256："
  cat "$ZIP.sha256"
fi
