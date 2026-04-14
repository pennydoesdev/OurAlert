// src/routes/subscribe.js
/**
 * routes/subscribe.js — alert subscription lifecycle.
 *
 *   POST /api/subscribe          { email, zip, radius_mi?, digest_hour_utc? }
 *     -> creates (or idempotently re-sends verification for) a subscriber,
 *        enqueues a 'subscribe_verify' email, returns 202.
 *
 *   GET  /api/subscribe/verify?token=<verify_token>
 *     -> marks the subscriber verified, returns a short confirmation HTML.
 *
 *   POST /api/unsubscribe        { token }
 *   GET  /api/unsubscribe?token=<unsubscribe_token>
 *     -> deletes the subscriber row (hard delete — we never keep unsub'd
 *        emails) and returns a confirmation.
 *
 * Privacy posture: subscriber email is only stored once verified-or-pending;
 * raw email never appears in logs. We derive lat/lon at subscribe time from
 * the zip (via zip_cache + Nominatim) so the alert fan-out job can do a fast
 * bounding-box query without geocoding each time.
 */

import { json, errors } from '../lib/response.js';
import { checkRateLimit } from '../lib/rate-limit.js';
import { isEmail, isZip } from '../lib/validation.js';
import { prefixedId, nanoid } from '../lib/nanoid.js';
import { enqueueEmail } from '../lib/email.js';

const MAX_RADIUS_MI = 250;
const DEFAULT_RADIUS_MI = 50;

// ────────────────────────────────────────────────────────────────────────────
// POST /api/subscribe
// ────────────────────────────────────────────────────────────────────────────

export async function handleSubscribe(request, env, ctx) {
  const rl = await checkRateLimit(env, request, 'subscribe');
  if (!rl.ok) return errors.rateLimited(rl.retryAfter);

  let body;
  try { body = await request.json(); } catch { return errors.badRequest('Invalid JSON'); }

  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const zip = typeof body?.zip === 'string' ? body.zip.trim() : '';
  if (!isEmail(email)) return errors.badRequest('Invalid email');
  if (!isZip(zip)) return errors.badRequest('Invalid ZIP');

  const radiusRaw = Number(body?.radius_mi);
  const radius = Number.isFinite(radiusRaw) && radiusRaw > 0 && radiusRaw <= MAX_RADIUS_MI
    ? Math.round(radiusRaw)
    : DEFAULT_RADIUS_MI;

  const digestHourRaw = Number(body?.digest_hour_utc);
  const digestHour = Number.isFinite(digestHourRaw) && digestHourRaw >= 0 && digestHourRaw <= 23
    ? Math.trunc(digestHourRaw)
    : 13;

  // Resolve zip → lat/lon via zip_cache. If not cached, the fan-out cron can
  // still enrich it later; we just save NULLs for now and warn.
  const geo = await env.DB.prepare(
    `SELECT lat, lon FROM zip_cache WHERE zip = ? LIMIT 1`
  ).bind(zip).first();

  const now = Date.now();
  const existing = await env.DB.prepare(
    `SELECT id, verified, unsubscribe_token FROM subscribers WHERE email = ? LIMIT 1`
  ).bind(email).first();

  let subscriberId, verifyToken, unsubscribeToken, verified;

  if (existing) {
    subscriberId = existing.id;
    unsubscribeToken = existing.unsubscribe_token;
    verified = existing.verified;
    verifyToken = nanoid(32);

    await env.DB.prepare(
      `UPDATE subscribers
       SET zip = ?, radius_mi = ?, lat = ?, lon = ?, digest_hour_utc = ?,
           verify_token = ?, verify_sent_at = ?
       WHERE id = ?`
    ).bind(
      zip, radius, geo?.lat ?? null, geo?.lon ?? null, digestHour,
      verified ? null : verifyToken, verified ? existing.verify_sent_at : now,
      subscriberId
    ).run();
  } else {
    subscriberId = prefixedId('sub', 14);
    verifyToken = nanoid(32);
    unsubscribeToken = nanoid(32);
    verified = 0;

    await env.DB.prepare(
      `INSERT INTO subscribers
        (id, email, zip, radius_mi, lat, lon,
         alerts_enabled, digest_enabled, digest_hour_utc,
         verified, verify_token, verify_sent_at, unsubscribe_token, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, 0, ?, ?, ?, ?)`
    ).bind(
      subscriberId, email, zip, radius, geo?.lat ?? null, geo?.lon ?? null,
      digestHour, verifyToken, now, unsubscribeToken, now
    ).run();
  }

  // If already verified, skip the email — just confirm.
  if (verified) return json({ status: 'already_verified' });

  const appUrl = env.APP_URL || 'https://ouralert.org';
  const verifyUrl = `${appUrl}/api/subscribe/verify?token=${verifyToken}`;

  const enqueuePromise = enqueueEmail(env, {
    to: email,
    category: 'verify',
    template: 'subscribe_verify',
    data: { verify_url: verifyUrl, zip }
  }).catch((err) => console.error('subscribe verify enqueue failed:', err.message));

  if (ctx?.waitUntil) ctx.waitUntil(enqueuePromise);
  else await enqueuePromise;

  return json({ status: 'verification_sent' }, 202);
}

