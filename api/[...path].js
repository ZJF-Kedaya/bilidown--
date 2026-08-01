/**
 * B站视频解析 - Vercel Edge Function 代理（含WBI签名）
 *
 * 改造自 cloudflare-worker.js
 * 部署：推到 GitHub 后导入 Vercel 即可，零配置
 *
 * 路由（catch-all /api/[...path]）：
 *   /api/health              健康检查
 *   /api/test                诊断
 *   /api/api?url=...         通用 API 代理（自动 WBI 签名）
 *   /api/up?mid=...          UP主视频列表
 *   /api/season?mid=...      合集/列表
 *   /api/download?url=...    视频下载
 */

// 启用 Vercel Edge Runtime（基于 Web 标准 Request/Response，与 CF Worker 几乎一致）
export const config = {
  runtime: 'edge',
};

// 允许跨域（前端同源时其实用不到，留作本地调试用）
export const dynamic = 'force-dynamic';

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52
];

let wbiKeysCache = { img_key: '', sub_key: '', update_time: 0 };
let wbiKeysPromise = null;
let anonCookieCache = { cookie: '', update_time: 0 };
let anonCookiePromise = null;

// 轮换 UA 池，避免单一 UA 被风控标记
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
  'sec-fetch-user': '?1',
  'X-Bili-Ftrace-Id': generateRandom(16, '0123456789abcdef') + ':0',
};

const BROWSER_VISIT_HEADERS = {
  'User-Agent': BROWSER_UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'DNT': '1',
  'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="8"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'Upgrade-Insecure-Requests': '1',
};

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

function getMixinKey(orig) {
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += orig[MIXIN_KEY_ENC_TAB[i]];
  }
  return result;
}

async function fetchWbiKeys(extraCookie) {
  if (wbiKeysCache.img_key && Date.now() - wbiKeysCache.update_time < 600000) {
    return wbiKeysCache;
  }
  if (wbiKeysPromise) return wbiKeysPromise;

  wbiKeysPromise = (async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const anonCookie = await getAnonCookie();
        const headers = { ...API_HEADERS };
        const cookieParts = [anonCookie];
        if (extraCookie) cookieParts.push(extraCookie);
        headers['Cookie'] = cookieParts.join('; ');
        headers['Referer'] = 'https://www.bilibili.com/';

        const resp = await fetch('https://api.bilibili.com/x/web-interface/nav', {
          headers: safeHeaders(headers),
        });

        const text = await resp.text();
        let data;
        try { data = JSON.parse(text); } catch {
          wbiKeysCache = { img_key: '', sub_key: '', update_time: 0 };
          break;
        }

        if (data.data && data.data.wbi_img) {
          const img_url = data.data.wbi_img.img_url || '';
          const sub_url = data.data.wbi_img.sub_url || '';
          const img_key = img_url.split('/').pop().split('.')[0];
          const sub_key = sub_url.split('/').pop().split('.')[0];

          wbiKeysCache = { img_key, sub_key, update_time: Date.now() };
          return wbiKeysCache;
        }
      } catch (e) {
        console.error('WBI密钥获取失败(尝试' + (attempt + 1) + '):', e.message);
      }
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }

    return wbiKeysCache;
  })();

  return wbiKeysPromise;
}

