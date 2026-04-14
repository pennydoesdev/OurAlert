# OurALERT — Project Handoff Document

**Last updated:** 2026-04-14
**Purpose:** Full project state for resuming work in a fresh Claude chat, Cowork session, or new developer onboarding. Paste this at the start of a new conversation and say "continue where this left off."

---

## What OurALERT is

**OurALERT** (ouralert.org) is a privacy-first platform for real-time ICE and military enforcement reporting, built by **Penny Tribune** (thepennytribune.com). Tagline: *"Community eyes. Protected neighbors."*

The platform lets anyone anonymously submit sighting reports (location, photos, description, nearest detention facility auto-matched), which are then moderated by volunteers and displayed on a public map for 24 hours. Subscribers receive email/push alerts for activity in their zip code radius, plus a daily AI-generated digest ("AlertIQ") summarizing activity near them.

Inspired by rapid response networks and the work of People Over Papers.

---

## Stack (locked)

- **Runtime:** Cloudflare Workers (wrangler 4.81.1)
- **Database:** D1 — name `ouralert`, id `548714f1-d169-433d-b530-f2d7e0d56d42`
- **Storage:** R2 bucket `ouralert-media`
- **KV:** namespace `ouralert-cache`, id `98e719e25b7d422f8894d06b39bd6cfb`
- **Map:** Leaflet + OpenStreetMap tiles, Nominatim for geocoding
- **Captcha:** Cloudflare Turnstile (using test key `1x00000000000000000000AA` until real widget is set up)
- **Email:** SES + Loops.so (dual-provider via EmailSender abstraction)
- **Push notifications:** OneSignal Web Push
- **AI (digest + trends):** Featherless.ai, branded as "AlertIQ"
- **SSO:** WorkOS for v0.1; Google Workspace Enterprise SAML via WorkOS Directory Sync in Phase 2
- **Analytics:** Fully in-house, first-party only — GA4-style tags, 6-tab admin dashboard, funnels/cohorts/retention, NO third-party trackers (explicitly no PostHog, no GA, no Jetpack)
- **Deployment:** Cloudflare Workers Builds (GitHub → CF auto-deploy, no GitHub Actions)

---

## Infrastructure identifiers

- **Cloudflare account:** Penelopes Workspace
- **Account ID:** `e9647a01787b681c8b116ffc2649e12c`
- **Cloudflare email:** penelopemiarose@gmail.com
- **Workers.dev subdomain:** `itsmiarosemathews`
- **Worker URL (live):** `https://ouralert.itsmiarosemathews.workers.dev`
- **Target custom domain:** `ouralert.org` (on CF but NOT yet bound to the Worker — route block commented out in wrangler.toml)
- **GitHub repo:** `https://github.com/pennydoesdev/OurAlert` (private)
- **Local clone path:** `~/Documents/Dev Tools/OurAlert/`
- **Developer handle:** pennydoesdev
- **Contact email:** hello@ouralert.org

---

## Privacy posture (locked, "spirit" interpretation)

- **IP addresses:** hashed with SHA-256 + `IP_SALT` secret, 7-day expiry, used ONLY for rate limiting
- **Country code:** from Cloudflare `CF-IPCountry` header, aggregated rollups only
- **Device class:** derived from UA string at parse time, UA itself never stored
- **No cookies:** volunteer sessions use localStorage tokens + server-side session table
- **EXIF stripping:** all uploaded images get EXIF/metadata stripped before R2 storage (JPEG, PNG, WebP all handled in `src/lib/exif.js`)
- **Anonymous reporters always:** no accounts required, no identifying fields requested
- **Arrestee names:** require explicit `arrestee_consent` checkbox on submission

---

## Phase plan (v0.1 = 22 phases, ~17 remaining)

### Complete

- ✅ **Phase 1a** — Repo scaffold, schema (28 tables), docs, GitHub workflows
- ✅ **Phase 1b** — Detention facility seeding: 203 ICE facilities parsed from FY26 biweekly spreadsheet, 202 geocoded via Nominatim with progressive fallback (99.5% success)
- ✅ **Phase 1c** — Worker core: static serving, routes for reports CRUD, R2 media upload, geocoding, nearest facility lookup, rate limiting, Turnstile verification, EXIF stripping
- ✅ **Phase 1c-bis** — Schema additions: 24h public window (`pinned_until`, `hidden_from_public`), SSO fields (`auth_provider`, `workos_user_id`), and 4 new tables: `api_keys`, `api_key_usage`, `trend_snapshots`, `public_exports_cache`. Also updated `src/lib/db.js` with `publicVisibilityClause()`, `getFullReport()`, `listReportsInTimeRange()`, and window-aware `listReportsInBox()`.

### Remaining (in order)

