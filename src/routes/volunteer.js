// src/routes/volunteer.js
/**
 * routes/volunteer.js — volunteer authentication endpoints.
 *
 *   POST /api/vol/login        { email, password }        -> issues OTP (email send deferred to 1g)
 *   POST /api/vol/verify-otp   { email, code }            -> issues session token
 *   POST /api/vol/logout       (X-OurAlert-Session)       -> revokes session
 *   GET  /api/vol/me           (X-OurAlert-Session)       -> returns volunteer profile
 *
 * Responses never leak whether an email is registered. Login always
 * returns 200 with a generic "otp_sent" payload even if the password
 * fails or the account doesn't exist. Rate limits are the real
 * enforcement surface.
 *
 * Email dispatch of the OTP code is not wired yet — Phase 1g. Until
 * then, in non-production, we return the code in the response under
 * `_dev_code` to allow the UI to be built. Production strips it.
 */

import { json, errors } from '../lib/response.js';
import { checkRateLimit } from '../lib/rate-limit.js';
import {
  verifyPassword,
  generateOtp,
  hashOtp,
  generateSessionToken,
  hashSessionToken,
  requireSession
} from '../lib/auth.js';
import { nanoid, prefixedId } from '../lib/nanoid.js';

const OTP_TTL_MS = 10 * 60 * 1000;        // 10 minutes
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const OTP_MAX_ATTEMPTS = 5;

// ────────────────────────────────────────────────────────────────────────────
// POST /api/vol/login
// ────────────────────────────────────────────────────────────────────────────

export async function handleLogin(request, env, ctx) {
  const rl = await checkRateLimit(env, request, 'login');
  if (!rl.ok) return errors.rateLimited(rl.retryAfter);

  let body;
  try { body = await request.json(); } catch { return errors.badRequest('Invalid JSON'); }

  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!email || !password) return errors.badRequest('Missing email or password');
  if (email.length > 254 || password.length > 512) return errors.badRequest('Field too long');

  const now = Date.now();
  const secret = env.SESSION_SECRET || 'dev-session-secret-change-me';

  // Always look up by email, but respond the same whether or not we find one.
  const volunteer = await env.DB.prepare(
    `SELECT id, password_hash, status, locked_until, failed_login_count
     FROM volunteers
     WHERE email = ?
     LIMIT 1`
  ).bind(email).first();

  let authed = false;
  if (volunteer && volunteer.status !== 'suspended') {
    if (!volunteer.locked_until || volunteer.locked_until < now) {
      authed = await verifyPassword(password, volunteer.password_hash);
    }
  }

  if (!authed) {
    // Best-effort failed-login bookkeeping (only if a real account).
    if (volunteer) {
      const fails = (volunteer.failed_login_count || 0) + 1;
      const lockUntil = fails >= 10 ? now + 15 * 60 * 1000 : volunteer.locked_until;
      try {
        await env.DB.prepare(
          `UPDATE volunteers SET failed_login_count = ?, locked_until = ? WHERE id = ?`
        ).bind(fails, lockUntil, volunteer.id).run();
      } catch {}
    }
    // Constant-shape response.
    return json({ status: 'otp_sent' });
  }

  // Reset counters on successful password match.
  try {
    await env.DB.prepare(
      `UPDATE volunteers SET failed_login_count = 0, locked_until = NULL WHERE id = ?`
    ).bind(volunteer.id).run();
  } catch {}

  // Generate + store OTP.
  const code = generateOtp();
  const codeHash = await hashOtp(code, secret);
  const otpId = prefixedId('otp', 14);

  // Invalidate any outstanding login OTPs for this volunteer so only the newest works.
  try {
    await env.DB.prepare(
      `UPDATE volunteer_otps SET consumed = 1
       WHERE volunteer_id = ? AND purpose = 'login' AND consumed = 0`
    ).bind(volunteer.id).run();
  } catch {}

  await env.DB.prepare(
    `INSERT INTO volunteer_otps
       (id, volunteer_id, code_hash, purpose, expires_at, attempts, consumed, created_at)
     VALUES (?, ?, ?, 'login', ?, 0, 0, ?)`
  ).bind(otpId, volunteer.id, codeHash, now + OTP_TTL_MS, now).run();

  // TODO Phase 1g: enqueue the OTP email. For now, return in dev.
  const payload = { status: 'otp_sent' };
  if (env.ENVIRONMENT !== 'production') {
    payload._dev_code = code;
  }
  return json(payload);
}

