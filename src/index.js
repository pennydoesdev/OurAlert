// src/index.js
/**
 * src/index.js — OurALERT Worker entry point and router.
 *
 * Live phases: 1d (analytics batch), 1e (drain/rollup/cleanup crons),
 * 1f (volunteer auth + moderation), 1g (email queue drain),
 * 1h (subscriptions + alert fan-out), 1i (AlertIQ daily digest),
 * 1j (SPA frontend + public config/facilities/v1 endpoints).
 */

import { json, errors, corsPreflight, safe } from './lib/response.js';

// Route handlers
import { handleListReports, handleGetReport, handleCreateReport } from './routes/reports.js';
import {
  handleSimpleUpload,
  handleUploadInit,
  handleUploadPart,
  handleUploadComplete,
  handleUploadAbort
} from './routes/upload.js';
import { handleGeocode } from './routes/geocode.js';
import { handleNearestFacility } from './routes/facilities.js';
import { handleAnalyticsBatch } from './routes/analytics.js';
import {
  handleLogin,
  handleVerifyOtp,
  handleLogout,
  handleMe
} from './routes/volunteer.js';
import {
  handleApprove,
  handleReject,
  handlePin,
  handleHide,
  handleUnhide
} from './routes/admin.js';
import {
  handleSubscribe,
  handleVerifySubscribe,
  handleUnsubscribe
} from './routes/subscribe.js';

// Scheduled jobs
import { drainAnalyticsBuffer } from './jobs/drain.js';
import { cleanupFrequent, cleanupNightly } from './jobs/cleanup.js';
import { recomputeDailyRollups } from './jobs/rollups.js';
import { drainEmailQueue } from './jobs/email.js';
import { fanOutAlerts } from './jobs/alerts.js';
import { fanOutDigests } from './jobs/digest.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (method === 'OPTIONS') return corsPreflight();

    if (pathname === '/health' || pathname === '/api/health') {
      return json({
        status: 'ok',
        app: env.APP_NAME || 'OurALERT',
        version: env.APP_VERSION || '0.1.0',
        time: Date.now()
      });
    }

    if (pathname === '/sitemap.xml') return sitemapResponse(env);
    if (pathname === '/robots.txt') return robotsResponse(env);

    if (pathname.startsWith('/api/')) {
      return await routeApi(request, env, ctx, pathname, method);
    }

    if (env.ASSETS) {
      try {
        const assetResponse = await env.ASSETS.fetch(request);
        const headers = new Headers(assetResponse.headers);
        headers.set('X-Content-Type-Options', 'nosniff');
        headers.set('X-Frame-Options', 'DENY');
        headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
        headers.set('Permissions-Policy', 'geolocation=(self), camera=(self), microphone=()');
        headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
        headers.set(
          'Content-Security-Policy',
          [
            "default-src 'self'",
            "script-src 'self' https://unpkg.com https://challenges.cloudflare.com",
            "style-src 'self' 'unsafe-inline' https://unpkg.com",
            "img-src 'self' data: https://*.tile.openstreetmap.org https://*.r2.cloudflarestorage.com",
            "connect-src 'self' https://challenges.cloudflare.com",
            "frame-src https://challenges.cloudflare.com",
            "font-src 'self' data:",
            "base-uri 'self'",
            "form-action 'self'",
            "frame-ancestors 'none'"
          ].join('; ')
        );
        if (assetResponse.headers.get('content-type')?.includes('text/html')) {
          headers.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=3600');
        }
        return new Response(assetResponse.body, {
          status: assetResponse.status,
          statusText: assetResponse.statusText,
          headers
        });
      } catch (err) {
        console.error('asset fetch failed:', err.message);
      }
    }

    return new Response(
      `<!DOCTYPE html><html><head><title>OurALERT</title></head><body style="font-family:system-ui;padding:40px;max-width:600px;margin:auto;"><h1>OurALERT</h1><p>The Worker is running but no static assets are bound.</p></body></html>`,
      { status: 200, headers: { 'Content-Type': 'text/html' } }
    );
  },

  async scheduled(event, env, ctx) {
    const start = Date.now();
    const cron = event.cron;
    console.log(`cron fired: "${cron}" at ${new Date(start).toISOString()}`);

    try {
      switch (cron) {
        case '*/2 * * * *':
          ctx.waitUntil(drainAnalyticsBuffer(env));
          break;
        case '*/3 * * * *':
          ctx.waitUntil(fanOutAlerts(env));
          break;
        case '*/5 * * * *':
          ctx.waitUntil(drainEmailQueue(env));
          break;
        case '*/15 * * * *':
          ctx.waitUntil(recomputeDailyRollups(env));
          break;
        case '30 * * * *':
          ctx.waitUntil(cleanupFrequent(env));
          break;
        case '0 3 * * *':
          ctx.waitUntil(cleanupNightly(env));
          break;
        case '0 13 * * *':
          ctx.waitUntil(fanOutDigests(env));
          break;
        case '0 * * * *':
          console.log('cron: hourly rollups — deferred');
          break;
        case '0 0 * * SUN':
          console.log('cron: weekly cohorts — deferred');
          break;
        default:
          console.log(`cron: unrecognized expression "${cron}"`);
      }
    } catch (err) {
      console.error(`cron "${cron}" failed:`, err.message, err.stack);
    }

    console.log(`cron dispatched "${cron}" in ${Date.now() - start}ms`);
  }
};

