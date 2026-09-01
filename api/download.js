/**
 * 正常下载 API - 支持进度显示
 * 支持 B站视频页面链接 或 CDN 直链
 * 移植自 [...path].js 的匿名 Cookie 生成 + 412 重试逻辑，
 * 无需 BILI_COOKIE 环境变量也能独立完成解析与下载。
 */

export const config = { runtime: 'edge' };
export const dynamic = 'force-dynamic';

// ===== 常量 =====
const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
];
const BROWSER_UA = UA_POOL[Math.floor(Math.random() * UA_POOL.length)];

const API_HEADERS = {
  'User-Agent': BROWSER_UA,
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Referer': 'https://www.bilibili.com/',
  'Origin': 'https://www.bilibili.com',
  'DNT': '1',
  'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="8"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-site',
};

const BROWSER_VISIT_HEADERS = {
  'User-Agent': BROWSER_UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'DNT': '1',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'Upgrade-Insecure-Requests': '1',
};

// ===== 工具函数 =====
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Range, Origin',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Disposition, Content-Range, Accept-Ranges',
  };
}

function safeHeaders(obj) {
  const h = new Headers();
  for (const [k, v] of Object.entries(obj)) h.set(k, v);
  return h;
}

function generateRandom(len, chars) {
  let r = '';
  for (let i = 0; i < len; i++) r += chars[Math.floor(Math.random() * chars.length)];
  return r;
}

function generateBuvid() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 36; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
    if (i === 8 || i === 13 || i === 18 || i === 23) result += '-';
  }
  return result;
}

