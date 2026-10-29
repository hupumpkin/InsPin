#!/bin/zsh
# InsPin 开发版启动脚本。被「启动 InsPin.app」调用，也可以直接在终端里跑。
#
# 注意：AppleScript 的 `do shell script` 用的是最小 PATH（不含 /usr/local/bin），
# 所以这里必须自己把 node/npm 的常见位置加回去，否则会找不到 npm。

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

# 项目根目录 = 本脚本所在目录的上一级，跟着仓库走
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_FILE="${TMPDIR:-/tmp}/ins-pin-launch.log"

cd "$PROJECT_DIR" || {
  echo "找不到项目目录：$PROJECT_DIR" | tee -a "$LOG_FILE"
  exit 1
}

# 某些环境下系统会注入这个变量，它会让 Electron 退化成纯 Node、窗口起不来
unset ELECTRON_RUN_AS_NODE

# 已经在跑就不重复启动（避免开出两个窗口抢同一份数据）。
# 但要把已有窗口切到前台；如果窗口被留在屏幕外（换过显示器 / 分辨率），挪回主屏。
if pgrep -f "electron-vite dev" >/dev/null 2>&1; then
  echo "InsPin 已经在运行，正在切到前台" | tee -a "$LOG_FILE"
  osascript <<'APPLESCRIPT' >> "$LOG_FILE" 2>&1
tell application "Finder" to set {dx, dy, screenWidth, screenHeight} to bounds of window of desktop
tell application "System Events"
  if exists process "Electron" then
    tell process "Electron"
      set frontmost to true
      try
        set {x, y} to position of window 1
        set {w, h} to size of window 1
      on error
        return
      end try
      -- 只有整扇窗都在主屏外时才挪回来；只是部分超出（比如放在副屏）不动它。
      if (x + w) <= dx or x >= screenWidth or (y + h) <= dy or y >= screenHeight then
        set position of window 1 to {dx + 80, dy + 80}
      end if
    end tell
  end if
end tell
APPLESCRIPT
  # 进程在、但主窗口已经关了/丢了：直接重启，否则用户点了永远没反应。
  window_count=$(osascript -e 'tell application "System Events" to tell process "Electron" to count windows' 2>/dev/null || echo 0)
  if [ "${window_count:-0}" -gt 0 ]; then
    exit 0
  fi
  echo "InsPin 进程在但没有窗口，正在重启" | tee -a "$LOG_FILE"
  pkill -f "electron-vite dev" 2>/dev/null || true
  pkill -f "Electron.app/Contents/MacOS/Electron" 2>/dev/null || true
  sleep 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "找不到 npm。请先安装 Node.js：https://nodejs.org" | tee -a "$LOG_FILE"
  exit 1
fi

echo "===== $(date '+%Y-%m-%d %H:%M:%S') 启动 InsPin =====" >> "$LOG_FILE"
npm run dev >> "$LOG_FILE" 2>&1
