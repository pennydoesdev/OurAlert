# OurALERT

> Community eyes. Protected neighbors.

**[ouralert.org](https://ouralert.org)** — a community-powered, privacy-first platform for reporting ICE and military enforcement activity in real time.

OurALERT is built and maintained by [Penny Tribune](https://thepennytribune.com), an independent digital newsroom, with support from volunteer moderators and rapid response networks.

---

## Why this matters

Every day, Immigration and Customs Enforcement conducts operations in communities across the United States. Families are separated. Neighbors disappear. Court dates are missed because no one knew where someone was taken. And the official information pipeline — detention locators, press releases, FOIA responses — runs on timelines measured in weeks, not minutes.

Rapid response networks have shown that the gap between "someone just got picked up" and "an attorney is on the phone" is often the single biggest factor in whether a person has a fighting chance at due process. That gap closes with real-time, community-sourced information.

OurALERT exists to close that gap.

We are not a replacement for lawyers, legal aid organizations, or established rapid response networks. **We are a signal layer that feeds them faster information so they can do their work sooner.** Our data is community-submitted, moderator-reviewed, and openly available to anyone working in the immigrant defense space — attorneys, journalists, organizers, family members, or neighbors.

## How you can help

**We need three things: reporters, volunteers, and developers.**

### Reporters
If you see ICE or military enforcement activity in your neighborhood, submit an anonymous report at [ouralert.org](https://ouralert.org). No account required, no personal information collected, no tracking. Photos, videos, and a short description are all it takes. Safety first — never put yourself at risk to document an incident.

### Volunteers
We are building a team of volunteer moderators who review incoming reports, verify image metadata, run reverse image searches, and cross-reference with rapid response networks. If you have time to give and care about community safety, apply at [ouralert.org/volunteer](https://ouralert.org/volunteer). All volunteer accounts require two-factor email verification and are subject to a code of conduct.

### Developers
OurALERT is open source under the MIT license. Pull requests, bug reports, and security disclosures are all welcome. See [Local Development](#local-development) below to get started. If you find a security issue, please email `security@ouralert.org` before filing a public issue.

### Donate
OurALERT is hosted by Penny Tribune and operated on a nonprofit basis. If you would like to support infrastructure costs (Cloudflare, detention center data sourcing, volunteer training), donation information will be posted at [ouralert.org/support](https://ouralert.org/support) when available.

---

## Features (v0.1)

- **Interactive map** of community-submitted reports, powered by Leaflet and OpenStreetMap — no proprietary map APIs, no tracking
- **Anonymous reporting** with photo, video, and description upload; no account required
- **Automatic detention center matching** — every report is matched against a database of ICE detention facilities to identify the nearest "Possible Facility"
- **Moderation queue** with volunteer verification workflow, reverse image search helpers, and metadata inspection
- **Two-factor volunteer authentication** via email one-time codes
- **Email alerts** within a chosen zip code radius (25mi / 50mi / 100mi), with double opt-in and one-click unsubscribe
- **Push notifications** via OneSignal — instant alerts when a new report is approved near your zip code, with quiet hours support
- **AlertIQ daily digest** — AI-generated summary of the last 24 hours of activity in your area, powered by Featherless
- **Progressive Web App** — installable on mobile and desktop, works offline
- **First-party analytics dashboard** — GA-style reports, built and owned entirely by us, no third-party trackers
- **Know Your Rights** page with resources from the Immigrant Legal Resource Center (ILRC)
- **Privacy-first** — no cookies, no IP storage, no cross-session tracking, no third-party analytics

---

## Tech stack

- **Runtime:** Cloudflare Workers
- **Database:** Cloudflare D1 (SQLite at the edge)
- **Storage:** Cloudflare R2 (photo and video uploads)
- **Cache:** Cloudflare KV (hot analytics buffer, zip code cache, rate limits)
- **Map:** Leaflet 1.9 + OpenStreetMap tiles
- **Geocoding:** Nominatim (OpenStreetMap's free geocoder)
- **Captcha:** Cloudflare Turnstile
- **Email:** Amazon SES or Loops.so (configurable per email type)
- **Push:** OneSignal Web Push
- **AI:** Featherless.ai for AlertIQ digest generation
- **Frontend:** Vanilla JavaScript, no framework, single-file SPA
- **Analytics:** Fully in-house, written from scratch against D1

## Local development

```bash
# Install dependencies
npm install

# Authenticate with Cloudflare
npx wrangler login

# Create D1 database (first time only)
npx wrangler d1 create ouralert

# Run schema migrations
npx wrangler d1 execute ouralert --remote --file=src/schema.sql

# Create R2 bucket
npx wrangler r2 bucket create ouralert-media

# Create KV namespace
npx wrangler kv:namespace create ouralert-cache

# Set secrets
npx wrangler secret put TURNSTILE_SECRET
npx wrangler secret put SES_ACCESS_KEY_ID
npx wrangler secret put SES_SECRET_ACCESS_KEY
npx wrangler secret put LOOPS_API_KEY
npx wrangler secret put FEATHERLESS_API_KEY
npx wrangler secret put ONESIGNAL_APP_ID
npx wrangler secret put ONESIGNAL_REST_KEY
npx wrangler secret put IP_SALT
npx wrangler secret put SESSION_SECRET

# Deploy
npx wrangler deploy
```

After first deploy, see `docs/ADMIN_BOOTSTRAP.md` to create your first admin account.

## Project structure

```
OurAlert/
├── src/                   # Worker source
│   ├── index.js           # Entry + router
│   ├── routes/            # Route handlers
│   ├── lib/               # Shared utilities (auth, email, analytics, etc.)
│   └── schema.sql         # D1 schema
├── public/                # Static frontend assets (served by Worker)
│   ├── index.html
│   ├── app.js
│   ├── app.css
│   ├── sw.js
│   ├── manifest.json
│   └── assets/
├── scripts/               # One-off tooling
│   ├── seed-facilities.js
│   └── hash-password.js
├── docs/                  # Operations docs
├── .github/workflows/     # CI/CD
└── wrangler.toml
```

---

## Privacy posture

OurALERT is designed to be safe for both reporters and the people they report about.

**We do not:**
- Store IP addresses in their raw form (hashed + salted, 7-day auto-expiry, rate limiting only)
- Use cookies for any purpose
- Track users across sessions
- Share data with third-party analytics providers
- Collect user agents, browser fingerprints, or device identifiers
- Publish reports until a volunteer has reviewed them

**We do:**
- Strip EXIF metadata (including GPS coordinates) from all uploaded photos before storage
- Require an explicit consent checkbox before publishing any arrestee name
- Operate a public takedown process via `takedown@ouralert.org`
- Maintain a moderation queue with full volunteer action logs for accountability
- Publish all reports under an "Alleged Sighting — Not Confirmed" disclaimer until independently verified

See [PRIVACY.md](./PRIVACY.md) for the full privacy policy.

## Safety and moderation

OurALERT has zero tolerance for:
- Violence, threats, or calls to violence
- Illegal acts
- Scams or fundraising fraud
- Doxxing of minors or uninvolved civilians
- Use of the platform to harass any community

See [docs/SAFETY.md](./docs/SAFETY.md) for the full moderation policy.

## License

- **Code:** MIT License — see [LICENSE](./LICENSE)
- **Content and data:** Creative Commons Attribution-ShareAlike 4.0 (CC-BY-SA 4.0)

## Contact

- **General:** `hello@ouralert.org`
- **Security disclosures:** `security@ouralert.org`
- **Takedowns:** `takedown@ouralert.org`
- **Press:** `press@ouralert.org`
- **Built by:** [Penny Tribune](https://thepennytribune.com)

## Acknowledgments

OurALERT is inspired by the work of People Over Papers, ICE Tracker, and the volunteer rapid response networks across the country. Detention facility data is sourced from the [Deportation Data Project](https://deportationdata.org) and ICE's own biweekly detention statistics. Know Your Rights content is based on materials from the [Immigrant Legal Resource Center](https://www.ilrc.org).

We stand on the shoulders of everyone who has been doing this work for decades.