async function signUrl(baseUrl, params, extraCookie) {
  const keys = await fetchWbiKeys(extraCookie);
  if (!keys.img_key) {
    const query = new URLSearchParams(params).toString();
    return baseUrl + '?' + query;
  }

  params.wts = Math.round(Date.now() / 1000);

  const sortedKeys = Object.keys(params).sort();
  const filteredParams = {};
  for (const k of sortedKeys) {
    filteredParams[k] = String(params[k]).replace(/[!'()*]/g, '');
  }

  const query = new URLSearchParams(filteredParams).toString();
  const mixinKey = getMixinKey(keys.img_key + keys.sub_key);
  const wRidValue = md5(query + mixinKey);

  return baseUrl + '?' + query + '&w_rid=' + wRidValue;
}

function md5(string) {
  function md5cycle(x, k) {
    let a = x[0], b = x[1], c = x[2], d = x[3];
    a = ff(a, b, c, d, k[0], 7, -680876936); d = ff(d, a, b, c, k[1], 12, -389564586);
    c = ff(c, d, a, b, k[2], 17, 606105819); b = ff(b, c, d, a, k[3], 22, -1044525330);
    a = ff(a, b, c, d, k[4], 7, -176418897); d = ff(d, a, b, c, k[5], 12, 1200080426);
    c = ff(c, d, a, b, k[6], 17, -1473231341); b = ff(b, c, d, a, k[7], 22, -45705983);
    a = ff(a, b, c, d, k[8], 7, 1770035416); d = ff(d, a, b, c, k[9], 12, -1958414417);
    c = ff(c, d, a, b, k[10], 17, -42063); b = ff(b, c, d, a, k[11], 22, -1990404162);
    a = ff(a, b, c, d, k[12], 7, 1804603682); d = ff(d, a, b, c, k[13], 12, -40341101);
    c = ff(c, d, a, b, k[14], 17, -1502002290); b = ff(b, c, d, a, k[15], 22, 1236535329);
    a = gg(a, b, c, d, k[1], 5, -165796510); d = gg(d, a, b, c, k[6], 9, -1069501632);
    c = gg(c, d, a, b, k[11], 14, 643717713); b = gg(b, c, d, a, k[0], 20, -373897302);
    a = gg(a, b, c, d, k[5], 5, -701558691); d = gg(d, a, b, c, k[10], 9, 38016083);
    c = gg(c, d, a, b, k[15], 14, -660478335); b = gg(b, c, d, a, k[4], 20, -405537848);
    a = gg(a, b, c, d, k[9], 5, 568446438); d = gg(d, a, b, c, k[14], 9, -1019803690);
    c = gg(c, d, a, b, k[3], 14, -187363961); b = gg(b, c, d, a, k[8], 20, 1163531501);
    a = gg(a, b, c, d, k[13], 5, -1444681467); d = gg(d, a, b, c, k[2], 9, -51403784);
    c = gg(c, d, a, b, k[7], 14, 1735328473); b = gg(b, c, d, a, k[12], 20, -1926607734);
    a = hh(a, b, c, d, k[5], 4, -378558); d = hh(d, a, b, c, k[8], 11, -2022574463);
    c = hh(c, d, a, b, k[11], 16, 1839030562); b = hh(b, c, d, a, k[14], 23, -35309556);
    a = hh(a, b, c, d, k[1], 4, -1530992060); d = hh(d, a, b, c, k[4], 11, 1272893353);
    c = hh(c, d, a, b, k[7], 16, -155497632); b = hh(b, c, d, a, k[10], 23, -1094730640);
    a = hh(a, b, c, d, k[13], 4, 681279174); d = hh(d, a, b, c, k[0], 11, -358537222);
    c = hh(c, d, a, b, k[3], 16, -722521979); b = hh(b, c, d, a, k[6], 23, 76029189);
    a = hh(a, b, c, d, k[9], 4, -640364487); d = hh(d, a, b, c, k[12], 11, -421815835);
    c = hh(c, d, a, b, k[15], 16, 530742520); b = hh(b, c, d, a, k[2], 23, -995338651);
    a = ii(a, b, c, d, k[0], 6, -198630844); d = ii(d, a, b, c, k[7], 10, 1126891415);
    c = ii(c, d, a, b, k[14], 15, -1416354155); b = ii(b, c, d, a, k[5], 21, -57434055);
    a = ii(a, b, c, d, k[12], 6, 1700485571); d = ii(d, a, b, c, k[3], 10, -1894986606);
    c = ii(c, d, a, b, k[10], 15, -1051523); b = ii(b, c, d, a, k[1], 21, -2054922799);
    a = ii(a, b, c, d, k[8], 6, 1873313359); d = ii(d, a, b, c, k[15], 10, -30611744);
    c = ii(c, d, a, b, k[6], 15, -1560198380); b = ii(b, c, d, a, k[13], 21, 1309151649);
    a = ii(a, b, c, d, k[4], 6, -145523070); d = ii(d, a, b, c, k[11], 10, -1120210379);
    c = ii(c, d, a, b, k[2], 15, 718787259); b = ii(b, c, d, a, k[9], 21, -343485551);
    x[0] = add32(a, x[0]); x[1] = add32(b, x[1]); x[2] = add32(c, x[2]); x[3] = add32(d, x[3]);
  }
  function cmn(q, a, b, x, s, t) { a = add32(add32(a, q), add32(x, t)); return add32((a << s) | (a >>> (32 - s)), b); }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | ((~b) & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & (~d)), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | (~d)), a, b, x, s, t); }
  function md51(s) {
    let n = s.length, state = [1732584193, -271733879, -1732584194, 271733878], i;
    for (i = 64; i <= n; i += 64) { md5cycle(state, md5blk(s.substring(i - 64, i))); }
    s = s.substring(i - 64);
    let tail = [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0];
    for (i = 0; i < s.length; i++) tail[i >> 2] |= s.charCodeAt(i) << ((i % 4) << 3);
    tail[i >> 2] |= 0x80 << ((i % 4) << 3);
    if (i > 55) { md5cycle(state, tail); for (i = 0; i < 16; i++) tail[i] = 0; }
    tail[14] = n * 8;
    md5cycle(state, tail);
    return state;
  }
  function md5blk(s) {
    let md5blks = [], i;
    for (i = 0; i < 64; i += 4) { md5blks[i >> 2] = s.charCodeAt(i) + (s.charCodeAt(i + 1) << 8) + (s.charCodeAt(i + 2) << 16) + (s.charCodeAt(i + 3) << 24); }
    return md5blks;
  }
  const hex_chr = '0123456789abcdef'.split('');
  function rhex(n) { let s = '', j = 0; for (; j < 4; j++) s += hex_chr[(n >> (j * 8 + 4)) & 0x0f] + hex_chr[(n >> (j * 8)) & 0x0f]; return s; }
  function hex(x) { for (let i = 0; i < x.length; i++) x[i] = rhex(x[i]); return x.join(''); }
  function add32(a, b) { return (a + b) & 0xFFFFFFFF; }
  return hex(md51(string));
}

