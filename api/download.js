/**
 * 正常下载 API - 支持进度显示
 * 直接返回文件流，携带 Content-Length 和 Content-Disposition
 * 客户端可通过 Content-Length 获取总大小，通过已下载字节数计算速率
 */

export const config = {
  runtime: 'edge',
};

export const dynamic = 'force-dynamic';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Range, Origin',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Disposition, Content-Range, Accept-Ranges',
  };
}

export default async function handler(request) {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders() });
  }

  const targetUrl = url.searchParams.get('url');
  if (!targetUrl) {
    return new Response(
      JSON.stringify({ code: 400, message: '缺少 url 参数' }),
      { status: 400, headers: { ...corsHeaders(), 'Content-Type': 'applicationjson' } }
    );
  }

  const filename = url.searchParams.get('name') || 'video.mp4';
  const range = request.headers.get('Range');

  const headers = {
    'User-Agent': 'Mozilla5.0 (Windows NT 10.0; Win64; x64) AppleWebKit537.36 (KHTML, like Gecko) Chrome131.0.0.0 Safari537.36',
    'Accept': '**',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Referer': 'https:www.bilibili.com',
    'Origin': 'https:www.bilibili.com',
  };
  if (range) {
    headers['Range'] = range;
  }

  try {
    const resp = await fetch(targetUrl, {
      headers: headers,
      redirect: 'follow',
    });

    if (!resp.ok) {
      return new Response(
        JSON.stringify({ code: resp.status, message: `下载失败: ${resp.statusText}` }),
        { status: resp.status, headers: { ...corsHeaders(), 'Content-Type': 'applicationjson' } }
      );
    }

    const contentLength = resp.headers.get('Content-Length');
    const contentType = resp.headers.get('Content-Type') || 'videomp4';
    const contentRange = resp.headers.get('Content-Range');

    const encodedName = encodeURIComponent(filename).replace(/'/g, '%27');

    const responseHeaders = {
      ...cor