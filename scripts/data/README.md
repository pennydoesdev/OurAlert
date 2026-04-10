# scripts/data/

This directory holds source data for the seeding scripts. **Everything in here except this README and `.gitkeep` is gitignored.** Don't commit detention facility data back to the repo — download fresh each time.

## For `seed-facilities.js`

Download ICE's biweekly detention facilities spreadsheet from:

**https://www.ice.gov/detain/detention-management**

On that page, look for the link that says something like:

> **Detention FY 2026 YTD, Alternatives to Detention FY 2026 YTD and Facilities FY 2026 YTD**

Save the file as one of these exact names (the script auto-detects):

- `ice-facilities.xlsx` (recommended — raw ICE spreadsheet)
- `ice-facilities.csv` (if you've converted to CSV in Excel/Numbers)
- `ice-facilities.json` (if you have a pre-processed JSON source)

Then run:

```bash
node scripts/seed-facilities.js
```

## Output files (auto-generated, gitignored)

- `facilities-geocoded.json` — Nominatim geocoding cache. Reused on subsequent runs so we don't hit Nominatim again for facilities we've already looked up.
- `facilities.sql` — the final SQL INSERT file to push to D1.

## Alternative data sources

If ICE stops publishing, changes the format, or you want a pre-cleaned dataset with lat/lon already included:

- **Vera Institute** — https://github.com/Vera-Institute/ice-detention-trends — has a maintained facility list with coordinates
- **Deportation Data Project** — https://deportationdata.org/data/ice.html — FOIA-sourced raw data

For Vera's dataset, download their CSV, rename it to `ice-facilities.csv`, and run the script with `--no-geocode` since Vera already includes lat/lon (just make sure the column names match: `name`, `city`, `state`, `lat`, `lon`).
