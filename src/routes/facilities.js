/**
 * routes/facilities.js — nearest detention facility lookup.
 *
 * GET /api/facilities/nearest?lat=<lat>&lon=<lon>&limit=<n>
 *
 * Returns the N closest facilities to the given point, with distance in
 * miles. Uses a bounding-box pre-filter to keep D1 reads low, then
 * computes haversine distance in JS.
 *
 * Cached in KV for 1 hour per (lat, lon, limit) triple.
 */

import { json, errors } from '../lib/response.js';
import { facilitiesInBox, allFacilitiesWithCoords } from '../lib/db.js';
import { nearestN, boundingBox } from '../lib/haversine.js';
import { getJson, setJson, cacheKey, TTL } from '../lib/kv.js';
import { checkRateLimit } from '../lib/rate-limit.js';

const DEFAULT_RADIUS_MI = 500; // initial search radius for bounding box

export async function handleNearestFacility(request, env) {
  const rl = await checkRateLimit(env, request, 'nearest');
  if (!rl.ok) return errors.rateLimited(rl.retryAfter);

  const url = new URL(request.url);
  const lat = parseFloat(url.searchParams.get('lat'));
  const lon = parseFloat(url.searchParams.get('lon'));
  const limit = Math.min(10, Math.max(1, parseInt(url.searchParams.get('limit') || '3', 10)));

  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    return errors.badRequest('lat must be a number between -90 and 90');
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    return errors.badRequest('lon must be a number between -180 and 180');
  }

  // Cache key rounded to ~1km to maximize hit rate
  const roundedLat = lat.toFixed(2);
  const roundedLon = lon.toFixed(2);
  const key = await cacheKey('cache:facility-near', { lat: roundedLat, lon: roundedLon, limit });

  const cached = await getJson(env.CACHE, key);
  if (cached) return json({ facilities: cached, cached: true });

  // Try an expanding bounding box search. If the initial box finds too few,
  // fall back to the full table scan (only 203 rows so it's cheap).
  let candidates = await facilitiesInBox(
    env,
    ...Object.values(boundingBox(lat, lon, DEFAULT_RADIUS_MI)).flatMap(v => [v])
  );

  // Actually we want to pass the args in order, not flatten values. Fix:
  const box = boundingBox(lat, lon, DEFAULT_RADIUS_MI);
  candidates = await facilitiesInBox(env, box.minLat, box.maxLat, box.minLon, box.maxLon);

  if (candidates.length < limit) {
    // Fall back to a full-table scan — only ~203 rows with coords, no problem.
    candidates = await allFacilitiesWithCoords(env);
  }

  const nearest = nearestN(candidates, lat, lon, limit).map(f => ({
    id: f.id,
    name: f.name,
    address: f.address,
    city: f.city,
    state: f.state,
    zip: f.zip,
    lat: f.lat,
    lon: f.lon,
    facility_type: f.facility_type,
    operator: f.operator,
    distance_mi: Math.round(f.distance_mi * 10) / 10
  }));

  await setJson(env.CACHE, key, nearest, TTL.FACILITY_NEAREST);

  return json({ facilities: nearest, cached: false });
}
