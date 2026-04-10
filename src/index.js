/**
 * src/index.js — OurALERT Worker entry point and router.
 *
 * Handles:
 * - Static asset serving (via env.ASSETS binding)
 * - /api/* route dispatch
 * - CORS preflight
 * - Global safe() wrapper for uncaught errors
 *
 * Analytics, volunteer auth, email, and cron handlers are added in later
 * phases. The scheduled() handler is stubbed here so wrangler.toml cron
 * triggers don't fail.
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
    // The [assets] block in wrangler.toml binds public/ to env.ASSETS
    // with SPA fallback, so unknown paths get index.html.
    if (env.ASSETS) {
      try {
        const assetResponse = await env.ASSETS.fetch(request);
        // Add privacy-respecting security headers
        const headers = new Headers(assetResponse.headers);
        headers.set('X-Content-Type-Options', 'nosniff');
        headers.set('X-Frame-Options', 'DENY');
        headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
        headers.set('Permissions-Policy', 'geolocation=(self), camera=(self), microphone=()');
        // HTML gets a short cache, everything else gets long immutable cache
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

  async scheduled(event, env, ctx) {
    // Cron handler stub — real jobs land in Phases 1d, 1e, 1g, 1h, 1i.
    // Each cron expression from wrangler.toml routes to a specific job
    // based on event.cron (the crontab string).
    console.log('cron triggered:', event.cron);
    // No-op for Phase 1c — later phases will dispatch here.
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

  // Phase 1d+ endpoints — stubbed so they return something meaningful
  if (pathname.startsWith('/api/analytics/')) {
    return errors.notImplemented('Analytics endpoints land in Phase 1d');
  }
  if (pathname.startsWith('/api/vol/') || pathname.startsWith('/api/volunteer/')) {
    return errors.notImplemented('Volunteer endpoints land in Phase 1f');
  }
  if (pathname.startsWith('/api/admin/')) {
    return errors.notImplemented('Admin endpoints land in Phase 1f');
  }
  if (pathname.startsWith('/api/subscribe') || pathname.startsWith('/api/unsubscribe')) {
    return errors.notImplemented('Subscription endpoints land in Phase 1h');
  }

  return errors.notFound('API endpoint not found');
}
