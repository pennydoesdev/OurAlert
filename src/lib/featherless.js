// src/lib/featherless.js
/**
 * lib/featherless.js — Featherless.ai chat completion client.
 *
 * Used by AlertIQ (digest + trend) to summarize a set of reports into a
 * short, calm, factual prose blurb. The prompt constrains the model to
 * report-only content (no editorializing), and we strip markdown from
 * the output before rendering.
 *
 * We never send PII downstream. Input to the model is ALWAYS the already-
 * public fields: category, status, city, state, activity_text, counts,
 * time. No IPs, emails, hashes, arrestee names.
 *
 * Env:
 *   FEATHERLESS_API_KEY       — required
 *   FEATHERLESS_MODEL         — optional override (default: meta-llama/Meta-Llama-3.1-8B-Instruct)
 */

const DEFAULT_MODEL = 'meta-llama/Meta-Llama-3.1-8B-Instruct';
const ENDPOINT = 'https://api.featherless.ai/v1/chat/completions';
const DEFAULT_MAX_TOKENS = 400;
const TIMEOUT_MS = 20_000;

/**
 * Summarize a list of report objects into { html, text, model }.
 * Safe to call with 0 reports — returns a canned "no activity" message
 * without hitting the API.
 */
export async function summarizeReports(env, reports, opts = {}) {
  const model = env.FEATHERLESS_MODEL || DEFAULT_MODEL;
  const scopeLabel = opts.scopeLabel || 'your area';
  const windowLabel = opts.windowLabel || 'the last 24 hours';

  if (!reports || reports.length === 0) {
    return {
      html: `<p>No reports were submitted in <strong>${escapeHtml(scopeLabel)}</strong> during ${escapeHtml(windowLabel)}.</p>`,
      text: `No reports were submitted in ${scopeLabel} during ${windowLabel}.`,
      model: 'static:empty'
    };
  }

  const apiKey = env.FEATHERLESS_API_KEY;
  if (!apiKey) {
    // Fall back to a structured non-AI summary so the feature still works
    // without the secret; operator gets a log warning.
    console.warn('FEATHERLESS_API_KEY not set — returning static summary');
    return staticSummary(reports, scopeLabel, windowLabel);
  }

  const summary = reports.map(normalizeForPrompt).slice(0, 40);
  const prompt = buildPrompt(summary, scopeLabel, windowLabel);

  let text;
  try {
    text = await callFeatherless(apiKey, model, prompt);
  } catch (err) {
    console.error('featherless call failed, falling back to static:', err.message);
    return staticSummary(reports, scopeLabel, windowLabel);
  }

  const cleanText = stripMarkdown(text).trim().slice(0, 2000);
  const html = textToSafeHtml(cleanText);

  return { html, text: cleanText, model };
}

// ────────────────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────────────────

function normalizeForPrompt(r) {
  return {
    category: r.category || 'other',
    status: r.status || 'observed',
    city: r.city || null,
    state: r.state || null,
    activity: String(r.activity_text || '').slice(0, 400) || null,
    officials: r.official_count || null,
    vehicles: r.vehicle_count || null,
    at: r.time_occurred ? new Date(r.time_occurred).toISOString() : null
  };
}

function buildPrompt(reports, scopeLabel, windowLabel) {
  const SYSTEM = `You are AlertIQ, a calm, neutral summarizer of community-submitted ICE and immigration-enforcement reports for OurALERT.

Rules:
- Base your summary ONLY on the JSON reports provided. Do not invent details.
- Be factual and concise. No speculation about motive, legality, or politics.
- Use the phrase "community reports indicate" when describing events.
- Do not use superlatives, alarmist language, or emoji.
- Output plain prose (2–4 short paragraphs, no bullet lists, no markdown headers).
- If reports cluster by city or agency, mention the pattern in one sentence.
- Do not include timestamps, coordinates, or IDs.
- End with one short sentence stating the total count.`;

  const USER = `Summarize ${reports.length} report(s) for ${scopeLabel} over ${windowLabel}:

${JSON.stringify(reports, null, 2)}`;

  return { system: SYSTEM, user: USER };
}

async function callFeatherless(apiKey, model, { system, user }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        temperature: 0.3,
        max_tokens: DEFAULT_MAX_TOKENS,
        stream: false
      })
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`featherless ${res.status}: ${errText.slice(0, 300)}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('featherless returned empty content');
    return content;
  } finally {
    clearTimeout(timer);
  }
}

function staticSummary(reports, scopeLabel, windowLabel) {
  const byCat = {};
  for (const r of reports) byCat[r.category || 'other'] = (byCat[r.category || 'other'] || 0) + 1;
  const parts = Object.entries(byCat)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, n]) => `${n} ${cat}`);
  const line = parts.length
    ? `Community reports indicate ${parts.join(', ')} in ${scopeLabel} over ${windowLabel}.`
    : `Community reports indicate activity in ${scopeLabel} over ${windowLabel}.`;
  const count = `Total reports: ${reports.length}.`;
  return {
    html: `<p>${escapeHtml(line)}</p><p>${escapeHtml(count)}</p>`,
    text: `${line}\n${count}`,
    model: 'static:fallback'
  };
}

function stripMarkdown(s) {
  return String(s || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

function textToSafeHtml(text) {
  const paragraphs = String(text)
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) return `<p>${escapeHtml(text)}</p>`;
  return paragraphs.map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
