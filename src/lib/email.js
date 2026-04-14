// src/lib/email.js
/**
 * lib/email.js — email provider abstraction.
 *
 * Two providers supported:
 *   - 'ses'   → Amazon SES via SigV4-signed HTTPS POST
 *   - 'loops' → Loops.so transactional API (templateId + dataVariables)
 *
 * Everything flows through `enqueueEmail()` which writes a row to
 * `email_queue` with status='pending'. The `*/5 * * * *` cron drains
 * the queue (see src/jobs/email.js) — actual delivery is async.
 *
 * Templates live inline in renderTemplate() for now; moving to a
 * separate templates/ directory is a later polish task.
 *
 * Privacy: email bodies can contain tokens (OTP codes, unsubscribe
 * tokens). Rows are purged by the nightly cleanup cron 90 days after
 * send.
 */

import { prefixedId } from './nanoid.js';
import { hmacSha256 as hmacHex, sha256Hex } from './hash.js';

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

/**
 * Enqueue an email for async delivery.
 *
 * @param {Env} env
 * @param {object} opts
 * @param {string} opts.to            — recipient address
 * @param {string} opts.category      — 'otp' | 'alert' | 'digest' | 'verify' | 'admin'
 * @param {string} [opts.template]    — template key (see renderTemplate)
 * @param {object} [opts.data]        — template variables
 * @param {string} [opts.subject]     — override subject (required if no template)
 * @param {string} [opts.html]        — override HTML body (required if no template)
 * @param {string} [opts.text]        — override plaintext body
 * @param {string} [opts.provider]    — 'ses' | 'loops' (defaults to env.DEFAULT_EMAIL_PROVIDER)
 * @param {string} [opts.loopsTemplateId]
 * @param {number} [opts.scheduledFor] — ms timestamp; if set, drain waits until then
 * @returns {Promise<{ id: string }>}
 */
export async function enqueueEmail(env, opts) {
  if (!opts?.to || !opts?.category) {
    throw new Error('enqueueEmail: missing "to" or "category"');
  }

  const provider = (opts.provider || env.DEFAULT_EMAIL_PROVIDER || 'ses').toLowerCase();
  let subject, html, text;

  if (opts.template) {
    const rendered = renderTemplate(opts.template, opts.data || {}, env);
    subject = opts.subject || rendered.subject;
    html = opts.html || rendered.html;
    text = opts.text || rendered.text;
  } else {
    subject = opts.subject;
    html = opts.html;
    text = opts.text || htmlToText(html || '');
  }

  if (!subject || !html) throw new Error('enqueueEmail: missing subject/html');

  const id = prefixedId('mail', 14);
  const now = Date.now();
  const from = env.SES_FROM || 'noreply@ouralert.org';

  await env.DB.prepare(
    `INSERT INTO email_queue
       (id, provider, category, to_address, from_address,
        subject, body_html, body_text,
        loops_template_id, loops_data_variables,
        status, attempts, scheduled_for, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`
  ).bind(
    id,
    provider,
    opts.category,
    String(opts.to).slice(0, 254),
    from,
    subject.slice(0, 256),
    html,
    text || null,
    opts.loopsTemplateId || null,
    opts.data ? JSON.stringify(opts.data) : null,
    opts.scheduledFor || null,
    now
  ).run();

  return { id };
}

/**
 * Send an already-materialized email row via its provider.
 * Called by the queue drainer. Returns true on success, throws on failure.
 */
export async function sendEmail(env, row) {
  const provider = (row.provider || 'ses').toLowerCase();
  if (provider === 'loops') return await sendViaLoops(env, row);
  return await sendViaSes(env, row);
}

// ────────────────────────────────────────────────────────────────────────────
// Template rendering
// ────────────────────────────────────────────────────────────────────────────

const BRAND = {
  name: 'OurALERT',
  color: '#c8102e',
  url: 'https://ouralert.org'
};

function baseLayout(bodyHtml, env) {
  const appUrl = env?.APP_URL || BRAND.url;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OurALERT</title></head>
<body style="margin:0;padding:0;background:#fafafa;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#222;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#fafafa;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0" style="background:#fff;border-radius:8px;padding:32px;max-width:92%;">
        <tr><td style="padding-bottom:16px;border-bottom:2px solid ${BRAND.color};">
          <a href="${appUrl}" style="text-decoration:none;color:${BRAND.color};font-size:22px;font-weight:700;">OurALERT</a>
        </td></tr>
        <tr><td style="padding:24px 0;font-size:15px;line-height:1.6;">
          ${bodyHtml}
        </td></tr>
        <tr><td style="padding-top:16px;border-top:1px solid #eee;font-size:12px;color:#888;">
          You received this because you interacted with OurALERT at ${appUrl}.
          If this wasn't you, you can ignore this message.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

/**
 * Render a named template. Extend this switch as new transactional
 * mails are added — keeping the contract narrow is intentional.
 */
export function renderTemplate(key, data, env) {
  switch (key) {
    case 'volunteer_otp': {
      const code = String(data.code || '').replace(/[^0-9]/g, '');
      const display = code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
      const html = baseLayout(`
        <p>Hi${data.name ? ` ${escapeHtml(data.name)}` : ''},</p>
        <p>Your OurALERT sign-in code is:</p>
        <p style="font-size:28px;font-weight:700;letter-spacing:4px;padding:16px;background:#f4f4f4;border-radius:6px;text-align:center;">
          ${escapeHtml(display)}
        </p>
        <p>This code expires in 10 minutes. If you didn't try to sign in, ignore this message and your account stays safe.</p>
      `, env);
      return {
        subject: `Your OurALERT sign-in code: ${code}`,
        html,
        text: `Your OurALERT sign-in code is ${code}. It expires in 10 minutes.\nIf you didn't request this, ignore this message.`
      };
    }

    case 'subscribe_verify': {
      const link = String(data.verify_url || '');
      const html = baseLayout(`
        <p>Confirm your alert subscription for ZIP <strong>${escapeHtml(data.zip || '')}</strong>:</p>
        <p style="margin:24px 0;">
          <a href="${escapeAttr(link)}" style="background:${BRAND.color};color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;font-weight:600;">
            Confirm subscription
          </a>
        </p>
        <p style="font-size:12px;color:#888;">Or paste this link into your browser: ${escapeHtml(link)}</p>
      `, env);
      return {
        subject: 'Confirm your OurALERT alert subscription',
        html,
        text: `Confirm your OurALERT subscription by visiting: ${link}`
      };
    }

    case 'alert_new_report': {
      const city = escapeHtml(data.city || 'your area');
      const state = escapeHtml(data.state || '');
      const summary = escapeHtml(data.summary || 'A new report was submitted near you.');
      const link = String(data.report_url || '');
      const unsub = String(data.unsubscribe_url || '');
      const html = baseLayout(`
        <p><strong>New report near ${city}${state ? `, ${state}` : ''}</strong></p>
        <p>${summary}</p>
        <p><a href="${escapeAttr(link)}" style="color:${BRAND.color};font-weight:600;">View on the map →</a></p>
        <p style="font-size:12px;color:#888;">Not useful? <a href="${escapeAttr(unsub)}" style="color:#888;">Unsubscribe</a>.</p>
      `, env);
      return {
        subject: `OurALERT: new report near ${data.city || 'your area'}`,
        html,
        text: `New OurALERT report near ${data.city || 'your area'}. View: ${link}\nUnsubscribe: ${unsub}`
      };
    }

    default:
      throw new Error(`renderTemplate: unknown template "${key}"`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Providers
// ────────────────────────────────────────────────────────────────────────────

async function sendViaSes(env, row) {
  const accessKey = env.SES_ACCESS_KEY_ID;
  const secretKey = env.SES_SECRET_ACCESS_KEY;
  const region = env.SES_REGION || 'us-east-1';
  if (!accessKey || !secretKey) throw new Error('SES credentials not configured');

  const host = `email.${region}.amazonaws.com`;
  const endpoint = `https://${host}/`;

  // SES v1 SendEmail action via x-www-form-urlencoded body.
  const params = new URLSearchParams();
  params.set('Action', 'SendEmail');
  params.set('Version', '2010-12-01');
  params.set('Source', row.from_address);
  params.set('Destination.ToAddresses.member.1', row.to_address);
  params.set('Message.Subject.Data', row.subject);
  params.set('Message.Subject.Charset', 'UTF-8');
  params.set('Message.Body.Html.Data', row.body_html);
  params.set('Message.Body.Html.Charset', 'UTF-8');
  if (row.body_text) {
    params.set('Message.Body.Text.Data', row.body_text);
    params.set('Message.Body.Text.Charset', 'UTF-8');
  }

  const body = params.toString();
  const signed = await signSigV4({
    method: 'POST',
    host,
    path: '/',
    service: 'ses',
    region,
    accessKey,
    secretKey,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  });

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: signed.headers,
    body
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`SES ${res.status}: ${errText.slice(0, 400)}`);
  }
  return true;
}

