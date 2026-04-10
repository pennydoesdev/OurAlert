/**
 * lib/turnstile.js — Cloudflare Turnstile token verification.
 *
 * Turnstile tokens are single-use and expire ~5 minutes after issue. We
 * verify by POSTing to Cloudflare's siteverify endpoint with our secret.
 *
 * https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 */

import { getClientIp } from './hash.js';

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// Cloudflare's public "always passes" test key — used in dev when
// TURNSTILE_SECRET isn't set or explicitly points at the test value.
const TEST_ALWAYS_PASS_SECRET = '1x0000000000000000000000000000000AA';

/**
 * Verify a Turnstile token. Returns true on success, false otherwise.
 *
 * @param {object} env — Worker env with TURNSTILE_SECRET
 * @param {string} token — the cf-turnstile-response token from the client
 * @param {Request} [request] — optional; used to pass the client IP to CF
 */
export async function verifyTurnstile(env, token, request = null) {
  if (!token) return { ok: false, reason: 'missing_token' };

  const secret = env.TURNSTILE_SECRET || TEST_ALWAYS_PASS_SECRET;
  if (!secret || secret.length < 10) {
    return { ok: false, reason: 'missing_secret' };
  }

  const body = new URLSearchParams();
  body.append('secret', secret);
  body.append('response', token);
  if (request) {
    const ip = getClientIp(request);
    if (ip && ip !== 'unknown') body.append('remoteip', ip);
  }

  let res;
  try {
    res = await fetch(VERIFY_URL, { method: 'POST', body });
  } catch (err) {
    return { ok: false, reason: 'network_error', error: err.message };
  }

  if (!res.ok) return { ok: false, reason: 'upstream_error', status: res.status };

  const data = await res.json();
  return {
    ok: data.success === true,
    reason: data.success ? 'ok' : (data['error-codes']?.[0] || 'unknown'),
    errors: data['error-codes'] || [],
    challenge_ts: data.challenge_ts,
    hostname: data.hostname,
    action: data.action
  };
}