4. **Phase 1d** — Analytics batch endpoint + KV hot buffer
5. **Phase 1e** — Analytics cron jobs: drain, rollups, weekly cohorts, nightly cleanup
6. **Phase 1f** — Volunteer auth with PBKDF2 + 2FA email OTP + moderation endpoints
7. **Phase 1f-bis** — WorkOS SSO as alternate auth path
8. **Phase 1g** — Email sender abstraction (SES + Loops). **DEPLOYMENT VERIFICATION CHECKPOINT**
9. **Phase 1h** — Subscribers + zip-radius alert fan-out + OneSignal push
10. **Phase 1i** — AlertIQ daily digest via Featherless
11. **Phase 1j** — Frontend shell: Leaflet map, reports list, filters, search
12. **Phase 1k** — Frontend: add-report modal, media upload UI, Turnstile widget
13. **Phase 1l** — Frontend: volunteer portal + login + 2FA + moderation queue UI
14. **Phase 1m** — Frontend: admin analytics dashboard (6 tabs)
15. **Phase 1n** — **Hub & Trends** public page
16. **Phase 1o** — Admin trends dashboard with Featherless AlertIQ summaries
17. **Phase 1p** — **API key system**: admin-granted, /api/public/* (aggregated), /api/v1/* (key-gated + POST)
18. **Phase 1q** — PWA: manifest, service worker, icons
19. **Phase 1r** — /rights ILRC page, final privacy policy
20. **Phase 1s** — Final deploy, smoke test, handoff

---

## Decisions locked (do NOT re-litigate)

- **Analytics:** Tier 2+, GA4-style tags, in-house, NO third-party trackers ever
- **Captcha:** Turnstile
- **Admin bootstrap:** Manual D1 INSERT, hash from `scripts/hash-password.js`
- **GitHub repo:** private
- **License:** MIT for code, CC-BY-SA 4.0 for content
- **Deploy flow:** Cloudflare Workers Builds (no GitHub Actions)
- **24h public window:** pin to extend, stay in D1 forever
- **Public API privacy:** aggregated-only, key-gated API returns full data
- **API tier structure:** FREE FOREVER
- **SSO flavor:** WorkOS for v0.1, hard NO to rolling our own SAML
- **AI on images:** DEFERRED to post-v0.1
- **OG tags:** static in Phase 1c-bis extension, admin-editable in Phase 1m

---

## Current deployment state

- ✅ Worker `ouralert` exists on Cloudflare
- ✅ Worker code is deployed (Phase 1c confirmed by pulling bundle from CF)
- ✅ Worker URL active: `https://ouralert.itsmiarosemathews.workers.dev`
- ✅ Secrets set: `IP_SALT`, `SESSION_SECRET`
- ✅ D1 bindings: `DB` → ouralert (203 facilities, 202 geocoded)
- ✅ R2 bindings: `MEDIA` → ouralert-media
- ✅ KV bindings: `CACHE` → namespace id `98e719e25b7d422f8894d06b39bd6cfb`
- ✅ 9 cron triggers registered (all unique)
- ✅ Workers Builds connected to pennydoesdev/OurAlert main
- ❌ Custom domain ouralert.org NOT YET BOUND (intentionally deferred)
- ❓ Phase 1c-bis commits (26a5ed8 + adfe79b) deployment status UNCONFIRMED

## Secrets still needed

- `TURNSTILE_SECRET` (create widget first)
- `SES_*` (4 secrets, after domain verification)
- `LOOPS_API_KEY`
- `FEATHERLESS_API_KEY`
- `ONESIGNAL_APP_ID`, `ONESIGNAL_REST_KEY`
- `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`
- `ADMIN_NOTIFY_EMAIL`

---

## Database schema (28 tables)

Located at `src/schema.sql`. Domain groups: reports, rate-limiting, volunteer auth, subscribers, email queue, analytics (12 tables), API keys, trends.

## Code files

### `src/`
- `index.js` — Worker entry, router, scheduled() stub
- `schema.sql` — full idempotent schema

### `src/lib/`
- `response.js` — json/error/CORS/safe helpers
- `nanoid.js` — short ID gen
- `hash.js` — sha256, hmac, hashIp, getClientIp
- `haversine.js` — distance math, bounding box
- `validation.js` — report body validator
- `kv.js` — cache helpers, standard TTLs
- `rate-limit.js` — D1-backed tumbling windows, 7 scopes
- `turnstile.js` — siteverify wrapper
- `db.js` — D1 helpers + publicVisibilityClause + window-aware queries
- `exif.js` — JPEG/PNG/WebP metadata stripper (SAFETY-CRITICAL)

### `src/routes/`
- `facilities.js` — GET /api/facilities/nearest
- `geocode.js` — GET /api/geocode (zip/query)
- `upload.js` — simple + multipart R2 uploads with EXIF strip
- `reports.js` — list, get single, create

### `public/`
- `index.html` — branded coming-soon page
- `robots.txt` — blocks AI training crawlers

### `scripts/`
- `seed-facilities.js` — 5-variant fallback geocoder
- `hash-password.js` — PBKDF2 for admin bootstrap
- `data/ice-facilities.xlsx` — source data
- `data/facilities.sql` — seeded SQL
- `data/facilities-geocoded.json` — geocode cache

### Root
- `README.md`, `LICENSE` (MIT), `PRIVACY.md`, `CHANGELOG.md`
- `wrangler.toml` — all bindings and 9 unique cron triggers
- `package.json` — lint script

---

## Routes currently live in Phase 1c

| Route | Method | Status |
|---|---|---|
| `/health` | GET | ✅ Live |
| `/` | GET | ✅ Live (coming-soon page) |
| `/robots.txt` | GET | ✅ Live |
| `/api/reports` | GET | ✅ Live |
| `/api/reports` | POST | ✅ Live |
| `/api/reports/:id` | GET | ✅ Live |
| `/api/geocode?zip=` | GET | ✅ Live |
| `/api/geocode?q=` | GET | ✅ Live |
| `/api/facilities/nearest` | GET | ✅ Live |
| `/api/upload/simple` | POST | ✅ Live |
| `/api/upload/init|part|complete|abort` | POST | ✅ Live |

Stubs (return 501 "not implemented"): /api/analytics/*, /api/volunteer/*, /api/admin/*, /api/subscribe, /api/v1/*, /api/public/*

---

## Rate limit scopes

| Scope | Limit | Window |
|---|---|---|
| report | 5 | 10 min |
| login | 5 | 10 min |
| subscribe | 3 | 1 hour |
| batch | 120 | 1 min |
| upload | 20 | 10 min |
| geocode | 30 | 1 min |
| nearest | 60 | 1 min |

---

## Cron triggers

```
*/2 * * * *    drain analytics KV buffer to D1
*/3 * * * *    fan-out new-report alerts
*/5 * * * *    drain email queue
*/15 * * * *   analytics rollups
0 * * * *      hourly funnels + retention
30 * * * *     rate-limit cleanup, expired OTPs
0 3 * * *      nightly cleanup (events > 30d, IPs > 7d)
0 0 * * 0      weekly cohort computation
0 13 * * *     AlertIQ daily digest fan-out
```

---

## Open tasks for next session (priority order)

### Immediate verification

1. **Smoke test Phase 1c.** Paste into browser:
   - `https://ouralert.itsmiarosemathews.workers.dev/health`
   - `https://ouralert.itsmiarosemathews.workers.dev/`
   - `https://ouralert.itsmiarosemathews.workers.dev/api/facilities/nearest?lat=40.7589&lon=-73.9851&limit=3`
   - `https://ouralert.itsmiarosemathews.workers.dev/api/geocode?zip=11102`
   - `https://ouralert.itsmiarosemathews.workers.dev/api/reports`

