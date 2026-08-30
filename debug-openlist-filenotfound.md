# Debug Session: openlist-filenotfound

Status: [OPEN]

## 症状 (Symptom)
OpenList 离线下载（SimpleHttp）从本项目 Vercel 代理下载 B站视频图片时，在固定进度位置报错：
`res_code: FileNotFound, res_msg: File not found`

- 浏览器直接下载同一代理链接：正常
- 图片（<4.5MB）也失败
- 每次失败位置固定（确定性，非随机）
- OpenList 更新前曾可正常下载，更新后出现
- 无 aria2，仅 SimpleHttp

## 假设 (Hypotheses)
- H1: 代理响应缺少 Content-Disposition  Content-Length（chunked），SimpleHttp 文件名或长度解析异常
- H2: Vercel 流式响应被平台截断（固定字节），浏览器能容忍，SimpleHttp 不能
- H3: OpenList 请求头与浏览器不同（无 Accept-Encoding  Range 