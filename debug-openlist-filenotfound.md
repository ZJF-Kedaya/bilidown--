# Debug Session: openlist-filenotfound

Status: [OPEN]

## 症状 (Symptom)
OpenList 离线下载（SimpleHttp）从本项目 Vercel 代理下载 B站视频图片时，在固定进度位置报错：
`res_code: FileNotFound, res_msg: File not found`

- 浏览器直接下载同一代理链接：正常
- 视频仅 1.6MB（远小于 4.5MB）依然失败 —— 排除 Vercel 响应体截断
- 每次失败位置固定（确定性，非随机）
- OpenList 更新前曾可正常下载，更新后出现
- 无 aria2，仅 SimpleHttp；目标存储两种：本地转存、stream-put 直传

## 假设 (Hypotheses)
- H1: 代理响应 Content-Disposition 的 filename 为 percent-encoded 中文，OpenList 用 mime.ParseMediaType 读取而不解码 → 保存为乱码文件名 → 转存阶段找不到文件
- H2: ~~Vercel 流式响应截断~~ —— 已排除（1.6MB 视频同样失败，且浏览器正常）
- H3: OpenList 请求头与浏览器不同触发不同行为 —— 暂未证实
- H4: B站 CDN 对 Vercel 出口 IP 风控 —— 无法解释 1.6MB 固定节点失败与浏览器正常并存
- H5: stream-put 模式（HEAD 后 GET）两次请求 filename 不同 → 转存找不到文件（原 `dl_${Date.now()}${ext}` 时间戳 bug）

## 证据 (Evidence)
- 用户确认：1.6MB 视频、浏览器可正常下载、OpenList 固定节点失败 → 排除 H2
- OpenList 源码 `internaloffline_downloadhttpclient.go`：SimpleHttp.Run 本身不产生 FileNotFound，该错误来自后续转存阶段
- OpenList 源码 `internaloffline_downloadhttputil.go`：parseFilenameFromContentDisposition 使用 mime.ParseMediaType，不解码百分号编码
- 原 [...path].js 使用 `dl_${Date.now()}${ext}` 时间戳文件名，stream-put 的 HEADGET 两次请求产生不同 filename

## 修复 (Fix)
1. apidownload.js：Content-Disposition 的 filename 改为稳定 ASCII 名（download.mp4），filename* 保留 UTF-8 原名给浏览器
2. api[...path].js：去掉 Date.now(