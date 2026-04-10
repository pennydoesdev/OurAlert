# Seeding Detention Facilities

This guide walks you through populating the `detention_facilities` table in D1 with the current list of ICE detention centers. You run this once at first deploy, and then roughly monthly when ICE updates its biweekly detention spreadsheet.

---

## What this is for

OurALERT's "Possible Facility" feature matches every approved report to the nearest known ICE detention center using haversine distance. For that to work, the `detention_facilities` table needs to be populated with every currently-in-use facility and its lat/lon coordinates.

ICE publishes a biweekly spreadsheet listing every active detention facility, but they do **not** include coordinates. So we download their list, parse it, and geocode the addresses ourselves using OpenStreetMap's free Nominatim service.

---

## Step 1 — Download the ICE biweekly detention facilities spreadsheet

1. Open **https://www.ice.gov/detain/detention-management** in your browser
2. Scroll down to the "Detention Statistics" section
3. Find the link labeled something like:
   > **Detention FY 2026 YTD, Alternatives to Detention FY 2026 YTD and Facilities FY 2026 YTD**
4. Click it to download the XLSX file
5. Move the downloaded file into your local OurAlert clone at:
   ```
   OurAlert/scripts/data/ice-facilities.xlsx
   ```

The filename must be exactly `ice-facilities.xlsx` (or `.csv` or `.json` — see below).

### Alternative sources if ICE's site is down or the format has changed

**Vera Institute** maintains a cleaned dataset with coordinates already included:
- https://github.com/Vera-Institute/ice-detention-trends
- Download their facilities CSV, rename to `ice-facilities.csv`, and run the script with `--no-geocode`

**Deportation Data Project** has FOIA-sourced data:
- https://deportationdata.org/data/ice.html

---

## Step 2 — Install the XLSX parser (first time only)

The script uses the `xlsx` package to read Excel files. It's a dev-only dependency so we don't save it to `package.json`:

```bash
npm install --no-save xlsx
```

If you're using a CSV or JSON source instead of XLSX, skip this step — those formats have no extra dependencies.

---

## Step 3 — Run the seeding script

From the OurAlert directory:

```bash
node scripts/seed-facilities.js
```

You'll see output like:

```
  OurALERT — Detention Facilities Seeder

  ✓  Found input file: ice-facilities.xlsx
  Input: /Users/you/OurAlert/scripts/data/ice-facilities.xlsx
  Reading sheet: Facilities
  Parsed 237 raw rows
  Normalized 237 facilities (dropped rows without a name)
  Deduped to 234 unique facilities
  Geocoding via Nominatim (rate-limited to 1 req/sec)...
  geocoding (1/234) Adelanto ICE Processing Center... ✓
  geocoding (2/234) Alamance County Detention Center... ✓
  ...
  ✓  Geocoding done: 231 new, 0 cached, 3 failed
  Facilities with coordinates: 231/234
  ✓  Wrote /Users/you/OurAlert/scripts/data/facilities.sql

  Next step — push to D1:

    npx wrangler d1 execute ouralert --remote --file=scripts/data/facilities.sql
```

**This takes about 5 minutes** because Nominatim's usage policy requires no more than 1 request per second. Let it run. If you see occasional "no match" failures for 2-3 facilities, that's normal — those addresses are sometimes ambiguous (e.g., a county jail with only a PO Box). You can manually fix those rows later in D1 if you want.

### Script flags

- `--no-geocode` — skip geocoding entirely; lat/lon will be NULL (useful for testing parsing)
- `--cache-only` — only use cached geocoding results; don't call Nominatim (useful for re-runs after a partial failure)
- `--dry-run` — parse and normalize but don't write the SQL file

---

## Step 4 — Push the SQL file to D1

Once `facilities.sql` exists:

```bash
npx wrangler d1 execute ouralert --remote --file=scripts/data/facilities.sql
```

You'll see a summary like:

```
🌀 Executing on remote database ouralert
🌀 Processed 235 queries.
🚣 Executed 235 queries in 78.23ms
```

The first query is `DELETE FROM detention_facilities;` (so you can safely re-run this script as many times as you want). The rest are INSERTs.

---

## Step 5 — Verify the data landed

```bash
npx wrangler d1 execute ouralert --remote --command="SELECT COUNT(*) as n, COUNT(lat) as with_coords FROM detention_facilities;"
```

You should see something like:

```
┌─────┬─────────────┐
│  n  │ with_coords │
├─────┼─────────────┤
│ 234 │     231     │
└─────┴─────────────┘
```

Also check a couple of specific rows:

```bash
npx wrangler d1 execute ouralert --remote --command="SELECT name, city, state, lat, lon FROM detention_facilities WHERE state = 'CA' LIMIT 5;"
```

---

## Updating the data later

When ICE publishes a new biweekly update (every 2 weeks), you don't have to do anything unless you want the latest facility list. To refresh:

1. Download the new XLSX from ice.gov
2. Replace `scripts/data/ice-facilities.xlsx` with the new file
3. Re-run `node scripts/seed-facilities.js`
4. Re-run the `wrangler d1 execute` command

The geocoding cache (`scripts/data/facilities-geocoded.json`) will be reused, so only genuinely new facilities will be sent to Nominatim. This makes re-runs fast — usually under 30 seconds.

---

## Troubleshooting

**"No input file found in scripts/data/"**
You haven't downloaded the spreadsheet yet, or it's saved under a different name. The script looks for `ice-facilities.xlsx`, `ice-facilities.csv`, `ice-facilities.json`, `facilities.xlsx`, `facilities.csv`, or `facilities.json`.

**"xlsx parsing requires the 'xlsx' package"**
Run `npm install --no-save xlsx` first.

**"Nominatim 429" or "Too Many Requests"**
You're hitting Nominatim too fast. The script already throttles to 1 req/sec but if you're running it in parallel with something else, stop the other process. You can also add more delay by editing `NOMINATIM_DELAY_MS` in the script.

**"no match" for many facilities**
Nominatim can't find some remote or PO-Box addresses. If more than 10% fail, try preprocessing the XLSX to clean up addresses (remove suite numbers, expand state abbreviations, etc.) before re-running.

**Some facilities have suspicious coordinates** (e.g., in the middle of the ocean)
Nominatim occasionally returns wrong results for ambiguous addresses. Open `scripts/data/facilities-geocoded.json`, delete the bad entries, and re-run the script. The script will re-geocode just the deleted entries.

---

## Privacy note

This script only sends facility **addresses** to Nominatim — no user data, no IPs, nothing identifiable about anyone. Nominatim is operated by the OpenStreetMap Foundation and their [usage policy](https://operations.osmfoundation.org/policies/nominatim/) is privacy-respecting.

The geocoding cache is stored locally in `scripts/data/facilities-geocoded.json` and is gitignored.