2. **Verify Phase 1c-bis schema.** Run:
   ```bash
   npx wrangler d1 execute ouralert --remote --command="PRAGMA table_info(reports);"
   ```
   Look for `pinned_until` and `hidden_from_public`. If missing:
   ```bash
   npx wrangler d1 execute ouralert --remote --file=src/schema.sql
   ```

3. **Trigger a Workers Builds rebuild** via a trivial commit to confirm auto-deploy.

### Begin Phase 1d

- `POST /api/analytics/batch` endpoint
- KV hot buffer, key pattern `buf:events:YYYYMMDDHHMM:<nanoid>`
- Validation: ≤50 events per batch, ≤2 KB per event
- Rate limit scope: `batch`
- Cron drain already wired at `*/2 * * * *`

---

## Guard rails (things NOT to do)

- ❌ No PostHog, GA4, Fathom, Plausible, or any third-party analytics
- ❌ No raw IP storage anywhere
- ❌ No public AI chat interface
- ❌ No AI training dataset without ethics review
- ❌ No self-rolled SAML — use WorkOS
- ❌ Do not enable `routes` in wrangler.toml until ouralert.org is bound
- ❌ No paid API tier
- ❌ No GitHub Actions for deploy (use Workers Builds)
- ❌ Do not reproduce arrestee names without `arrestee_consent = true`

---

## Known issues

1. Schema migration state on live D1 unknown — verify before assuming
2. Latest 2 commits may not be deployed — check CF Deployments tab
3. Turnstile is using the public test key — create real widget before prod
4. Minor dead code in `src/routes/facilities.js` line 49 — lint noise, not a bug
5. Connector cannot modify `.github/workflows/` files — use local clone

---

## Prompting style (developer preferences)

- Direct honest pushback over agreement
- Step-by-step debugging walkthroughs
- Explicit scope warnings before feature additions
- Interactive choice lists for decisions (2-4 options each)
- Verbatim terminal output, not summaries
- Commit message format: `[scope] description`

---

## Suggested opening prompt for next chat

```
I'm continuing work on OurALERT (https://github.com/pennydoesdev/OurAlert),
a privacy-first ICE enforcement reporting platform on Cloudflare Workers.
Full state below — read it before any action. Last phase: 1c-bis. Next: 1d.

Run the 6 browser smoke tests in "Open tasks" first. If any fail, debug
before proceeding.

[paste full handoff doc]
```

---

Built by Penny Tribune (pennydoesdev). Inspired by rapid response networks and the work of People Over Papers.
