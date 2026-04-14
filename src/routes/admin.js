// src/routes/admin.js
/**
 * routes/admin.js — moderation endpoints for authenticated volunteers.
 *
 *   POST /api/admin/reports/:id/approve   { notes? }
 *   POST /api/admin/reports/:id/reject    { notes? }
 *   POST /api/admin/reports/:id/pin       { hours? (default 24) }
 *   POST /api/admin/reports/:id/hide      { notes? }
 *   POST /api/admin/reports/:id/unhide    { notes? }
 *
 * All endpoints require a valid volunteer session (X-OurAlert-Session or
 * Authorization: Bearer). Role check: 'volunteer' can approve/reject;
 * pin/hide/unhide require 'senior_mod' or 'admin'.
 *
 * Every action writes a volunteer_actions audit row.
 */

import { json, errors } from '../lib/response.js';
import { requireSession } from '../lib/auth.js';
import { prefixedId } from '../lib/nanoid.js';

const ROLE_RANK = { volunteer: 1, senior_mod: 2, admin: 3 };

function hasRole(volunteer, minimum) {
  return (ROLE_RANK[volunteer?.role] || 0) >= (ROLE_RANK[minimum] || 99);
}

async function logAction(env, volunteerId, reportId, action, notes) {
  try {
    await env.DB.prepare(
      `INSERT INTO volunteer_actions (id, volunteer_id, report_id, action, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(prefixedId('act', 14), volunteerId, reportId, action, notes || null, Date.now()).run();
  } catch (err) {
    console.error('volunteer_actions insert failed:', err.message);
  }
}

async function parseBody(request) {
  try {
    const text = await request.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch { return null; }
}

async function loadReport(env, reportId) {
  return await env.DB.prepare(
    `SELECT id, moderation_state, pinned_until, hidden_from_public FROM reports WHERE id = ? LIMIT 1`
  ).bind(reportId).first();
}

// ────────────────────────────────────────────────────────────────────────────
// POST /api/admin/reports/:id/approve
// ────────────────────────────────────────────────────────────────────────────

export async function handleApprove(request, env, reportId) {
  const auth = await requireSession(request, env);
  if (!auth.ok) return errors.unauthorized(auth.reason);
  if (!hasRole(auth.volunteer, 'volunteer')) return errors.forbidden();

  const body = await parseBody(request);
  if (body === null) return errors.badRequest('Invalid JSON');
  const notes = typeof body.notes === 'string' ? body.notes.slice(0, 1000) : null;

  const report = await loadReport(env, reportId);
  if (!report) return errors.notFound('Report not found');

  const now = Date.now();
  await env.DB.prepare(
    `UPDATE reports
     SET moderation_state = 'approved', moderator_id = ?, moderation_notes = ?, updated_at = ?
     WHERE id = ?`
  ).bind(auth.volunteer.id, notes, now, reportId).run();

  await logAction(env, auth.volunteer.id, reportId, 'approve', notes);
  return json({ status: 'ok', report_id: reportId, moderation_state: 'approved' });
}

// ────────────────────────────────────────────────────────────────────────────
// POST /api/admin/reports/:id/reject
// ────────────────────────────────────────────────────────────────────────────

export async function handleReject(request, env, reportId) {
  const auth = await requireSession(request, env);
  if (!auth.ok) return errors.unauthorized(auth.reason);
  if (!hasRole(auth.volunteer, 'volunteer')) return errors.forbidden();

  const body = await parseBody(request);
  if (body === null) return errors.badRequest('Invalid JSON');
  const notes = typeof body.notes === 'string' ? body.notes.slice(0, 1000) : null;

  const report = await loadReport(env, reportId);
  if (!report) return errors.notFound('Report not found');

  const now = Date.now();
  await env.DB.prepare(
    `UPDATE reports
     SET moderation_state = 'rejected', moderator_id = ?, moderation_notes = ?, updated_at = ?
     WHERE id = ?`
  ).bind(auth.volunteer.id, notes, now, reportId).run();

  await logAction(env, auth.volunteer.id, reportId, 'reject', notes);
  return json({ status: 'ok', report_id: reportId, moderation_state: 'rejected' });
}

// ────────────────────────────────────────────────────────────────────────────
// POST /api/admin/reports/:id/pin
// ────────────────────────────────────────────────────────────────────────────

export async function handlePin(request, env, reportId) {
  const auth = await requireSession(request, env);
  if (!auth.ok) return errors.unauthorized(auth.reason);
  if (!hasRole(auth.volunteer, 'senior_mod')) return errors.forbidden('Requires senior_mod or admin');

  const body = await parseBody(request);
  if (body === null) return errors.badRequest('Invalid JSON');

  const hoursRaw = Number(body.hours);
  const hours = Number.isFinite(hoursRaw) && hoursRaw > 0 && hoursRaw <= 24 * 30
    ? hoursRaw
    : 24;
  const notes = typeof body.notes === 'string' ? body.notes.slice(0, 1000) : null;

  const report = await loadReport(env, reportId);
  if (!report) return errors.notFound('Report not found');

  const now = Date.now();
  const pinnedUntil = now + hours * 60 * 60 * 1000;
  await env.DB.prepare(
    `UPDATE reports SET pinned_until = ?, updated_at = ? WHERE id = ?`
  ).bind(pinnedUntil, now, reportId).run();

  await logAction(env, auth.volunteer.id, reportId, 'pin', `hours=${hours}${notes ? ' | ' + notes : ''}`);
  return json({ status: 'ok', report_id: reportId, pinned_until: pinnedUntil });
}

// ────────────────────────────────────────────────────────────────────────────
// POST /api/admin/reports/:id/hide
// ────────────────────────────────────────────────────────────────────────────

export async function handleHide(request, env, reportId) {
  const auth = await requireSession(request, env);
  if (!auth.ok) return errors.unauthorized(auth.reason);
  if (!hasRole(auth.volunteer, 'senior_mod')) return errors.forbidden('Requires senior_mod or admin');

  const body = await parseBody(request);
  if (body === null) return errors.badRequest('Invalid JSON');
  const notes = typeof body.notes === 'string' ? body.notes.slice(0, 1000) : null;

  const report = await loadReport(env, reportId);
  if (!report) return errors.notFound('Report not found');

  const now = Date.now();
  await env.DB.prepare(
    `UPDATE reports SET hidden_from_public = 1, updated_at = ? WHERE id = ?`
  ).bind(now, reportId).run();

  await logAction(env, auth.volunteer.id, reportId, 'hide', notes);
  return json({ status: 'ok', report_id: reportId, hidden_from_public: 1 });
}

// ────────────────────────────────────────────────────────────────────────────
// POST /api/admin/reports/:id/unhide
// ────────────────────────────────────────────────────────────────────────────

export async function handleUnhide(request, env, reportId) {
  const auth = await requireSession(request, env);
  if (!auth.ok) return errors.unauthorized(auth.reason);
  if (!hasRole(auth.volunteer, 'senior_mod')) return errors.forbidden('Requires senior_mod or admin');

  const body = await parseBody(request);
  if (body === null) return errors.badRequest('Invalid JSON');
  const notes = typeof body.notes === 'string' ? body.notes.slice(0, 1000) : null;

  const report = await loadReport(env, reportId);
  if (!report) return errors.notFound('Report not found');

  const now = Date.now();
  await env.DB.prepare(
    `UPDATE reports SET hidden_from_public = 0, updated_at = ? WHERE id = ?`
  ).bind(now, reportId).run();

  await logAction(env, auth.volunteer.id, reportId, 'unhide', notes);
  return json({ status: 'ok', report_id: reportId, hidden_from_public: 0 });
}
