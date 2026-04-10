/**
 * routes/geocode.js — address and zip geocoding via Nominatim.
 *
 * GET /api/geocode?q=<address>           — freeform geocoding
 * GET /api/geocode?zip=<zip>             — zip code lookup
 *
 * Cached in D1 (zip_cache) for zips and in KV for freeform queries
 * (30 days). We respect Nominatim's 1-req/sec policy with a per-instance
 * rate limit AND the user-agent requirement.
 */

import { json, errors } from '../lib/response.js';
import { queryOne, exec } from '../lib/db.js';
import { getJson, setJson, cacheKey, TTL } from '../lib/kv.js';
import { checkRateLimit } from '../lib/rate-limit.js';
import { isZip } from '../lib/validation.js';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'OurALERT/0.1 (https://ouralert.org; hello@ouralert.org)';

export async function handleGeocode(request, env) {
  const rl = await checkRateLimit(env, request, 'geocode');
  if (!rl.ok) return errors.rateLimited(rl.retryAfter);

  const url = new URL(request.url);
  const zip = url.searchParams.get('zip');
  const q = url.searchParams.get('q');

  if (zip) return await geocodeZip(env, zip);
  if (q) return await geocodeQuery(env, q);

  return errors.badRequest('Provide either ?zip=<zip> or ?q=<address>');
}

async function geocodeZip(env, rawZip) {
  const zip = rawZip.trim();
  if (!isZip(zip)) return errors.badRequest('Invalid zip code format');

  // Cache hit from D1
  const cached = await queryOne(
    env,
    `SELECT zip, lat, lon, city, state FROM zip_cache WHERE zip = ?`,
    zip
  );
  if (cached) {
    return json({ zip: cached.zip, lat: cached.lat, lon: cached.lon, city: cached.city, state: cached.state, cached: true });
  }

  // Look up from Nominatim with postalcode-focused query
  const params = new URLSearchParams({
    postalcode: zip,
    country: 'United States',
    format: 'json',
    limit: '1',
    addressdetails: '1'
  });

  const result = await fetchNominatim(params);
  if (!result) return errors.notFound('Zip code not found');

  const city = result.address?.city || result.address?.town || result.address?.village || result.address?.county || null;
  const state = result.address?.state || null;

  // Cache to D1
  await exec(
    env,
    `INSERT OR REPLACE INTO zip_cache (zip, lat, lon, city, state, cached_at) VALUES (?, ?, ?, ?, ?, ?)`,
    zip, parseFloat(result.lat), parseFloat(result.lon), city, state, Date.now()
  );

  return json({
    zip,
    lat: parseFloat(result.lat),
    lon: parseFloat(result.lon),
    city,
    state,
    cached: false
  });
}

async function geocodeQuery(env, rawQuery) {
  const q = rawQuery.trim().slice(0, 500);
  if (q.length < 3) return errors.badRequest('Query too short (min 3 chars)');

  // KV cache
  const key = await cacheKey('cache:geocode', { q: q.toLowerCase() });
  const cached = await getJson(env.CACHE, key);
  if (cached) return json({ ...cached, cached: true });

  const params = new URLSearchParams({
    q,
    format: 'json',
    limit: '1',
    countrycodes: 'us',
    addressdetails: '1'
  });

  const result = await fetchNominatim(params);
  if (!result) return errors.notFound('Address not found');

  const payload = {
    lat: parseFloat(result.lat),
    lon: parseFloat(result.lon),
    display_name: result.display_name,
    city: result.address?.city || result.address?.town || result.address?.village || null,
    state: result.address?.state || null,
    zip: result.address?.postcode || null,
    country: result.address?.country_code?.toUpperCase() || 'US'
  };

  await setJson(env.CACHE, key, payload, TTL.GEOCODE);
  return json({ ...payload, cached: false });
}

async function fetchNominatim(params) {
  const url = `${NOMINATIM_URL}?${params.toString()}`;
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
      cf: { cacheTtl: 3600, cacheEverything: true }
    });
  } catch (err) {
    console.error('Nominatim fetch failed:', err.message);
    return null;
  }
  if (!res.ok) return null;
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) return null;
  return data[0];
}
