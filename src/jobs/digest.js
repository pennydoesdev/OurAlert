// src/jobs/digest.js
/**
 * jobs/digest.js — AlertIQ daily digest fan-out (Phase 1i).
 *
 * Fired by the `0 13 * * *` cron (13:00 UTC = 9am ET baseline). The
 * subscriber.digest_hour_utc field lets individual subscribers opt into
 * other delivery hours, and this job will also run when their preferred
 * hour matches the cron tick.
 *
 * Flow:
 *   1. Select subscribers where verified=1, digest_enabled=1, and
 *      digest_hour_utc = currentUtcHour. (Currently we only tick at 13
 *      so only 13-hour subscribers fire; moving to an hourly cron for
 *      self-serve timezones is an easy future change.)
 *   2. Group by (zip, radius_mi) so we summarize once per group and
 *      hand the cached summary_html to every subscriber in the group.
 *   3. For each group:
 *        a. Check `digest_cache` for today's summary (keyed by zip,
 *           radius, day). If fresh, reuse.
 *        b. Otherwise: pull approved reports within the bounding box
 *           from the last 24 hours, precise-filter by haversine, and
 *           call Featherless summarizeReports().
 *        c. Insert the result into `digest_cache` so the next group
 *           with same (zip, radius) within 24h reuses it.
 *   4. For each subscriber in the group, enqueue a 'digest_daily'
 *      email (lib/email.js) and mark `last_digest_sent_at`.
 *
 * Dedupe: `last_digest_sent_at` — skip any subscriber who was emailed
 * a digest within the last 20 hours (handles cron retries safely).
 */

import { boundingBox, distanceMi } from '../lib/haversine.js';
import { enqueueEmail } from '../lib/email.js';
import { summarizeReports } from '../lib/featherless.js';
import { prefixedId } from '../lib/nanoid.js';

const DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEDUPE_WINDOW_MS = 20 * 60 * 60 * 1000;   // min gap between digests per subscriber
const MAX_SUBSCRIBERS_PER_RUN = 5000;
const MAX_REPORTS_PER_GROUP = 100;

export async function fanOutDigests(env) {
  if (!env.DB) {
    console.error('digest: no DB binding');
    return { groups: 0, subscribers: 0, sent: 0, skipped: 0 };
  }

  const now = Date.now();
  const utcHour = new Date(now).getUTCHours();
  const today = new Date(now).toISOString().slice(0, 10); // YYYY-MM-DD

  // 1. Pull eligible subscribers.
  const { results: subs } = await env.DB.prepare(
    `SELECT id, email, zip, radius_mi, lat, lon, digest_hour_utc,
            last_digest_sent_at, unsubscribe_token
     FROM subscribers
     WHERE verified = 1
       AND digest_enabled = 1
       AND lat IS NOT NULL AND lon IS NOT NULL
       AND digest_hour_utc = ?
     LIMIT ?`
  ).bind(utcHour, MAX_SUBSCRIBERS_PER_RUN).all();

  if (!subs || subs.length === 0) {
    return { groups: 0, subscribers: 0, sent: 0, skipped: 0 };
  }

  // 2. Group subscribers by (zip, radius_mi) so we summarize once per group.
  const groups = new Map();
  for (const s of subs) {
    const key = `${s.zip}|${s.radius_mi}`;
    if (!groups.has(key)) groups.set(key, { zip: s.zip, radius: s.radius_mi, lat: s.lat, lon: s.lon, subs: [] });
    groups.get(key).subs.push(s);
  }

  let sent = 0;
  let skipped = 0;

  for (const group of groups.values()) {
    // 3a. Check cache.
    let cached = await env.DB.prepare(
      `SELECT id, report_count, summary_html, summary_text, featherless_model
       FROM digest_cache
       WHERE zip = ? AND radius_mi = ? AND day = ?
       LIMIT 1`
    ).bind(group.zip, group.radius, today).first();

    let reportCount, summaryHtml, summaryText;

    if (cached) {
      reportCount = cached.report_count;
      summaryHtml = cached.summary_html;
      summaryText = cached.summary_text;
    } else {
      // 3b. Build the summary.
      const bbox = boundingBox(group.lat, group.lon, group.radius);
      const cutoff = now - DIGEST_WINDOW_MS;
      const { results: reports } = await env.DB.prepare(
        `SELECT id, category, status, city, state, activity_text,
                vehicle_count, official_count, lat, lon, time_occurred
         FROM reports
         WHERE moderation_state = 'approved'
           AND (hidden_from_public IS NULL OR hidden_from_public = 0)
           AND lat BETWEEN ? AND ?
           AND lon BETWEEN ? AND ?
           AND created_at >= ?
         ORDER BY created_at DESC
         LIMIT ?`
      ).bind(bbox.minLat, bbox.maxLat, bbox.minLon, bbox.maxLon, cutoff, MAX_REPORTS_PER_GROUP).all();

      const filtered = (reports || []).filter((r) =>
        distanceMi(group.lat, group.lon, r.lat, r.lon) <= group.radius
      );

      const scopeLabel = `ZIP ${group.zip} (${group.radius}-mi radius)`;
      const summary = await summarizeReports(env, filtered, {
        scopeLabel,
        windowLabel: 'the last 24 hours'
      });

      reportCount = filtered.length;
      summaryHtml = summary.html;
      summaryText = summary.text;

      // 3c. Cache it.
      try {
        await env.DB.prepare(
          `INSERT INTO digest_cache
             (id, zip, radius_mi, day, report_count,
              summary_html, summary_text, featherless_model, generated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          prefixedId('dg', 14), group.zip, group.radius, today,
          reportCount, summaryHtml, summaryText, summary.model || 'unknown', now
        ).run();
      } catch (err) {
        console.error('digest: cache insert failed:', err.message);
      }
    }

    // 4. Enqueue a digest email per subscriber in the group.
    for (const sub of group.subs) {
      if (sub.last_digest_sent_at && (now - sub.last_digest_sent_at) < DEDUPE_WINDOW_MS) {
        skipped++;
        continue;
      }

      const appUrl = env.APP_URL || 'https://ouralert.org';
      const mapUrl = `${appUrl}/?zip=${encodeURIComponent(sub.zip)}`;
      const unsubUrl = `${appUrl}/api/unsubscribe?token=${encodeURIComponent(sub.unsubscribe_token)}`;

      try {
        await enqueueEmail(env, {
          to: sub.email,
          category: 'digest',
          template: 'digest_daily',
          data: {
            scope_label: `ZIP ${sub.zip}`,
            day: today,
            count: reportCount,
            summary_html: summaryHtml,
            map_url: mapUrl,
            unsubscribe_url: unsubUrl
          }
        });
      } catch (err) {
        console.error(`digest: enqueue failed for sub=${sub.id}:`, err.message);
        skipped++;
        continue;
      }

      try {
        await env.DB.prepare(
          `UPDATE subscribers SET last_digest_sent_at = ? WHERE id = ?`
        ).bind(now, sub.id).run();
      } catch {}

      sent++;
    }
  }

  try {
    await env.DB.prepare(
      `UPDATE analytics_totals
       SET value = value + ?, updated_at = ?
       WHERE key = 'all_time_digests_sent'`
    ).bind(sent, now).run();
  } catch {}

  console.log(`digest: groups=${groups.size} sent=${sent} skipped=${skipped}`);
  return { groups: groups.size, subscribers: subs.length, sent, skipped };
}
