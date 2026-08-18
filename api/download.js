/**
 * 正常下载 API - 支持进度显示
 * 支持 B站视频页面链接 或 CDN 直链
 */

export const config = { runtime: 'nodejs' };
export const dynamic = 'force-dynamic';

// ===== 工具函数 =====
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Range, Origin',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Disposition, Content-Range, Accept-Ranges',
  };
}

function isVideoPageUrl(u) {
  return /\/video\/BV|bilibili\.com\/video\/|b23\.tv/i.test(u || '');
}

function extractBvid(text) {
  const m = String(text).match(/BV[a-zA-Z0-9]+/);
  return m ? m[0] : null;
}

async function resolveFinalPageUrl(targetUrl) {
  try {
    const resp = await fetch(targetUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      redirect: 'follow',
    });
    return resp.url || targetUrl;
  } catch {
    return targetUrl;
  }
}

async function getAnonCookie() {
  // 简化：使用固定 cookie，实际可复用 [...path].js 的完整逻辑
  return 'buvid3=xxx; b_nut=xxx; ...';
}

// ===== 主处理 =====
export default async function handler(request) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders() });
  }

  let targetUrl = url.searchParams.get('url');
  if (!targetUrl) {
    return new Response(
      JSON.stringify({ code: 400, message: '缺少 url 参数' }),
      { status: 400, headers: { ...corsHeaders(), 'Content-Type': 'application/json' } }
    );
  }

  let filename = url.searchParams.get('name') || 'video.mp4';
  const range = request.headers.get('Range');

  try {
    // 如果是 B站视频页面，自动解析
    if (isVideoPageUrl(targetUrl)) {
      const finalUrl = await resolveFinalPageUrl(targetUrl);
      const bvid = extractBvid(finalUrl);
      if (!bvid) {
        return new Response(
          JSON.stringify({ code: 400, message: '无法提取 BV 号' }),
          { status: 400, headers: { ...corsHeaders(), 'Content-Type': 'application/json' } }
        );
      }

      // 1. 获取 cid
      const viewUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`;
      const viewResp = await fetch(viewUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Referer': 'https://www.bilibili.com/',
          'Cookie': await getAnonCookie(),
        },
      });
      const viewData = await viewResp.json();
      if (viewData.code !== 0 || !viewData.data) {
        return new Response(
          JSON.stringify({ code: viewData.code, message: viewData.message || '获取视频信息失败' }),
          { status: 400, headers: { ...corsHeaders(), 'Content-Type': 'application/json' } }
        );
      }
      const info = viewData.data;
      const cid = info.cid;
      filename = (info.title || 'video').replace(/[\\/:*?"<>|]/g, '_') + '.mp4';

      // 2. 获取直链
      const playUrl = `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=64&fnval=1&platform=pc`;
      const playResp = await fetch(playUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Referer': 'https://www.bilibili.com/',
          'Cookie': await getAnonCookie(),
        },
      });
      const playData = await playResp.json();
      if (playData.code !== 0 || !playData.data || !playData.data.durl || playData.data.durl.length === 0) {
        return new Response(
          JSON.stringify({ code: playData.code, message: playData.message || '获取播放地址失败' }),
          { status: 400, headers: { ...corsHeaders(), 'Content-Type': 'application/json' } }
        );
      }
      targetUrl = playData.data.durl[0].url;
    }

    // 最终下载
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': '*/*',
      'Referer': 'https://www.bilibili.com/',
      'Origin': 'https://www.bilibili.com',
      'Cookie': await getAnonCookie(),
    };
    if (range) headers['Range'] = range;

    const resp = await fetch(targetUrl, { headers, redirect: 'follow' });
    if (!resp.ok) {
      return new Response(
        JSON.stringify({ code: resp.status, message: `下载失败: ${resp.statusText}` }),
        { status: resp.status, headers: { ...corsHeaders(), 'Content-Type': 'application/json' } }
      );
    }

    const contentLength = resp.headers.get('Content-Length');
    const contentType = resp.headers.get('Content-Type') || 'video/mp4';
    const contentRange = resp.headers.get('Content-Range');
    const encodedName = encodeURIComponent(filename).replace(/'/g, '%27');

    const responseHeaders = {
      ...corsHeaders(),
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${encodedName}"; filename*=UTF-8''${encodedName}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=3600',
    };
    if (contentLength) responseHeaders['Content-Length'] = contentLength;
    if (contentRange) responseHeaders['Content-Range'] = contentRange;

    return new Response(resp.body, { status: resp.status, headers: responseHeaders });
  } catch (err) {
    return new Response(
      JSON.stringify({ code: 500, message: err.message || '内部错误' }),
      { status: 500, headers: { ...corsHeaders(), 'Content-Type': 'application/json' } }
    );
  }
}