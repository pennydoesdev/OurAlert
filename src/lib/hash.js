/**
 * lib/hash.js — cryptographic hashing utilities.
 *
 * Used for:
 * - Hashing IP addresses before rate-limit storage (never store raw IPs)
 * - Hashing session tokens before DB storage
 * - Generating stable anonymous session IDs
 *
 * Uses WebCrypto SHA-256 everywhere for consistency and edge compatibility.
 */

const encoder = new TextEncoder();

/**
 * Compute SHA-256 hex digest of a string.
 */
export async function sha256Hex(input) {
  const data = encoder.encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return bufferToHex(hash);
}

/**
 * Compute SHA-256 base64 digest (shorter than hex, still safe).
 */
export async function sha256Base64(input) {
  const data = encoder.encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return bufferToBase64(hash);
}

/**
 * HMAC-SHA256 used for signing session tokens.
 * @param {string} secret — shared secret
 * @param {string} message — value to sign
 */
export async function hmacSha256(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return bufferToHex(signature);
}

/**
 * Hash an IP address with the IP_SALT secret.
 * Used for rate limiting WITHOUT storing the raw IP.
 */
export async function hashIp(ip, salt) {
  if (!ip || !salt) return null;
  return sha256Hex(`${salt}:${ip}`);
}

/**
 * Extract the client IP from a request, preferring CF-Connecting-IP.
 */
export function getClientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0].trim() ||
    request.headers.get('X-Real-IP') ||
    'unknown'
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Internal encoding helpers
// ────────────────────────────────────────────────────────────────────────────

function bufferToHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
