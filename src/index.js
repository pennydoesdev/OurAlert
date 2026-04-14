// src/index.js
/**
 * src/index.js — OurALERT Worker entry point and router.
 *
 * Live phases: 1d (analytics batch), 1e (drain/rollup/cleanup crons),
 * 1f (volunteer auth + moderation), 1g (email queue drain),
 * 1h (subscriptions + alert fan-out).
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

        case '0 * * * *':
          console.log('cron: hourly rollups — deferred to Phase 1e-bis');
          break;
        case '0 0 * * 0':
          console.log('cron: weekly cohorts — deferred to Phase 1e-bis');
          break;
        case '0 13 * * *':
          console.log('cron: AlertIQ digest — deferred to Phase 1i');
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

  if (pathname === '/api/upload/simple') {
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

  // ── Phase 1f: volunteer auth ─────────────────────────────────────────
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

  // ── Phase 1f: admin moderation actions ───────────────────────────────
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

  // ── Phase 1h: subscriptions ──────────────────────────────────────────
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
