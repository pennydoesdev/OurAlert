/**
 * routes/reports.js — public reports API.
 *
 * GET  /api/reports?bbox=<minLat,minLon,maxLat,maxLon>   → list in box
 * GET  /api/reports?zip=<zip>&radius=<mi>                 → list near zip
 * GET  /api/reports?limit=<n>                             → recent approved
 * GET  /api/reports/:id                                   → single report
 * POST /api/reports                                       → submit new report
 *
 * All public GETs only return reports with moderation_state='approved'.
 * Pending reports are invisible outside the volunteer portal.
 */

import { json, errors } from '../lib/response.js';
import { query, queryOne, exec, getPublicReport, listReportsInBox, facilitiesInBox, allFacilitiesWithCoords, incrementTotal } from '../lib/db.js';
import { nearestN, boundingBox } from '../lib/haversine.js';
import { checkRateLimit } from '../lib/rate-limit.js';
import { verifyTurnstile } from '../lib/turnstile.js';
import { validateReport, sanitizeString } from '../lib/validation.js';
import { hashIp, getClientIp } from '../lib/hash.js';
import { prefixedId } from '../lib/nanoid.js';
import { getJson, setJson, cacheKey, TTL } from '../lib/kv.js';

// ────────────────────────────────────────────────────────────────────────────
// GET /api/reports
// ────────────────────────────────────────────────────────────────────────────

export async function handleListReports(request, env) {
  const url = new URL(request.url);
  const bbox = url.searchParams.get('bbox');
  const zip = url.searchParams.get('zip');
  const radius = parseInt(url.searchParams.get('radius') || '50', 10);
  const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') || '100', 10)));

  let box;
  if (bbox) {
    const parts = bbox.split(',').map(parseFloat);
    if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) {
      return errors.badRequest('bbox must be minLat,minLon,maxLat,maxLon');
    }
    const [minLat, minLon, maxLat, maxLon] = parts;
    if (minLat >= maxLat || minLon >= maxLon) return errors.badRequest('invalid bbox ordering');
    box = { minLat, maxLat, minLon, maxLon };
  } else if (zip) {
    const zipRow = await queryOne(env, `SELECT lat, lon FROM zip_cache WHERE zip = ?`, zip);
    if (!zipRow) return errors.badRequest('zip not in cache; call /api/geocode?zip= first');
    box = boundingBox(zipRow.lat, zipRow.lon, radius);
  } else {
    // No filter — return a reasonable default: continental US bbox
    box = { minLat: 24, maxLat: 50, minLon: -125, maxLon: -66 };
  }

  const key = await cacheKey('cache:reports:list', { ...box, limit });
  const cached = await getJson(env.CACHE, key);
  if (cached) return json({ reports: cached, cached: true });

  const rows = await listReportsInBox(env, box.minLat, box.maxLat, box.minLon, box.maxLon, limit);

  const reports = rows.map(r => ({
    id: r.id,
    status: r.status,
    confirmed: !!r.confirmed,
    category: r.category,
    lat: r.lat,
    lon: r.lon,
    address: r.address,
    zip: r.zip,
    city: r.city,
    state: r.state,
    activity_text: r.activity_text,
    vehicle_count: r.vehicle_count,
    official_count: r.official_count,
    agency_tags: parseJson(r.agency_tags),
    activity_tags: parseJson(r.activity_tags),
    arrestee_name: r.arrestee_name,
    possible_facility_id: r.possible_facility_id,
    possible_facility_distance_mi: r.possible_facility_distance_mi,
    time_occurred: r.time_occurred,
    time_submitted: r.time_submitted
  }));

  await setJson(env.CACHE, key, reports, TTL.REPORTS_LIST);
  return json({ reports, cached: false });
}

// ────────────────────────────────────────────────────────────────────────────
// GET /api/reports/:id
// ────────────────────────────────────────────────────────────────────────────

export async function handleGetReport(request, env, id) {
  if (!id || id.length > 64) return errors.badRequest('invalid id');
  const report = await getPublicReport(env, id);
  if (!report) return errors.notFound('Report not found or not yet approved');
  return json({ report });
}

// ────────────────────────────────────────────────────────────────────────────
// POST /api/reports
// ────────────────────────────────────────────────────────────────────────────