function generateBuvid3() {
  return generateRandom(32, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
}

function generateBuvid5() {
  return generateRandom(32, '0123456789abcdefghijklmnopqrstuvwxyz');
}

function generatePsudo() {
  return generateRandom(49, '0123456789ABCDEF');
}

function generateBlsid() {
  return generateRandom(8, '0123456789abcdef');
}

function generateUuid() {
  const chars = '0123456789abcdef';
  let uuid = '';
  for (let i = 0; i < 32; i++) {
    uuid += chars[Math.floor(Math.random() * 16)];
    if (i === 7 || i === 11 || i === 15 || i === 19) uuid += '-';
  }
  return uuid + 'infoc';
}

function parseSetCookies(setCookieHeader) {
  if (!setCookieHeader) return {};
  const result = {};
  const cookies = setCookieHeader.split(/,(?=\s*[A-Za-z0-9_]+=)/);
  for (const raw of cookies) {
    const trimmed = raw.trim();
    const firstEq = trimmed.indexOf('=');
    if (firstEq === -1) continue;
    const name = trimmed.substring(0, firstEq).trim();
    const rest = trimmed.substring(firstEq + 1);
    const semiIdx = rest.indexOf(';');
    const value = semiIdx === -1 ? rest.trim() : rest.substring(0, semiIdx).trim();
    if (name && value) result[name] = value;
  }
  return result;
}

let anonCookieCache = { cookie: '', update_time: 0 };
let anonCookiePromise = null;

async function getAnonCookie() {
  if (anonCookieCache.cookie && Date.now() - anonCookieCache.update_time < 1800000) {
    return anonCookieCache.cookie;
  }
  if (anonCookiePromise) return anonCookiePromise;

  anonCookiePromise = (async () => {
    try {
      const resp = await fetch('https://www.bilibili.com/', {
        headers: safeHeaders(BROWSER_VISIT_HEADERS),
        redirect: 'follow',
      });

      const setCookie = resp.headers.get('set-cookie') || '';
      const parsed = parseSetCookies(setCookie);
      const cookies = [];

      if (parsed.buvid3) cookies.push('buvid3=' + parsed.buvid3);
      else cookies.push('buvid3=' + generateBuvid3());

      if (parsed.b_nut) cookies.push('b_nut=' + parsed.b_nut);
      else cookies.push('b_nut=' + Math.floor(Date.now() / 1000));

      if (parsed.buvid4) cookies.push('buvid4=' + parsed.buvid4);
      else cookies.push('buvid4=' + generateBuvid() + '%2C' + Date.now());

      if (parsed.buvid5) cookies.push('buvid5=' + parsed.buvid5);

      if (parsed.PSUID) cookies.push('PSUID=' + parsed.PSUID);
      else cookies.push('PSUID=' + generatePsudo());

      if (parsed.b_ut) cookies.push('b_ut=' + parsed.b_ut);

      if (!parsed.b_lsid) cookies.push('b_lsid=' + generateBlsid());
      if (!parsed._uuid) cookies.push('_uuid=' + generateUuid());
      if (!parsed.CURRENT_FNVAL) cookies.push('CURRENT_FNVAL=4048');
      if (!parsed.btimer) cookies.push('btimer=' + Math.floor(Date.now() / 1000) + '000');
      if (!parsed.fingerprint) cookies.push('fingerprint=' + generateRandom(32, '0123456789abcdefghijklmnopqrstuvwxyz'));
      if (!parsed.home_lang) cookies.push('home_lang=chs');
      if (!parsed.browser_resolution) cookies.push('browser_resolution=1920-1080');

      for (const [name, value] of Object.entries(parsed)) {
        if (!cookies.some(c => c.startsWith(name + '='))) {
          if (name !== 'buvid3' && name !== 'b_nut' && name !== 'buvid4' && name !== 'buvid5' && name !== 'PSUID') {
            cookies.push(name + '=' + value);
          }
        }
      }

      const cookieStr = cookies.join('; ');
      anonCookieCache = { cookie: cookieStr, update_time: Date.now() };
      return cookieStr;
    } catch (e) {
      const cookieStr = 'buvid3=' + generateBuvid3() +
        '; b_nut=' + Math.floor(Date.now() / 1000) +
        '; buvid4=' + generateBuvid() + '%2C' + Date.now() +
        '; buvid5=' + generateBuvid5() +
        '; PSUID=' + generatePsudo() +
        '; b_lsid=' + generateBlsid() +
        '; _uuid=' + generateUuid() +
        '; CURRENT_FNVAL=4048' +
        '; home_lang=chs' +
        '; browser_resolution=1920-1080' +
        '; btimer=' + Math.floor(Date.now() / 1000) + '000';
      anonCookieCache = { cookie: cookieStr, update_time: Date.now() };
      return cookieStr;
    } finally {
      anonCookiePromise = null;
    }
  })();

  return anonCookiePromise;
}

// 带 412 重试的 fetch
async function fetchWithRetry(url, headers, options = {}) {
  let resp = await fetch(url, { headers: safeHeaders(headers), ...options });
  if (resp.status === 412) {
    anonCookieCache = { cookie: '', update_time: 0 };
    const freshCookie = await getAnonCookie();
    headers['Cookie'] = freshCookie;
    await new Promise(r => setTimeout(r, 300));
    resp = await fetch(url, { headers: safeHeaders(headers), ...options });
  }
  return resp;
}

// 手动跟随重定向（每跳带 Referer）
async function fetchWithRedirects(startUrl, headers) {
  let currentUrl = startUrl;
  let r = await fetch(currentUrl, { headers: safeHeaders(headers), redirect: 'manual' });
  let hops = 0;
  while (r.status >= 300 && r.status < 400 && hops < 5) {
    let loc = r.headers.get('Location');
    if (!loc) break;
    if (loc.startsWith('/')) loc = new URL(loc, currentUrl).toString();
    currentUrl = loc;
    r = await fetch(currentUrl, { headers: safeHeaders(headers), redirect: 'manual' });
    hops++;
  }
  return r;
}

function isVideoPageUrl(u) {
  return /\/video\/BV|bilibili\.com\/video\/|b23\.tv/i.test(u || '');
}

function extractBvid(text) {
  const m = String(text).match(/BV[a-zA-Z0-9]+/);
  return m ? m[0] : null;
}

// 安全解析 JSON，非 JSON（如风控 HTML）返回 null
async function parseJsonOrNull(resp) {
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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
    // 如果是 B站视频页面，自动解析为直链
    if (isVideoPageUrl(targetUrl)) {
      // 短链先跟随重定向拿到最终页面 URL
      if (targetUrl.includes('b23.tv')) {
        const finalUrl = await fetchWithRedirects(targetUrl, { ...API_HEADERS, 'Cookie': await getAnonCookie() });
        targetUrl = finalUrl.url || targetUrl;
      }
      const bvid = extractBvid(targetUrl);
      if (!bvid) {
        return new Response(
          JSON.stringify({ code: 400, message: '无法提取 BV 号' }),
          { status: 400, headers: { ...corsHeaders(), 'Content-Type': 'application/json' } }
        );
      }

      const anonCookie = await getAnonCookie();
      const apiHeaders = { ...API_HEADERS, 'Cookie': anonCookie };

      // 1. 获取 cid
      const viewUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`;
      const viewResp = await fetchWithRetry(viewUrl, apiHeaders, { redirect: 'follow' });
      const viewData = await parseJsonOrNull(viewResp);
      if (!viewData || viewData.code !== 0 || !viewData.data) {
        return new Response(
          JSON.stringify({
            code: -1,
            message: '获取视频信息失败（B站可能返回了风控页面，请稍后重试或配置环境变量 BILI_COOKIE 为 SESSDATA）',
            httpStatus: viewResp.status,
          }),
          { status: 400, headers: { ...corsHeaders(), 'Content-Type': 'application/json' } }
        );
      }
      const info = viewData.data;
      const cid = info.cid;
      filename = (info.title || 'video').replace(/[\\/:*?"<>|]/g, '_') + '.mp4';

      // 2. 获取直链
      const playUrl = `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=64&fnval=1&platform=pc`;
      const playResp = await fetchWithRetry(playUrl, apiHeaders, { redirect: 'follow' });
      const playData = await parseJsonOrNull(playResp);
      if (!playData || playData.code !== 0 || !playData.data || !playData.data.durl || playData.data.durl.length === 0) {
        return new Response(
          JSON.stringify({
            code: -1,
            message: '获取播放地址失败（B站可能返回了风控页面，请稍后重试或配置环境变量 BILI_COOKIE 为 SESSDATA）',
            httpStatus: playResp.status,
          }),
          { status: 400, headers: { ...corsHeaders(), 'Content-Type': 'application/json' } }
        );
      }
      targetUrl = playData.data.durl[0].url;
    }

    // 最终下载 CDN 直链
    const downloadHeaders = {
      ...API_HEADERS,
      'Referer': 'https://www.bilibili.com/',
      'Origin': 'https://www.bilibili.com',
      'Cookie': await getAnonCookie(),
    };

    const resp = await fetchWithRedirects(targetUrl, downloadHeaders);
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
    // 不解析百分号编码：中文名 percent-encode 后会被保存成 "%E6%A0%87..." 字面量 → FileNotFound。
    // filename 用稳定 ASCII 名，filename* 保留 UTF-8 原名给浏览器（浏览器优先 filename*）。
    const utf8Name = encodeURIComponent(filename).replace(/'/g, '%27');
    const ext = (filename.match(/\.[^.]+$/) || ['.mp4'])[0];
    const asciiName = 'download' + ext;

    const responseHeaders = {
      ...corsHeaders(),
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`,
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
