/**
 * lib/validation.js — input validation helpers.
 *
 * These are defensive checks for public-facing POST bodies. Each returns
 * either null (valid) or a string describing the first failure. Routes use
 * them like:
 *
 *   const err = validateReport(body);
 *   if (err) return errors.unprocessable(err);
 */

const REPORT_STATUSES = new Set(['critical', 'active', 'observed', 'other']);
const REPORT_CATEGORIES = new Set(['ice', 'military', 'local_le', 'other']);
const VEHICLE_COUNTS = new Set(['1', '2-4', '5+']);
const OFFICIAL_COUNTS = new Set(['1', '2-4', '5-7', '8+']);

export function isString(v, { min = 0, max = Infinity } = {}) {
  if (typeof v !== 'string') return false;
  if (v.length < min || v.length > max) return false;
  return true;
}

export function isLat(v) {
  return typeof v === 'number' && v >= -90 && v <= 90;
}

export function isLon(v) {
  return typeof v === 'number' && v >= -180 && v <= 180;
}

export function isZip(v) {
  return typeof v === 'string' && /^\d{5}(-\d{4})?$/.test(v);
}

export function isEmail(v) {
  return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254;
}

export function isIsoDate(v) {
  return typeof v === 'string' && !isNaN(Date.parse(v));
}

export function sanitizeString(v, max = 5000) {
  if (typeof v !== 'string') return null;
  // Strip control chars except tab/newline, collapse runs of whitespace
  return v
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, max);
}

/**
 * Validate a report submission body. Returns null on success, or an error
 * message string on first failure.
 */
export function validateReport(body) {
  if (!body || typeof body !== 'object') return 'Missing request body';

  if (!isLat(body.lat)) return 'lat must be a number between -90 and 90';
  if (!isLon(body.lon)) return 'lon must be a number between -180 and 180';
  if (!isString(body.address, { min: 3, max: 500 })) return 'address is required (3–500 chars)';

  if (body.status && !REPORT_STATUSES.has(body.status)) {
    return `status must be one of: ${[...REPORT_STATUSES].join(', ')}`;
  }
  if (body.category && !REPORT_CATEGORIES.has(body.category)) {
    return `category must be one of: ${[...REPORT_CATEGORIES].join(', ')}`;
  }
  if (body.vehicle_count && !VEHICLE_COUNTS.has(body.vehicle_count)) {
    return `vehicle_count must be one of: ${[...VEHICLE_COUNTS].join(', ')}`;
  }
  if (body.official_count && !OFFICIAL_COUNTS.has(body.official_count)) {
    return `official_count must be one of: ${[...OFFICIAL_COUNTS].join(', ')}`;
  }

  if (body.activity_text != null && !isString(body.activity_text, { max: 2000 })) {
    return 'activity_text must be a string up to 2000 chars';
  }
  if (body.uniform_description != null && !isString(body.uniform_description, { max: 1000 })) {
    return 'uniform_description must be a string up to 1000 chars';
  }

  if (body.agency_tags != null) {
    if (!Array.isArray(body.agency_tags)) return 'agency_tags must be an array';
    if (body.agency_tags.length > 10) return 'agency_tags: max 10 items';
    if (body.agency_tags.some(t => !isString(t, { max: 100 }))) return 'agency_tags items must be short strings';
  }
  if (body.activity_tags != null) {
    if (!Array.isArray(body.activity_tags)) return 'activity_tags must be an array';
    if (body.activity_tags.length > 10) return 'activity_tags: max 10 items';
    if (body.activity_tags.some(t => !isString(t, { max: 100 }))) return 'activity_tags items must be short strings';
  }

  // Arrestee name requires explicit consent checkbox
  if (body.arrestee_name != null) {
    if (!isString(body.arrestee_name, { min: 1, max: 200 })) {
      return 'arrestee_name must be a non-empty string up to 200 chars';
    }
    if (body.arrestee_consent !== true) {
      return 'arrestee_consent must be true when arrestee_name is provided';
    }
  }

  // Media keys must reference completed R2 uploads
  if (body.media != null) {
    if (!Array.isArray(body.media)) return 'media must be an array';
    if (body.media.length > 4) return 'media: max 4 items per report';
    for (const m of body.media) {
      if (!m || typeof m !== 'object') return 'media items must be objects';
      if (!isString(m.kind, { min: 1, max: 32 })) return 'media.kind is required';
      if (!isString(m.r2_key, { min: 1, max: 512 })) return 'media.r2_key is required';
      if (!isString(m.mime, { min: 1, max: 128 })) return 'media.mime is required';
    }
  }

  if (body.turnstile_token != null && !isString(body.turnstile_token, { min: 1, max: 4096 })) {
    return 'turnstile_token must be a string';
  }

  return null;
}

export const constants = {
  REPORT_STATUSES: [...REPORT_STATUSES],
  REPORT_CATEGORIES: [...REPORT_CATEGORIES],
  VEHICLE_COUNTS: [...VEHICLE_COUNTS],
  OFFICIAL_COUNTS: [...OFFICIAL_COUNTS]
};
