# Changelog

All notable changes to OurALERT will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to semantic versioning starting from v1.0.0.

Prior to v1.0.0, version numbers are of the form `v0.X.Y` where X is a phase
milestone and Y is a patch. Auto-generated entries are appended by the
`.github/workflows/changelog.yml` workflow on every push to `main`.

## [Unreleased]

### Fixed
- [`a37e822`](https://github.com/pennydoesdev/OurAlert/commit/a37e822fe1589c3ed633a7923be3c2ef937e1b61) **[fix]** wrangler.toml: unique cron expressions (*/3 for fan-out), comment out custom_domain routes until first deploy succeeds, set Turnstile test site key, bump version tag
- [`e9921ed`](https://github.com/pennydoesdev/OurAlert/commit/e9921edf09657145cc7a06830480b5bb25c79a63) **[fix]** collapse duplicate */5 cron to a single tick; jobs will be dispatched in code based on event.cron
- [`9090aaf`](https://github.com/pennydoesdev/OurAlert/commit/9090aaf355818dd881bc0a54b0123bc3524d42a5) **[fix]** seed-facilities: progressive geocoding fallback with abbreviation expansion, name+city fallback, zip-only last resort, and negative cache with --retry-fails flag
- [`8941137`](https://github.com/pennydoesdev/OurAlert/commit/8941137861fc4980472209d5f284d7749fa7dfd5) **[fix]** seed-facilities: 4-strategy geocoding fallback (full → cleaned → named → coarse) with abbreviation expansion to recover failed lookups
- [`ce2cb81`](https://github.com/pennydoesdev/OurAlert/commit/ce2cb81ac1b378e9d20f2ea187d994ec3d50f169) **[fix]** seed-facilities: read sheet as raw matrix and manually detect header row to bypass merged-cell confusion
- [`3f0f844`](https://github.com/pennydoesdev/OurAlert/commit/3f0f84492ca0025f17f9ba0faba8068296ca2811) **[fix]** seed-facilities: unwrap xlsx CommonJS default export, parse via buffer, add --inspect flag and better error messages

### Added
- [`adfe79b`](https://github.com/pennydoesdev/OurAlert/commit/adfe79babb09a753f4209bf616d705c8339d3398) **[worker]** db.js: add 24h public window + pin override to listReportsInBox/getPublicReport, add getFullReport and listReportsInTimeRange for admin/analytics paths
- [`26a5ed8`](https://github.com/pennydoesdev/OurAlert/commit/26a5ed80ff2a149a130903dc4b33894bfe750596) **[db]** add 24h window (pinned_until, hidden_from_public), SSO fields (auth_provider, workos_user_id), api_keys, api_key_usage, trend_snapshots, public_exports_cache tables
- [`621431c`](https://github.com/pennydoesdev/OurAlert/commit/621431c2f0cf88d8c8d64f6eccd5fd6f09be1aca) **[frontend]** add robots.txt blocking AI training crawlers from report content
- [`e8deaf8`](https://github.com/pennydoesdev/OurAlert/commit/e8deaf891c4ca41167588fc29228b7e2d3d90a7b) **[worker]** add index.js entry point with router, asset serving, security headers, and scheduled() stub
- [`815ed14`](https://github.com/pennydoesdev/OurAlert/commit/815ed140912e7f3df8a0be7e4177ba7c3de7bd31) **[worker]** add reports.js with list, get, and create endpoints including Turnstile verify, nearest-facility matching, and moderation queue entry
- [`887ee0e`](https://github.com/pennydoesdev/OurAlert/commit/887ee0e496453cab7c5660657811e78a7a56b9ad) **[worker]** add upload.js with simple and multipart R2 uploads, Turnstile verify, EXIF stripping on images
- [`ed2e1a0`](https://github.com/pennydoesdev/OurAlert/commit/ed2e1a03fa89fd3fad2e519eb465995c7b4f7a34) **[worker]** add geocode.js route for zip and freeform address lookup via Nominatim with D1+KV caching
- [`db022f2`](https://github.com/pennydoesdev/OurAlert/commit/db022f2771122a85856a91cf9c720d4c11c36f05) **[worker]** add facilities.js route with nearest-N lookup, bounding-box pre-filter, and 1h KV cache
- [`833910b`](https://github.com/pennydoesdev/OurAlert/commit/833910bd0862831bedee8b14792badda1a77645b) **[worker]** add exif.js with EXIF/metadata stripping for JPEG, PNG, and WebP (privacy-critical)
- [`193012a`](https://github.com/pennydoesdev/OurAlert/commit/193012a67e27152ab18c6972f5ef1c01ef80cfe0) **[worker]** add db.js with D1 query/exec/batch helpers and report/facility fetch functions
- [`2441a5b`](https://github.com/pennydoesdev/OurAlert/commit/2441a5bee3bfda7ad872a5bb864bc61cdfc60efe) **[worker]** add turnstile.js with siteverify wrapper, test-key fallback, and structured result
- [`5f2192c`](https://github.com/pennydoesdev/OurAlert/commit/5f2192cda52622bac01fc9238ca0bef5f39609b4) **[worker]** add rate-limit.js with per-scope tumbling windows backed by D1 rate_limits table
- [`555b684`](https://github.com/pennydoesdev/OurAlert/commit/555b68459468c1534f3fb63426df5a43c7539835) **[worker]** add kv.js with cache helpers, prefix invalidation, and standard TTLs
- [`55a293d`](https://github.com/pennydoesdev/OurAlert/commit/55a293d6a583b38749d38e55107c9d2685ead464) **[worker]** add validation.js with report submission validator and common type guards
- [`9e802fd`](https://github.com/pennydoesdev/OurAlert/commit/9e802fd771b89582480c9c98b8e129ca14386d53) **[worker]** add haversine.js with distance math, bounding box helper, and nearest-N selector
- [`ff54844`](https://github.com/pennydoesdev/OurAlert/commit/ff5484494b331b650bdd9d5a9afa76df05345e9e) **[worker]** add hash.js with sha256, hmac, IP hashing, and client-IP extraction
- [`5b34934`](https://github.com/pennydoesdev/OurAlert/commit/5b34934b37c49af1efd8d245cc1d878b56bc9965) **[worker]** add nanoid.js for short unique ID generation using Workers crypto
- [`192893a`](https://github.com/pennydoesdev/OurAlert/commit/192893a34c3b0e2b1dc325b311474b63c46358fd) **[worker]** add response.js with json/error helpers, CORS, and safe() wrapper
- [`2773914`](https://github.com/pennydoesdev/OurAlert/commit/27739141e766136534f591eeb2aaceeae8f9288f) **[docs]** add full seeding walkthrough covering download, geocode, push to D1, and refresh workflow
- [`c62a405`](https://github.com/pennydoesdev/OurAlert/commit/c62a405f94e24ad051a9d0b413bee21ab072e573) **[init]** expand .gitignore to exclude all scripts/data/ except README and .gitkeep
- [`c57c630`](https://github.com/pennydoesdev/OurAlert/commit/c57c630e8718f8ebc383ad994effb8068bf890ed) **[docs]** add scripts/data/README with source download instructions and alternate datasets
- [`fa69dc9`](https://github.com/pennydoesdev/OurAlert/commit/fa69dc9d5c3074b3fc5e091ab37568013ffd29d9) **[scripts]** add seed-facilities.js with xlsx/csv/json parsing, Nominatim geocoding, caching, and D1 SQL output
- [`6b9b0ab`](https://github.com/pennydoesdev/OurAlert/commit/6b9b0abcaef05a14367df2c2d347b144ebb7359c) **[infra]** wire real D1 database_id and KV namespace id into wrangler.toml
- [`2b2caa3`](https://github.com/pennydoesdev/OurAlert/commit/2b2caa3c38788f81931565528802540fab403129) **[ci]** activate auto-changelog and deploy workflows
- Initial project scaffold: README, LICENSE, privacy policy, D1 schema
- GitHub Actions workflows for automated changelog and deployment
- Admin bootstrap documentation

[Unreleased]: https://github.com/pennydoesdev/OurAlert/compare/main...HEAD