export async function handleCreateReport(request, env) {
  const rl = await checkRateLimit(env, request, 'report');
  if (!rl.ok) return errors.rateLimited(rl.retryAfter);

  let body;
  try { body = await request.json(); }
  catch { return errors.badRequest('Invalid JSON body'); }

  // Verify Turnstile token
  const tsResult = await verifyTurnstile(env, body.turnstile_token, request);
  if (!tsResult.ok) return errors.captchaFailed();

  // Validate input
  const validationError = validateReport(body);
  if (validationError) return errors.unprocessable(validationError);

  // Look up nearest facility for the "Possible Facility" label
  const box = boundingBox(body.lat, body.lon, 500);
  let candidates = await facilitiesInBox(env, box.minLat, box.maxLat, box.minLon, box.maxLon);
  if (candidates.length === 0) {
    candidates = await allFacilitiesWithCoords(env);
  }
  const [nearest] = nearestN(candidates, body.lat, body.lon, 1);

  // Build the report row
  const id = prefixedId('rep', 14);
  const now = Date.now();
  const ip = getClientIp(request);
  const ipHash = await hashIp(ip, env.IP_SALT || 'dev-salt-change-me');

  const report = {
    id,
    status: body.status || 'observed',
    confirmed: 0,
    category: body.category || 'ice',
    lat: body.lat,
    lon: body.lon,
    address: sanitizeString(body.address, 500),
    zip: body.zip || null,
    city: body.city || null,
    state: body.state || null,
    activity_text: sanitizeString(body.activity_text, 2000),
    vehicle_count: body.vehicle_count || null,
    official_count: body.official_count || null,
    agency_tags: JSON.stringify(body.agency_tags || []),
    activity_tags: JSON.stringify(body.activity_tags || []),
    arrestee_name: body.arrestee_consent === true ? sanitizeString(body.arrestee_name, 200) : null,
    arrestee_consent: body.arrestee_consent === true ? 1 : 0,
    uniform_description: sanitizeString(body.uniform_description, 1000),
    possible_facility_id: nearest?.id || null,
    possible_facility_distance_mi: nearest?.distance_mi ? Math.round(nearest.distance_mi * 10) / 10 : null,
    time_occurred: body.time_occurred || now,
    time_submitted: now,
    ip_hash: ipHash,
    moderation_state: 'pending',
    created_at: now,
    updated_at: now
  };

  // Insert the report + any media rows in a single batch
  const statements = [
    {
      sql: `INSERT INTO reports (
        id, status, confirmed, category, lat, lon, address, zip, city, state,
        activity_text, vehicle_count, official_count, agency_tags, activity_tags,
        arrestee_name, arrestee_consent, uniform_description,
        possible_facility_id, possible_facility_distance_mi,
        time_occurred, time_submitted, ip_hash, moderation_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        report.id, report.status, report.confirmed, report.category, report.lat, report.lon,
        report.address, report.zip, report.city, report.state,
        report.activity_text, report.vehicle_count, report.official_count,
        report.agency_tags, report.activity_tags,
        report.arrestee_name, report.arrestee_consent, report.uniform_description,
        report.possible_facility_id, report.possible_facility_distance_mi,
        report.time_occurred, report.time_submitted, report.ip_hash, report.moderation_state,
        report.created_at, report.updated_at
      ]
    }
  ];

  if (Array.isArray(body.media)) {
    for (const m of body.media) {
      statements.push({
        sql: `INSERT INTO report_media (id, report_id, kind, r2_key, mime, size_bytes, exif_stripped, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          prefixedId('med', 12),
          id,
          m.kind,
          m.r2_key,
          m.mime,
          m.size_bytes || null,
          m.exif_stripped ? 1 : 0,
          now
        ]
      });
    }
  }

  const prepared = statements.map(s => env.DB.prepare(s.sql).bind(...s.params));
  await env.DB.batch(prepared);

  // Bump all-time counter
  await incrementTotal(env, 'all_time_reports', 1);

  return json({
    id,
    moderation_state: 'pending',
    message: 'Report submitted. A moderator will review it shortly.',
    possible_facility: nearest ? {
      id: nearest.id,
      name: nearest.name,
      distance_mi: Math.round(nearest.distance_mi * 10) / 10
    } : null
  }, 201);
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function parseJson(s) {
  if (!s) return [];
  try { return JSON.parse(s); } catch { return []; }
}
