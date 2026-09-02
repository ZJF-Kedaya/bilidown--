/**
 * 共享 Cookie 持久化存储（基于 Vercel KV）
 * - 前端保存 Cookie 后写入 KV
 * - 后端 /api/download 与 /api/api 解析时优先读取 KV 里最新保存的 Cookie
 * - 未配置 KV（未创建 Vercel Storage / 本地 dev）时静默降级，返回 ''
 */
import { kv } from '@vercel/kv';

const KEY = 'bilibili_latest_cookie';
const CACHE_TTL = 30 * 1000; // 30s 内存缓存，避免高频打 KV

let cachedCookie = null;
let cachedAt = 0;

/**
 * 读取持久化的最新 Cookie（带短 TTL 缓存）
 * @returns {Promise<string>}
 */
export async function readStoredCookie() {
  try {
    const now = Date.now();
    if (cachedCookie !== null && now - cachedAt < CACHE_TTL) {
      return cachedCookie;
    }
    const value = await kv.get(KEY);
    cachedCookie = typeof value === 'string' ? value : '';
    cachedAt = now;
    return cachedCookie;
  } catch {
    // KV 不可用（未创建 Vercel Storage 或本地 dev），降级为空串
    return '';
  }
}

/**
 * 保存最新 Cookie 到 KV，并刷新内存缓存
 * @param {string} cookie 允许空串（表示清除）
 */
export async function saveStoredCookie(cookie) {
  try {
    const normalized = typeof cookie === 'string' ? cookie.trim() : '';
    await kv.set(KEY, normalized);
    cachedCookie = normalized;
    cachedAt = Date.now();
    return true;
  } catch {
    return false;
  }
}