/**
 * YouTube 视频解析 - Vercel 独立 Node.js Function
 *
 * 路由：
 *   /api/youtube?url=<视频链接>   解析视频并返回可下载的流地址
 *
 * 方案（纯 HTTP，无第三方依赖库，仅在 Vercel 后端发起请求）：
 *   YouTube 对数据中心 IP 风控 + 需 PO Token，纯直连基本拿不到流。
 *   因此采用多源回退，任一成功即返回：
 *     1) youtubei v1/player（无需 PO Token 的客户端：WEB_EMBEDDED_PLAYER/ANDROID_VR/TVHTML5）
 *     2) Piped API（社区代理，多实例并行）
 *     3) Invidious API（社区代理，多实例并行）
 *     4) 带 visitorData 重试 youtubei
 *     5) embed 页面
 *   失败时返回诊断信息，便于定位。
 */

export const config = {
  runtime: 'nodejs',
};

const YOUTUBEI_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'; // 公开的 embed key

const CLIENTS = [
  { name: 'WEB_EMBEDDED_PLAYER', version: '1.20240101.00.00' },
  { name: 'ANDROID_VR', version: '1.60.28' },
  { name: 'TVHTML5', version: '7.20250320.12.00' },
  { name: 'ANDROID', version: '19.09.37' },
  { name: 'IOS', version: '19.09.3' },
];

const CLIENT_UA = {
  ANDROID_VR: 'Mozilla/5.0 (Linux; Android 13; VR) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  ANDROID: 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip',
  IOS: 'com.google.ios.youtube/19.09.3 (iPhone; U; CPU iOS 17_0 like Mac OS X)',
  TVHTML5: 'Mozilla/5.0 (PlayStation; PlayStation 5/2.00) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ---- Piped 实例 ----
const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://api.piped.yt',
  'https://pipedapi.tokhmi.xyz',
  'https://pipedapi.leptons.xyz',
  'https://pipedapi.rivo.lol',
  'https://pipedapi.moomoo.me',
  'https://pipedapi.syncpundit.io',
];

// ---- Invidious 实例 ----
const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://invidious.tiekoetter.com',
  'https://invidious.f5.si',
  'https://inv.zoomerville.com',
];

// ---- Cobalt 实例（专门为下载设计，跟追反爬最积极）----
const COBALT_INSTANCES = [
  'https://api.cobalt.tools',
  'https://co.wuk.sh',
  'https://cobalt-api.kwiatekmiki.com',
];

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timeout);
  }
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
      client: { clientName: client.name, clientVersion: client.version, hl: 'en', gl: 'US' },
    },
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
  };
  if (visitorData) body.context.client.visitorData = visitorData;

  const resp = await fetchWithTimeout(`https://www.youtube.com/youtubei/v1/player?key=${YOUTUBEI_KEY}`, {
    method: 'POST',
    headers: {
      'User-Agent': CLIENT_UA[client.name] || WEB_UA,
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': YOUTUBEI_KEY,
      'Origin': 'https://www.youtube.com',
      'Referer': 'https://www.youtube.com/',
    },
    body: JSON.stringify(body),
    redirect: 'follow',
  }, 10000);
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  return await resp.text();
}

