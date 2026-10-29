# Contributing to InsPin

感谢你帮助改进 InsPin。当前项目仍处于早期预览阶段，提交较大功能前请先开 Issue 对齐范围。

## 开发环境

- Apple Silicon Mac
- macOS 14+
- Node.js 与 npm
- Xcode Command Line Tools

```bash
npm ci
npm run dev
```

## 提交前检查

```bash
npm run typecheck
npm test
npm run build
```

涉及界面或 Electron 窗口行为时，还应在本机执行 `npm run smoke`，并完成相关手工测试。

请不要提交 `node_modules/`、`out/`、`dist/`、运行日志、用户数据库、Cookie、私人素材或本机生成的测试包。

## Pull Request

PR 请说明：

- 要解决的问题
- 实际改动
- 验证方式和结果
- 对数据、隐私、安全或兼容性的影响
- 界面变化的截图或录屏（如适用）
