// src/jobs/cleanup.js
/**
 * jobs/cleanup.js — scheduled data retention + eviction.
 *
 * Two entry points, both called from the cron dispatcher in src/index.js:
 *
 *   cleanupFrequent(env) — 30 * * * * (every 30 min at :30)
 *     - expired OTPs
 *     - rate_limits rows older than 7 days
 *     - trend_snapshots / public_exports_cache with expires_at in the past
 *
 *   cleanupNightly(env) — 0 3 * * * (3am UTC daily)
 *     - analytics_events older than 30 days (privacy retention)
 *     - report ip_hash values older than 7 days (null them out)
 *     - api_key_usage older than 90 days (audit retention)
 *     - orphaned digest_cache entries older than 90 days
 *
 * All cutoffs are computed here rather than baked into the schema so the
 * retention window can be tuned without a migration.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const S_PER_DAY = 24 * 60 * 60;

// ────────────────────────────────────────────────────────────────────────────
// Frequent cleanup (runs every 30 minutes)
// ────────────────────────────────────────────────────────────────────────────

export async function cleanupFrequent(env) {
  if (!env.DB) {
    console.error('cleanupFrequent: DB binding missing');
    return { otps: 0, rateLimits: 0, trendSnapshots: 0, publicExports: 0 };
  }

  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  const rateLimitCutoffSec = nowSec - 7 * S_PER_DAY;

  const results = { otps: 0, rateLimits: 0, trendSnapshots: 0, publicExports: 0 };

  // Expired OTPs (2FA codes). expires_at is stored in ms.
  try {
    const r = await env.DB.prepare(
      `DELETE FROM volunteer_otps WHERE expires_at < ?`
    ).bind(now).run();
    results.otps = r.meta?.changes || 0;
  } catch (err) {
    console.error('cleanupFrequent otps:', err.message);
  }

  // Rate-limit rows older than 7 days. window_start is in seconds.
  try {
    const r = await env.DB.prepare(
      `DELETE FROM rate_limits WHERE window_start < ?`
    ).bind(rateLimitCutoffSec).run();
    results.rateLimits = r.meta?.changes || 0;
  } catch (err) {
    console.error('cleanupFrequent rate_limits:', err.message);
  }

  // Expired trend snapshots (Phase 1o data — safe to prune continuously).
  try {
    const r = await env.DB.prepare(
      `DELETE FROM trend_snapshots WHERE expires_at < ?`
    ).bind(now).run();
    results.trendSnapshots = r.meta?.changes || 0;
  } catch (err) {
    console.error('cleanupFrequent trend_snapshots:', err.message);
  }

  // Expired public-export cache rows.
  try {
    const r = await env.DB.prepare(
      `DELETE FROM public_exports_cache WHERE expires_at < ?`
    ).bind(now).run();
    results.publicExports = r.meta?.changes || 0;
  } catch (err) {
    console.error('cleanupFrequent public_exports_cache:', err.message);
  }

  console.log('cleanupFrequent:', results);
  return results;
}

// ────────────────────────────────────────────────────────────────────────────
// Nightly cleanup (runs at 03:00 UTC)
// ────────────────────────────────────────────────────────────────────────────

export async function cleanupNightly(env) {
  if (!env.DB) {
    console.error('cleanupNightly: DB binding missing');
    return { events: 0, ipHashesNulled: 0, apiUsage: 0, digests: 0, sessions: 0 };
  }

  const now = Date.now();
  const eventCutoff = now - 30 * MS_PER_DAY;
  const ipHashCutoff = now - 7 * MS_PER_DAY;
  const apiUsageCutoff = now - 90 * MS_PER_DAY;
  const digestCutoff = now - 90 * MS_PER_DAY;
  const sessionCutoff = now - 30 * MS_PER_DAY;

  const results = {
    events: 0,
    ipHashesNulled: 0,
    apiUsage: 0,
    digests: 0,
    sessions: 0
  };

  // Raw analytics events: 30-day retention per privacy policy.
  // Daily rollups live in other tables and are kept separately.
  try {
    const r = await env.DB.prepare(
      `DELETE FROM analytics_events WHERE created_at < ?`
    ).bind(eventCutoff).run();
    results.events = r.meta?.changes || 0;
  } catch (err) {
    console.error('cleanupNightly events:', err.message);
  }

  // Drop session rows older than 30 days as well; they're aggregated
  // into analytics_retention_daily and analytics_cohorts_weekly before
  // this point so no data is lost from dashboards.
  try {
    const r = await env.DB.prepare(
      `DELETE FROM analytics_sessions WHERE last_seen < ?`
    ).bind(sessionCutoff).run();
    results.sessions = r.meta?.changes || 0;
  } catch (err) {
    console.error('cleanupNightly sessions:', err.message);
  }

  // Hashed IPs on reports: 7-day retention — null them out rather than
  // delete the report rows, which stay around for analytics/digest.
  try {
    const r = await env.DB.prepare(
      `UPDATE reports SET ip_hash = NULL
         WHERE ip_hash IS NOT NULL AND created_at < ?`
    ).bind(ipHashCutoff).run();
    results.ipHashesNulled = r.meta?.changes || 0;
  } catch (err) {
    console.error('cleanupNightly ip_hashes:', err.message);
  }

  // API key usage logs: 90-day audit retention.
  try {
    const r = await env.DB.prepare(
      `DELETE FROM api_key_usage WHERE created_at < ?`
    ).bind(apiUsageCutoff).run();
    results.apiUsage = r.meta?.changes || 0;
  } catch (err) {
    console.error('cleanupNightly api_key_usage:', err.message);
  }

  // Stale digest cache entries.
  try {
    const r = await env.DB.prepare(
      `DELETE FROM digest_cache WHERE generated_at < ?`
    ).bind(digestCutoff).run();
    results.digests = r.meta?.changes || 0;
  } catch (err) {
    console.error('cleanupNightly digest_cache:', err.message);
  }

  console.log('cleanupNightly:', results);
  return results;
}
