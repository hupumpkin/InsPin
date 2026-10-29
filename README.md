# InsPin（灵感钉）

![InsPin icon](src/renderer/src/assets/app-icon.png)

InsPin 是一款面向设计师的 macOS 本地灵感画布：在内置浏览器里浏览真实网页，把图片、截图和参考内容直接收进无限画布，保存后离线仍可查看。

> 当前版本：`0.2.0-internal.2`。这是面向早期测试的源码预览，仅验证 macOS Apple Silicon；暂未提供经过 Apple 公证的通用安装包。

## 主要能力

- 内置多标签浏览器，可从网页拖图或框选截图到画布
- 无限画布、图层、编组、形状、文本、裁切和自动布局
- Pinterest、花瓣、Google Lens、站酷以图搜图
- 本地素材库、项目导入导出、备份与素材体检
- 将画布内容钉成始终置顶的参考浮窗
- 使用 Apple Vision 在本机完成主体去背景

## 支持范围

| 项目 | 当前支持 |
| --- | --- |
| 操作系统 | macOS 14 或更高版本 |
| 芯片 | Apple Silicon |
| 数据方式 | 本地优先，单人使用 |
| Windows / Intel Mac | 尚未支持 |

## 本地开发

需要 Node.js、npm，以及安装了 Xcode Command Line Tools 的 Apple Silicon Mac。

```bash
npm ci
npm run dev
```

发布前检查：

```bash
npm run typecheck
npm test
npm run build
npm run smoke
```

## 数据与隐私

项目、图片、浏览器会话和日志默认保存在本机。InsPin 没有自建的图片上传服务器；使用以图搜图时，所选图片会在用户确认后上传到相应的第三方搜索服务。完整说明见 [PRIVACY.md](PRIVACY.md)。

## 反馈与安全

普通问题可以使用 GitHub Issues。安全漏洞请不要公开提交，参见 [SECURITY.md](SECURITY.md)。参与开发前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## License

[MIT](LICENSE)
