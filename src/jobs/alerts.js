// src/jobs/alerts.js
/**
 * jobs/alerts.js — alert fan-out (Phase 1h).
 *
 * Fired every 3 minutes from the cron dispatcher.
 *
 * Flow:
 *   1. Find approved reports whose updated_at is newer than the cron's
 *      last-tick horizon (we use report.updated_at > cutoff so reports
 *      that were approved *after* submission are picked up once).
 *   2. For each candidate report, compute a bounding box at the maximum
 *      subscriber radius (250 mi) and select verified subscribers inside
 *      it where alerts_enabled = 1.
 *   3. For each subscriber, compute actual haversine distance and compare
 *      against the subscriber's personal radius_mi.
 *   4. For matches, enqueue an alert email via lib/email.js AND insert a
 *      row into alert_deliveries with a UNIQUE (subscriber_id, report_id,
 *      transport) — this is the dedupe guarantee: if the cron re-runs, the
 *      INSERT OR IGNORE trips and we skip.
 *
 * The cron horizon is state-stored in KV under `alerts:last_cutoff` so
 * restarts don't re-fan-out old reports.
 */

import { json } from '../lib/response.js';
import { boundingBox, distanceMi } from '../lib/haversine.js';
import { enqueueEmail } from '../lib/email.js';
import { prefixedId } from '../lib/nanoid.js';

const MAX_RADIUS_MI = 250;
const MAX_REPORTS_PER_RUN = 50;
const MAX_SUBS_PER_REPORT = 5000;
const CUTOFF_KEY = 'alerts:last_cutoff';
const CUTOFF_FALLBACK_MS = 30 * 60 * 1000; // 30 min backlog on cold start
const QUIET_WINDOW_MS = 5 * 60 * 1000;     // don't re-alert same subscriber within 5 min

export async function fanOutAlerts(env) {
  if (!env.DB || !env.CACHE) {
    console.error('alerts: missing DB or CACHE binding');
    return { reports: 0, delivered: 0, skipped: 0 };
  }

  const now = Date.now();

  // Load last cutoff (or default to now - fallback).
  let lastCutoff;
  try {
    const raw = await env.CACHE.get(CUTOFF_KEY);
    lastCutoff = raw ? parseInt(raw, 10) : (now - CUTOFF_FALLBACK_MS);
    if (!Number.isFinite(lastCutoff)) lastCutoff = now - CUTOFF_FALLBACK_MS;
  } catch {
    lastCutoff = now - CUTOFF_FALLBACK_MS;
  }

  // Pick approved reports whose updated_at is in (lastCutoff, now].
  const { results: reports } = await env.DB.prepare(
    `SELECT id, lat, lon, city, state, category, status, activity_text,
            address, zip, updated_at
     FROM reports
     WHERE moderation_state = 'approved'
       AND (hidden_from_public IS NULL OR hidden_from_public = 0)
       AND updated_at > ?
       AND updated_at <= ?
     ORDER BY updated_at ASC
     LIMIT ?`
  ).bind(lastCutoff, now, MAX_REPORTS_PER_RUN).all();

  if (!reports || reports.length === 0) {
    // Still advance the cutoff so we don't scan the same window forever.
    await env.CACHE.put(CUTOFF_KEY, String(now));
    return { reports: 0, delivered: 0, skipped: 0 };
  }

  let delivered = 0;
  let skipped = 0;
  let maxUpdatedAt = lastCutoff;

  for (const report of reports) {
    if (report.updated_at > maxUpdatedAt) maxUpdatedAt = report.updated_at;

    if (!Number.isFinite(report.lat) || !Number.isFinite(report.lon)) {
      skipped++;
      continue;
    }

    const bbox = boundingBox(report.lat, report.lon, MAX_RADIUS_MI);

    // Candidate subscribers: verified, alerts_enabled, inside bbox.
    // radius_mi is filtered precisely in the JS loop below.
    const { results: subs } = await env.DB.prepare(
      `SELECT id, email, zip, radius_mi, lat, lon, last_alert_sent_at, unsubscribe_token
       FROM subscribers
       WHERE verified = 1 AND alerts_enabled = 1
         AND lat IS NOT NULL AND lon IS NOT NULL
         AND lat BETWEEN ? AND ?
         AND lon BETWEEN ? AND ?
       LIMIT ?`
    ).bind(bbox.minLat, bbox.maxLat, bbox.minLon, bbox.maxLon, MAX_SUBS_PER_REPORT).all();

    if (!subs || subs.length === 0) continue;

    for (const sub of subs) {
      const dist = distanceMi(report.lat, report.lon, sub.lat, sub.lon);
      if (dist > (sub.radius_mi || 0)) continue;

      // Quiet window: if we alerted this sub within the last 5 min, skip so a
      // burst of approvals doesn't hammer the inbox.
      if (sub.last_alert_sent_at && (now - sub.last_alert_sent_at) < QUIET_WINDOW_MS) continue;

      // Dedupe guard: alert_deliveries has UNIQUE(subscriber_id, report_id, transport).
      const deliveryId = prefixedId('dlv', 14);
      let inserted;
      try {
        const result = await env.DB.prepare(
          `INSERT OR IGNORE INTO alert_deliveries
             (id, subscriber_id, report_id, transport, status, created_at)
           VALUES (?, ?, ?, 'email', 'queued', ?)`
        ).bind(deliveryId, sub.id, report.id, now).run();
        inserted = (result?.meta?.changes ?? 0) > 0;
      } catch (err) {
        console.error(`alerts: delivery insert failed for sub=${sub.id} report=${report.id}:`, err.message);
        inserted = false;
      }

      if (!inserted) { skipped++; continue; }

      const appUrl = env.APP_URL || 'https://ouralert.org';
      const reportUrl = `${appUrl}/?r=${encodeURIComponent(report.id)}`;
      const unsubUrl = `${appUrl}/api/unsubscribe?token=${encodeURIComponent(sub.unsubscribe_token)}`;

      const summary = report.activity_text
        ? String(report.activity_text).slice(0, 240)
        : `A ${report.category || 'report'} was reported ${dist.toFixed(1)} miles from your ZIP ${sub.zip}.`;

      try {
        await enqueueEmail(env, {
          to: sub.email,
          category: 'alert',
          template: 'alert_new_report',
          data: {
            city: report.city,
            state: report.state,
            summary,
            report_url: reportUrl,
            unsubscribe_url: unsubUrl
          }
        });
      } catch (err) {
        console.error(`alerts: enqueue failed for sub=${sub.id}:`, err.message);
        // Mark delivery row as failed-to-queue so we can retry later.
        try {
          await env.DB.prepare(
            `UPDATE alert_deliveries SET status='failed', error=? WHERE id = ?`
          ).bind(err.message?.slice(0, 500) || 'enqueue error', deliveryId).run();
        } catch {}
        continue;
      }

      try {
        await env.DB.prepare(
          `UPDATE subscribers SET last_alert_sent_at = ? WHERE id = ?`
        ).bind(now, sub.id).run();
      } catch {}

      delivered++;
    }

    // Bump the global all_time_alerts_sent total.
    try {
      await env.DB.prepare(
        `UPDATE analytics_totals
         SET value = value + ?, updated_at = ?
         WHERE key = 'all_time_alerts_sent'`
      ).bind(delivered, now).run();
    } catch {}
  }

  // Advance cutoff past the newest report we processed (or to `now` if empty).
  await env.CACHE.put(CUTOFF_KEY, String(maxUpdatedAt));

  console.log(`alerts: scanned=${reports.length} delivered=${delivered} skipped=${skipped}`);
  return { reports: reports.length, delivered, skipped };
}
