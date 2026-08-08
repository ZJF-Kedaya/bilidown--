/**
 * YouTube 视频解析 - Vercel 独立 Node.js Function
 *
 * 路由：
 *   /api/youtube?url=<视频链接>   解析视频并返回可下载的流地址
 *
 * 说明：
 *   - 采用"无 key 页面解析"：抓取 watch 页面，解析内嵌的 ytInitialPlayerResponse，
 *     提取 streamingData 中的流地址（googlevideo 直链，可直接下载）。
 *   - 不使用官方 API key；属于 best-effort，YouTube 反爬变化时可能失效。
 *   - 音视频通常分离（adaptiveFormats），需要时用 ffmpeg 合并；formats 里也有合一 mp4。
 */

export const config = {
  runtime: 'nodejs',
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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

async function fetchPlayer(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const resp = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cookie': 'CONSENT=PENDING+999; SOCS=CAI',
    },
    redirect: 'follow',
  });
  if (!resp.ok) throw new Error('YouTube 页面请求失败: HTTP ' + resp.status);
  return await resp.text();
}

function parsePlayer(html) {
  const m = html.match(/ytInitialPlayerResponse\s*=\s*(\{.*?\});/s);
  if (!m) throw new Error('无法从页面解析到播放数据（可能被重定向到验证页）');
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch (e) {
    throw new Error('播放数据解析失败');
  }
  if (!data || !data.streamingData) {
    throw new Error('该视频无可用播放流（可能区域受限、会员视频或需要登录）');
  }
  return data;
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
    const html = await fetchPlayer(videoId);
    const data = parsePlayer(html);
    const details = data.videoDetails || {};
    const sd = data.streamingData || {};

    // 合并 formats（合一 mp4）与 adaptiveFormats（纯视频/纯音频），只保留带直链且为 mp4 的
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
        url: f.url, // googlevideo 直链，通常可直接下载；如需代理可走 /api/youtube-download
      }));

    const videos = items.filter((f) => f.kind === 'video');
    const audios = items.filter((f) => f.kind === 'audio');
    // 视频按分辨率降序，音频按码率降序
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