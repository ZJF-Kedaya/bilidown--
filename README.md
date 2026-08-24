# Bilibili 视频解析 - Vercel Edge 部署

本项目是一个部署在 Vercel Edge Runtime 的 Bilibili 视频分辨率代理服务。

## 功能特点

- **WBI 签名**：自动为 Bilibili API 请求添加 `w_rid` 参数签名
- **Cookie 管理**：自动生成匿名 Cookie，并支持 `DEFAULT_SESSDATA` 环境变量用于登录状态
- **反屏蔽**：遇到 412 状态码时自动刷新 Cookie 并重试
- **多端点支持**：视频分辨率、UP主视频列表、合集、动态、下载代理
- **YouTube 支持**：通过 `youtubei.js` 提供基础 YouTube 视频解析

## 路由

| 路由 | 描述 |
|------|------|
| `/api/health` | 健康检查 |
| `/api/test` | 诊断测试 |
| `/api/api?url=...` | 带 WBI 签名的通用 API 代理 |
| `/api/up?mid=...` | UP主视频列表 |
| `/api/season?mid=...` | 合集/系列列表 |
| `/api/dynamic?id=...` | 动态详情（提取图片） |
| `/api/download?url=...` | 视频下载代理 |
| `/api/youtube-download?url=...` | YouTube 视频下载 |

## 部署

推送到 GitHub 并导入 Vercel 即可，无需额外配置。

环境变量：
- `DEFAULT_SESSDATA`：用于登录回退的默认 SESSDATA

## 开发

```bash
npm install
npm run dev
```

## 注意事项

- Vercel Edge IP 经常被 Bilibili 的反爬虫系统屏蔽
- 使用 `/api/test` 诊断连接状态
- 前端页面由 `public/index.html` 提供
