# Changelog

## 0.4.0 — 2026-11-14

- **Chart notes and treatment planning** in the Claude connector (15 new tools):
  - Read: progress notes, procedures, procedure notes, medical summary (allergies, medications, premedication, problems), treatment plans with their procedures, procedure-code lookup, treatment priorities and diagnoses.
  - Write (new **Allow chart changes** setting, off by default): visit group notes across the day's completed procedures, addenda to procedure or group notes, treatment-planned procedures (code, tooth, surfaces, range, priority, diagnosis, note), changing or removing planned procedures, creating and renaming treatment plans and grouping procedures into them.
  - Built-in limits: never signs; only appends to notes; group notes only cover completed procedures of the named patient; only treatment-planned procedures can be changed or removed; saved (presented) plans are left alone; every target is checked against the patient first.
- New **od-clinical** skill describing the office workflow (group notes for the day's completed procedures, the dentist decides and Claude records).
- "Allow changes" is now labeled **Allow schedule changes**.

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
