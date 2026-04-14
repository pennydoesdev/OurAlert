// src/jobs/rollups.js
/**
 * jobs/rollups.js — 15-minute daily-rollup recomputation (Phase 1e).
 *
 * Called every 15 min by the cron dispatcher. Strategy: instead of doing
 * incremental increments with a watermark, we DELETE-then-INSERT the last
 * two days' worth of rollup rows from analytics_events. This is idempotent,
 * handles late-arriving events, and keeps the code dead simple.
 *
 * The two-day window bounds the recompute cost: at 1M events/month
 * (≈33k/day) we re-aggregate ~66k rows every 15 min, which D1 handles
 * comfortably under a second.
 *
 * Rollup tables touched:
 *   - analytics_daily
 *   - analytics_paths_daily
 *   - analytics_referrers_daily
 *   - analytics_utm_daily
 *   - analytics_totals (point-count refresh)
 *
 * Not touched (handled by hourly / weekly jobs in Phase 1e-bis):
 *   - analytics_retention_daily (DAU/WAU/MAU)
 *   - analytics_funnel_results
 *   - analytics_cohorts_weekly
 *   - analytics_sessions.ended (session-end detection)
 */

export async function recomputeDailyRollups(env) {
  if (!env.DB) {
    console.error('rollups: DB binding missing');
    return { days: [], tables: {} };
  }

  const today = formatUtcDay(Date.now());
  const yesterday = formatUtcDay(Date.now() - 24 * 60 * 60 * 1000);
  const days = [today, yesterday];

  const tables = {
    analytics_daily: 0,
    analytics_paths_daily: 0,
    analytics_referrers_daily: 0,
    analytics_utm_daily: 0,
    analytics_totals: 0
  };

  // analytics_daily — breakdown by category/name/country/device.
  try {
    const r = await env.DB.batch([
      env.DB.prepare(`DELETE FROM analytics_daily WHERE day IN (?, ?)`)
        .bind(today, yesterday),
      env.DB.prepare(
        `INSERT INTO analytics_daily
           (day, event_category, event_name, country, device, count, unique_sessions)
         SELECT
           created_day,
           COALESCE(event_category, ''),
           event_name,
           'XX',
           COALESCE(device, 'unknown'),
           COUNT(*),
           COUNT(DISTINCT session_id)
         FROM analytics_events
         WHERE created_day IN (?, ?)
         GROUP BY created_day, COALESCE(event_category, ''), event_name, COALESCE(device, 'unknown')`
      ).bind(today, yesterday)
    ]);
    tables.analytics_daily = r[1]?.meta?.changes || 0;
  } catch (err) {
    console.error('rollups analytics_daily:', err.message);
  }

  // analytics_paths_daily — per-path views + bounces.
  try {
    const r = await env.DB.batch([
      env.DB.prepare(`DELETE FROM analytics_paths_daily WHERE day IN (?, ?)`)
        .bind(today, yesterday),
      env.DB.prepare(
        `INSERT INTO analytics_paths_daily
           (day, path, views, unique_sessions, avg_duration_seconds, bounces)
         SELECT
           e.created_day,
           COALESCE(e.path, '(unknown)'),
           COUNT(*),
           COUNT(DISTINCT e.session_id),
           0,
           COALESCE(SUM(CASE WHEN s.is_bounce = 1 THEN 1 ELSE 0 END), 0)
         FROM analytics_events e
         LEFT JOIN analytics_sessions s ON s.session_id = e.session_id
         WHERE e.created_day IN (?, ?) AND e.event_name = 'page_view'
         GROUP BY e.created_day, COALESCE(e.path, '(unknown)')`
      ).bind(today, yesterday)
    ]);
    tables.analytics_paths_daily = r[1]?.meta?.changes || 0;
  } catch (err) {
    console.error('rollups paths_daily:', err.message);
  }

  // analytics_referrers_daily — session counts per referrer domain.
  try {
    const r = await env.DB.batch([
      env.DB.prepare(`DELETE FROM analytics_referrers_daily WHERE day IN (?, ?)`)
        .bind(today, yesterday),
      env.DB.prepare(
        `INSERT INTO analytics_referrers_daily (day, referrer_domain, sessions)
         SELECT
           created_day,
           COALESCE(referrer_domain, '(direct)'),
           COUNT(DISTINCT session_id)
         FROM analytics_events
         WHERE created_day IN (?, ?)
         GROUP BY created_day, COALESCE(referrer_domain, '(direct)')`
      ).bind(today, yesterday)
    ]);
    tables.analytics_referrers_daily = r[1]?.meta?.changes || 0;
  } catch (err) {
    console.error('rollups referrers_daily:', err.message);
  }

  // analytics_utm_daily — attribution rollup.
  try {
    const r = await env.DB.batch([
      env.DB.prepare(`DELETE FROM analytics_utm_daily WHERE day IN (?, ?)`)
        .bind(today, yesterday),
      env.DB.prepare(
        `INSERT INTO analytics_utm_daily (day, source, medium, campaign, sessions)
         SELECT
           created_day,
           COALESCE(utm_source, '(none)'),
           COALESCE(utm_medium, '(none)'),
           COALESCE(utm_campaign, '(none)'),
           COUNT(DISTINCT session_id)
         FROM analytics_events
         WHERE created_day IN (?, ?)
         GROUP BY created_day,
                  COALESCE(utm_source, '(none)'),
                  COALESCE(utm_medium, '(none)'),
                  COALESCE(utm_campaign, '(none)')`
      ).bind(today, yesterday)
    ]);
    tables.analytics_utm_daily = r[1]?.meta?.changes || 0;
  } catch (err) {
    console.error('rollups utm_daily:', err.message);
  }

  // analytics_totals — monotonic counters. Refresh each one from source.
  try {
    const now = Date.now();
    const q = (sql, ...params) => env.DB.prepare(sql).bind(...params).first();

    const [views, reports, approved, subs, alerts, digests, pushes, apiCalls] =
      await Promise.all([
        q(`SELECT COUNT(*) AS c FROM analytics_events WHERE event_name = 'page_view'`),
        q(`SELECT COUNT(*) AS c FROM reports`),
        q(`SELECT COUNT(*) AS c FROM reports WHERE moderation_state = 'approved'`),
        q(`SELECT COUNT(*) AS c FROM subscribers WHERE verified = 1`),
        q(`SELECT COUNT(*) AS c FROM alert_deliveries WHERE transport IN ('email', 'push')`),
        q(`SELECT COUNT(*) AS c FROM email_queue WHERE category = 'digest' AND status = 'sent'`),
        q(`SELECT COUNT(*) AS c FROM alert_deliveries WHERE transport = 'push'`),
        q(`SELECT COUNT(*) AS c FROM api_key_usage`)
      ]);

    const upserts = [
      ['all_time_views', views?.c || 0],
      ['all_time_reports', reports?.c || 0],
      ['all_time_reports_approved', approved?.c || 0],
      ['all_time_subscribers', subs?.c || 0],
      ['all_time_alerts_sent', alerts?.c || 0],
      ['all_time_digests_sent', digests?.c || 0],
      ['all_time_push_sent', pushes?.c || 0],
      ['all_time_api_calls', apiCalls?.c || 0]
    ];

    const statements = upserts.map(([key, value]) =>
      env.DB.prepare(
        `UPDATE analytics_totals SET value = ?, updated_at = ? WHERE key = ?`
      ).bind(value, now, key)
    );
    await env.DB.batch(statements);
    tables.analytics_totals = upserts.length;
  } catch (err) {
    console.error('rollups analytics_totals:', err.message);
  }

  console.log('rollups: days=[', days.join(','), '] tables=', tables);
  return { days, tables };
}

function formatUtcDay(ms) {
  const d = new Date(ms);
  const pad = (n) => n.toString().padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