async function proxyFetch(url, extraCookie, options = {}) {
  const headers = { ...API_HEADERS };
  if (options.referer) headers['Referer'] = options.referer;
  if (options.range) headers['Range'] = options.range;

  const anonCookie = await getAnonCookie();
  const cookieParts = [anonCookie];
  if (extraCookie) cookieParts.push(extraCookie);
  headers['Cookie'] = cookieParts.join('; ');

  let resp = await fetch(url, {
    headers: safeHeaders(headers),
    redirect: 'follow',
  });

  if (resp.status === 412) {
    anonCookieCache = { cookie: '', update_time: 0 };
    const freshCookie = await getAnonCookie();
    const retryHeaders = { ...API_HEADERS };
    if (options.referer) retryHeaders['Referer'] = options.referer;
    if (options.range) retryHeaders['Range'] = options.range;
    retryHeaders['Cookie'] = [freshCookie, extraCookie].filter(Boolean).join('; ');
    await new Promise(r => setTimeout(r, 300));
    resp = await fetch(url, {
      headers: safeHeaders(retryHeaders),
      redirect: 'follow',
    });
  }

  return resp;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Cookie, Referer, Origin',
    'Access-Control-Allow-Credentials': 'true',
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
  });
}

async function handleApiProxy(targetUrl, cookie) {
  let fetchUrl = targetUrl;
  const needWbi = targetUrl.includes('/x/space/wbi/') || targetUrl.includes('/x/wbi/');
  if (needWbi) {
    try {
      const targetUrlObj = new URL(targetUrl);
      const params = Object.fromEntries(targetUrlObj.searchParams.entries());
      fetchUrl = await signUrl(targetUrlObj.origin + targetUrlObj.pathname, params, cookie);
    } catch (e) {
      console.error('WBI签名失败:', e.message);
    }
  }

  const resp = await proxyFetch(fetchUrl, cookie, { referer: 'https://www.bilibili.com/' });
  const contentType = resp.headers.get('Content-Type') || '';

  if (resp.status === 412) {
    return jsonResponse({
      code: -412,
      message: '请求被B站风控拦截(412)。可能原因：1) Vercel出口IP被标记，可稍后重试或换Region；2) 缺少登录态，请在页面填入SESSDATA；3) 短期内请求过多，请等待10-30分钟。'
    }, 412);
  }

  if (!resp.ok && resp.status >= 400) {
    const errText = await resp.text();
    return jsonResponse({
      code: resp.status,
      message: `B站API错误(${resp.status})：${errText.substring(0, 200)}`
    }, resp.status);
  }

  if (contentType.startsWith('image/') || contentType.startsWith('video/')) {
    const headers = { ...corsHeaders(), 'Content-Type': contentType };
    const cl = resp.headers.get('Content-Length');
    if (cl) headers['Content-Length'] = cl;
    const cc = resp.headers.get('Cache-Control');
    if (cc) headers['Cache-Control'] = cc;
    return new Response(resp.body, { status: resp.status, headers });
  }

  if (contentType.includes('json') || contentType.includes('javascript')) {
    const text = await resp.text();
    try {
      const data = JSON.parse(text);
      return jsonResponse(data, resp.status);
    } catch {
      return jsonResponse({ code: -1, message: '响应解析失败', raw: text.substring(0, 500) }, resp.status);
    }
  }

  if (contentType.startsWith('text/html')) {
    return jsonResponse({ code: -412, message: 'B站返回HTML页面（可能是风控）' }, 412);
  }

  const text = await resp.text();
  return new Response(text, {
    status: resp.status,
    headers: { ...corsHeaders(), 'Content-Type': contentType || 'text/plain' }
  });
}

