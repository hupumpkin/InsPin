#!/usr/bin/env bash
# 编译 Apple Vision 主体分割小工具；产物由构建流程生成，不纳入 Git。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/native/SubjectLift/main.swift"
OUT="$ROOT/native/SubjectLift/subject-lift"

if [[ -x "$OUT" && "$OUT" -nt "$SRC" && "${FORCE_BUILD_SUBJECT_LIFT:-0}" != "1" ]]; then
  exit 0
fi

if ! command -v xcrun >/dev/null 2>&1; then
  echo "找不到 xcrun：编译抠图组件需要安装 Xcode Command Line Tools" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"
# Vision 前景实例分割要求 macOS 14；正式版当前本就只打 arm64。
xcrun swiftc -O -target arm64-apple-macosx14.0 "$SRC" -o "$OUT"
codesign --force --sign - "$OUT" >/dev/null 2>&1 || true
echo "已编译抠图组件：$OUT"
