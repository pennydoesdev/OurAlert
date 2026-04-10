/**
 * lib/haversine.js — great-circle distance calculations.
 *
 * Used for:
 * - Matching reports to nearest detention facility
 * - Matching alert subscribers to new reports by radius
 */

const EARTH_RADIUS_MI = 3958.8;
const EARTH_RADIUS_KM = 6371.0;

/**
 * Distance between two lat/lon points in miles (haversine formula).
 */
export function distanceMi(lat1, lon1, lat2, lon2) {
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_MI * c;
}

export function distanceKm(lat1, lon1, lat2, lon2) {
  return (distanceMi(lat1, lon1, lat2, lon2) * EARTH_RADIUS_KM) / EARTH_RADIUS_MI;
}

/**
 * Compute a bounding box around a center point for a given radius in miles.
 * Used to pre-filter D1 queries before running the full haversine in JS.
 *
 * Returns { minLat, maxLat, minLon, maxLon }.
 */
export function boundingBox(lat, lon, radiusMi) {
  // Approximate: 1° latitude ≈ 69 miles. 1° longitude ≈ 69 * cos(lat) miles.
  const latDelta = radiusMi / 69;
  const lonDelta = radiusMi / (69 * Math.cos((lat * Math.PI) / 180) || 0.001);
  return {
    minLat: lat - latDelta,
    maxLat: lat + latDelta,
    minLon: lon - lonDelta,
    maxLon: lon + lonDelta
  };
}

/**
 * Given a list of points with lat/lon, return the N closest to (lat, lon)
 * along with their computed distance in miles.
 */
export function nearestN(points, lat, lon, n = 3) {
  return points
    .filter(p => p.lat != null && p.lon != null)
    .map(p => ({ ...p, distance_mi: distanceMi(lat, lon, p.lat, p.lon) }))
    .sort((a, b) => a.distance_mi - b.distance_mi)
    .slice(0, n);
}
