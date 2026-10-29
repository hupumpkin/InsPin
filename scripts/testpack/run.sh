#!/bin/zsh
# 由 InsPin.app 内部调用。不要双击本文件。
#
# 目录关系：
#   InsPin.app/Contents/Resources/run.sh                  ← 本文件
#   InsPin.app/Contents/Resources/InsPin/                 ← 应用代码
#   InsPin.app/Contents/Resources/运行环境/InsPin.app/    ← 自带 Electron 运行时
#
# 依赖都在 app 内部，所以即使 macOS 把 app 放进临时只读目录（App Translocation），
# 也不会出现“找不到文件”。

RES_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$RES_DIR/InsPin"

# 日志写在桌面，同事最容易找到；桌面不可写时退到用户日志目录、再退到临时目录。
LOG="$HOME/Desktop/InsPin-运行日志.txt"
if ! touch "$LOG" 2>/dev/null; then
  mkdir -p "$HOME/Library/Logs/InsPin" 2>/dev/null
  LOG="$HOME/Library/Logs/InsPin/运行日志.txt"
  touch "$LOG" 2>/dev/null || LOG="${TMPDIR:-/tmp}/InsPin-运行日志.txt"
fi

# 某些环境会注入这个变量，它会让 Electron 退化成纯 Node、窗口起不来
unset ELECTRON_RUN_AS_NODE

# 内部版使用独立数据目录，和以后装在同一台机器上的正式版互不覆盖。
# 测试包是“未打包”的 Electron，默认目录会跟着 productName 走，所以这里显式指定。
export INSPIN_USER_DATA_DIR="$HOME/Library/Application Support/InsPin-Internal"

{
  echo ""
  echo "===== $(date '+%Y-%m-%d %H:%M:%S') 启动 InsPin ====="
  echo "启动器位置: $RES_DIR"
  echo "系统: macOS $(sw_vers -productVersion 2>/dev/null) / $(uname -m)"
  echo "数据目录: $INSPIN_USER_DATA_DIR"
} >> "$LOG" 2>&1

RUNTIME="$RES_DIR/运行环境/InsPin.app/Contents/MacOS/Electron"

if [ ! -x "$RUNTIME" ]; then
  echo "启动失败：找不到运行环境 $RUNTIME（测试包可能不完整，请重新解压）" >> "$LOG" 2>&1
  exit 1
fi

if [ ! -d "$APP_DIR" ]; then
  echo "启动失败：找不到应用目录 $APP_DIR（测试包可能不完整，请重新解压）" >> "$LOG" 2>&1
  exit 1
fi

"$RUNTIME" "$APP_DIR" >> "$LOG" 2>&1
CODE=$?
echo "InsPin 退出码: $CODE" >> "$LOG" 2>&1
exit $CODE
