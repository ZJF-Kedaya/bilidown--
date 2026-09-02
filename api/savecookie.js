/**
 * 保存/清除最新 Cookie 到 Vercel KV
 * - 前端 applyCookie 时 POST { cookie: '...' } 持久化最新 Cookie
 * - 前端 clearCookie 时 POST { cookie: '' } 清除
 * - 可选鉴权：配置环境变量 SAVE_COOKIE_TOKEN 后，需带 &token=xxx 或 Authorization 头才可写
 */
export const config = { runtime: 'edge' };
export const dynamic = 'force-dynamic';

import { saveStoredCookie } from '../lib/cookie-store.js';

const TOKEN = (typeof process !== 'undefined' && process.env.SAVE_COOKIE_TOKEN) || '';

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Origin',
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(), 'Content-Type': 'application/json' },
  });
}

export default async function handler(request) {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors() });
  }

  // 鉴权：若配置了 SAVE_COOKIE_TOKEN，则校验 token（query 或 Authorization 头）
  if (TOKEN) {
    const qToken = url.searchParams.get('token') || '';
    const hToken = (request.headers.get('Authorization') || '').replace(/^Bearer /i, '');
    if (qToken !== TOKEN && hToken !== TOKEN) {
      return json({ code: 401, message: '未授权：缺少正确的 token（配置了 SAVE_COOKIE_TOKEN）' }, 401);
    }
  }

  let cookie = '';
  if (request.method === 'POST') {
    try {
      const body = await request.json();
      cookie = (body && typeof body.cookie === 'string') ? body.cookie : '';
    } catch {
      cookie = '';
    }
  } else { // GET 支持 ?cookie= 便于调试
    cookie = url.searchParams.get('cookie') || '';
  }

  const ok = await saveStoredCookie(cookie);
  if (!ok) {
    return json({ code: 500, message: '写入 KV 失败（未创建 Vercel Storage 或缺少 KV 环境变量）' }, 500);
  }
  return json({ code: 0, message: cookie ? 'Cookie 已保存，全站接口将自动使用最新 Cookie' : 'Cookie 已清除', data: { saved: !!cookie } });
}