// ────────────────────────────────────────────────────────────────────────────
// API router
// ────────────────────────────────────────────────────────────────────────────

async function routeApi(request, env, ctx, pathname, method) {
  // Public config — site key + feature flags for the SPA
  if (pathname === '/api/config') {
    if (method !== 'GET') return errors.methodNotAllowed();
    return json({
      app_name: env.APP_NAME || 'OurALERT',
      app_version: env.APP_VERSION || '0.1.0',
      turnstile_site_key: env.TURNSTILE_SITE_KEY || null,
      onesignal_app_id: env.ONESIGNAL_APP_ID || null,
      features: {
        push: Boolean(env.ONESIGNAL_APP_ID),
        alertiq: Boolean(env.FEATHERLESS_API_KEY),
        email: Boolean(env.SES_ACCESS_KEY_ID || env.LOOPS_API_KEY)
      }
    });
  }

  // Public facilities list (used by the map)
  if (pathname === '/api/facilities') {
    if (method !== 'GET') return errors.methodNotAllowed();
    return await safe(handleFacilitiesList)(request, env, ctx);
  }

  // Public v1 API — stable JSON feeds for third parties
  if (pathname === '/api/v1/reports.json') {
    if (method !== 'GET') return errors.methodNotAllowed();
    return await safe(handlePublicReportsJson)(request, env, ctx);
  }
  if (pathname === '/api/v1/reports.geojson') {
    if (method !== 'GET') return errors.methodNotAllowed();
    return await safe(handlePublicReportsGeoJson)(request, env, ctx);
  }

  if (pathname === '/api/reports') {
    if (method === 'GET') return await safe(handleListReports)(request, env, ctx);
    if (method === 'POST') return await safe(handleCreateReport)(request, env, ctx);
    return errors.methodNotAllowed();
  }
  const reportMatch = pathname.match(/^\/api\/reports\/([a-zA-Z0-9_-]{1,64})$/);
  if (reportMatch) {
    if (method === 'GET') return await safe(handleGetReport)(request, env, reportMatch[1]);
    return errors.methodNotAllowed();
  }

  if (pathname === '/api/geocode') {
    if (method === 'GET') return await safe(handleGeocode)(request, env, ctx);
    return errors.methodNotAllowed();
  }

  if (pathname === '/api/facilities/nearest') {
    if (method === 'GET') return await safe(handleNearestFacility)(request, env, ctx);
    return errors.methodNotAllowed();
  }

  // Frontend sugar: POST /api/upload/sign → delegate to existing simple upload
  if (pathname === '/api/upload/sign') {
    if (method === 'POST') return await safe(handleSimpleUpload)(request, env, ctx);
    return errors.methodNotAllowed();
  }
  if (pathname === '/api/upload/simple' || pathname === '/api/upload') {
    if (method === 'POST') return await safe(handleSimpleUpload)(request, env, ctx);
    return errors.methodNotAllowed();
  }
  if (pathname === '/api/upload/init') {
    if (method === 'POST') return await safe(handleUploadInit)(request, env, ctx);
    return errors.methodNotAllowed();
  }
  if (pathname === '/api/upload/part') {
    if (method === 'POST') return await safe(handleUploadPart)(request, env, ctx);
    return errors.methodNotAllowed();
  }
  if (pathname === '/api/upload/complete') {
    if (method === 'POST') return await safe(handleUploadComplete)(request, env, ctx);
    return errors.methodNotAllowed();
  }
  if (pathname === '/api/upload/abort') {
    if (method === 'POST') return await safe(handleUploadAbort)(request, env, ctx);
    return errors.methodNotAllowed();
  }

  if (pathname === '/api/analytics/batch') {
    if (method === 'POST') return await safe(handleAnalyticsBatch)(request, env, ctx);
    return errors.methodNotAllowed();
  }
  if (pathname.startsWith('/api/analytics/')) {
    return errors.notImplemented('This analytics endpoint lands in a later phase');
  }

  // Phase 1f: volunteer auth
  if (pathname === '/api/vol/login') {
    if (method === 'POST') return await safe(handleLogin)(request, env, ctx);
    return errors.methodNotAllowed();
  }
  if (pathname === '/api/vol/verify-otp') {
    if (method === 'POST') return await safe(handleVerifyOtp)(request, env, ctx);
    return errors.methodNotAllowed();
  }
  if (pathname === '/api/vol/logout') {
    if (method === 'POST') return await safe(handleLogout)(request, env, ctx);
    return errors.methodNotAllowed();
  }
  if (pathname === '/api/vol/me') {
    if (method === 'GET') return await safe(handleMe)(request, env, ctx);
    return errors.methodNotAllowed();
  }
  if (pathname.startsWith('/api/vol/') || pathname.startsWith('/api/volunteer/')) {
    return errors.notFound('Unknown volunteer endpoint');
  }

  // Phase 1f: admin moderation
  const adminReportAction = pathname.match(
    /^\/api\/admin\/reports\/([a-zA-Z0-9_-]{1,64})\/(approve|reject|pin|hide|unhide)$/
  );
  if (adminReportAction) {
    if (method !== 'POST') return errors.methodNotAllowed();
    const [, reportId, action] = adminReportAction;
    switch (action) {
      case 'approve': return await safe((req, e) => handleApprove(req, e, reportId))(request, env, ctx);
      case 'reject':  return await safe((req, e) => handleReject(req, e, reportId))(request, env, ctx);
      case 'pin':     return await safe((req, e) => handlePin(req, e, reportId))(request, env, ctx);
      case 'hide':    return await safe((req, e) => handleHide(req, e, reportId))(request, env, ctx);
      case 'unhide':  return await safe((req, e) => handleUnhide(req, e, reportId))(request, env, ctx);
    }
  }
  if (pathname.startsWith('/api/admin/')) {
    return errors.notImplemented('This admin endpoint lands in a later phase');
  }

  // Phase 1h: subscriptions
  if (pathname === '/api/subscribe') {
    if (method === 'POST') return await safe(handleSubscribe)(request, env, ctx);
    return errors.methodNotAllowed();
  }
  if (pathname === '/api/subscribe/verify') {
    if (method === 'GET') return await safe(handleVerifySubscribe)(request, env, ctx);
    return errors.methodNotAllowed();
  }
  if (pathname === '/api/unsubscribe') {
    if (method === 'GET' || method === 'POST') return await safe(handleUnsubscribe)(request, env, ctx);
    return errors.methodNotAllowed();
  }

  return errors.notFound('API endpoint not found');
}

