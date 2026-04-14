// src/routes/analytics.js
/**
 * routes/analytics.js — first-party analytics batch ingestion (Phase 1d).
 *
 * Clients POST batches of events here. Events are validated, annotated with
 * server-side context (country, received_at), then written to a KV hot
 * buffer under the key pattern `buf:events:YYYYMMDDHHMM:<nanoid>`.
 *
 * A cron job (Phase 1e) drains KV into D1 every 2 minutes. Until drain,
 * buffered events have a 1-hour TTL as a safety net so a stuck cron can't
 * lose more than an hour of data.
 *
 * Privacy posture:
 * - No raw IPs ever touch KV or D1 (rate limiter stores only SHA-256 hash).
 * - Country is derived from the CF-IPCountry header, aggregated rollups only.
 * - Device/UA are client-provided hints; raw UA is never stored.
 * - No third-party trackers — this is the entire analytics pipeline.
 */

import { json, errors } from '../lib/response.js';
import { checkRateLimit } from '../lib/rate-limit.js';
import { nanoid } from '../lib/nanoid.js';

// Batch size + per-event size limits. Keep these tight — the frontend
// batcher should flush early rather than pile up huge payloads.
const MAX_EVENTS_PER_BATCH = 50;
const MAX_EVENT_BYTES = 2 * 1024;          // 2 KB per serialized event
const MAX_BODY_BYTES = 128 * 1024;          // 128 KB total body cap
const KV_BUFFER_TTL_SECONDS = 60 * 60;      // 1 hour safety net; cron drains every 2 min

// Whitelist of top-level event fields we'll persist. Unknown fields are
// silently dropped — clients can't stuff arbitrary payloads into KV.
const ALLOWED_EVENT_FIELDS = new Set([
  'event_name',
  'event_category',
  'event_action',
  'event_label',
  'event_value',
  'session_id',
  'params',          // object, nested JSON.stringify'd later during drain
  'path',
  'referrer_domain',
  'device',          // 'mobile' | 'tablet' | 'desktop' | 'unknown'
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'client_time'      // client-reported timestamp (ms); server also records received_at
]);

/**
 * POST /api/analytics/batch
 *
 * Request body:
 *   { "events": [ { event_name, session_id, ... }, ... ] }
 *
 * Response (202 on success):
 *   { accepted: <number>, buffer_key: "buf:events:...", received_at: <ms> }
 */
export async function handleAnalyticsBatch(request, env, ctx) {
  // 1. Rate limit (scope 'batch': 120/min per hashed IP)
  const rl = await checkRateLimit(env, request, 'batch');
  if (!rl.ok) return errors.rateLimited(rl.retryAfter);

  // 2. Size guard before parsing — Content-Length isn't authoritative on
  //    Workers but it's a fast rejection for obviously-oversized uploads.
  const declared = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (declared > MAX_BODY_BYTES) {
    return errors.payloadTooLarge(`Body exceeds ${MAX_BODY_BYTES} bytes`);
  }

  // 3. Parse JSON
  let body;
  try {
    body = await request.json();
  } catch {
    return errors.badRequest('Body must be valid JSON');
  }

  const events = body?.events;
  if (!Array.isArray(events)) {
    return errors.badRequest('Body must include an "events" array');
  }
  if (events.length === 0) {
    // Empty batches are a no-op, not an error — lets the client flush
    // without worrying about empty-state branching.
    return json({ accepted: 0, received_at: Date.now() }, 200);
  }
  if (events.length > MAX_EVENTS_PER_BATCH) {
    return errors.payloadTooLarge(
      `Max ${MAX_EVENTS_PER_BATCH} events per batch (got ${events.length})`
    );
  }

  // 4. Validate + sanitize each event
  const now = Date.now();
  const country = request.headers.get('CF-IPCountry') || 'XX';
  const accepted = [];

  for (let i = 0; i < events.length; i++) {
    const raw = events[i];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return errors.unprocessable(`Event ${i}: must be an object`);
    }
    if (typeof raw.event_name !== 'string' || raw.event_name.length === 0 || raw.event_name.length > 64) {
      return errors.unprocessable(`Event ${i}: event_name must be a 1-64 char string`);
    }
    if (typeof raw.session_id !== 'string' || raw.session_id.length === 0 || raw.session_id.length > 64) {
      return errors.unprocessable(`Event ${i}: session_id must be a 1-64 char string`);
    }

    // Copy only whitelisted fields — silently drop unknowns.
    const clean = {};
    for (const [k, v] of Object.entries(raw)) {
      if (ALLOWED_EVENT_FIELDS.has(k)) clean[k] = v;
    }

    const serialized = JSON.stringify(clean);
    if (serialized.length > MAX_EVENT_BYTES) {
      return errors.payloadTooLarge(`Event ${i}: exceeds ${MAX_EVENT_BYTES} bytes`);
    }

    // Server-side annotations (clients can't set these)
    clean._country = country;
    clean._received_at = now;

    accepted.push(clean);
  }

  // 5. Write batch to KV buffer
  if (!env.CACHE) {
    console.error('KV binding CACHE missing — event batch dropped');
    return errors.serverError('Analytics storage unavailable');
  }

  const minuteKey = formatMinuteKey(now);
  const bufferId = nanoid(12);
  const key = `buf:events:${minuteKey}:${bufferId}`;
  const payload = JSON.stringify({ events: accepted, received_at: now });

  try {
    await env.CACHE.put(key, payload, { expirationTtl: KV_BUFFER_TTL_SECONDS });
  } catch (err) {
    console.error('KV put failed for', key, '—', err.message);
    return errors.serverError('Failed to buffer events');
  }

  return json(
    {
      accepted: accepted.length,
      buffer_key: key,
      received_at: now
    },
    202
  );
}

/**
 * Format a timestamp (ms) as YYYYMMDDHHMM in UTC.
 * Keys sort naturally and the drain cron can list by minute range.
 */
function formatMinuteKey(ms) {
  const d = new Date(ms);
  const pad = (n) => n.toString().padStart(2, '0');
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes())
  );
}
