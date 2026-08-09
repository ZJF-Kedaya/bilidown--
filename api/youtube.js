/**
 * YouTube 视频解析 - Vercel 独立 Node.js Function
 *
 * 路由：
 *   /api/youtube?url=<视频链接>   解析视频并返回可下载的流地址
 *
 * 方案（参考 yt-dlp PO Token 指南，纯内部接口，无第三方依赖）：
 *   YouTube 的反爬要点：
 *   - datacenter/云 IP 会被 bot detection 拦截（Vercel 属于此类）
 *   - WEB/MWEB 客户端需要 PO Token 才返回流
 *   因此选择"无需 PO Token"的客户端：
 *     web_embedded / android_vr / tv(tv_downgraded) / web_safari(HLS)
 *   流程：
 *     1) 直接用 youtubei v1/player 以多个无需 PO Token 的客户端并行请求（不先访问 watch 页）
 *     2) 失败后再带 visitorData 重试
 *     3) 兜底 embed 页面 / HLS m3u8
 */

export const config = {
  runtime: 'nodejs',
};

const YOUTUBEI_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'; // 公开的 embed key

// 无需(或低要求) PO Token 的客户端，按优先级排序
const CLIENTS = [
  { name: 'WEB_EMBEDDED_PLAYER', version: '1.20240101.00.00' },
  { name: 'ANDROID_VR', version: '1.60.28' },
  { name: 'TVHTML5', version: '7.20250320.12.00' },
  { name: 'ANDROID', version: '19.09.37' },
  { name: 'IOS', version: '19.09.3' },
];

// 各客户端对应的浏览器 UA（部分客户端对 UA 敏感）
const CLIENT_UA = {
  ANDROID_VR: 'Mozilla/5.0 (Linux; Android 13; VR) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  ANDROID: 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip',
  IOS: 'com.google.ios.youtube/19.09.3 (iPhone; U; CPU iOS 17_0 like Mac OS X)',
  TVHTML5: 'Mozilla/5.0 (PlayStation; PlayStation 5/2.00) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

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
    if (j) return j;
  } catch { /* 不是纯 JSON */ }
  const raw = extractJson(text, 'ytInitialPlayerResponse');
  if (raw) {
    try { return JSON.parse(raw); } catch { /* 忽略 */ }
  }
  return null;
}

function hasStreams(d) {
  const sd = d && d.streamingData;
  return !!sd;
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
      'User-Agent': CLIENT_UA[client.name] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
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

// 从 watch 页提取 visitorData
async function fetchVisitorData() {
  try {
    const resp = await fetch('https://www.youtube.com/watch?v=____', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });
    const html = await resp.text();
    const m = html.match(/"visitorData":"([^"]+)"/);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

async function fetchEmbed(videoId) {
  const resp = await fetch(`https://www.youtube.com/embed/${videoId}?autoplay=0`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  return await resp.text();
}

async function tryClients(videoId, visitorData, clients) {
  const results = await Promise.all(
    clients.map(async (c) => {
      try {
        const text = await fetchYoutubei(videoId, c, visitorData);
        const d = parsePlayerPayload(text);
        if (!d || !d.streamingData) return null;
        // 判断是否真的可播放且含流
        const sd = d.streamingData;
        const hasFmt = (sd.formats && sd.formats.length) || (sd.adaptiveFormats && sd.adaptiveFormats.length) || sd.hlsManifestUrl;
        return hasFmt ? d : null;
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
    // 1. 先不带 visitorData 并行尝试无需 PO Token 的客户端
    let data = await tryClients(videoId, '', CLIENTS.slice(0, 3));

    // 2. 失败则拿 visitorData 后重试
    if (!data) {
      const visitorData = await fetchVisitorData();
      data = await tryClients(videoId, visitorData, CLIENTS.slice(1));
    }

    // 3. 兜底 embed 页面
    if (!data) {
      try {
        const text = await fetchEmbed(videoId);
        const d = parsePlayerPayload(text);
        if (d && hasStreams(d)) data = d;
      } catch { /* 忽略 */ }
    }

    if (!data) {
      throw new Error('无可用播放流（可能区域受限、会员视频、需要登录，或 YouTube 对服务器 IP 风控）');
    }

    const details = data.videoDetails || {};
    const sd = data.streamingData || {};

    // 收集带直链的 mp4 流（过滤掉需解密的 n 签名流）
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

    // HLS m3u8 兜底（web_safari/tv 可能只返回 HLS 流）
    let hls = sd.hlsManifestUrl || '';
    if (hls && !hls.startsWith('http')) hls = '';

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
          thumbnail:
            details.thumbnail && details.thumbnail.thumbnails && details.thumbnail.thumbnails.length
              ? details.thumbnail.thumbnails[details.thumbnail.thumbnails.length - 1].url
              : '',
          bestVideo: videos[0] || null,
          bestAudio: audios[0] || null,
          videos,
          audios,
          formats: items,
          hls: hls || null,
        },
      })
    );
  } catch (e) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: -1, message: e.message || '解析失败' }));
  }
}