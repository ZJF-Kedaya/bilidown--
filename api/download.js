/**
 * 正常下载 API - 支持进度显示
 * 支持 B站视频页面链接 或 CDN 直链
 */

export const config = { runtime: 'edge' };
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
  // 从环境变量读取 Cookie，部署时需在 Vercel 设置环境变量 BILI_COOKIE
  const cookie = process.env.BILI_COOKIE;
  if (!cookie) {
    console.warn('未设置 BILI_COOKIE 环境变量，可能无法正常访问 B站 API');
    // 返回一个基本的 User-Agent，但可能失效
    return '';
  }
  return cookie;
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
          'Referer': 'https://www.bilibili.com',
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
    // 不转发客户端的 Range：强制整文件单流返回，避免 OpenList SimpleHttp 分片请求被
    // B站对代理出口 IP 风控而在固定比例处失败（浏览器本就是单流，故正常）。
    // 手动跟随重定向：每跳带 Referer，避免 follow 模式在跨域 302 跳转时丢失 Referer。
    const fetchWithRedirects = async (startUrl, hdrs) => {
      let currentUrl = startUrl;
      let r = await fetch(currentUrl, { headers: hdrs, redirect: 'manual' });
      let hops = 0;
      while (r.status >= 300 && r.status < 400 && hops < 5) {
        let loc = r.headers.get('Location');
        if (!loc) break;
        if (loc.startsWith('/')) loc = new URL(loc, currentUrl).toString();
        currentUrl = loc;
        r = await fetch(currentUrl, { headers: hdrs, redirect: 'manual' });
        hops++;
      }
      return r;
    };

    const resp = await fetchWithRedirects(targetUrl, headers);
    if (!resp.ok) {
      return new Response(
        JSON.stringify({ code: resp.status, message: `下载失败: ${resp.statusText}` }),
        { status: resp.status, headers: { ...corsHeaders(), 'Content-Type': 'application/json' } }
      );
    }

    const contentLength = resp.headers.get('Content-Length');
    const contentType = resp.headers.get('Content-Type') || 'video/mp4';
    const contentRange = resp.headers.get('Content-Range');
    // OpenList SimpleHttp 用 mime.ParseMediaType 读取 Content-Disposition 的 filename 字段，
    // 且不会解析百分号编码：中文名 percent-encode 后会被保存成 "%E6%A0%87..." 字面量，
    // 转存阶段按原名找不到该文件 → 报 FileNotFound。
    // 因此 filename 用稳定 ASCII 名，filename* 保留 UTF-8 原名给浏览器（浏览器优先 filename*）。
    const utf8Name = encodeURIComponent(filename).replace(/'/g, '%27');
    const ext = (filename.match(/\.[^.]+$/) || ['.mp4'])[0];
    const asciiName = 'download' + ext;

    const responseHeaders = {
      ...corsHeaders(),
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`,
      'Accept-Ranges': 'none',
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