// Vercel Edge Function 入口
export default async function handler(request) {
  const url = new URL(request.url);
  // catch-all 路由 /api/[...path]：pathname 形如 /api/health、/api/up 等
  const path = url.pathname;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders() });
  }

  try {
    if (path === '/api/health' || path === '/health') {
      const now = Date.now();
      const anonAge = anonCookieCache.cookie ? Math.floor((now - anonCookieCache.update_time) / 60000) : -1;
      const wbiAge = wbiKeysCache.update_time ? Math.floor((now - wbiKeysCache.update_time) / 60000) : -1;
      return jsonResponse({
        status: 'ok',
        proxy: 'vercel-edge',
        wbi: !!wbiKeysCache.img_key,
        wbiAge: wbiAge,
        hasAnonCookie: !!anonCookieCache.cookie,
        anonCookieAge: anonAge,
        timestamp: now,
      });
    }

    if (path === '/api/test' || path === '/test') {
      const tests = {};
      try {
        const resp = await fetch('https://www.bilibili.com/', { headers: safeHeaders(BROWSER_VISIT_HEADERS), redirect: 'follow' });
        tests.visitHome = { status: resp.status, hasCookie: !!(resp.headers.get('set-cookie')) };
      } catch (e) { tests.visitHome = { error: e.message }; }
      try {
        const resp = await proxyFetch('https://api.bilibili.com/x/web-interface/nav', '', { referer: 'https://www.bilibili.com/' });
        const text = await resp.text();
        tests.navApi = { status: resp.status, body: text.substring(0, 200) };
      } catch (e) { tests.navApi = { error: e.message }; }
      const allOk = tests.visitHome.status === 200 && tests.navApi.status === 200;
      return jsonResponse({
        ok: allOk,
        message: allOk ? 'Vercel Edge IP 可正常访问B站' : 'Vercel Edge IP 被B站风控拦截，可稍后重试或换 Region 部署',
        tests,
        timestamp: Date.now(),
      });
    }

    if (path === '/api/api' || path === '/api') {
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl) return jsonResponse({ code: 400, message: '缺少url参数' }, 400);
      const cookie = url.searchParams.get('cookie') || '';
      return handleApiProxy(targetUrl, cookie);
    }

    if (path === '/api/up' || path === '/up') {
      const mid = url.searchParams.get('mid');
      if (!mid) return jsonResponse({ code: 400, message: '缺少mid参数' }, 400);

      const cookie = url.searchParams.get('cookie') || '';
      const params = {
        mid,
        pn: url.searchParams.get('pn') || '1',
        ps: url.searchParams.get('ps') || '10',
        order: url.searchParams.get('order') || 'pubdate',
        platform: 'web',
        web_location: '1550104',
        order_avoided: 'true',
      };

      const signedUrl = await signUrl('https://api.bilibili.com/x/space/wbi/arc/search', params, cookie);
      const resp = await proxyFetch(signedUrl, cookie, { referer: 'https://space.bilibili.com/' });

      if (resp.status === 412) {
        return jsonResponse({ code: -412, message: 'UP主视频列表被风控拦截(412)。建议：1) 填入SESSDATA；2) 稍后重试。' }, 412);
      }

      const text = await resp.text();
      try {
        const data = JSON.parse(text);
        if (data.code === -412) {
          return jsonResponse({ code: -412, message: 'B站风控拦截。建议填入SESSDATA或稍后重试。' }, 412);
        }
        return jsonResponse(data, resp.status);
      } catch {
        return jsonResponse({ code: -1, message: '响应解析失败', raw: text.substring(0, 300) }, resp.status);
      }
    }

    if (path === '/api/season' || path === '/season') {
      const mid = url.searchParams.get('mid') || '';
      const seasonId = url.searchParams.get('season_id') || '';
      const seriesId = url.searchParams.get('series_id') || '';
      const cookie = url.searchParams.get('cookie') || '';

      let apiUrl;
      if (seasonId) {
        const params = new URLSearchParams({
          mid, season_id: seasonId, sort_reverse: 'false',
          page_num: url.searchParams.get('page_num') || '1',
          page_size: url.searchParams.get('page_size') || '30',
        });
        apiUrl = `https://api.bilibili.com/x/polymer/web-space/seasons_archives_list?${params}`;
      } else if (seriesId) {
        const params = new URLSearchParams({
          mid, series_id: seriesId,
          page_num: url.searchParams.get('page_num') || '1',
          page_size: url.searchParams.get('page_size') || '30',
        });
        apiUrl = `https://api.bilibili.com/x/polymer/web-space/seasons_series_list?${params}`;
      } else {
        return jsonResponse({ code: 400, message: '缺少season_id或series_id' }, 400);
      }

      const resp = await proxyFetch(apiUrl, cookie, { referer: 'https://space.bilibili.com/' });

      if (resp.status === 412) {
        return jsonResponse({ code: -412, message: '合集列表被风控拦截(412)。建议填入SESSDATA或稍后重试。' }, 412);
      }

      const text = await resp.text();
      try {
        const data = JSON.parse(text);
        return jsonResponse(data, resp.status);
      } catch {
        return jsonResponse({ code: -1, message: '响应解析失败' }, resp.status);
      }
    }

    if (path === '/api/download' || path === '/download') {
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl) return jsonResponse({ code: 400, message: '缺少url参数' }, 400);
      const cookie = url.searchParams.get('cookie') || '';
      const filename = url.searchParams.get('name') || 'video.mp4';
      const range = request.headers.get('Range'); // 支持 Range 分片请求

      // 手动处理重定向，保留 Range / Referer 头到最终 CDN URL
      const anonCookie = await getAnonCookie();
      const cookieParts = [anonCookie];
      if (cookie) cookieParts.push(cookie);
      const headers = {
        ...API_HEADERS,
        'Referer': 'https://www.bilibili.com/',
        'Cookie': cookieParts.join('; '),
      };
      if (range) headers['Range'] = range;

      let resp = await fetch(targetUrl, {
        headers: safeHeaders(headers),
        redirect: 'manual',
      });

      // 跟随 301/302/307/308 重定向，最多 5 层
      let redirects = 0;
      while (resp.status >= 300 && resp.status < 400 && redirects < 5) {
        let loc = resp.headers.get('Location');
        if (!loc) break;
        if (loc.startsWith('/')) loc = new URL(loc, targetUrl).toString();
        redirects++;
        resp = await fetch(loc, {
          headers: safeHeaders(headers),
          redirect: 'manual',
        });
      }

      if (resp.status === 412) {
        anonCookieCache = { cookie: '', update_time: 0 };
        const freshCookie = await getAnonCookie();
        headers['Cookie'] = [freshCookie, cookie].filter(Boolean).join('; ');
        resp = await fetch(targetUrl, {
          headers: safeHeaders(headers),
          redirect: 'manual',
        });
        redirects = 0;
        while (resp.status >= 300 && resp.status < 400 && redirects < 5) {
          let loc = resp.headers.get('Location');
          if (!loc) break;
          if (loc.startsWith('/')) loc = new URL(loc, targetUrl).toString();
          redirects++;
          resp = await fetch(loc, {
            headers: safeHeaders(headers),
            redirect: 'manual',
          });
        }
      }

      const respHeaders = {
        ...corsHeaders(),
        'Content-Type': resp.headers.get('Content-Type') || 'video/mp4',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600',
      };
      const cl = resp.headers.get('Content-Length');
      if (cl) respHeaders['Content-Length'] = cl;
      const cr = resp.headers.get('Content-Range');
      if (cr) respHeaders['Content-Range'] = cr;
      const lm = resp.headers.get('Last-Modified');
      if (lm) respHeaders['Last-Modified'] = lm;
      const et = resp.headers.get('ETag');
      if (et) respHeaders['ETag'] = et;

      return new Response(resp.body, {
        status: resp.status,
        headers: respHeaders
      });
    }

    return jsonResponse({ code: 404, message: '未知路由: ' + path }, 404);

  } catch (err) {
    return jsonResponse({ code: 500, message: err.message || '内部错误' }, 500);
  }
}
