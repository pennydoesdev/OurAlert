#!/usr/bin/env node
/**
 * seed-facilities.js — seed the detention_facilities table in D1.
 *
 * WHAT IT DOES
 *   1. Reads an ICE detention facilities source file from ./scripts/data/
 *      Accepts .xlsx (from ice.gov), .csv, or .json
 *   2. Parses each row into a normalized facility record
 *   3. Geocodes each facility's address via OpenStreetMap Nominatim
 *      (rate-limited to 1 req/sec per Nominatim's usage policy)
 *   4. Dedupes by (name + city + state)
 *   5. Writes a SQL file to ./scripts/data/facilities.sql
 *
 * USAGE
 *   # Download the latest ICE biweekly detention spreadsheet manually:
 *   #   https://www.ice.gov/detain/detention-management
 *   #   Look for "Detention FY 2026 YTD, Alternatives to Detention FY 2026 YTD and Facilities FY 2026 YTD"
 *   #   Save it as: scripts/data/ice-facilities.xlsx
 *
 *   # Then run:
 *   node scripts/seed-facilities.js
 *
 *   # Or pass an explicit path:
 *   node scripts/seed-facilities.js ./scripts/data/my-facilities.csv
 *
 *   # Or skip geocoding (useful for re-runs if you've already geocoded once):
 *   node scripts/seed-facilities.js --no-geocode
 *
 *   # Or use a pre-geocoded cache from a prior run:
 *   node scripts/seed-facilities.js --cache-only
 *
 *   # Inspect the parsed sheet structure without geocoding or writing SQL:
 *   node scripts/seed-facilities.js --inspect
 *
 * OUTPUT
 *   scripts/data/facilities-geocoded.json   — cached geocoding results (gitignored)
 *   scripts/data/facilities.sql             — the SQL INSERT statements (gitignored)
 *
 * EXECUTION AGAINST D1
 *   After the script finishes it prints the exact wrangler command to run.
 *   Typically:
 *     npx wrangler d1 execute ouralert --remote --file=scripts/data/facilities.sql
 *
 * DATA SOURCES TRIED (in order of preference)
 *   1. ICE's own biweekly detention spreadsheet (authoritative)
 *      https://www.ice.gov/detain/detention-management
 *   2. Vera Institute's cleaned dataset
 *      https://github.com/Vera-Institute/ice-detention-trends
 *   3. Deportation Data Project
 *      https://deportationdata.org/data/ice.html
 *
 * PRIVACY NOTE
 *   Nominatim gets the facility address only. No user data is sent anywhere.
 *   We cache results so we don't hammer Nominatim on re-runs.
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
const NOMINATIM_DELAY_MS = 1100; // 1 req/sec + a little buffer

// ────────────────────────────────────────────────────────────────────────────
// ARG PARSING
// ────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flags = {
  noGeocode: args.includes('--no-geocode'),
  cacheOnly: args.includes('--cache-only'),
  dryRun: args.includes('--dry-run'),
  inspect: args.includes('--inspect')
};
const inputPathArg = args.find(a => !a.startsWith('--'));

// ────────────────────────────────────────────────────────────────────────────
// UTILITIES
// ────────────────────────────────────────────────────────────────────────────

function log(msg) { console.log(`  ${msg}`); }
function warn(msg) { console.warn(`  ⚠  ${msg}`); }
function fail(msg) { console.error(`\n  ✗  ${msg}\n`); process.exit(1); }
function ok(msg) { console.log(`  ✓  ${msg}`); }

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

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
  return s.substring(0, 10);
}

function buildFullAddress(row) {
  const parts = [];
  if (row.address) parts.push(row.address);
  if (row.city) parts.push(row.city);
  if (row.state) parts.push(row.state);
  if (row.zip) parts.push(row.zip);
  return parts.filter(Boolean).join(', ');
}

// ────────────────────────────────────────────────────────────────────────────
// INPUT PARSING
// ────────────────────────────────────────────────────────────────────────────

async function findInputFile() {
  if (inputPathArg) {
    const p = resolve(inputPathArg);
    if (!existsSync(p)) fail(`Input file not found: ${p}`);
    return p;
  }

  const candidates = [
    'ice-facilities.xlsx',
    'ice-facilities.csv',
    'ice-facilities.json',
    'facilities.xlsx',
    'facilities.csv',
    'facilities.json'
  ];

  for (const name of candidates) {
    const p = join(DATA_DIR, name);
    if (existsSync(p)) {
      ok(`Found input file: ${name}`);
      return p;
    }
  }

  fail(
    'No input file found in scripts/data/.\n\n' +
    '  Download ICE\'s biweekly detention facilities spreadsheet from:\n' +
    '    https://www.ice.gov/detain/detention-management\n\n' +
    '  Save it as: scripts/data/ice-facilities.xlsx\n\n' +
    '  Then re-run: node scripts/seed-facilities.js\n'
  );
}

async function loadXLSX() {
  // xlsx is a CommonJS package and under ESM dynamic imports it shows up
  // under `.default` in most node versions. Handle both shapes.
  let mod;
  try {
    mod = await import('xlsx');
  } catch (err) {
    fail(
      'xlsx parsing requires the "xlsx" package.\n\n' +
      '  Install it with:\n' +
      '    npm install --no-save xlsx\n\n' +
      '  Or convert your .xlsx to .csv and save as scripts/data/ice-facilities.csv\n\n' +
      '  Original error: ' + err.message + '\n'
    );
  }
  // Try in order: the default export, then the module itself.
  const candidates = [mod.default, mod];
  for (const candidate of candidates) {
    if (candidate && typeof candidate.read === 'function' && candidate.utils) {
      return candidate;
    }
  }
  fail(
    'Could not locate xlsx\'s read() / utils on the imported module.\n' +
    '  Top-level keys: ' + Object.keys(mod).join(', ') + '\n' +
    '  Try: rm -rf node_modules package-lock.json && npm install && npm install --no-save xlsx\n'
  );
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

    // Read the file as a buffer and parse — more portable than XLSX.readFile,
    // which depends on xlsx's own fs shim that is flaky under ESM.
    const buf = await readFile(path);
    const wb = XLSX.read(buf, { type: 'buffer' });

    log(`Workbook sheets: ${wb.SheetNames.join(', ')}`);

    // ICE's spreadsheet has multiple sheets; "Facilities" is the one we want
    const sheetName = wb.SheetNames.find(n => /facilit/i.test(n)) || wb.SheetNames[0];
    log(`Reading sheet: ${sheetName}`);
    const sheet = wb.Sheets[sheetName];

    if (flags.inspect) {
      // Dump the first 15 rows with raw cell refs so we can see the structure
      const all = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, blankrows: false });
      log(`Sheet has ${all.length} rows total`);
      console.log('\n  First 15 rows (header:1):');
      for (let i = 0; i < Math.min(15, all.length); i++) {
        console.log(`  [${i}] ${JSON.stringify(all[i]).substring(0, 200)}`);
      }
      return [];
    }

    // ICE's header row varies by release. Try several offsets and pick the
    // one that produces rows whose keys include a "name"-like column.
    for (const headerRow of [6, 7, 5, 4, 3, 2, 1, 0]) {
      try {
        const rows = XLSX.utils.sheet_to_json(sheet, { range: headerRow, defval: null });
        if (rows.length === 0) continue;
        const keys = Object.keys(rows[0]).map(k => String(k).toLowerCase());
        const hasName = keys.some(k => k.includes('name') || k.includes('facility'));
        if (hasName) {
          log(`Detected header row at offset ${headerRow}`);
          log(`Columns: ${keys.slice(0, 10).join(', ')}${keys.length > 10 ? ', ...' : ''}`);
          return rows;
        }
      } catch {}
    }
    // Last-resort fallback: return whatever comes out of the default parse
    warn('Could not auto-detect header row. Using default parse.');
    return XLSX.utils.sheet_to_json(sheet, { defval: null });
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

// ────────────────────────────────────────────────────────────────────────────
// NORMALIZATION
// ────────────────────────────────────────────────────────────────────────────

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

// ────────────────────────────────────────────────────────────────────────────
// GEOCODING (Nominatim, rate-limited, cached)
// ────────────────────────────────────────────────────────────────────────────

async function loadCache() {
  try {
    const raw = await readFile(CACHE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
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
  return {
    lat: parseFloat(result.lat),
    lon: parseFloat(result.lon),
    display_name: result.display_name
  };
}

async function geocodeAll(facilities) {
  const cache = await loadCache();
  let newCount = 0;
  let cachedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < facilities.length; i++) {
    const f = facilities[i];
    const address = buildFullAddress(f);
    if (!address) {
      f.lat = null; f.lon = null;
      failedCount++;
      continue;
    }

    if (cache[address]) {
      f.lat = cache[address].lat;
      f.lon = cache[address].lon;
      cachedCount++;
      continue;
    }

    if (flags.cacheOnly) {
      f.lat = null; f.lon = null;
      failedCount++;
      continue;
    }

    process.stdout.write(`  geocoding (${i + 1}/${facilities.length}) ${f.name.substring(0, 50)}...`);

    try {
      const result = await geocodeOne(address);
      if (result) {
        f.lat = result.lat;
        f.lon = result.lon;
        cache[address] = result;
        newCount++;
        process.stdout.write(` ✓\n`);
      } else {
        f.lat = null; f.lon = null;
        failedCount++;
        process.stdout.write(` ✗ (no match)\n`);
      }
    } catch (err) {
      warn(`geocode failed for "${address}": ${err.message}`);
      f.lat = null; f.lon = null;
      failedCount++;
    }

    if ((i + 1) % 10 === 0) await saveCache(cache);

    await sleep(NOMINATIM_DELAY_MS);
  }

  await saveCache(cache);
  ok(`Geocoding done: ${newCount} new, ${cachedCount} cached, ${failedCount} failed`);
}

// ────────────────────────────────────────────────────────────────────────────
// SQL GENERATION
// ────────────────────────────────────────────────────────────────────────────

function buildSQL(facilities) {
  const now = Date.now();
  const lines = [];

  lines.push('-- OurALERT detention_facilities seed');
  lines.push(`-- Generated: ${new Date(now).toISOString()}`);
  lines.push(`-- Source: ICE biweekly detention spreadsheet`);
  lines.push(`-- Facilities: ${facilities.length}`);
  lines.push('');
  lines.push('-- Clear existing data (safe re-run)');
  lines.push('DELETE FROM detention_facilities;');
  lines.push('');
  lines.push('-- Insert facilities');

  for (const f of facilities) {
    const id = `fac_${nanoid(10)}`;
    const sql = `INSERT INTO detention_facilities (id, name, address, city, state, zip, lat, lon, facility_type, operator, source_url, created_at, updated_at) VALUES (${sqlEscape(id)}, ${sqlEscape(f.name)}, ${sqlEscape(f.address)}, ${sqlEscape(f.city)}, ${sqlEscape(f.state)}, ${sqlEscape(f.zip)}, ${sqlEscape(f.lat)}, ${sqlEscape(f.lon)}, ${sqlEscape(f.facility_type)}, ${sqlEscape(f.operator)}, ${sqlEscape(f.source_url)}, ${now}, ${now});`;
    lines.push(sql);
  }

  return lines.join('\n');
}

// ────────────────────────────────────────────────────────────────────────────
// MAIN
// ────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n  OurALERT — Detention Facilities Seeder\n');

  await mkdir(DATA_DIR, { recursive: true });

  const inputPath = await findInputFile();
  log(`Input: ${inputPath}`);

  const raw = await parseInput(inputPath);
  if (flags.inspect) {
    log('Inspect mode — exiting before normalization.');
    return;
  }
  log(`Parsed ${raw.length} raw rows`);

  let facilities = raw.map(normalizeFacility).filter(Boolean);
  log(`Normalized ${facilities.length} facilities (dropped rows without a name)`);

  facilities = dedupe(facilities);
  log(`Deduped to ${facilities.length} unique facilities`);

  if (facilities.length === 0) {
    fail(
      'No facilities parsed. Run with --inspect to see the raw sheet structure:\n\n' +
      '    node scripts/seed-facilities.js --inspect\n\n' +
      '  Then paste the first 15 rows to debug.'
    );
  }

  if (flags.noGeocode) {
    log('Skipping geocoding (--no-geocode)');
    for (const f of facilities) { f.lat = null; f.lon = null; }
  } else {
    log('Geocoding via Nominatim (rate-limited to 1 req/sec)...');
    await geocodeAll(facilities);
  }

  const withCoords = facilities.filter(f => f.lat !== null && f.lon !== null).length;
  log(`Facilities with coordinates: ${withCoords}/${facilities.length}`);

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