// ────────────────────────────────────────────────────────────────────────────
// Inline handlers — small public endpoints added in Phase 1j
// ────────────────────────────────────────────────────────────────────────────

async function handleFacilitiesList(request, env) {
  const url = new URL(request.url);
  const state = (url.searchParams.get('state') || '').toUpperCase().slice(0, 2);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '500', 10) || 500, 1000);
  const where = state ? 'WHERE state = ?' : '';
  const binds = state ? [state, limit] : [limit];
  const sql = `SELECT id, name, agency, city, state, lat, lon FROM detention_facilities ${where} ORDER BY state, name LIMIT ?`;
  try {
    const res = await env.DB.prepare(sql).bind(...binds).all();
    return json({ facilities: res.results || [] }, {
      headers: { 'Cache-Control': 'public, max-age=3600, s-maxage=3600' }
    });
  } catch (err) {
    console.error('facilities list failed:', err.message);
    return json({ facilities: [] });
  }
}

async function handlePublicReportsJson(request, env) {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 500);
  const sql = `
    SELECT id, category, title, activity, city, state, lat, lon, created_at
    FROM reports
    WHERE moderation_state = 'approved' AND (hidden_from_public = 0 OR hidden_from_public IS NULL)
    ORDER BY created_at DESC
    LIMIT ?
  `;
  try {
    const res = await env.DB.prepare(sql).bind(limit).all();
    return json({
      generated_at: new Date().toISOString(),
      count: (res.results || []).length,
      reports: res.results || []
    }, { headers: { 'Cache-Control': 'public, max-age=60, s-maxage=60' } });
  } catch (err) {
    console.error('public reports failed:', err.message);
    return json({ generated_at: new Date().toISOString(), count: 0, reports: [] });
  }
}

