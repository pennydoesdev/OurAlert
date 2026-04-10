/**
 * lib/exif.js — EXIF metadata stripping for uploaded images.
 *
 * This is a SAFETY-CRITICAL feature. Photos of ICE sightings often contain
 * GPS metadata that could identify the reporter's exact location at the
 * time of submission. We strip all EXIF before storing anything in R2.
 *
 * Strategy:
 * - JPEG: walk the segment markers and drop APP0/APP1 (EXIF), APP13 (IPTC),
 *         and any other APPn segments except the SOI/EOI framing.
 * - PNG: drop the entire tEXt, iTXt, zTXt, and eXIf chunks.
 * - WebP: drop the EXIF chunk inside a RIFF/WebP container.
 * - Everything else: pass through unchanged (we can't safely rewrite
 *   formats we don't fully understand).
 *
 * Returns a new Uint8Array with a cleaned copy of the image bytes.
 */

/**
 * Strip EXIF and other metadata from an image buffer.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {string} mime — content-type; determines which stripper to use
 * @returns {Uint8Array}
 */
export function stripExif(buffer, mime) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const type = (mime || '').toLowerCase();

  try {
    if (type === 'image/jpeg' || type === 'image/jpg') return stripJpeg(bytes);
    if (type === 'image/png') return stripPng(bytes);
    if (type === 'image/webp') return stripWebp(bytes);
  } catch (err) {
    // If stripping fails, return the original bytes rather than corrupting
    // the upload. Log for review.
    console.error('EXIF strip failed for', type, err.message);
    return bytes;
  }

  return bytes;
}

// ────────────────────────────────────────────────────────────────────────────
// JPEG
// ────────────────────────────────────────────────────────────────────────────

function stripJpeg(bytes) {
  // JPEG starts with 0xFFD8 (SOI) and ends with 0xFFD9 (EOI).
  // Between them are segments: 0xFF <marker> <length-hi> <length-lo> <data>
  // We drop: APP0 (E0), APP1 (E1 = EXIF), APP2 (E2 = ICC sometimes ok), APP13 (ED = IPTC), APP14 (EE)
  if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return bytes;

  const out = [];
  out.push(0xFF, 0xD8); // SOI

  let i = 2;
  while (i < bytes.length - 1) {
    if (bytes[i] !== 0xFF) { i++; continue; }

    // Skip padding 0xFF bytes
    while (bytes[i] === 0xFF && i < bytes.length - 1) i++;
    const marker = bytes[i];

    // EOI — copy remainder and stop
    if (marker === 0xD9) {
      out.push(0xFF, 0xD9);
      break;
    }

    // SOS (Start of Scan) — from here to EOI is image data, copy everything
    if (marker === 0xDA) {
      out.push(0xFF, marker);
      i++;
      while (i < bytes.length) {
        out.push(bytes[i]);
        i++;
      }
      break;
    }

    // Standalone markers (no length field): RST0-7 (D0-D7), SOI (D8), EOI (D9), TEM (01)
    if (marker >= 0xD0 && marker <= 0xD7) {
      out.push(0xFF, marker);
      i++;
      continue;
    }

    // All other markers have a 2-byte length field following
    if (i + 3 >= bytes.length) break;
    const segLen = (bytes[i + 1] << 8) | bytes[i + 2];
    if (segLen < 2 || i + 1 + segLen > bytes.length) break;

    // Drop metadata-carrying APPn segments
    const isAppN = marker >= 0xE0 && marker <= 0xEF;
    const isComment = marker === 0xFE;
    if (isAppN || isComment) {
      i += 1 + segLen; // skip marker + segment
      continue;
    }

    // Copy the segment
    out.push(0xFF, marker);
    for (let j = 0; j < segLen; j++) out.push(bytes[i + 1 + j]);
    i += 1 + segLen;
  }

  return new Uint8Array(out);
}

// ────────────────────────────────────────────────────────────────────────────
// PNG
// ────────────────────────────────────────────────────────────────────────────

function stripPng(bytes) {
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (bytes.length < 8) return bytes;
  const sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) return bytes;

  const out = [];
  for (let i = 0; i < 8; i++) out.push(bytes[i]);

  // Chunks: 4-byte length, 4-byte type, <length> bytes data, 4-byte CRC
  let i = 8;
  const DROP_TYPES = new Set(['tEXt', 'iTXt', 'zTXt', 'eXIf', 'tIME']);
  while (i + 8 <= bytes.length) {
    const len = (bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3];
    const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
    const chunkSize = 12 + len; // length + type + data + crc
    if (i + chunkSize > bytes.length) break;

    if (!DROP_TYPES.has(type)) {
      for (let j = 0; j < chunkSize; j++) out.push(bytes[i + j]);
    }
    i += chunkSize;

    if (type === 'IEND') break;
  }

  return new Uint8Array(out);
}

// ────────────────────────────────────────────────────────────────────────────
// WebP
// ────────────────────────────────────────────────────────────────────────────

function stripWebp(bytes) {
  // RIFF container: "RIFF" <size> "WEBP" <chunks>
  if (bytes.length < 12) return bytes;
  const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const webp = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  if (riff !== 'RIFF' || webp !== 'WEBP') return bytes;

  const out = [];
  // We'll rewrite the RIFF size at the end
  for (let k = 0; k < 12; k++) out.push(bytes[k]);

  const DROP_FOURCC = new Set(['EXIF', 'XMP ', 'ICCP']);
  let i = 12;
  while (i + 8 <= bytes.length) {
    const fourcc = String.fromCharCode(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]);
    const len = bytes[i + 4] | (bytes[i + 5] << 8) | (bytes[i + 6] << 16) | (bytes[i + 7] << 24);
    const padded = len + (len % 2); // chunks are padded to even length
    const chunkSize = 8 + padded;
    if (i + chunkSize > bytes.length) break;

    if (!DROP_FOURCC.has(fourcc)) {
      for (let j = 0; j < chunkSize; j++) out.push(bytes[i + j]);
    }
    i += chunkSize;
  }

  // Rewrite RIFF size (bytes 4-7): out.length - 8
  const newSize = out.length - 8;
  out[4] = newSize & 0xFF;
  out[5] = (newSize >> 8) & 0xFF;
  out[6] = (newSize >> 16) & 0xFF;
  out[7] = (newSize >> 24) & 0xFF;

  return new Uint8Array(out);
}
