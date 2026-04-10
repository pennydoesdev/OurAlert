/**
 * lib/rate-limit.js — tumbling-window rate limiting backed by D1.
 *
 * Privacy posture: IPs are never stored raw. The `ip_hash` column holds
 * SHA-256(IP_SALT + ip). A nightly cron deletes entries older than 7 days.
 *
 * Each scope has its own (limit, windowSeconds) so report submission can
 * be stricter than analytics batch, etc.
 */

import { hashIp, getClientIp } from './hash.js';

// Scope configuration — tuned to be generous for humans, tight for bots
export const SCOPES = {
  report:     { limit: 5,   windowSeconds: 600 },    // 5 reports / 10 min per IP
  login:      { limit: 5,   windowSeconds: 600 },    // 5 logins / 10 min
  subscribe:  { limit: 3,   windowSeconds: 3600 },   // 3 subscriptions / hour
  batch:      { limit: 120, windowSeconds: 60 },     // 120 analytics batches / min
  upload:     { limit: 20,  windowSeconds: 600 },    // 20 upload initiations / 10 min
  geocode:    { limit: 30,  windowSeconds: 60 },     // 30 geocode lookups / min
  nearest:    { limit: 60,  windowSeconds: 60 }      // 60 nearest-facility / min
};

/**
 * Check and increment the rate limit for a given IP and scope.
 * @returns { ok: boolean, remaining: number, retryAfter: number }
 */
export async function checkRateLimit(env, request, scope) {
  const cfg = SCOPES[scope];
  if (!cfg) throw new Error(`Unknown rate limit scope: ${scope}`);

  const ip = getClientIp(request);
  const ipHash = await hashIp(ip, env.IP_SALT || 'dev-salt-change-me');
  if (!ipHash) return { ok: true, remaining: cfg.limit, retryAfter: 0 };

  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / cfg.windowSeconds) * cfg.windowSeconds;

  // Atomically increment the counter for this (ip_hash, scope, window_start).
  // D1 doesn't support ON CONFLICT INCREMENT, so we upsert with COALESCE.
  await env.DB.prepare(
    `INSERT INTO rate_limits (ip_hash, scope, window_start, count)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(ip_hash, scope, window_start)
     DO UPDATE SET count = count + 1`
  ).bind(ipHash, scope, windowStart).run();

  // Read the current count
  const row = await env.DB.prepare(
    `SELECT count FROM rate_limits WHERE ip_hash = ? AND scope = ? AND window_start = ?`
  ).bind(ipHash, scope, windowStart).first();

  const count = row?.count || 1;
  const remaining = Math.max(0, cfg.limit - count);
  const retryAfter = count > cfg.limit ? (windowStart + cfg.windowSeconds) - now : 0;

  return {
    ok: count <= cfg.limit,
    count,
    remaining,
    limit: cfg.limit,
    retryAfter
  };
}

/**
 * Periodic cleanup job — called from the nightly cron.
 * Deletes rate_limits entries older than 7 days.
 */
export async function cleanupRateLimits(env) {
  const cutoff = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
  const { success } = await env.DB.prepare(
    `DELETE FROM rate_limits WHERE window_start < ?`
  ).bind(cutoff).run();
  return success;
}
