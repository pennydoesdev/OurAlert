// src/index.js
/**
 * src/index.js — OurALERT Worker entry point and router.
 *
 * Handles:
 * - Static asset serving (via env.ASSETS binding)
 * - /api/* route dispatch
 * - CORS preflight
 * - Global safe() wrapper for uncaught errors
 * - Cron job dispatch (scheduled() handler below)
 *
 * Analytics ingestion (Phase 1d), cron jobs (Phase 1e), and volunteer
 * auth + moderation (Phase 1f) are live. Email send, subscriptions,
 * and SSO land in later phases; their endpoints 501 until then.
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

// Scheduled jobs (Phase 1e)
import { drainAnalyticsBuffer } from './jobs/drain.js';
import { cleanupFrequent, cleanupNightly } from './jobs/cleanup.js';
import { recomputeDailyRollups } from './jobs/rollups.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') return corsPreflight();

    // ── Health check ────────────────────────────────────────────────────
    if (pathname === '/health' || pathname === '/api/health') {
      return json({
        status: 'ok',
        app: env.APP_NAME || 'OurALERT',
        version: env.APP_VERSION || '0.1.0',
        time: Date.now()
      });
    }

    // ── API routes ──────────────────────────────────────────────────────
    if (pathname.startsWith('/api/')) {
      return await routeApi(request, env, ctx, pathname, method);
    }

    // ── Static assets (index.html, manifest.json, app.js, etc) ─────────
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

    // Fallback if no asset binding — serve a minimal placeholder
    return new Response(
      `<!DOCTYPE html><html><head><title>OurALERT</title></head><body style="font-family:system-ui;padding:40px;max-width:600px;margin:auto;"><h1>OurALERT</h1><p>The Worker is running but no static assets are bound.</p></body></html>`,
      { status: 200, headers: { 'Content-Type': 'text/html' } }
    );
  },

  /**
   * Cron dispatcher. Each cron trigger declared in wrangler.toml fires
   * here with `event.cron` set to the crontab string; we dispatch to
   * the matching job. Unknown or later-phase crons log and no-op.
   */
  async scheduled(event, env, ctx) {
    const start = Date.now();
    const cron = event.cron;
    console.log(`cron fired: "${cron}" at ${new Date(start).toISOString()}`);

    try {
      switch (cron) {
        case '*/2 * * * *':
          ctx.waitUntil(drainAnalyticsBuffer(env));
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

        // Deferred to later phases — log only.
        case '*/3 * * * *':
          console.log('cron: alert fan-out — deferred to Phase 1h');
          break;
        case '*/5 * * * *':
          console.log('cron: email queue drain — deferred to Phase 1g');
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
  // /api/reports
  if (pathname === '/api/reports') {
    if (method === 'GET') return await safe(handleListReports)(request, env, ctx);
    if (method === 'POST') return await safe(handleCreateReport)(request, env, ctx);
    return errors.methodNotAllowed();
  }
  // /api/reports/:id
  const reportMatch = pathname.match(/^\/api\/reports\/([a-zA-Z0-9_-]{1,64})$/);
  if (reportMatch) {
    if (method === 'GET') return await safe(handleGetReport)(request, env, reportMatch[1]);
    return errors.methodNotAllowed();
  }

  // /api/geocode
  if (pathname === '/api/geocode') {
    if (method === 'GET') return await safe(handleGeocode)(request, env, ctx);
    return errors.methodNotAllowed();
  }

  // /api/facilities/nearest
  if (pathname === '/api/facilities/nearest') {
    if (method === 'GET') return await safe(handleNearestFacility)(request, env, ctx);
    return errors.methodNotAllowed();
  }

  // /api/upload/*
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

  // /api/analytics/batch — Phase 1d
  if (pathname === '/api/analytics/batch') {
    if (method === 'POST') return await safe(handleAnalyticsBatch)(request, env, ctx);
    return errors.methodNotAllowed();
  }
  // Other /api/analytics/* is reserved for later phases (dashboards).
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

  if (pathname.startsWith('/api/subscribe') || pathname.startsWith('/api/unsubscribe')) {
    return errors.notImplemented('Subscription endpoints land in Phase 1h');
  }

  return errors.notFound('API endpoint not found');
}
