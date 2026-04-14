// src/jobs/email.js
/**
 * jobs/email.js — email_queue drain (Phase 1g).
 *
 * Fired by the */5 cron from src/index.js.
 *
 * Pulls up to MAX_PER_RUN rows with status IN ('pending','retry') and
 * scheduled_for <= now, sends via the row's provider, and marks the
 * row as 'sent' or 'failed'. Transient failures flip to 'retry' with
 * an exponential backoff via `scheduled_for`. Permanent failures
 * (4xx addressing problems) flip to 'failed' immediately.
 *
 * MAX_ATTEMPTS: 5. After that the row stays 'failed' and the nightly
 * cleanup retains it for 90 days for debugging.
 */

import { sendEmail } from '../lib/email.js';

const MAX_PER_RUN = 25;
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 5 * 60 * 1000; // 5 min × 2^attempts

export async function drainEmailQueue(env) {
  if (!env.DB) {
    console.error('email drain: no DB binding');
    return { sent: 0, failed: 0, retried: 0 };
  }

  const now = Date.now();

  const { results } = await env.DB.prepare(
    `SELECT id, provider, category, to_address, from_address,
            subject, body_html, body_text,
            loops_template_id, loops_data_variables,
            status, attempts
     FROM email_queue
     WHERE status IN ('pending','retry')
       AND (scheduled_for IS NULL OR scheduled_for <= ?)
     ORDER BY created_at ASC
     LIMIT ?`
  ).bind(now, MAX_PER_RUN).all();

  if (!results || results.length === 0) {
    return { sent: 0, failed: 0, retried: 0 };
  }

  let sent = 0;
  let failed = 0;
  let retried = 0;

  for (const row of results) {
    const attempts = (row.attempts || 0) + 1;
    try {
      await sendEmail(env, row);
      await env.DB.prepare(
        `UPDATE email_queue SET status='sent', attempts=?, sent_at=?, last_error=NULL WHERE id = ?`
      ).bind(attempts, Date.now(), row.id).run();
      sent++;
    } catch (err) {
      const msg = (err?.message || String(err)).slice(0, 500);
      const permanent = isPermanentFailure(msg);
      if (permanent || attempts >= MAX_ATTEMPTS) {
        await env.DB.prepare(
          `UPDATE email_queue SET status='failed', attempts=?, last_error=? WHERE id = ?`
        ).bind(attempts, msg, row.id).run();
        failed++;
        console.error(`email ${row.id} permanently failed:`, msg);
      } else {
        const backoff = BASE_BACKOFF_MS * Math.pow(2, attempts - 1);
        await env.DB.prepare(
          `UPDATE email_queue SET status='retry', attempts=?, last_error=?, scheduled_for=? WHERE id = ?`
        ).bind(attempts, msg, Date.now() + backoff, row.id).run();
        retried++;
        console.warn(`email ${row.id} attempt ${attempts} failed, retry in ${backoff}ms:`, msg);
      }
    }
  }

  console.log(`email drain: sent=${sent} retried=${retried} failed=${failed}`);
  return { sent, failed, retried };
}

function isPermanentFailure(msg) {
  // SES/Loops 4xx status codes that indicate addressing / auth problems
  // not worth retrying. We're pattern-matching the error string since the
  // underlying provider response format is opaque here.
  return /\b(400|401|403|404|422)\b/.test(msg) ||
    /invalid(\s|-)address/i.test(msg) ||
    /unverified/i.test(msg) ||
    /not authorized/i.test(msg);
}
