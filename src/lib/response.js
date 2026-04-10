/**
 * lib/response.js — standard JSON and error responses.
 *
 * All Worker routes return through these helpers so every response has
 * consistent CORS, content-type, and error shape.
 */

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff'
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-OurAlert-Session',
  'Access-Control-Max-Age': '86400'
};

/**
 * Build a JSON response with optional status and extra headers.
 */
export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...CORS_HEADERS, ...extraHeaders }
  });
}

/**
 * Standard error response.
 * @param {string} code  — machine-readable error code (e.g. "rate_limited")
 * @param {string} message — human-readable message
 * @param {number} status — HTTP status code
 * @param {object} extra — optional extra fields merged into body
 */
export function error(code, message, status = 400, extra = {}) {
  return json({ error: code, message, ...extra }, status);
}

/**
 * Shortcut helpers for common error states.
 */
export const errors = {
  badRequest: (msg = 'Bad request', extra) => error('bad_request', msg, 400, extra),
  unauthorized: (msg = 'Unauthorized') => error('unauthorized', msg, 401),
  forbidden: (msg = 'Forbidden') => error('forbidden', msg, 403),
  notFound: (msg = 'Not found') => error('not_found', msg, 404),
  methodNotAllowed: (msg = 'Method not allowed') => error('method_not_allowed', msg, 405),
  conflict: (msg = 'Conflict') => error('conflict', msg, 409),
  payloadTooLarge: (msg = 'Payload too large') => error('payload_too_large', msg, 413),
  unprocessable: (msg = 'Unprocessable entity', extra) => error('unprocessable', msg, 422, extra),
  rateLimited: (retryAfter = 60) => error('rate_limited', 'Too many requests', 429, { retry_after: retryAfter }),
  captchaFailed: () => error('captcha_failed', 'Captcha verification failed', 403),
  serverError: (msg = 'Internal server error') => error('server_error', msg, 500),
  notImplemented: (msg = 'Not implemented') => error('not_implemented', msg, 501)
};

/**
 * Handle CORS preflight.
 */
export function corsPreflight() {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS
  });
}

/**
 * Wrap a route handler with try/catch so an uncaught error becomes a 500
 * rather than a Worker crash.
 */
export function safe(handler) {
  return async (request, env, ctx) => {
    try {
      return await handler(request, env, ctx);
    } catch (err) {
      console.error('route error:', err.message, err.stack);
      return errors.serverError(
        env.ENVIRONMENT === 'production' ? 'Internal server error' : err.message
      );
    }
  };
}
