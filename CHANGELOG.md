# Changelog

All notable changes to OurALERT will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to semantic versioning starting from v1.0.0.

Prior to v1.0.0, version numbers are of the form `v0.X.Y` where X is a phase
milestone and Y is a patch. Auto-generated entries are appended by the
`.github/workflows/changelog.yml` workflow on every push to `main`.

## [Unreleased]

### Fixed
- [`3f0f844`](https://github.com/pennydoesdev/OurAlert/commit/3f0f84492ca0025f17f9ba0faba8068296ca2811) **[fix]** seed-facilities: unwrap xlsx CommonJS default export, parse via buffer, add --inspect flag and better error messages

### Added
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