async function fetchVisitorData() {
  try {
    const resp = await fetch('https://www.youtube.com/watch?v=____', {
      headers: { 'User-Agent': WEB_UA, 'Accept-Language': 'en-US,en;q=0.9' },
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
    headers: { 'User-Agent': WEB_UA, 'Accept': 'text/html,application/xhtml+xml,*/*', 'Accept-Language': 'en-US,en;q=0.9' },
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

// ---- Piped API ----
function toPlayerFromPiped(p) {
  const videoStreams = (p.videoStreams || []).map((v) => ({
    url: v.url, mimeType: v.mimeType || 'video/mp4', qualityLabel: v.quality || '',
    bitrate: v.bitrate || 0, width: v.width || 0, height: v.height || 0,
  }));
  const audioStreams = (p.audioStreams || []).map((a) => ({
    url: a.url, mimeType: a.mimeType || 'audio/webm', qualityLabel: a.quality || '', bitrate: a.bitrate || 0,
  }));
  const thumb = p.thumbnail ? { thumbnails: [{ url: p.thumbnail }] } : null;
  return {
    _source: 'piped',
    videoDetails: { title: p.title || '', lengthSeconds: p.duration || 0, author: p.uploader || '', thumbnail: thumb },
    streamingData: { formats: videoStreams, adaptiveFormats: [...videoStreams, ...audioStreams], hlsManifestUrl: p.hls || '' },
  };
}

async function tryPiped(videoId) {
  const results = await Promise.all(
    PIPED_INSTANCES.map(async (origin) => {
      try {
        const resp = await fetch(`${origin}/streams/${videoId}`, {
          headers: { 'User-Agent': WEB_UA, 'Accept': 'application/json' },
          redirect: 'follow',
        });
        if (!resp.ok) return null;
        const j = await resp.json();
        if (j && ((j.videoStreams && j.videoStreams.length) || (j.audioStreams && j.audioStreams.length) || j.hls)) {
          return toPlayerFromPiped(j);
        }
      } catch { /* 换下一个 */ }
      return null;
    })
  );
  return results.find(Boolean) || null;
}

// ---- Invidious API ----
function toPlayerFromInvidious(v) {
  const fs = (v.formatStreams || []).map((f) => ({
    url: f.url, mimeType: (f.type || 'video/mp4').split(';')[0], qualityLabel: f.qualityLabel || '', bitrate: 0, width: 0, height: 0,
  }));
  const af = (v.adaptiveFormats || []).map((f) => ({
    url: f.url, mimeType: (f.type || 'video/mp4').split(';')[0], qualityLabel: f.qualityLabel || '',
    bitrate: f.bitrate || 0, width: f.width || 0, height: f.height || 0,
  }));
  const thumb = v.videoThumbnails && v.videoThumbnails.length ? { thumbnails: [{ url: v.videoThumbnails[v.videoThumbnails.length - 1].url }] } : null;
  return {
    _source: 'invidious',
    videoDetails: { title: v.title || '', lengthSeconds: v.lengthSeconds || 0, author: v.author || '', thumbnail: thumb },
    streamingData: { formats: fs, adaptiveFormats: [...fs, ...af], hlsManifestUrl: '' },
  };
}

async function tryInvidious(videoId) {
  const results = await Promise.all(
    INVIDIOUS_INSTANCES.map(async (origin) => {
      try {
        const resp = await fetch(`${origin}/api/v1/videos/${videoId}`, {
          headers: { 'User-Agent': WEB_UA, 'Accept': 'application/json' },
          redirect: 'follow',
        });
        if (!resp.ok) return null;
        const j = await resp.json();
        if (j && ((j.formatStreams && j.formatStreams.length) || (j.adaptiveFormats && j.adaptiveFormats.length))) {
          return toPlayerFromInvidious(j);
        }
      } catch { /* 换下一个 */ }
      return null;
    })
  );
  return results.find(Boolean) || null;
}

// ---- Cobalt API ----
function toPlayerFromCobalt(j) {
  let entries = [];
  if (j.status === 'stream' && j.url) {
    entries = [{ url: j.url, mimeType: 'video/mp4', qualityLabel: '', kind: 'video' }];
  } else if (j.picker && Array.isArray(j.picker)) {
    entries = j.picker.map((p) => ({
      url: p.url,
      mimeType: (p.type || 'video/mp4').replace(':', '/'),
      qualityLabel: p.text || '',
      kind: (p.type || '').includes('audio') ? 'audio' : 'video',
    }));
  }
  if (!entries.length) return null;
  const thumb = j.audioThumbnails && j.audioThumbnails.length ? { thumbnails: [{ url: j.audioThumbnails[0].url }] } : null;
  return {
    _source: 'cobalt',
    videoDetails: { title: j.text || '', lengthSeconds: 0, author: '', thumbnail: thumb },
    streamingData: { formats: entries, adaptiveFormats: entries, hlsManifestUrl: '' },
  };
}

async function tryCobalt(targetUrl) {
  for (const origin of COBALT_INSTANCES) {
    try {
      const resp = await fetch(`${origin}/api/json`, {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'User-Agent': WEB_UA, 'Origin': origin, 'Referer': origin + '/' },
        body: JSON.stringify({ url: targetUrl, videoQuality: '1080' }),
        redirect: 'follow',
      });
      if (!resp.ok) continue;
      const j = await resp.json();
      const d = toPlayerFromCobalt(j);
      if (d) return d;
    } catch { /* 换下一个 */ }
  }
  return null;
}

// ---- youtubei.js（内置 nsig 签名解密，可支持不可嵌入视频）----
function toPlayerFromYoutubeiJs(info) {
  const bi = info?.basic_info || {};
  const sd = info?.streaming_data;
  if (!sd) return null;
  const all = [...(sd.formats || []), ...(sd.adaptive_formats || [])];
  const entries = all
    .map((f) => {
      const url = (f.decoder_info && f.decoder_info.url) || f.url || '';
      const mime = f.mime_type || '';
      return {
        url,
        mimeType: mime,
        qualityLabel: f.quality_label || f.quality || '',
        bitrate: f.bitrate || 0,
        width: f.width || 0,
        height: f.height || 0,
        itag: f.itag,
      };
    })
    .filter((f) => f.url);
  if (!entries.length) return null;
  const thumb = bi.thumbnail && bi.thumbnail.url ? { thumbnails: [{ url: bi.thumbnail.url }] } : null;
  return {
    _source: 'youtubeijs',
    videoDetails: { title: bi.title || '', lengthSeconds: bi.duration || 0, author: bi.author || '', thumbnail: thumb },
    streamingData: { formats: entries, adaptiveFormats: entries, hlsManifestUrl: '' },
  };
}

async function tryYoutubeiJs(videoId) {
  try {
    const { Innertube } = await import('youtubei.js');
    const yt = await Innertube.create({ client_type: 'ANDROID' });
    const info = await yt.getInfo(videoId);
    return toPlayerFromYoutubeiJs(info);
  } catch {
    return null;
  }
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

  const diag = [];
  try {
    // 0. youtubei.js（内置 nsig 签名解密，可支持不可嵌入视频）
    let data = await tryYoutubeiJs(videoId);
    if (!data) diag.push('youtubei.js失败');

    // 1. youtubei（无需 PO Token 客户端，并行）
    if (!data) data = await tryClients(videoId, '', CLIENTS.slice(0, 3));
    if (!data) diag.push('youtubei直接请求失败');

    // 2. Cobalt（专门下载服务，最稳）
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
    if (!data) data = await tryCobalt(watchUrl);
    if (!data) diag.push('Cobalt不可用');

    // 3. Piped
    if (!data) data = await tryPiped(videoId);
    if (!data) diag.push('Piped不可用');

    // 4. Invidious
    if (!data) data = await tryInvidious(videoId);
    if (!data) diag.push('Invidious不可用');

    // 5. 带 visitorData 重试 youtubei
    if (!data) {
      const visitorData = await fetchVisitorData();
      data = await tryClients(videoId, visitorData, CLIENTS.slice(1));
      if (!data) diag.push('带visitorData仍失败');
    }

    // 6. embed 页面
    if (!data) {
      try {
        const text = await fetchEmbed(videoId);
        const d = parsePlayerPayload(text);
        if (d && hasStreams(d)) data = d;
      } catch { /* 忽略 */ }
      if (!data) diag.push('embed页面失败');
    }

    if (!data) {
      throw new Error('无可用播放流（可能区域受限、会员视频、需要登录，或 YouTube 对服务器 IP 风控）。[诊断: ' + diag.join('; ') + ']');
    }

    const thirdParty = data._source === 'piped' || data._source === 'invidious' || data._source === 'youtubeijs';
    const details = data.videoDetails || {};
    const sd = data.streamingData || {};

    // 只保留带直链的 mp4；第三方来源也保留 webm，且不过滤 n 签名
    const items = [...(sd.formats || []), ...(sd.adaptiveFormats || [])]
      .filter((f) => f.url && (thirdParty || (f.mimeType || '').includes('mp4')))
      .filter((f) => thirdParty || !/[?&]n=/.test(f.url))
      .map((f) => ({
        itag: f.itag,
        mime: f.mimeType,
        kind: (f.mimeType || '').includes('audio') ? 'audio' : 'video',
        quality: f.qualityLabel || '',
        bitrate: f.bitrate || 0,
        width: f.width || 0,
        height: f.height || 0,
        url: f.url,
      }));

    const videos = items.filter((f) => f.kind === 'video');
    const audios = items.filter((f) => f.kind === 'audio');
    videos.sort((a, b) => (b.height || 0) - (a.height || 0));
    audios.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

    const hls = sd.hlsManifestUrl && sd.hlsManifestUrl.startsWith('http') ? sd.hlsManifestUrl : '';

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        code: 0,
        message: 'ok',
        source: data._source || 'youtubei',
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