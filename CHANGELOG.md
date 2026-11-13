# Changelog

## 0.3.1 — 2026-11-13

- **API plan setting** (`read-all`, `standard`, `enterprise`) for the connector and gateway, so cloud requests are paced to your Open Dental plan (1 per 5 s, 1 per s, 1 per 0.5 s). Gateway also accepts an exact `minIntervalMs`.
- **Per-app upload limit** in the gateway (`apps[].maxBodyBytes`), for apps that upload documents.
- Gateway answers oversized uploads with 413 instead of resetting the connection (fixes Windows clients).
- Docs: which Open Dental API plan you need for each feature, and a warning that Open Dental's user permissions don't restrict API changes.

## 0.3.0 — 2026-11-13

First public release.

- **Claude connector** as a Claude desktop extension (`opendental.mcpb`): 12 read tools and 6 change tools (changes off by default), built-in report catalog (`od_list_reports`, `od_run_report`), read-only custom SQL.
- **Claude plugin** with skills for schedule, patient lookup, billing/A-R and production/collections.
- **App gateway**: per-app keys and permissions, pass-through to the Open Dental API, built-in reports, optional read-only SQL, SSN redaction, rate limits, audit log, CORS allowlist, optional HTTPS.
- Shared core: no redirects, private-network-only http, strict ID/date validation, bounded retries honoring Retry-After, request pacing for the cloud API, response size limits.
- Zero-dependency build script and test suite.
