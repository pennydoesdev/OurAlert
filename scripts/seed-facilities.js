#!/usr/bin/env node
/**
 * seed-facilities.js — seed the detention_facilities table in D1.
 *
 * Flags:
 *   --inspect      dump first 15 raw rows (no parse)
 *   --no-geocode   skip Nominatim; all lat/lon NULL
 *   --cache-only   only use cached results; don't call Nominatim
 *   --dry-run      parse + geocode but don't write SQL
 *   --retry-fails  force re-geocode of addresses that previously failed
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const CACHE_PATH = join(DATA_DIR, 'facilities-geocoded.json');
const OUTPUT_SQL = join(DATA_DIR, 'facilities.sql');

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_USER_AGENT = 'OurALERT/0.1 (https://ouralert.org; hello@ouralert.org)';
const NOMINATIM_DELAY_MS = 1100;

const args = process.argv.slice(2);
const flags = {
  noGeocode: args.includes('--no-geocode'),
  cacheOnly: args.includes('--cache-only'),
  dryRun: args.includes('--dry-run'),
  inspect: args.includes('--inspect'),
  retryFails: args.includes('--retry-fails')
};
const inputPathArg = args.find(a => !a.startsWith('--'));

function log(msg) { console.log(`  ${msg}`); }
function warn(msg) { console.warn(`  ⚠  ${msg}`); }
function fail(msg) { console.error(`\n  ✗  ${msg}\n`); process.exit(1); }
function ok(msg) { console.log(`  ✓  ${msg}`); }
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function sqlEscape(val) {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number') return String(val);
  return `'${String(val).replace(/'/g, "''")}'`;
}

function nanoid(size = 12) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < size; i++) id += alphabet[Math.floor(Math.random() * alphabet.length)];
  return id;
}

function normalizeFacilityType(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toUpperCase();
  if (s.includes('CDF')) return 'CDF';
  if (s.includes('SPC')) return 'SPC';
  if (s.includes('DIGSA')) return 'DIGSA';
  if (s.includes('IGSA')) return 'IGSA';
  if (s.includes('USMS') || s.includes('MARSHAL')) return 'USMS';
  if (s.includes('BOP') || s.includes('BUREAU')) return 'BOP';
  if (s.includes('FAMILY')) return 'FRC';
  if (s.includes('HOLD')) return 'HOLD';
  if (s.includes('STAGING')) return 'STAGING';
  if (s.includes('STATE')) return 'STATE';
  return s.substring(0, 10);
}

const STREET_EXPANSIONS = [
  [/\bRD\.?\b/gi, 'Road'],
  [/\bST\.?\b/gi, 'Street'],
  [/\bAVE\.?\b/gi, 'Avenue'],
  [/\bBLVD\.?\b/gi, 'Boulevard'],
  [/\bHWY\.?\b/gi, 'Highway'],
  [/\bPKWY\.?\b/gi, 'Parkway'],
  [/\bDR\.?\b/gi, 'Drive'],
  [/\bLN\.?\b/gi, 'Lane'],
  [/\bCT\.?\b/gi, 'Court'],
  [/\bPL\.?\b/gi, 'Place'],
  [/\bCIR\.?\b/gi, 'Circle'],
  [/\bTRL\.?\b/gi, 'Trail']
];

const NAME_EXPANSIONS = [
  [/\bCTR\b/gi, 'Center'],
  [/\bCORR\b/gi, 'Correctional'],
  [/\bDET\b/gi, 'Detention'],
  [/\bINST\b/gi, 'Institution'],
  [/\bCO\b/gi, 'County'],
  [/\bDEPT\b/gi, 'Department'],
  [/\bFAC\b/gi, 'Facility'],
  [/\bPROC\b/gi, 'Processing'],
  [/\bIPC\b/gi, 'Processing Center'],
  [/\bMDC\b/gi, 'Metropolitan Detention Center'],
  [/\bFDC\b/gi, 'Federal Detention Center'],
  [/\bFCI\b/gi, 'Federal Correctional Institution']
];

function cleanAddress(addr) {
  if (!addr) return addr;
  let s = String(addr).trim();
  s = s.replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
  for (const [re, rep] of STREET_EXPANSIONS) s = s.replace(re, rep);
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function cleanName(name) {
  if (!name) return name;
  let s = String(name).trim();
  s = s.replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
  for (const [re, rep] of NAME_EXPANSIONS) s = s.replace(re, rep);
  s = s.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function buildQueryVariants(row) {
  const variants = [];
  const cleanedAddr = cleanAddress(row.address);
  const cleanedName = cleanName(row.name);

  if (row.address && row.city && row.state) {
    const p = [cleanedAddr, row.city, row.state];
    if (row.zip) p.push(row.zip);
    variants.push(p.join(', '));
  }
  if (row.address && row.city && row.state) {
    variants.push([cleanedAddr, row.city, row.state].join(', '));
  }
  if (cleanedName && row.city && row.state) {
    variants.push([cleanedName, row.city, row.state].join(', '));
  }
  if (row.name && row.city && row.state) {
    variants.push([row.name, row.city, row.state].join(', '));
  }
  if (row.city && row.state) {
    const p = [row.city, row.state];
    if (row.zip) p.push(row.zip);
    variants.push(p.join(', '));
  }
  if (row.zip && row.state) {
    variants.push(`${row.zip}, ${row.state}, USA`);
  }

  return [...new Set(variants)];
}

async function findInputFile() {
  if (inputPathArg) {
    const p = resolve(inputPathArg);
    if (!existsSync(p)) fail(`Input file not found: ${p}`);
    return p;
  }
  const candidates = [
    'ice-facilities.xlsx', 'ice-facilities.csv', 'ice-facilities.json',
    'facilities.xlsx', 'facilities.csv', 'facilities.json'
  ];
  for (const name of candidates) {
    const p = join(DATA_DIR, name);
    if (existsSync(p)) {
      ok(`Found input file: ${name}`);
      return p;
    }
  }
  fail('No input file found in scripts/data/. See docs/SEEDING.md');
}

async function loadXLSX() {
  let mod;
  try { mod = await import('xlsx'); }
  catch (err) { fail('xlsx required. npm install --no-save xlsx\n  ' + err.message); }
  const candidates = [mod.default, mod];
  for (const c of candidates) {
    if (c && typeof c.read === 'function' && c.utils) return c;
  }
  fail('Could not locate xlsx read()/utils on imported module.');
}

function rowsWithHeader(matrix, headerIdx) {
  if (headerIdx >= matrix.length) return [];
  const headers = matrix[headerIdx].map(h => (h == null ? '' : String(h).trim()));
  const rows = [];
  for (let i = headerIdx + 1; i < matrix.length; i++) {
    const cells = matrix[i];
    if (!cells || cells.every(c => c == null || c === '')) continue;
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      if (!headers[j]) continue;
      obj[headers[j]] = cells[j] ?? null;
    }
    rows.push(obj);
  }
  return rows;
}

function detectHeaderRow(matrix) {
  for (let i = 0; i < Math.min(matrix.length, 20); i++) {
    const row = matrix[i] || [];
    const cells = row.map(c => String(c || '').trim().toLowerCase());
    const hasName = cells.some(c => c === 'name' || c === 'facility name' || c === 'facility');
    const hasAddr = cells.some(c => c === 'address' || c === 'city' || c === 'state');
    if (hasName && hasAddr) return i;
  }
  return -1;
}

async function parseInput(path) {
  const ext = extname(path).toLowerCase();

  if (ext === '.json') {
    const raw = await readFile(path, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : (data.facilities || data.data || []);
  }
  if (ext === '.csv') {
    const raw = await readFile(path, 'utf8');
    return parseCSV(raw);
  }
  if (ext === '.xlsx' || ext === '.xls') {
    const XLSX = await loadXLSX();
    const buf = await readFile(path);
    const wb = XLSX.read(buf, { type: 'buffer' });
    log(`Workbook sheets: ${wb.SheetNames.join(', ')}`);
    const sheetName = wb.SheetNames.find(n => /facilit/i.test(n)) || wb.SheetNames[0];
    log(`Reading sheet: ${sheetName}`);
    const sheet = wb.Sheets[sheetName];
    const matrix = XLSX.utils.sheet_to_json(sheet, {
      header: 1, defval: null, blankrows: false, raw: true
    });
    log(`Sheet has ${matrix.length} raw rows`);
    if (flags.inspect) {
      console.log('\n  First 15 rows (raw):');
      for (let i = 0; i < Math.min(15, matrix.length); i++) {
        console.log(`  [${i}] ${JSON.stringify(matrix[i]).substring(0, 200)}`);
      }
      return [];
    }
    const headerIdx = detectHeaderRow(matrix);
    if (headerIdx === -1) fail('No header row found. Use --inspect to debug.');
    log(`Detected header row at index ${headerIdx}`);
    const rows = rowsWithHeader(matrix, headerIdx);
    log(`Data rows after header: ${rows.length}`);
    if (rows.length > 0) {
      const keys = Object.keys(rows[0]);
      log(`Column names: ${keys.slice(0, 8).join(', ')}${keys.length > 8 ? ', ...' : ''}`);
    }
    return rows;
  }
  fail(`Unsupported file extension: ${ext}`);
}

function parseCSV(raw) {
  const rows = [];
  const lines = raw.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  function parseLine(line) {
    const fields = [];
    let cur = '', inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuotes) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') { inQuotes = false; }
        else { cur += c; }
      } else {
        if (c === '"') inQuotes = true;
        else if (c === ',') { fields.push(cur); cur = ''; }
        else { cur += c; }
      }
    }
    fields.push(cur);
    return fields.map(f => f.trim());
  }
  const headers = parseLine(lines[0]);
  for (let i = 1; i < lines.length; i++) {
    const values = parseLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = values[idx] || null; });
    rows.push(obj);
  }
  return rows;
}

function normalizeFacility(row) {
  const lower = {};
  for (const [k, v] of Object.entries(row)) lower[String(k).toLowerCase().trim()] = v;
  const get = (...keys) => {
    for (const k of keys) {
      if (lower[k] !== undefined && lower[k] !== null && String(lower[k]).trim() !== '') {
        return String(lower[k]).trim();
      }
    }
    return null;
  };
  const name = get('name', 'facility name', 'detention facility', 'facility');
  if (!name) return null;
  if (/^(total|note|footnote)/i.test(name)) return null;
  return {
    name,
    address: get('address', 'street address', 'address line 1'),
    city: get('city'),
    state: get('state', 'st', 'state code'),
    zip: get('zip', 'zip code', 'postal code', 'zipcode'),
    facility_type: normalizeFacilityType(get('type detailed', 'type', 'facility type')),
    operator: get('operator', 'owner', 'contractor'),
    source_url: 'https://www.ice.gov/detain/detention-management'
  };
}

function dedupe(facilities) {
  const seen = new Map();
  for (const f of facilities) {
    const key = `${f.name}|${f.city || ''}|${f.state || ''}`.toLowerCase();
    if (!seen.has(key)) seen.set(key, f);
  }
  return Array.from(seen.values());
}

async function loadCache() {
  try {
    const raw = await readFile(CACHE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch { return {}; }
}

async function saveCache(cache) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');
}

async function geocodeOne(query) {
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '1');
  url.searchParams.set('countrycodes', 'us');

  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': NOMINATIM_USER_AGENT, 'Accept': 'application/json' }
    });
  } catch (err) {
    warn(`network error: ${err.message}`);
    return null;
  }
  if (!res.ok) { warn(`Nominatim ${res.status}`); return null; }
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) return null;
  const r = data[0];
  return { lat: parseFloat(r.lat), lon: parseFloat(r.lon), display_name: r.display_name };
}

async function geocodeWithFallback(row, cache, stats) {
  const variants = buildQueryVariants(row);
  if (variants.length === 0) {
    stats.failed++;
    return null;
  }
  const primaryKey = variants[0];

  if (cache[primaryKey] && cache[primaryKey].lat != null) {
    stats.cached++;
    return { lat: cache[primaryKey].lat, lon: cache[primaryKey].lon };
  }

  if (cache[primaryKey] && cache[primaryKey].failed && !flags.retryFails) {
    stats.cachedFails++;
    return null;
  }

  if (flags.cacheOnly) {
    stats.skipped++;
    return null;
  }

  for (let i = 0; i < variants.length; i++) {
    const q = variants[i];
    const label = `[${stats.done}/${stats.total}] ${row.name.substring(0, 38).padEnd(38)} variant ${i + 1}/${variants.length}`;
    process.stdout.write(`\r  ${label}`.padEnd(100));

    try {
      const result = await geocodeOne(q);
      if (result) {
        cache[primaryKey] = {
          lat: result.lat,
          lon: result.lon,
          display_name: result.display_name,
          winningQuery: q,
          variantIndex: i
        };
        stats.fresh++;
        if (i > 0) stats.freshByFallback++;
        await sleep(NOMINATIM_DELAY_MS);
        return { lat: result.lat, lon: result.lon };
      }
    } catch (err) {
      warn(`\nerror on "${q}": ${err.message}`);
    }
    await sleep(NOMINATIM_DELAY_MS);
  }

  cache[primaryKey] = { failed: true, failedAt: Date.now() };
  stats.failed++;
  return null;
}

async function geocodeAll(facilities) {
  const cache = await loadCache();
  const stats = {
    total: facilities.length, done: 0,
    cached: 0, cachedFails: 0, fresh: 0, freshByFallback: 0,
    failed: 0, skipped: 0
  };

  for (let i = 0; i < facilities.length; i++) {
    const f = facilities[i];
    stats.done = i + 1;
    const result = await geocodeWithFallback(f, cache, stats);
    if (result) { f.lat = result.lat; f.lon = result.lon; }
    else { f.lat = null; f.lon = null; }
    if ((i + 1) % 10 === 0) await saveCache(cache);
  }

  process.stdout.write('\n');
  await saveCache(cache);
  ok(`Geocoding: ${stats.fresh} fresh (${stats.freshByFallback} via fallback), ${stats.cached} cached hits, ${stats.cachedFails} cached-fails, ${stats.failed} failed`);
}

function buildSQL(facilities) {
  const now = Date.now();
  const lines = [];
  lines.push('-- OurALERT detention_facilities seed');
  lines.push(`-- Generated: ${new Date(now).toISOString()}`);
  lines.push(`-- Facilities: ${facilities.length}`);
  lines.push('');
  lines.push('DELETE FROM detention_facilities;');
  lines.push('');
  for (const f of facilities) {
    const id = `fac_${nanoid(10)}`;
    const sql = `INSERT INTO detention_facilities (id, name, address, city, state, zip, lat, lon, facility_type, operator, source_url, created_at, updated_at) VALUES (${sqlEscape(id)}, ${sqlEscape(f.name)}, ${sqlEscape(f.address)}, ${sqlEscape(f.city)}, ${sqlEscape(f.state)}, ${sqlEscape(f.zip)}, ${sqlEscape(f.lat)}, ${sqlEscape(f.lon)}, ${sqlEscape(f.facility_type)}, ${sqlEscape(f.operator)}, ${sqlEscape(f.source_url)}, ${now}, ${now});`;
    lines.push(sql);
  }
  return lines.join('\n');
}

async function main() {
  console.log('\n  OurALERT — Detention Facilities Seeder\n');
  await mkdir(DATA_DIR, { recursive: true });

  const inputPath = await findInputFile();
  log(`Input: ${inputPath}`);

  const raw = await parseInput(inputPath);
  if (flags.inspect) { log('Inspect mode — exiting.'); return; }
  log(`Parsed ${raw.length} raw rows`);

  let facilities = raw.map(normalizeFacility).filter(Boolean);
  log(`Normalized ${facilities.length} facilities`);
  facilities = dedupe(facilities);
  log(`Deduped to ${facilities.length} unique facilities`);

  if (facilities.length === 0) fail('No facilities parsed.');

  if (flags.noGeocode) {
    log('Skipping geocoding (--no-geocode)');
    for (const f of facilities) { f.lat = null; f.lon = null; }
  } else {
    log('Geocoding via Nominatim with progressive fallback (~1 req/sec)...');
    if (flags.retryFails) log('--retry-fails: ignoring cached failures');
    await geocodeAll(facilities);
  }

  const withCoords = facilities.filter(f => f.lat !== null && f.lon !== null).length;
  log(`Facilities with coordinates: ${withCoords}/${facilities.length} (${Math.round(100 * withCoords / facilities.length)}%)`);

  if (flags.dryRun) { log('Dry run — not writing SQL'); return; }

  const sql = buildSQL(facilities);
  await writeFile(OUTPUT_SQL, sql, 'utf8');
  ok(`Wrote ${OUTPUT_SQL}`);

  console.log('\n  Next — push to D1:');
  console.log('\n    npx wrangler d1 execute ouralert --remote --file=scripts/data/facilities.sql\n');
  console.log('  Verify:');
  console.log('\n    npx wrangler d1 execute ouralert --remote --command="SELECT COUNT(*) as n, COUNT(lat) as with_coords FROM detention_facilities;"\n');
}

main().catch(err => {
  console.error('\n  ✗  Fatal:', err.message);
  console.error(err.stack);
  process.exit(1);
});
