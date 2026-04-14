// src/jobs/drain.js
/**
 * jobs/drain.js — KV hot buffer → D1 drain (Phase 1e).
 *
 * Called every 2 minutes by the cron dispatcher in src/index.js.
 *
 * 1. Lists up to MAX_KEYS_PER_RUN keys under the `buf:events:` prefix.
 * 2. For each key:
 *    - Parse the batch { events: [...], received_at }
 *    - Build a D1 batch: INSERT each event + UPSERT each session
 *    - Execute the batch atomically
 *    - On success, delete the KV key
 *    - On failure, log and leave the key for the next run (KV 1h TTL is
 *      the hard floor — nothing is lost for less than an hour of outage)
 *
 * Privacy: KV payload carries only already-sanitized events. No raw IPs
 * or user agents enter D1 at any point. Country comes from CF-IPCountry
 * which was captured server-side during ingestion.
 */

import { nanoid } from '../lib/nanoid.js';

// Cap drain work per invocation to keep under Workers CPU budget (~30s wall).
// At 100 KV batches × ~50 events each that's ~10k inserts per run; if backlog
// builds, subsequent ticks catch up (cron fires every 2 min).
const MAX_KEYS_PER_RUN = 100;
const KV_PREFIX = 'buf:events:';

export async function drainAnalyticsBuffer(env) {
  if (!env.CACHE || !env.DB) {
    console.error('drain: missing KV or D1 binding');
    return { drained: 0, failed: 0, events: 0 };
  }

  let keys;
  try {
    const list = await env.CACHE.list({ prefix: KV_PREFIX, limit: MAX_KEYS_PER_RUN });
    keys = list.keys || [];
  } catch (err) {
    console.error('drain: KV list failed —', err.message);
    return { drained: 0, failed: 0, events: 0 };
  }

  if (keys.length === 0) return { drained: 0, failed: 0, events: 0 };

  let drained = 0;
  let failed = 0;
  let eventCount = 0;

  for (const { name: key } of keys) {
    try {
      const raw = await env.CACHE.get(key);
      if (!raw) {
        // Race: key expired between list and get. Skip.
        continue;
      }

      let batch;
      try {
        batch = JSON.parse(raw);
      } catch (err) {
        console.error(`drain: corrupt JSON at ${key} — ${err.message}; deleting`);
        await env.CACHE.delete(key);
        failed++;
        continue;
      }

      const events = Array.isArray(batch?.events) ? batch.events : [];
      if (events.length === 0) {
        await env.CACHE.delete(key);
        continue;
      }

      const statements = buildBatchStatements(env, events);
      if (statements.length > 0) {
        await env.DB.batch(statements);
      }

      await env.CACHE.delete(key);
      drained++;
      eventCount += events.length;
    } catch (err) {
      console.error(`drain: failed on ${key} —`, err.message);
      failed++;
      // Leave the KV key in place for retry next tick.
    }
  }

  console.log(`drain: ${drained} batches / ${eventCount} events committed, ${failed} failed`);
  return { drained, failed, events: eventCount };
}

/**
 * Build the list of prepared D1 statements for a batch of events.
 * Each event produces:
 *   - one INSERT into analytics_events
 *   - one UPSERT into analytics_sessions
 */
function buildBatchStatements(env, events) {
  const statements = [];

  for (const e of events) {
    const receivedAt = Number(e._received_at) || Date.now();
    const country = String(e._country || 'XX').slice(0, 2);
    const { day, hour } = formatDayHour(receivedAt);

    const id = `ev_${nanoid(14)}`;
    const paramsJson =
      e.params && typeof e.params === 'object'
        ? truncate(JSON.stringify(e.params), 1024)
        : null;

    statements.push(
      env.DB.prepare(
        `INSERT INTO analytics_events
           (id, event_name, event_category, event_action, event_label, event_value,
            session_id, params_json, path, referrer_domain, device,
            utm_source, utm_medium, utm_campaign, utm_term, utm_content,
            created_day, created_hour, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id,
        truncate(e.event_name, 64),
        truncate(e.event_category, 64),
        truncate(e.event_action, 64),
        truncate(e.event_label, 128),
        Number.isFinite(e.event_value) ? Math.trunc(e.event_value) : null,
        truncate(e.session_id, 64),
        paramsJson,
        truncate(e.path, 256),
        truncate(e.referrer_domain, 128),
        truncate(e.device || 'unknown', 16),
        truncate(e.utm_source, 64),
        truncate(e.utm_medium, 64),
        truncate(e.utm_campaign, 128),
        truncate(e.utm_term, 64),
        truncate(e.utm_content, 64),
        day,
        hour,
        receivedAt
      )
    );

    // Session upsert: on insert, seed everything; on conflict, extend
    // the session, increment counters, update exit_path to current path,
    // and flip is_bounce off once we've seen more than one event.
    const isPageView = e.event_name === 'page_view' ? 1 : 0;
    statements.push(
      env.DB.prepare(
        `INSERT INTO analytics_sessions
           (session_id, first_seen, last_seen, event_count, page_count,
            country, device, landing_path, exit_path,
            referrer_domain, utm_source, utm_medium, utm_campaign,
            duration_seconds, is_bounce, ended)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 0)
         ON CONFLICT(session_id) DO UPDATE SET
           last_seen = MAX(last_seen, excluded.last_seen),
           event_count = event_count + 1,
           page_count = page_count + excluded.page_count,
           exit_path = COALESCE(excluded.exit_path, exit_path),
           duration_seconds = (MAX(last_seen, excluded.last_seen) - first_seen) / 1000,
           is_bounce = 0`
      ).bind(
        truncate(e.session_id, 64),
        receivedAt,
        receivedAt,
        isPageView,
        country,
        truncate(e.device || 'unknown', 16),
        truncate(e.path, 256),
        truncate(e.path, 256),
        truncate(e.referrer_domain, 128),
        truncate(e.utm_source, 64),
        truncate(e.utm_medium, 64),
        truncate(e.utm_campaign, 128)
      )
    );
  }

  return statements;
}

/**
 * Format a ms timestamp as { day: 'YYYY-MM-DD', hour: 0-23 } in UTC.
 */
function formatDayHour(ms) {
  const d = new Date(ms);
  const pad = (n) => n.toString().padStart(2, '0');
  return {
    day: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    hour: d.getUTCHours()
  };
}

function truncate(v, max) {
  if (v == null) return null;
  const s = String(v);
  return s.length > max ? s.slice(0, max) : s;
}
