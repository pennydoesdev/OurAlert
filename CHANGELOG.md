# Changelog

All notable changes to OurALERT will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to semantic versioning starting from v1.0.0.

Prior to v1.0.0, version numbers are of the form `v0.X.Y` where X is a phase
milestone and Y is a patch. Auto-generated entries are appended by the
`.github/workflows/changelog.yml` workflow on every push to `main`.

## [Unreleased]

### Added
- [`c57c630`](https://github.com/pennydoesdev/OurAlert/commit/c57c630e8718f8ebc383ad994effb8068bf890ed) **[docs]** add scripts/data/README with source download instructions and alternate datasets
- [`fa69dc9`](https://github.com/pennydoesdev/OurAlert/commit/fa69dc9d5c3074b3fc5e091ab37568013ffd29d9) **[scripts]** add seed-facilities.js with xlsx/csv/json parsing, Nominatim geocoding, caching, and D1 SQL output
- [`6b9b0ab`](https://github.com/pennydoesdev/OurAlert/commit/6b9b0abcaef05a14367df2c2d347b144ebb7359c) **[infra]** wire real D1 database_id and KV namespace id into wrangler.toml
- [`2b2caa3`](https://github.com/pennydoesdev/OurAlert/commit/2b2caa3c38788f81931565528802540fab403129) **[ci]** activate auto-changelog and deploy workflows
- Initial project scaffold: README, LICENSE, privacy policy, D1 schema
- GitHub Actions workflows for automated changelog and deployment
- Admin bootstrap documentation

[Unreleased]: https://github.com/pennydoesdev/OurAlert/compare/main...HEAD
