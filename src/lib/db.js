/**
 * lib/db.js — D1 helpers.
 *
 * Thin conveniences over env.DB.prepare(). Nothing magical — just
 * reduces boilerplate and centralizes common queries.
 */

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
 * @param {Array<{sql: string, params: Array}>} statements
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
 * Fetch a report by id with its media and possible_facility (if any).
 * Returns null if not found or not approved (public view).
 */
export async function getPublicReport(env, id) {
  const report = await queryOne(
    env,
    `SELECT r.*, f.name as facility_name, f.city as facility_city, f.state as facility_state
     FROM reports r
     LEFT JOIN detention_facilities f ON r.possible_facility_id = f.id
     WHERE r.id = ? AND r.moderation_state = 'approved'`,
    id
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
 * List approved reports within a bounding box, ordered newest first.
 * Limited to the most recent 500 within the box to keep payloads sane.
 */
export async function listReportsInBox(env, minLat, maxLat, minLon, maxLon, limit = 500) {
  return await query(
    env,
    `SELECT id, status, confirmed, category, lat, lon, address, zip, city, state,
            activity_text, vehicle_count, official_count, agency_tags, activity_tags,
            arrestee_name, possible_facility_id, possible_facility_distance_mi,
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
