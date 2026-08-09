/**
 * YouTube 视频解析 - Vercel 独立 Node.js Function
 *
 * 路由：
 *   /api/youtube?url=<视频链接>   解析视频并返回可下载的流地址
 *
 * 方案（纯内部接口，无第三方依赖，均在 Vercel 后端完成）：
 *   1) 从 watch 页面提取 visitorData
 *   2) 用 youtubei v1/player 接口以多个客户端身份请求（并行，取最先成功的）
 *       真正义：WEB 客户端需 PO Token 才返回流，改用 MWEB / TVHTML5 / WEB_EMBEDDED_PLAYER
 *               等客户端（历史上无需 PO Token）
 *   3) 兜底再试 embed 页面
 *   只保留带成熟 URL 且不含 n 签名参数的流（保证可直接下载）
 */

export const config = {
  runtime: 'nodejs',
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const YOUTUBEI_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'; // 公开的 embed key

// 常用客户端（顺序即优先级，前 3 个并行请求）
const CLIENTS = [
  { name: 'WEB_EMBEDDED_PLAYER', version: '1.20240101.00.00' },
  { name: 'MWEB', version: '6.20240101.01.00' },
  { name: 'TVHTML5', version: '7.20240101.00.00' },
  { name: 'ANDROID', version: '19.09.37' },
  { name: 'IOS', version: '19.09.3' },
  { name: 'TV', version: '6.0' },
];

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
}

function extractVideoId(text) {
  let m = String(text).match(/[?&]v=([\w-]{11})/);
  if (m) return m[1];
  m = String(text).match(/youtu\.be\/([\w-]{11})/);
  if (m) return m[1];
  m = /\/(?:shorts|embed|live)\/([\w-]{11})/.exec(String(text));
  if (m) return m[1];
  if (/^[\w-]{11}$/.test(String(text))) return String(text);
  return null;
}

// 括号计数法提取指定 key 后的完整 JSON 对象（避免非贪婪正则截断）
function extractJson(text, key) {
  const idx = text.indexOf(key);
  if (idx === -1) return null;
  const start = text.indexOf('{', idx);
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return text.substring(start, i + 1);
      }
    }
  }
  return null;
}

function parsePlayerPayload(text) {
  try {
    const j = JSON.parse(text);
    if (j && j.streamingData) return j;
  } catch { /* 不是纯 JSON */ }
  const raw = extractJson(text, 'ytInitialPlayerResponse');
  if (raw) {
    try { return JSON.parse(raw); } catch { /* 忽略 */ }
  }
  return null;
}

function hasStreams(d) {
  const sd = d && d.streamingData;
  return !!(sd && ((sd.formats && sd.formats.length) || (sd.adaptiveFormats && sd.adaptiveFormats.length)));
}

const baseHeaders = {
  'User-Agent': UA,
  'Accept-Language': 'en-US,en;q=0.9',
  'Cookie': 'CONSENT=PENDING+999; SOCS=CAI',
};

async function fetchWatch(videoId) {
  const resp = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: { ...baseHeaders, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    redirect: 'follow',
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  return await resp.text();
}

// 从 watch 页提取 visitorData（用于 youtubei 请求）
function extractVisitorData(html) {
  const m = html.match(/"visitorData":"([^"]+)"/);
  return m ? m[1] : '';
}

async function fetchYoutubei(videoId, client, visitorData) {
  const body = {
    context: {
      client: {
        clientName: client.name,
        clientVersion: client.version,
        hl: 'en',
        gl: 'US',
      },
    },
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
  };
  if (visitorData) body.context.client.visitorData = visitorData;

  const resp = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${YOUTUBEI_KEY}`, {
    method: 'POST',
    headers: {
      ...baseHeaders,
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': YOUTUBEI_KEY,
      'Origin': 'https://www.youtube.com',
      'Referer': 'https://www.youtube.com/',
    },
    body: JSON.stringify(body),
    redirect: 'follow',
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  return await resp.text();
}

async function fetchEmbed(videoId) {
  const resp = await fetch(`https://www.youtube.com/embed/${videoId}`, {
    headers: { ...baseHeaders, 'Accept': 'text/html,application/xhtml+xml,*/*' },
    redirect: 'follow',
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  return await resp.text();
}

// 并行尝试一组客户端，返回第一个有流的播放数据
async function tryClients(videoId, visitorData, clients) {
  const results = await Promise.all(
    clients.map(async (c) => {
      try {
        const text = await fetchYoutubei(videoId, c, visitorData);
        const d = parsePlayerPayload(text);
        return d && hasStreams(d) ? d : null;
      } catch {
        return null;
      }
    })
  );
  return results.find(Boolean) || null;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const u = new URL(req.url, 'http://localhost');
  const target = u.searchParams.get('url') || '';
  const videoId = extractVideoId(target);
  if (!videoId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 400, message: '无法识别YouTube视频链接' }));
    return;
  }

  try {
    // 1. 获取 visitorData
    let visitorData = '';
    try {
      const html = await fetchWatch(videoId);
      visitorData = extractVisitorData(html);
    } catch { /* 忽略，继续 */ }

    // 2. 多客户端并行尝试（分批，避免并发过多）
    let data = await tryClients(videoId, visitorData, CLIENTS.slice(0, 3));
    if (!data) data = await tryClients(videoId, visitorData, CLIENTS.slice(3));

    // 3. 兜底：embed 页面
    if (!data) {
      try {
        const text = await fetchEmbed(videoId);
        const d = parsePlayerPayload(text);
        if (d && hasStreams(d)) data = d;
      } catch { /* 忽略 */ }
    }

    if (!data) {
      throw new Error('无可用播放流（可能区域受限、会员视频、需要登录，或 YouTube 反爬拦截）');
    }

    const details = data.videoDetails || {};
    const sd = data.streamingData || {};

    // 只保留：mp4、带 url、且不含 n 签名参数（保证可直接下载）
    const items = [...(sd.formats || []), ...(sd.adaptiveFormats || [])]
      .filter((f) => f.url && (f.mimeType || '').includes('mp4') && !/[?&]n=/.test(f.url))
      .map((f) => ({
        itag: f.itag,
        mime: f.mimeType,
        kind: (f.mimeType || '').includes('audio') ? 'audio' : 'video',
        quality: f.qualityLabel || f.quality || '',
        bitrate: f.bitrate || 0,
        width: f.width || 0,
        height: f.height || 0,
        url: f.url,
      }));

    const videos = items.filter((f) => f.kind === 'video');
    const audios = items.filter((f) => f.kind === 'audio');
    videos.sort((a, b) => (b.height || 0) - (a.height || 0));
    audios.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

    if (videos.length === 0 && audios.length === 0) {
      throw new Error('拿到了播放数据但没有可用的直链（流的签名需要额外处理，暂不支持该清晰度）');
    }

    const thumb =
      details.thumbnail && details.thumbnail.thumbnails && details.thumbnail.thumbnails.length
        ? details.thumbnail.thumbnails[details.thumbnail.thumbnails.length - 1].url
        : '';

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        code: 0,
        message: 'ok',
        data: {
          id: videoId,
          title: details.title || '',
          duration: details.lengthSeconds ? +details.lengthSeconds : 0,
          author: details.author || '',
          thumbnail: thumb,
          bestVideo: videos[0] || null,
          bestAudio: audios[0] || null,
          videos,
          audios,
          formats: items,
        },
      })
    );
  } catch (e) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: -1, message: e.message || '解析失败' }));
  }
}