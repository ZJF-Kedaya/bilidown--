/**
 * YouTube 视频解析 - Vercel 独立 Node.js Function
 *
 * 路由：
 *   /api/youtube?url=<视频链接>   解析视频并返回可下载的流地址
 *
 * 说明：
 *   - 采用"无 key 页面解析"：多策略回退获取播放数据
 *       1) watch 页面（解析 ytInitialPlayerResponse）
 *       2) youtubei v1/player 内部接口（Web 客户端）
 *       3) embed 页面
 *   - 属于 best-effort，YouTube 反爬（PO Token 等）严格时可能仍拿不到流。
 */

export const config = {
  runtime: 'nodejs',
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const YOUTUBEI_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'; // 公开的 embed key

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

function safeName(s) {
  return String(s || 'video').replace(/[\\/:*?"<>|]/g, '_').trim() || 'video';
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

// 从响应文本中解析出播放数据对象（兼容纯 JSON 和包含 ytInitialPlayerResponse 的 HTML）
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

async function fetchText(url, options) {
  const resp = await fetch(url, options);
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  return await resp.text();
}

const baseHeaders = {
  'User-Agent': UA,
  'Accept-Language': 'en-US,en;q=0.9',
  'Cookie': 'CONSENT=PENDING+999; SOCS=CAI',
};

async function fetchWatch(videoId) {
  return await fetchText(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: { ...baseHeaders, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    redirect: 'follow',
  });
}

async function fetchYoutubei(videoId) {
  return await fetchText(
    `https://www.youtube.com/youtubei/v1/player?key=${YOUTUBEI_KEY}`,
    {
      method: 'POST',
      headers: {
        ...baseHeaders,
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': YOUTUBEI_KEY,
        'Origin': 'https://www.youtube.com',
        'Referer': 'https://www.youtube.com/',
      },
      body: JSON.stringify({
        context: {
          client: { clientName: 'WEB', clientVersion: '2.20250101.01.00', hl: 'en', gl: 'US' },
        },
        videoId,
        contentCheckOk: true,
        racyCheckOk: true,
      }),
      redirect: 'follow',
    }
  );
}

async function fetchEmbed(videoId) {
  return await fetchText(`https://www.youtube.com/embed/${videoId}`, {
    headers: { ...baseHeaders, 'Accept': 'text/html,application/xhtml+xml,*/*' },
    redirect: 'follow',
  });
}

function hasStreams(d) {
  const sd = d && d.streamingData;
  return !!(sd && ((sd.formats && sd.formats.length) || (sd.adaptiveFormats && sd.adaptiveFormats.length)));
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
    // 多策略回退：watch → youtubei → embed
    const strategies = [
      { name: 'watch', get: () => fetchWatch(videoId) },
      { name: 'youtubei', get: () => fetchYoutubei(videoId) },
      { name: 'embed', get: () => fetchEmbed(videoId) },
    ];

    let data = null;
    let lastError = null;
    for (const s of strategies) {
      try {
        const text = await s.get();
        const d = parsePlayerPayload(text);
        if (d && hasStreams(d)) { data = d; break; }
        lastError = new Error('该策略未返回播放流');
      } catch (e) {
        lastError = e;
      }
    }

    if (!data) {
      throw new Error('无可用播放流（可能区域受限、会员视频、需要登录，或 YouTube 反爬拦截）' + (lastError ? '；' + lastError.message : ''));
    }

    const details = data.videoDetails || {};
    const sd = data.streamingData || {};

    const items = [...(sd.formats || []), ...(sd.adaptiveFormats || [])]
      .filter((f) => f.url && (f.mimeType || '').includes('mp4'))
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