async function handlePublicReportsGeoJson(request, env) {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '500', 10) || 500, 1000);
  const sql = `
    SELECT id, category, title, activity, city, state, lat, lon, created_at
    FROM reports
    WHERE moderation_state = 'approved' AND (hidden_from_public = 0 OR hidden_from_public IS NULL)
      AND lat IS NOT NULL AND lon IS NOT NULL
    ORDER BY created_at DESC
    LIMIT ?
  `;
  try {
    const res = await env.DB.prepare(sql).bind(limit).all();
    const features = (res.results || []).map(r => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
      properties: {
        id: r.id, category: r.category, title: r.title,
        city: r.city, state: r.state, created_at: r.created_at
      }
    }));
    return json({ type: 'FeatureCollection', features }, {
      headers: { 'Cache-Control': 'public, max-age=60, s-maxage=60' }
    });
  } catch (err) {
    console.error('public geojson failed:', err.message);
    return json({ type: 'FeatureCollection', features: [] });
  }
}

function sitemapResponse(env) {
  const base = env.APP_URL || 'https://ouralert.org';
  const pages = ['/', '/reports', '/report', '/subscribe', '/about', '/privacy', '/terms', '/security'];
  const lastmod = new Date().toISOString().slice(0, 10);
  const urls = pages.map(p =>
    `<url><loc>${base}${p}</loc><lastmod>${lastmod}</lastmod><changefreq>${p === '/' || p === '/reports' ? 'hourly' : 'weekly'}</changefreq></url>`
  ).join('');
  const body = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }
  });
}

function robotsResponse(env) {
  const base = env.APP_URL || 'https://ouralert.org';
  const body = `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /volunteer\nDisallow: /api/vol/\nDisallow: /api/admin/\n\nSitemap: ${base}/sitemap.xml\n`;
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }
  });
}
