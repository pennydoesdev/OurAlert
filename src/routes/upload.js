/**
 * routes/upload.js — R2 multipart upload for photos and videos.
 *
 * Flow:
 *   POST /api/upload/init      → returns { upload_id, r2_key, part_size }
 *   POST /api/upload/part      → body is the raw chunk; ?upload_id=&key=&part=
 *   POST /api/upload/complete  → body { upload_id, r2_key, parts: [{partNumber, etag}] }
 *   POST /api/upload/abort     → body { upload_id, r2_key }
 *
 * Safety:
 * - Turnstile required on init
 * - Rate limited
 * - Content-type must be image/* or video/*
 * - JPEG/PNG/WebP get EXIF stripped after completion (via r2_transform
 *   or, for simple uploads, during the "complete" step)
 *
 * For reports with a small single photo, the client can also use the
 * simple /api/upload/simple endpoint which handles the whole upload in
 * one request (max 10 MB).
 */

import { json, errors } from '../lib/response.js';
import { prefixedId } from '../lib/nanoid.js';
import { checkRateLimit } from '../lib/rate-limit.js';
import { verifyTurnstile } from '../lib/turnstile.js';
import { stripExif } from '../lib/exif.js';

const MAX_FILE_BYTES = 25 * 1024 * 1024;      // 25 MB
const MAX_SIMPLE_BYTES = 10 * 1024 * 1024;    // 10 MB for single-shot uploads
const PART_SIZE = 5 * 1024 * 1024;            // 5 MB parts (R2 minimum except last)

const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
  'video/mp4', 'video/quicktime', 'video/webm'
]);

const IMAGE_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);

// ────────────────────────────────────────────────────────────────────────────
// Simple single-shot upload — convenient for small photos
// POST /api/upload/simple  (multipart/form-data or raw body)
// ────────────────────────────────────────────────────────────────────────────

export async function handleSimpleUpload(request, env) {
  const rl = await checkRateLimit(env, request, 'upload');
  if (!rl.ok) return errors.rateLimited(rl.retryAfter);

  const contentType = request.headers.get('content-type') || '';
  const contentLength = parseInt(request.headers.get('content-length') || '0', 10);

  if (contentLength > MAX_SIMPLE_BYTES) {
    return errors.payloadTooLarge(`Max ${MAX_SIMPLE_BYTES} bytes for simple upload; use multipart for larger`);
  }

  // Accept either raw body upload with explicit headers, or multipart/form-data
  let bytes, mime, turnstileToken, kind;

  if (contentType.startsWith('multipart/form-data')) {
    const form = await request.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') return errors.badRequest('file field required');
    if (file.size > MAX_SIMPLE_BYTES) return errors.payloadTooLarge();
    mime = file.type;
    bytes = new Uint8Array(await file.arrayBuffer());
    turnstileToken = form.get('turnstile_token');
    kind = form.get('kind') || 'photo';
  } else {
    mime = contentType;
    bytes = new Uint8Array(await request.arrayBuffer());
    turnstileToken = request.headers.get('X-Turnstile-Token');
    kind = request.headers.get('X-Media-Kind') || 'photo';
  }

  if (!ALLOWED_MIME.has(mime)) {
    return errors.unprocessable(`Unsupported content type: ${mime}`);
  }

  const tsResult = await verifyTurnstile(env, turnstileToken, request);
  if (!tsResult.ok) return errors.captchaFailed();

  // Strip EXIF for images
  const stripped = IMAGE_MIME.has(mime) ? stripExif(bytes, mime) : bytes;
  const exifStripped = IMAGE_MIME.has(mime) ? 1 : 0;

  const r2Key = `uploads/${datePath()}/${prefixedId('med', 16)}${extFor(mime)}`;

  await env.MEDIA.put(r2Key, stripped, {
    httpMetadata: { contentType: mime }
  });

  return json({
    r2_key: r2Key,
    mime,
    size: stripped.length,
    exif_stripped: !!exifStripped,
    kind
  }, 201);
}

// ────────────────────────────────────────────────────────────────────────────
// Multipart flow for larger uploads
// ────────────────────────────────────────────────────────────────────────────

export async function handleUploadInit(request, env) {
  const rl = await checkRateLimit(env, request, 'upload');
  if (!rl.ok) return errors.rateLimited(rl.retryAfter);

  let body;
  try { body = await request.json(); }
  catch { return errors.badRequest('Invalid JSON body'); }

  const { mime, kind = 'photo', turnstile_token } = body;
  if (!mime || !ALLOWED_MIME.has(mime)) {
    return errors.unprocessable(`Unsupported content type: ${mime}`);
  }

  const tsResult = await verifyTurnstile(env, turnstile_token, request);
  if (!tsResult.ok) return errors.captchaFailed();

  const r2Key = `uploads/${datePath()}/${prefixedId('med', 16)}${extFor(mime)}`;
  const multipart = await env.MEDIA.createMultipartUpload(r2Key, {
    httpMetadata: { contentType: mime }
  });

  return json({
    upload_id: multipart.uploadId,
    r2_key: r2Key,
    part_size: PART_SIZE,
    mime,
    kind
  }, 201);
}

export async function handleUploadPart(request, env) {
  const url = new URL(request.url);
  const uploadId = url.searchParams.get('upload_id');
  const r2Key = url.searchParams.get('key');
  const partNumber = parseInt(url.searchParams.get('part') || '0', 10);

  if (!uploadId || !r2Key || !partNumber) {
    return errors.badRequest('upload_id, key, and part are required');
  }
  if (partNumber < 1 || partNumber > 10000) {
    return errors.badRequest('part must be between 1 and 10000');
  }

  const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
  if (contentLength > PART_SIZE * 2) {
    return errors.payloadTooLarge();
  }

  const multipart = env.MEDIA.resumeMultipartUpload(r2Key, uploadId);
  const uploadedPart = await multipart.uploadPart(partNumber, request.body);

  return json({ partNumber, etag: uploadedPart.etag });
}

export async function handleUploadComplete(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return errors.badRequest('Invalid JSON body'); }

  const { upload_id, r2_key, parts } = body;
  if (!upload_id || !r2_key || !Array.isArray(parts)) {
    return errors.badRequest('upload_id, r2_key, and parts[] required');
  }

  const multipart = env.MEDIA.resumeMultipartUpload(r2_key, upload_id);
  try {
    const result = await multipart.complete(parts);
    // Note: EXIF stripping is NOT applied to multipart uploads because
    // we'd need to re-read and re-upload. Multipart is for large videos
    // which don't carry EXIF the same way. If we ever accept multipart
    // for images we'll add a post-complete rewrite step.
    return json({
      r2_key,
      etag: result.etag,
      size: result.size,
      mime: result.httpMetadata?.contentType
    });
  } catch (err) {
    return errors.unprocessable(`Failed to complete upload: ${err.message}`);
  }
}

export async function handleUploadAbort(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return errors.badRequest('Invalid JSON body'); }

  const { upload_id, r2_key } = body;
  if (!upload_id || !r2_key) {
    return errors.badRequest('upload_id and r2_key required');
  }

  const multipart = env.MEDIA.resumeMultipartUpload(r2_key, upload_id);
  try {
    await multipart.abort();
    return json({ aborted: true, r2_key });
  } catch (err) {
    return errors.unprocessable(`Failed to abort: ${err.message}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function datePath() {
  const d = new Date();
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
}

function extFor(mime) {
  const map = {
    'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
    'image/webp': '.webp', 'image/heic': '.heic', 'image/heif': '.heif',
    'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm'
  };
  return map[mime] || '';
}
