/**
 * lib/kv.js — thin wrappers around KV for caching.
 *
 * Keys are namespaced by prefix so different caches don't collide:
 *   cache:reports:bbox:{hash}   → report list cache (10 min)
 *   cache:geocode:{query_hash}  → geocoding cache (30 days)
 *   cache:facility-near:{hash}  → nearest facility cache (1 hour)
 *
 * All values are JSON-encoded. Use getJson/setJson to avoid repeating the
 * encode/decode dance.
 */

/**
 * Get a JSON value from KV. Returns null if missing or malformed.
 */
export async function getJson(kv, key) {
  try {
    const raw = await kv.get(key, 'json');
    return raw;
  } catch {
    return null;
  }
}

/**
 * Set a JSON value in KV with a TTL in seconds.
 * KV minimum TTL is 60 seconds.
 */
export async function setJson(kv, key, value, ttlSeconds = 600) {
  const ttl = Math.max(60, Math.floor(ttlSeconds));
  await kv.put(key, JSON.stringify(value), { expirationTtl: ttl });
}

/**
 * Delete a key.
 */
export async function del(kv, key) {
  try { await kv.delete(key); } catch {}
}

/**
 * Invalidate all keys matching a prefix. Use sparingly — KV.list is
 * expensive. Only call from infrequent paths (moderation approval, etc).
 */
export async function invalidatePrefix(kv, prefix) {
  let cursor = undefined;
  let deleted = 0;
  do {
    const res = await kv.list({ prefix, cursor, limit: 1000 });
    for (const key of res.keys) {
      await kv.delete(key.name);
      deleted++;
    }
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor);
  return deleted;
}

/**
 * Build a stable cache key from an arbitrary object.
 * Used to hash query parameters into a short key.
 */
export async function cacheKey(prefix, params) {
  const sorted = Object.keys(params)
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&');
  const hash = await sha256Short(sorted);
  return `${prefix}:${hash}`;
}

async function sha256Short(input) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return hex.substring(0, 16);
}

// Standard TTLs used across the app
export const TTL = {
  REPORTS_LIST: 10 * 60,        // 10 minutes
  GEOCODE: 30 * 24 * 60 * 60,   // 30 days
  FACILITY_NEAREST: 60 * 60,    // 1 hour
  ZIP_LOOKUP: 30 * 24 * 60 * 60 // 30 days
};
