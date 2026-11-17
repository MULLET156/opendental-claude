# Changelog

## 0.12.0 — 2026-11-16

- **Reports return only what the pages show** (issue #6, item 5; SITE-OUTLINE.md). Removed columns, for module agents:
  - `daysheet`: ProvNum, ProvHyg, OpNum, ScheduledFee
  - `unscheduled_treatment`: ProvNum, Provider, AptNum; **added** `PatientOldestDateTP` (the Unscheduled page's oldest plan date)
  - `no_future_appointment`: PriProv, Provider
  - `xray_history`: CountLast12Months, Carrier, and the PA category (the Daysheet shows BWX, FMX and Pano)
  - `insurance_remaining`: GroupName, BenefitYearStart, AnnualMax, Used (Remaining is still worked out from them)
  - `unsigned_notes`: Descript, ProvNum, NoteEntered
- **TrueNAS gateway now uses a Cloudflare Tunnel instead of Tailscale Funnel** (issue #6, Ryan's choice). `docs/truenas.md` covers moving toledodentalcare.com's DNS from GoDaddy to Cloudflare without breaking the website or email, creating the tunnel, and its address (`https://od-gateway.toledodentalcare.com`). `gateway/truenas/compose.yaml` adds a `cloudflared` service; its token goes in TrueNAS, never in GitHub.
- Behind a trusted local proxy, the gateway reads Cloudflare's `CF-Connecting-IP` for the visitor's address (for the wrong-key lockout), then `X-Forwarded-For`.
- `runReport()` returns exactly a report's declared columns, so nothing extra leaves the gateway even when the SQL reads more.

## 0.11.1 — 2026-11-16

- The gateway image is published as `ghcr.io/mullet156/opendental-claude` (named after the repository, so GitHub lets the release workflow publish it). The TrueNAS guide and compose file use the new name.

## 0.11.0 — 2026-11-16

- **Gateway on TrueNAS SCALE, through Tailscale Funnel** (issue #6; guide: `docs/truenas.md`). New image `ghcr.io/mullet156/opendental-claude` (published with each regular release) and a TrueNAS "Install via YAML" file (`gateway/truenas/compose.yaml`). It listens only on the NAS itself; the Tailscale app publishes it.
- **Self-updating:** the image runs `gateway/runner.js`, which checks GitHub once a day for a newer regular release (never test builds), verifies it against the release's new `SHA256SUMS`, checks it accepts the config, switches, and confirms `/health` answers with the new version, or goes back to the working version and never retries that one. `AUTO_UPDATE=off` turns it off.
- **`node gateway/cli.js init <folder> --stage design`** writes a design-stage config with a key and preset per TDC Office module, an `.env` to fill in, and a private `module-keys.txt`.
- **Safer when reachable from the internet:** after 10 wrong app keys from one address in 10 minutes, that address waits 15 minutes. `trustProxy` can list the proxy addresses whose `X-Forwarded-For` is believed (e.g. `["127.0.0.1", "::1"]` for Tailscale on the same box).
- Releases also include `opendental-gateway-<version>.tar.gz` (Linux) and `SHA256SUMS`. CI builds the image and checks its `/health`.

## 0.10.0 — 2026-11-16

- **Gateway stage** (CONTRACT.md §1, issue #6): `"stage": "design" | "live"` in the gateway config (Windows setup: `STAGE=` in `settings.txt`); unset means live, so a forgotten setting fails safe. `/health` reports `"stage"` (and still `"fake"`). The demo gateway says `"stage": "design"`. `checkStage()` now follows the stage: a design-stage module accepts the office gateway serving Open Dental's demo database, not only the fake demo.
- **Ryan's hygiene codes** are the default: D0120, D0140, D0150, D0210, D0272, D0274, D1110, D1120, D1206, D1208, D4341, D4342, D4346, D4355, D4910. One office-wide setting, `hygieneCodes` in the gateway config, applies to `unscheduled_treatment` and `no_future_appointment` (whose planned total now leaves hygiene out).
- **Demo gateway starts on Hostinger** (issue #5): the fake Open Dental now answers in-process instead of as a second web server, which LiteSpeed's `lsnode` took over.

## 0.9.0 — 2026-11-15

For the TDC Office web apps (design stage). See `docs/tdc-office.md`.

- **Gateway mode for `core/`:** `createClient({ gatewayUrl, gatewayKey })` (or `createGatewayClient`) gives the same client interface, but every call goes through the gateway with the module's own key. The existing tools (notes, group notes, planning, priorities, status, read-back checks) work unchanged. `runReport()` runs a named report on any client (gateway, direct or demo). `checkStage()` makes a module refuse to start in `TDC_STAGE=design` unless the gateway is the fake one.
- **Demo gateway with fake data:** `npm start` (Hostinger Node.js app) and `npm run dev` / `start-demo.cmd` (this computer, published test keys). A made-up office with a schedule today, planned treatment, insurance maximums and x-ray limits, benefits used, unsigned notes and lab cases; writes work and show up in reports. It never talks to real Open Dental and refuses Open Dental keys. `/health` now includes `"fake"` (always `false` on the real gateway).
- **Reports:** `daysheet`, `unscheduled_treatment` (hygiene left out by default; `reportDefaults` in the gateway config can set the office's list), `no_future_appointment`, `xray_history` (last BWX/FMX/pano/PA, the plan's frequency limit and next-covered date), `insurance_remaining` (an estimate), `unsigned_notes`. Reports now list their output columns.
- **Module presets:** `node gateway/cli.js new-key daysheet` (also `finder`, `voice`, `numbers`) prints a config entry with that module's narrowest permissions. Only Voice Charting may write.
- **`scripts/sync-core.js`** for module repos: copies `core/` at a released version (or a test build) into `vendor/opendental-core/` with `VERSION` and `CHECKSUMS`.
- The Windows gateway download leaves out the demo.
- **Lab tracker sync can send the patient number** (was 0.8.3): with `"sendPatNum": true` in `labSync` (Windows setup: `SEND_PATIENT_NUMBER=yes` in `settings.txt`), each case also carries Open Dental's PatNum so staff can find the patient. Off by default; date of birth, chart number and other Open Dental numbers are still never sent.

## 0.8.2 — 2026-11-14

- **Windows setup reads `settings.txt`:** fill in the keys and lab sync settings in Notepad before running `Setup.cmd`, and Setup uses them instead of asking. The only stop left is pasting a new shared secret into the tracker's `config.php`, and none if `SHARED_SECRET` is filled in. Values are checked: a key with a label or punctuation, an unknown lab number or a bad date makes Setup say why and ask instead. Once saved securely, the keys and secret are blanked out of `settings.txt`, and a copy without them is kept in `C:\OpenDentalGateway` for next time. On later runs, `SYNC_START_DATE=today` keeps the start date already saved.

## 0.8.1 — 2026-11-14

- **Windows setup:** each Open Dental key is entered in a small pop-up window, where Ctrl+V and right-click → Paste work normally and a **Show** box lets you check it. Paste in PowerShell's hidden prompt didn't work in some windows. The console prompt remains as a fallback.
- CI checks the setup script under Windows PowerShell 5.1.

## 0.8.0 — 2026-11-14 (test builds only)

- **Lab tracker sync** (gateway): keeps a web-hosted lab tracker in step with Open Dental's lab cases. Cases added in Open Dental appear in the tracker (patient as "J. Smith" or "J.S." only; no DOB, chart number or Open Dental record numbers); when every step is done Open Dental's case is marked Checked and the seat appointment gets a "ready to deliver" note; for outside labs the tracker's sent date marks the case Sent. Office-initiated over HTTPS, signed with a shared secret (HMAC-SHA256, 5-minute window, replay protection); every write is read back. Off unless `labSync` is configured. See `docs/lab-tracker-sync.md`.
- Gateway CLI: `new-secret` and `lab-sync [--dry-run]`. A gateway can run with only the lab sync and no apps.
- New report `lab_cases_for_sync`.
- **Windows setup:** new download `opendental-gateway-windows-<version>.zip`. Extract it and double-click `Setup.cmd`: it installs the gateway with its own Node.js (checksum-verified), asks for and tests the Open Dental keys, sets up the lab tracker sync (lab list, shared secret copied for config.php, preview before sending), and runs the gateway at startup. Run it again to change settings or update. Pasted keys are cleaned of spaces, line breaks, quotes and invisible characters; if a key still looks wrong, Setup says why without showing it and offers to show the typing. Guide: `docs/install-gateway-windows.md`.
- `.env` and config files saved by Notepad with a byte-order mark now load.

## 0.7.0 — 2026-11-14

Fixes and gaps found in live testing.

- **Fix:** `od_update_planned_procedure` didn't change priority. Open Dental's procedure update ignores the text `priority`/`dxName` fields; the connector now resolves priority and diagnosis names to their definition numbers on every create and update. `"none"` clears a priority.
- **Every write is read back.** Procedures, plan items, tooth markings, lab cases, appointments and commlogs are re-read after saving; if Open Dental didn't apply a change, the tool fails with "did not apply … Treat this change as NOT made" instead of reporting success.
- **Treatment-plan order:** new `od_set_treatment_plan_priorities` sets plan-item priorities for groups of procedures in one confirmed call (validated before any change). `od_add_to_treatment_plan` updates the priority of procedures already on the plan instead of failing. Procedure priority and plan-item priority are kept in sync by default.
- **Lab cases:** `od_update_lab_case_status` takes `overwrite: true` to replace a recorded date; `od_update_lab_case` can unlink an appointment or planned appointment; `od_mark_lab_cases_received` takes `received_date` and `overwrite_received` to re-date cases (preview shows old and new dates). New report `lab_cases_received_on_appointment_date`.
- **Schedule:** `od_find_open_slots` removes or trims slots that overlap blockouts and lists them; `od_break_appointment` takes `break_type` (Missed → D9986, Cancelled → D9987, when set up in Appts Preferences) and only breaks Scheduled appointments; reschedule notes the placeholder-time quirk.
- Docs: Open Dental API behaviors found in live testing (priority on update, broken-appointment adjustment, blockouts, placeholder times, `REPEAT()`).

## 0.6.0 — 2026-11-14

- **Procedure status** (needs **Allow chart changes**):
  - `od_chart_procedure`: chart a procedure as complete, existing (current or other provider), referred, or condition, with tooth, surfaces, date, diagnosis, optional appointment and note.
  - `od_set_procedure_status`: complete a planned procedure or move it between planned, existing, referred and condition. Completed and deleted procedures are never changed. Completing reports that the fee posted.
- **Tooth chart**: `od_get_tooth_chart` (missing, hidden, primary positions, movements) and `od_set_tooth_status` (missing / not missing, hidden / not hidden, primary / permanent; letters A-T map to permanent positions 4-13 and 20-29; already-correct teeth skipped; only the named patient's markings are removed).
- od-clinical skill covers completing work, existing restorations, referrals, conditions and the tooth chart.

## 0.5.0 — 2026-11-14

- **Lab cases** in the Claude connector (7 new tools): list labs with turnaround times; a patient's or appointment's lab cases; an open-case board with overdue and seat-risk flags; create a lab case (optionally linked to the seat appointment, due date from a lab turnaround, mark sent); mark sent, received or checked in order; update due date, instructions, seat appointment, lab, fee or invoice. Changes use the **Allow schedule changes** setting. Nothing deletes a lab case.
- **Lab case cleanup** (`od_mark_lab_cases_received`): marks old cases received using their linked appointment's date, only when that appointment is Complete and the case isn't already received, with an optional cutoff date; up to 50 per call; preview by default; stops on Open Dental errors.
- New reports: `lab_cases_open`, `lab_turnaround`, `lab_cases_unreceived_completed` (also available to gateway apps).
- New **od-lab** skill. The od-schedule skill now notes two Open Dental behaviors found in live testing: API breaks don't add the office's broken-appointment procedure or adjustment, and slot search can include blockouts.

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