// ────────────────────────────────────────────────────────────────────────────
// POST /api/vol/verify-otp
// ────────────────────────────────────────────────────────────────────────────

export async function handleVerifyOtp(request, env, ctx) {
  const rl = await checkRateLimit(env, request, 'login');
  if (!rl.ok) return errors.rateLimited(rl.retryAfter);

  let body;
  try { body = await request.json(); } catch { return errors.badRequest('Invalid JSON'); }

  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const code = typeof body?.code === 'string' ? body.code.trim() : '';
  if (!email || !/^\d{6}$/.test(code)) return errors.badRequest('Missing or malformed code');

  const now = Date.now();
  const secret = env.SESSION_SECRET || 'dev-session-secret-change-me';
  const codeHash = await hashOtp(code, secret);

  const volunteer = await env.DB.prepare(
    `SELECT id, email, display_name, role, status FROM volunteers WHERE email = ? LIMIT 1`
  ).bind(email).first();
  if (!volunteer || volunteer.status === 'suspended') return errors.unauthorized('Invalid code');

  const otp = await env.DB.prepare(
    `SELECT id, code_hash, expires_at, attempts, consumed
     FROM volunteer_otps
     WHERE volunteer_id = ? AND purpose = 'login'
     ORDER BY created_at DESC
     LIMIT 1`
  ).bind(volunteer.id).first();

  if (!otp || otp.consumed) return errors.unauthorized('Invalid code');
  if (otp.expires_at < now) return errors.unauthorized('Code expired');
  if (otp.attempts >= OTP_MAX_ATTEMPTS) return errors.unauthorized('Too many attempts');

  // Timing-safe compare on hex strings.
  const match = codeHash.length === otp.code_hash.length &&
    (() => { let d = 0; for (let i = 0; i < codeHash.length; i++) d |= codeHash.charCodeAt(i) ^ otp.code_hash.charCodeAt(i); return d === 0; })();

  if (!match) {
    try {
      await env.DB.prepare(
        `UPDATE volunteer_otps SET attempts = attempts + 1 WHERE id = ?`
      ).bind(otp.id).run();
    } catch {}
    return errors.unauthorized('Invalid code');
  }

  // Mark OTP consumed, promote pending → active, create session.
  const sessionToken = generateSessionToken();
  const sessionHash = await hashSessionToken(sessionToken, secret);
  const sessionId = prefixedId('sess', 16);
  const expires = now + SESSION_TTL_MS;

  await env.DB.batch([
    env.DB.prepare(`UPDATE volunteer_otps SET consumed = 1 WHERE id = ?`).bind(otp.id),
    env.DB.prepare(
      `UPDATE volunteers SET last_login = ?, status = CASE WHEN status = 'pending' THEN 'active' ELSE status END WHERE id = ?`
    ).bind(now, volunteer.id),
    env.DB.prepare(
      `INSERT INTO volunteer_sessions (id, volunteer_id, token_hash, expires_at, last_seen, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(sessionId, volunteer.id, sessionHash, expires, now, now)
  ]);

  return json({
    status: 'ok',
    session_token: sessionToken,
    expires_at: expires,
    volunteer: {
      id: volunteer.id,
      email: volunteer.email,
      display_name: volunteer.display_name,
      role: volunteer.role,
      status: volunteer.status === 'pending' ? 'active' : volunteer.status
    }
  });
}

// ────────────────────────────────────────────────────────────────────────────
// POST /api/vol/logout
// ────────────────────────────────────────────────────────────────────────────

export async function handleLogout(request, env, ctx) {
  const result = await requireSession(request, env);
  if (!result.ok) return errors.unauthorized(result.reason);

  try {
    await env.DB.prepare(
      `DELETE FROM volunteer_sessions WHERE id = ?`
    ).bind(result.sessionId).run();
  } catch {}

  return json({ status: 'ok' });
}

// ────────────────────────────────────────────────────────────────────────────
// GET /api/vol/me
// ────────────────────────────────────────────────────────────────────────────

export async function handleMe(request, env, ctx) {
  const result = await requireSession(request, env);
  if (!result.ok) return errors.unauthorized(result.reason);

  return json({ status: 'ok', volunteer: result.volunteer });
}
