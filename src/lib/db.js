/**
 * lib/db.js — D1 helpers.
 *
 * Thin conveniences over env.DB.prepare(). Nothing magical — just
 * reduces boilerplate and centralizes common queries.
 */

// Default public visibility window — reports disappear from public-facing
// endpoints this many milliseconds after creation unless pinned by an admin.
// Stays in D1 forever for analytics, digest, and key-gated API access.
export const PUBLIC_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Run a parameterized SELECT and return all rows.
 */
export async function query(env, sql, ...params) {
  const { results } = await env.DB.prepare(sql).bind(...params).all();
  return results || [];
}

/**
 * Run a parameterized SELECT and return the first row, or null.
 */
export async function queryOne(env, sql, ...params) {
  return await env.DB.prepare(sql).bind(...params).first();
}

/**
 * Run a parameterized INSERT/UPDATE/DELETE. Returns the D1 meta object.
 */
export async function exec(env, sql, ...params) {
  return await env.DB.prepare(sql).bind(...params).run();
}

/**
 * Run a batch of prepared statements atomically.
 */
export async function batch(env, statements) {
  const prepared = statements.map(s => env.DB.prepare(s.sql).bind(...(s.params || [])));
  return await env.DB.batch(prepared);
}

/**
 * Increment a counter in analytics_totals.
 */
export async function incrementTotal(env, key, by = 1) {
  await exec(
    env,
    `UPDATE analytics_totals SET value = value + ?, updated_at = ? WHERE key = ?`,
    by,
    Date.now(),
    key
  );
}

/**
 * SQL fragment that restricts a SELECT on the `reports` table to rows that
 * are currently visible to the public:
 *   - approved by moderators
 *   - not manually hidden by an admin
 *   - either within the 24h window OR explicitly pinned
 *
 * Returns { sql, params } to splice into a larger query.
 */
export function publicVisibilityClause() {
  const now = Date.now();
  const windowStart = now - PUBLIC_WINDOW_MS;
  return {
    sql: `moderation_state = 'approved'
          AND hidden_from_public = 0
          AND (created_at >= ? OR (pinned_until IS NOT NULL AND pinned_until > ?))`,
    params: [windowStart, now]
  };
}

/**
 * Fetch a report by id — public view. Applies the 24h window and pin logic.
 * Returns null if the report is not currently public.
 */
export async function getPublicReport(env, id) {
  const vis = publicVisibilityClause();
  const report = await queryOne(
    env,
    `SELECT r.*, f.name as facility_name, f.city as facility_city, f.state as facility_state
     FROM reports r
     LEFT JOIN detention_facilities f ON r.possible_facility_id = f.id
     WHERE r.id = ? AND ${vis.sql.replace(/moderation_state/g, 'r.moderation_state')
                                  .replace(/hidden_from_public/g, 'r.hidden_from_public')
                                  .replace(/created_at/g, 'r.created_at')
                                  .replace(/pinned_until/g, 'r.pinned_until')}`,
    id, ...vis.params
  );
  if (!report) return null;

  const media = await query(
    env,
    `SELECT id, kind, r2_key, mime FROM report_media WHERE report_id = ? ORDER BY created_at`,
    id
  );

  // Parse JSON fields
  if (report.agency_tags) {
    try { report.agency_tags = JSON.parse(report.agency_tags); } catch { report.agency_tags = []; }
  } else {
    report.agency_tags = [];
  }
  if (report.activity_tags) {
    try { report.activity_tags = JSON.parse(report.activity_tags); } catch { report.activity_tags = []; }
  } else {
    report.activity_tags = [];
  }

  return { ...report, media };
}

/**
 * Fetch a report by id — full data, no window restrictions. For admin/
 * volunteer views and key-gated API access only. Never expose this result
 * via a public endpoint.
 */
