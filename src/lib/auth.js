// src/lib/auth.js
/**
 * lib/auth.js — volunteer auth primitives.
 *
 * Three domains:
 *   1. Password hashing via PBKDF2-SHA256 (100k iterations).
 *   2. OTP generation + hashing for 2FA email codes.
 *   3. Session token generation + lookup middleware.
 *
 * All stored secrets (password_hash, code_hash, token_hash) are salted
 * derivatives — the raw password, OTP, and token are never persisted.
 *
 * Password hash serialization: `pbkdf2-sha256$<iterations>$<salt>$<hash>`
 * Session secret: env.SESSION_SECRET (set via `wrangler secret put`).
 */

import { sha256Hex } from './hash.js';

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_KEY_BITS = 256;
const SALT_BYTES = 16;

const encoder = new TextEncoder();

// ────────────────────────────────────────────────────────────────────────────
// Passwords
// ────────────────────────────────────────────────────────────────────────────

export async function hashPasswordWithSalt(password, saltHex, iterations = PBKDF2_ITERATIONS) {
  const saltBytes = hexToBytes(saltHex);
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    keyMaterial,
    PBKDF2_KEY_BITS
  );
  return bytesToHex(new Uint8Array(bits));
}

export async function newPasswordHash(password) {
  const salt = randomHex(SALT_BYTES);
  const hash = await hashPasswordWithSalt(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${salt}$${hash}`;
}

export function parsePasswordHash(stored) {
  if (!stored) return null;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return null;
  const iterations = parseInt(parts[1], 10);
  if (!Number.isFinite(iterations) || iterations < 1000) return null;
  return { iterations, salt: parts[2], hash: parts[3] };
}

export async function verifyPassword(password, stored) {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;
  const computed = await hashPasswordWithSalt(password, parsed.salt, parsed.iterations);
  return timingSafeEqualString(computed, parsed.hash);
}

// ────────────────────────────────────────────────────────────────────────────
// OTPs
// ────────────────────────────────────────────────────────────────────────────

export function generateOtp() {
  // Uniformly random 6-digit numeric code.
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return (arr[0] % 1_000_000).toString().padStart(6, '0');
}

export async function hashOtp(code, secret) {
  return sha256Hex(`${secret}:otp:${code}`);
}

// ────────────────────────────────────────────────────────────────────────────
// Session tokens
// ────────────────────────────────────────────────────────────────────────────

export function generateSessionToken() {
  // 32 random bytes → 64-char hex token.
  return randomHex(32);
}

export async function hashSessionToken(token, secret) {
  return sha256Hex(`${secret}:session:${token}`);
}

/**
 * Middleware-ish helper: pull the session token from the request, resolve
 * it to a volunteer row, enforce expiry + active status.
 *
 * Returns { ok: true, volunteer, sessionId }  on success
 *      or { ok: false, reason: <string> } on failure.
 *
 * The calling route handler decides what HTTP status to return.
 */
export async function requireSession(request, env) {
  const header = request.headers.get('X-OurAlert-Session');
  const authz = request.headers.get('Authorization');
  const bearer = authz && /^Bearer\s+/i.test(authz) ? authz.replace(/^Bearer\s+/i, '') : null;
  const token = (header || bearer || '').trim();
  if (!token) return { ok: false, reason: 'missing_token' };

  const secret = env.SESSION_SECRET || 'dev-session-secret-change-me';
  const tokenHash = await hashSessionToken(token, secret);

  const row = await env.DB.prepare(
    `SELECT s.id as session_id, s.expires_at,
            v.id as volunteer_id, v.email, v.display_name, v.role, v.status
     FROM volunteer_sessions s
     JOIN volunteers v ON v.id = s.volunteer_id
     WHERE s.token_hash = ?
     LIMIT 1`
  ).bind(tokenHash).first();

  if (!row) return { ok: false, reason: 'invalid_token' };
  if (row.expires_at < Date.now()) return { ok: false, reason: 'expired' };
  if (row.status !== 'active') return { ok: false, reason: 'inactive' };

  // Best-effort last_seen update; don't block the request.
  try {
    await env.DB.prepare(
      `UPDATE volunteer_sessions SET last_seen = ? WHERE id = ?`
    ).bind(Date.now(), row.session_id).run();
  } catch {}

  return {
    ok: true,
    sessionId: row.session_id,
    volunteer: {
      id: row.volunteer_id,
      email: row.email,
      display_name: row.display_name,
      role: row.role,
      status: row.status
    }
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Encoding helpers
// ────────────────────────────────────────────────────────────────────────────

function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return bytesToHex(arr);
}

function hexToBytes(hex) {
  const clean = hex.length % 2 ? '0' + hex : hex;
  const arr = new Uint8Array(clean.length / 2);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return arr;
}

function bytesToHex(bytes) {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

function timingSafeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
