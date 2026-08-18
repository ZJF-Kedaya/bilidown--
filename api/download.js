**
 * 正常下载 API - 302 重定向模式
 * 支持 B站视频页面链接 或 CDN 直链
 * 重定向到 CDN 直链，客户端直接下载，进度条可见，速度不受 Vercel 限制
 *

export const config = { runtime: 'edge' };
export const dynamic = 'force-dynamic';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Range, Origin',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Disposition, Content-Range, Accept-Ranges',
  };
}

function isVideoPageUrl(u) {
  return \video\BV|bilibili\.com\video\|b23\.tvi.test(u || '');
}

function extractBvid(text) {
  const m = String(text).match(BV[a-zA-Z0-9]+);
  return m ? m[0] : null;
}

async function resolveFinalPageUrl(targetUrl) {
  try {
    const resp = await fetch(targetUrl, {
      headers: { 'User-Agent': 'Mozilla5.0 (Windows NT 10.0; Win64; x64) AppleWebKit537.36' },
      redirect: 'follow',
    });
    return resp.url || targetUrl;
  } catch {
    return targetUrl;
  }
}

 简化版匿名 Cookie 获取（完整版可复用 [...path].js 中的实现）
async function getAnonCookie() {
  return 'buvid3=xxx; b_nut=xxx;';
}

export default async function handler(request) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders() });
  }

  let targetUrl = url.searchParams.get('url');
  if (!targetUrl) {
    return new Response(
      JSON.stringify({ code: 400, message: '缺少 url 参数' }),
      { status: 400, headers: { ...corsHeaders(), 'Content-Type': 'applicationjson' } }
    );
  }

  let filename = url.searchParams.get('name') || 'video.mp4';

  try {
     如果是 B站视频页面，自动解析
    if (isVideoPageUrl(targetUrl)) {
      const finalUrl = await resolveFinalPageUrl(targetUrl);
      const bvid = extractBvid(finalUrl);
      if (!bvid) {
        return new Response(
          JSON.stringify({ code: 400, message: '无法提取 BV 号' }),
          { status: 400, headers: { ...corsHeaders(), 'Content-Type': 'applicationjson' } }
        );
      }

       1. 获取 cid
      const viewUrl = `https:api.bilibili.comxweb-interfaceview?bvid=${bvid}`;
      const viewResp = await fetch(viewUrl, {
        headers: {
          'User-Agent': 'Mozilla5.0',
          'Referer': 'https:www.bilibili.com',
          'Cookie': await getAnonCookie(),
        },
      });
      const viewData = await viewResp.json();
      if (viewData.code !== 0 || !viewData.data) {
        return new Response(
          JSON.stringify({ code: viewData.code, message: viewData.message || '获取视频信息失败' }),
          { status: 400, headers: { ...corsHeaders(), 'Content-Type': 'applicationjson' } }
        );
      }
      const info = viewData.data;
      const cid = info.cid;
      filename = (info.title || 'video').replace([\\:*?"<>|]g, '_') + '.mp4';

       2. 获取直链
      const playUrl = `https:api.bilibili.comxplayerplayurl?bvid=${bvid}&cid=${cid}&qn=64&fnval=1&platform=pc`;
      const playResp = await fetch(playUrl, {
        headers: {
          'User-Agent': 'Mozilla5.0',
          'Referer': 'https:www.bilibili.com',
          'Cookie': await getAnonCookie(),
        },
      });
      const playData = await playResp.json();
      if (playData.code !== 0 || !playData.data || !playData.data.durl || playData.data.durl.length === 0) {
        return new Response(
          JSON.stringify({ code