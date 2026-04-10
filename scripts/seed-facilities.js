#!/usr/bin/env node
/**
 * seed-facilities.js — seed the detention_facilities table in D1.
 *
 * Geocodes facilities via Nominatim with 4 fallback strategies:
 *   1. Full original address
 *   2. Cleaned/expanded abbreviations (CTR -> Center, RD. -> Road, etc.)
 *   3. Named institution lookup ("<facility name>, <city>, <state>")
 *   4. Coarse fallback ("<city>, <state>, <zip>")
 *
 * Cached, rate-limited to 1 req/sec, idempotent.
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
  inspect: args.includes('--inspect')
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

const ABBREVIATIONS = [
  [/\bRD\.?\b/gi, 'Road'],
  [/\bST\.?\b/gi, 'Street'],
  [/\bAVE\.?\b/gi, 'Avenue'],
  [/\bBLVD\.?\b/gi, 'Boulevard'],
  [/\bDR\.?\b/gi, 'Drive'],
  [/\bLN\.?\b/gi, 'Lane'],
  [/\bCT\.?\b/gi, 'Court'],
  [/\bPL\.?\b/gi, 'Place'],
  [/\bPKWY\.?\b/gi, 'Parkway'],
  [/\bHWY\.?\b/gi, 'Highway'],
  [/\bFWY\.?\b/gi, 'Freeway'],
  [/\bTRL\.?\b/gi, 'Trail'],
  [/\bN\.?\s/g, 'North '],
  [/\bS\.?\s/g, 'South '],
  [/\bE\.?\s/g, 'East '],
  [/\bW\.?\s/g, 'West '],
  [/\bCTR\.?\b/gi, 'Center'],
  [/\bDET\.?\b/gi, 'Detention'],
  [/\bCORR\.?\b/gi, 'Correctional'],
  [/\bCORRS\.?\b/gi, 'Corrections'],
  [/\bINST\.?\b/gi, 'Institution'],
  [/\bFED\.?\b/gi, 'Federal'],
  [/\bDEPT\.?\b/gi, 'Department'],
  [/\bCO\.?\b/gi, 'County'],
  [/\bCNTY\.?\b/gi, 'County'],
  [/\bFAC\.?\b/gi, 'Facility'],
  [/\bSTE\.?\b/gi, 'Suite'],
  [/\s+/g, ' ']
];

function expandAbbreviations(text) {
  if (!text) return text;
  let out = String(text);
  for (const [pattern, replacement] of ABBREVIATIONS) {
    out = out.replace(pattern, replacement);
  }
  return out.trim().replace(/\.+$/, '');
}

function buildQueries(f) {
  const queries = [];
  const full = [f.address, f.city, f.state, f.zip].filter(Boolean).join(', ');
  if (full) queries.push({ q: full, strategy: 'full' });
  const cleanedAddr = expandAbbreviations(f.address);
  const cleaned = [cleanedAddr, f.city, f.state, f.zip].filter(Boolean).join(', ');
  if (cleaned && cleaned !== full) queries.push({ q: cleaned, strategy: 'cleaned' });
  const cleanedName = expandAbbreviations(f.name);
  const named = [cleanedName, f.city, f.state].filter(Boolean).join(', ');
  if (named) queries.push({ q: named, strategy: 'named' });
  const coarse = [f.city, f.state, f.zip].filter(Boolean).join(', ');
  if (coarse) queries.push({ q: coarse, strategy: 'coarse' });
  return queries;
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
  fail('No input file found in scripts/data/. Save as scripts/data/ice-facilities.xlsx');
}

async function loadXLSX() {
  let mod;
  try {
    mod = await import('xlsx');
  } catch (err) {
    fail('xlsx required: npm install --no-save xlsx\n  Original: ' + err.message);
  }
  for (const candidate of [mod.default, mod]) {
    if (candidate && typeof candidate.read === 'function' && candidate.utils) {
      return candidate;
    }
  }
  fail('Could not locate xlsx read()/utils on the imported module.');
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
    return parseCSV(await readFile(path, 'utf8'));
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
    if (headerIdx === -1) fail('Could not locate a header row. Run with --inspect to debug.');
    log(`Detected header row at index ${headerIdx}`);
    const rows = rowsWithHeader(matrix, headerIdx);
    log(`Data rows after header: ${rows.length}`);
    if (rows.length > 0) {
      const cols = Object.keys(rows[0]);
      log(`Column names: ${cols.slice(0, 8).join(', ')}${cols.length > 8 ? ', ...' : ''}`);
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
  try { return JSON.parse(await readFile(CACHE_PATH, 'utf8')); } catch { return {}; }
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
  const res = await fetch(url, {
    headers: { 'User-Agent': NOMINATIM_USER_AGENT, 'Accept': 'application/json' }
  });
  if (!res.ok) {
    warn(`Nominatim ${res.status} for: ${query}`);
    return null;
  }
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) return null;
  const result = data[0];
  return { lat: parseFloat(result.lat), lon: parseFloat(result.lon), display_name: result.display_name };
}

async function geocodeFacility(f, cache) {
  const queries = buildQueries(f);
  for (const { q } of queries) {
    if (cache[q]) return { lat: cache[q].lat, lon: cache[q].lon, strategy: 'cache' };
  }
  for (let i = 0; i < queries.length; i++) {
    const { q, strategy } = queries[i];
    try {
      const result = await geocodeOne(q);
      if (result) {
        cache[q] = result;
        return { lat: result.lat, lon: result.lon, strategy };
      }
    } catch (err) {
      warn(`geocode error for "${q}": ${err.message}`);
    }
    if (i < queries.length - 1) await sleep(NOMINATIM_DELAY_MS);
  }
  return null;
}

async function geocodeAll(facilities) {
  const cache = await loadCache();
  let stats = { full: 0, cleaned: 0, named: 0, coarse: 0, cache: 0, failed: 0 };

  for (let i = 0; i < facilities.length; i++) {
    const f = facilities[i];

    if (flags.cacheOnly) {
      const queries = buildQueries(f);
      let found = false;
      for (const { q } of queries) {
        if (cache[q]) {
          f.lat = cache[q].lat; f.lon = cache[q].lon;
          stats.cache++; found = true; break;
        }
      }
      if (!found) { f.lat = null; f.lon = null; stats.failed++; }
      continue;
    }

    const queries = buildQueries(f);
    let cached = null;
    for (const { q } of queries) {
      if (cache[q]) { cached = cache[q]; break; }
    }
    if (cached) {
      f.lat = cached.lat; f.lon = cached.lon;
      stats.cache++;
      continue;
    }

    process.stdout.write(`  geocoding (${i + 1}/${facilities.length}) ${f.name.substring(0, 50)}...`);
    const result = await geocodeFacility(f, cache);
    if (result) {
      f.lat = result.lat; f.lon = result.lon;
      stats[result.strategy]++;
      process.stdout.write(` ✓ (${result.strategy})\n`);
    } else {
      f.lat = null; f.lon = null;
      stats.failed++;
      process.stdout.write(` ✗\n`);
    }

    if ((i + 1) % 10 === 0) await saveCache(cache);
    await sleep(NOMINATIM_DELAY_MS);
  }

  await saveCache(cache);
  ok(
    `Geocoding done: ${stats.cache} cached, ${stats.full} full, ` +
    `${stats.cleaned} cleaned, ${stats.named} named, ${stats.coarse} coarse, ` +
    `${stats.failed} failed`
  );
}

function buildSQL(facilities) {
  const now = Date.now();
  const lines = [
    '-- OurALERT detention_facilities seed',
    `-- Generated: ${new Date(now).toISOString()}`,
    `-- Source: ICE biweekly detention spreadsheet`,
    `-- Facilities: ${facilities.length}`,
    '',
    'DELETE FROM detention_facilities;',
    ''
  ];
  for (const f of facilities) {
    const id = `fac_${nanoid(10)}`;
    lines.push(
      `INSERT INTO detention_facilities (id, name, address, city, state, zip, lat, lon, facility_type, operator, source_url, created_at, updated_at) VALUES (${sqlEscape(id)}, ${sqlEscape(f.name)}, ${sqlEscape(f.address)}, ${sqlEscape(f.city)}, ${sqlEscape(f.state)}, ${sqlEscape(f.zip)}, ${sqlEscape(f.lat)}, ${sqlEscape(f.lon)}, ${sqlEscape(f.facility_type)}, ${sqlEscape(f.operator)}, ${sqlEscape(f.source_url)}, ${now}, ${now});`
    );
  }
  return lines.join('\n');
}

async function main() {
  console.log('\n  OurALERT — Detention Facilities Seeder\n');
  await mkdir(DATA_DIR, { recursive: true });

  const inputPath = await findInputFile();
  log(`Input: ${inputPath}`);

  const raw = await parseInput(inputPath);
  if (flags.inspect) { log('Inspect mode — exiting before normalization.'); return; }
  log(`Parsed ${raw.length} raw rows`);

  let facilities = raw.map(normalizeFacility).filter(Boolean);
  log(`Normalized ${facilities.length} facilities (dropped rows without a name)`);
  facilities = dedupe(facilities);
  log(`Deduped to ${facilities.length} unique facilities`);

  if (facilities.length === 0) {
    fail('No facilities parsed. Run with --inspect to see the raw sheet structure.');
  }

  if (flags.noGeocode) {
    log('Skipping geocoding (--no-geocode)');
    for (const f of facilities) { f.lat = null; f.lon = null; }
  } else {
    log('Geocoding via Nominatim with 4-strategy fallback (rate-limited to 1 req/sec)...');
    await geocodeAll(facilities);
  }

  const withCoords = facilities.filter(f => f.lat !== null && f.lon !== null).length;
  log(`Facilities with coordinates: ${withCoords}/${facilities.length} (${Math.round(100 * withCoords / facilities.length)}%)`);

  if (flags.dryRun) {
    log('Dry run — not writing SQL file');
    console.log(JSON.stringify(facilities.slice(0, 5), null, 2));
    return;
  }

  const sql = buildSQL(facilities);
  await writeFile(OUTPUT_SQL, sql, 'utf8');
  ok(`Wrote ${OUTPUT_SQL}`);

  console.log('\n  Next step — push to D1:');
  console.log('\n    npx wrangler d1 execute ouralert --remote --file=scripts/data/facilities.sql\n');
  console.log('  Verify with:');
  console.log('\n    npx wrangler d1 execute ouralert --remote --command="SELECT COUNT(*) as n FROM detention_facilities;"\n');
}

main().catch(err => {
  console.error('\n  ✗  Fatal error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