async function sendViaLoops(env, row) {
  const apiKey = env.LOOPS_API_KEY;
  if (!apiKey) throw new Error('LOOPS_API_KEY not configured');

  // Loops transactional endpoint requires a templateId + dataVariables.
  // Fall back to a simpler send if only subject/html are provided.
  const templateId = row.loops_template_id;
  const endpoint = templateId
    ? 'https://app.loops.so/api/v1/transactional'
    : 'https://app.loops.so/api/v1/transactional';

  const payload = templateId
    ? {
        transactionalId: templateId,
        email: row.to_address,
        dataVariables: row.loops_data_variables ? JSON.parse(row.loops_data_variables) : {}
      }
    : {
        email: row.to_address,
        subject: row.subject,
        html: row.body_html
      };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Loops ${res.status}: ${errText.slice(0, 400)}`);
  }
  return true;
}

// ────────────────────────────────────────────────────────────────────────────
// AWS SigV4
// ────────────────────────────────────────────────────────────────────────────

async function signSigV4({ method, host, path, service, region, accessKey, secretKey, headers, body }) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const canonicalHeaders = {
    ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
    host,
    'x-amz-date': amzDate
  };

  const signedHeaderNames = Object.keys(canonicalHeaders).sort();
  const canonicalHeadersStr = signedHeaderNames.map((k) => `${k}:${canonicalHeaders[k]}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');
  const payloadHash = await sha256Hex(body || '');

  const canonicalRequest = [
    method,
    path,
    '',
    canonicalHeadersStr,
    signedHeaders,
    payloadHash
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest)
  ].join('\n');

  const kDate = await hmacRaw(`AWS4${secretKey}`, dateStamp);
  const kRegion = await hmacRaw(kDate, region);
  const kService = await hmacRaw(kRegion, service);
  const kSigning = await hmacRaw(kService, 'aws4_request');
  const signature = await hmacRawHex(kSigning, stringToSign);

  const authHeader =
    `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    headers: {
      ...headers,
      host,
      'x-amz-date': amzDate,
      Authorization: authHeader
    }
  };
}

async function hmacRaw(key, message) {
  const keyBytes = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
  return new Uint8Array(sig);
}

async function hmacRawHex(key, message) {
  const bytes = await hmacRaw(key, message);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(str) {
  return escapeHtml(str);
}

function htmlToText(html) {
  return String(html)
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 5000);
}