// ────────────────────────────────────────────────────────────────────────────
// GET /api/subscribe/verify?token=...
// ────────────────────────────────────────────────────────────────────────────

export async function handleVerifySubscribe(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  if (!token || token.length < 8) return htmlResponse(400, 'Invalid verification link.');

  const row = await env.DB.prepare(
    `SELECT id FROM subscribers WHERE verify_token = ? AND verified = 0 LIMIT 1`
  ).bind(token).first();

  if (!row) return htmlResponse(404, 'This verification link is expired or already used.');

  await env.DB.prepare(
    `UPDATE subscribers SET verified = 1, verify_token = NULL WHERE id = ?`
  ).bind(row.id).run();

  return htmlResponse(200, `
    <h1>You're all set</h1>
    <p>Your OurALERT subscription is verified. You'll receive alerts for reports near your ZIP.</p>
    <p><a href="${env.APP_URL || 'https://ouralert.org'}">Return to OurALERT</a></p>
  `);
}

// ────────────────────────────────────────────────────────────────────────────
// POST /api/unsubscribe  and  GET /api/unsubscribe?token=...
// ────────────────────────────────────────────────────────────────────────────

export async function handleUnsubscribe(request, env) {
  let token = '';
  if (request.method === 'GET') {
    token = new URL(request.url).searchParams.get('token') || '';
  } else {
    try {
      const body = await request.json();
      token = typeof body?.token === 'string' ? body.token : '';
    } catch { return errors.badRequest('Invalid JSON'); }
  }
  if (!token || token.length < 8) {
    return request.method === 'GET'
      ? htmlResponse(400, 'Invalid unsubscribe link.')
      : errors.badRequest('Invalid token');
  }

  const result = await env.DB.prepare(
    `DELETE FROM subscribers WHERE unsubscribe_token = ?`
  ).bind(token).run();

  const changed = result?.meta?.changes ?? 0;

  if (request.method === 'GET') {
    return changed > 0
      ? htmlResponse(200, `<h1>Unsubscribed</h1><p>You've been removed from OurALERT alerts.</p>`)
      : htmlResponse(200, `<h1>Already unsubscribed</h1><p>This link has already been used.</p>`);
  }
  return json({ status: 'ok', removed: changed > 0 });
}

// ────────────────────────────────────────────────────────────────────────────
function htmlResponse(status, bodyInner) {
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>OurALERT</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:40px auto;padding:24px;color:#222;}
h1{color:#c8102e;}a{color:#c8102e;}</style></head>
<body>${bodyInner}</body></html>`;
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