export async function getFullReport(env, id) {
  const report = await queryOne(
    env,
    `SELECT r.*, f.name as facility_name, f.city as facility_city, f.state as facility_state
     FROM reports r
     LEFT JOIN detention_facilities f ON r.possible_facility_id = f.id
     WHERE r.id = ?`,
    id
  );
  if (!report) return null;

  const media = await query(
    env,
    `SELECT id, kind, r2_key, mime, size_bytes, exif_stripped FROM report_media
     WHERE report_id = ? ORDER BY created_at`,
    id
  );

  if (report.agency_tags) {
    try { report.agency_tags = JSON.parse(report.agency_tags); } catch { report.agency_tags = []; }
  } else {
    report.agency_tags = [];
  }
  if (report.activity_tags) {
    try { report.activity_tags = JSON.parse(report.activity_tags); } catch { report.activity_tags = []; }
  } else {
    report.activity_tags = [];
  }

  return { ...report, media };
}

/**
 * List approved reports within a bounding box, ordered newest first.
 * Applies the 24h public window and pin logic by default.
 * Pass { includeAll: true } for admin/volunteer/API-v1 views that need
 * the full history.
 */
export async function listReportsInBox(env, minLat, maxLat, minLon, maxLon, limit = 500, opts = {}) {
  const { includeAll = false } = opts;
  const now = Date.now();
  const windowStart = now - PUBLIC_WINDOW_MS;

  if (includeAll) {
    return await query(
      env,
      `SELECT id, status, confirmed, category, lat, lon, address, zip, city, state,
              activity_text, vehicle_count, official_count, agency_tags, activity_tags,
              arrestee_name, possible_facility_id, possible_facility_distance_mi,
              pinned_until, hidden_from_public,
              time_occurred, time_submitted, created_at
       FROM reports
       WHERE moderation_state = 'approved'
         AND lat BETWEEN ? AND ?
         AND lon BETWEEN ? AND ?
       ORDER BY created_at DESC
       LIMIT ?`,
      minLat, maxLat, minLon, maxLon, limit
    );
  }

  return await query(
    env,
    `SELECT id, status, confirmed, category, lat, lon, address, zip, city, state,
            activity_text, vehicle_count, official_count, agency_tags, activity_tags,
            arrestee_name, possible_facility_id, possible_facility_distance_mi,
            pinned_until,
            time_occurred, time_submitted, created_at
     FROM reports
     WHERE moderation_state = 'approved'
       AND hidden_from_public = 0
       AND (created_at >= ? OR (pinned_until IS NOT NULL AND pinned_until > ?))
       AND lat BETWEEN ? AND ?
       AND lon BETWEEN ? AND ?
     ORDER BY created_at DESC
     LIMIT ?`,
    windowStart, now, minLat, maxLat, minLon, maxLon, limit
  );
}

/**
 * List all reports within a time range for analytics/digest purposes.
 * Ignores the public window — used by digests and trend computation where
 * we need the full last-24h regardless of pin state.
 */
export async function listReportsInTimeRange(env, minTime, maxTime, limit = 5000) {
  return await query(
    env,
    `SELECT id, status, confirmed, category, lat, lon, zip, city, state,
            activity_text, agency_tags, activity_tags, possible_facility_id,
            time_occurred, created_at
     FROM reports
     WHERE moderation_state = 'approved'
       AND created_at BETWEEN ? AND ?
     ORDER BY created_at DESC
     LIMIT ?`,
    minTime, maxTime, limit
  );
}

/**
 * Fetch candidate facilities in a bounding box for nearest-neighbor search.
 */
export async function facilitiesInBox(env, minLat, maxLat, minLon, maxLon) {
  return await query(
    env,
    `SELECT id, name, address, city, state, zip, lat, lon, facility_type, operator
     FROM detention_facilities
     WHERE lat IS NOT NULL
       AND lon IS NOT NULL
       AND lat BETWEEN ? AND ?
       AND lon BETWEEN ? AND ?`,
    minLat, maxLat, minLon, maxLon
  );
}

/**
 * All facilities with coordinates (fallback when bounding box is empty).
 */
export async function allFacilitiesWithCoords(env) {
  return await query(
    env,
    `SELECT id, name, address, city, state, zip, lat, lon, facility_type, operator
     FROM detention_facilities
     WHERE lat IS NOT NULL AND lon IS NOT NULL`
  );
}
