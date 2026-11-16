# TDC Office: the gateway for the office web apps

This is how the TDC Office modules (Daysheet, Treatment Finder, Voice Charting, Practice Numbers) reach Open Dental. The overall plan is in [TDC-Office-Plan](https://github.com/MULLET156/TDC-Office-Plan). This page covers this repo's part: the **demo gateway** with fake data, **gateway mode** for the shared `core/` code, **reports**, and **sync-core**.

```
 building (laptop)        module ──► demo gateway ──► fake office              /health "stage":"design", "fake":true
 design stage (Hostinger) module ──► tunnel ──► office gateway ──► OD demo database   "stage":"design", "fake":false
 live stage (office)      module ──► office gateway ──► real Open Dental        "stage":"live",   "fake":false
```

The same module code runs everywhere. Only its settings change (`TDC_STAGE`, `GATEWAY_URL`, `GATEWAY_KEY`). A module checks that the gateway's `/health` `"stage"` matches `TDC_STAGE` (`checkStage()`, at startup and every 5 minutes) and stops serving patient pages if it doesn't. The office gateway's stage is set in its config (`"stage": "design"`, or `STAGE=design` in the Windows setup's `settings.txt`); unset means live.

## The demo gateway (fake data)

It's the real gateway code in front of a made-up dental office: 48 invented patients (names like "Dana Applewood", phone numbers 555-01xx, emails @example.com), a full schedule **today** and for the next three weeks, past visits, planned treatment, insurance plans with annual maximums and x-ray frequency limits, insurance used this year, unsigned notes and lab cases. Dates move with the calendar, so there's always a schedule for today, even on a weekend.

- It **never talks to real Open Dental.** Its "Open Dental" is a fake one it starts itself, and it refuses to start if Open Dental keys are in its settings.
- Writes from Voice Charting (planning procedures, priorities, notes) work and show up in the reports. Everything starts over each day, and whenever the demo restarts.
- Each module has its own key and only the permissions it needs (`gateway/presets.js`).

### Try it on your Windows computer

You need Node.js 20 or newer (`node -v` in a terminal to check). Get it from [nodejs.org](https://nodejs.org) if needed.

1. Download this repository: on GitHub, **Code → Download ZIP**, then right-click the zip → **Extract All**. (Or `git clone https://github.com/MULLET156/opendental-claude.git`.)
2. In the extracted folder, double-click **start-demo.cmd**.
   (Or in a terminal in that folder: `npm run dev`.)
3. A window opens and shows something like:

   ```
   Demo gateway with FAKE DATA running at http://127.0.0.1:8787  (this computer only)
   Test keys (fake data only; never use them anywhere else):
     daysheet  odg_test_daysheet_key_0001
     ...
   ```

4. Open **http://127.0.0.1:8787/health** in your browser. You should see `"stage":"design"` and `"fake":true`.
5. Leave the window open while you try a module. Close it (or press Ctrl+C) to stop.

To fix "today" to a date: `npm run dev -- --today 2026-11-16`. For another port: `--port 8788`.

### Put it on Hostinger

The demo runs as its own Hostinger **Node.js app**, deployed from this repo's `main` branch. `npm start` runs the demo, never the real gateway, so deploying this repo anywhere can't touch real Open Dental.

1. **Make one key per module** on your computer, in a terminal in this folder:

   ```
   node gateway/cli.js new-key daysheet
   node gateway/cli.js new-key finder
   node gateway/cli.js new-key voice
   ```

   Each prints a key starting `odg_`. You only need the key itself here (ignore the config part, which is for the real gateway). Don't put these keys in GitHub, email or chat.
2. In hPanel, create a **Node.js app** from the GitHub repository `MULLET156/opendental-claude`, branch `main`, on its own subdomain, for example `gateway-dev.<your domain>`.
   - Node.js version: **20** or newer. Start command: `npm start`. No build command is needed (there's nothing to install).
3. In the app's **environment variables**, add:

   | Name | Value |
   |---|---|
   | `DEMO_KEY_DAYSHEET` | the daysheet key from step 1 |
   | `DEMO_KEY_FINDER` | the finder key |
   | `DEMO_KEY_VOICE` | the voice key |
   | `TZ` | `America/Los_Angeles` (so "today" is the office's day) |

   Never add `OD_DEVELOPER_KEY` or `OD_CUSTOMER_KEY` there. The demo refuses to start if they're set.
4. Deploy, then open `https://gateway-dev.<your domain>/health`. It should show `"fake":true`.
5. Give each module's Hostinger app its settings: `TDC_STAGE=design`, `GATEWAY_URL=https://gateway-dev.<your domain>`, and `GATEWAY_KEY=` that module's key.

From then on, merging to `main` redeploys the demo.

## For module agents

### Settings

```
TDC_STAGE=design
GATEWAY_URL=http://127.0.0.1:8787        # npm run dev here; on Hostinger, the demo gateway's https address
GATEWAY_KEY=odg_test_daysheet_key_0001  # npm run dev test key; on Hostinger, the private key Ryan set
```

### Get the shared code

Copy [`scripts/sync-core.js`](../scripts/sync-core.js) into your repo as `scripts/sync-core.js`, then:

```
node scripts/sync-core.js 0.9.0                      # a released version (tag v0.9.0)
node scripts/sync-core.js 0.9.0-test.10              # a test build, before Ryan merges
node scripts/sync-core.js 0.9.0 --from ..\opendental-claude   # from a local copy
```

It replaces `vendor/opendental-core/` with `core/` from that version and writes `VERSION` and `CHECKSUMS`. Never edit the vendored files.

### Use it

```js
const { createClient } = require("./vendor/opendental-core/odclient");
const { checkStage } = require("./vendor/opendental-core/gateway-client");
const { runReport } = require("./vendor/opendental-core/reports");

const od = createClient({ gatewayUrl: process.env.GATEWAY_URL, gatewayKey: process.env.GATEWAY_KEY });
await checkStage(od, process.env.TDC_STAGE);   // at startup and every 5 minutes: the gateway's stage must match

const { rows } = await runReport(od, "daysheet", { date: "2026-11-16" });   // or od.runReport(...)
const patient = await od.request("GET", "/patients/1001");                   // Open Dental API, through the gateway
```

The connector's tools take this client unchanged, for example Voice Charting:

```js
const { buildClinicalTools } = require("./vendor/opendental-core/clinical-tools");
const tools = buildClinicalTools(od, { allowChartChanges: true });
// od_plan_procedure, od_set_treatment_plan_priorities, od_add_group_note ... all read back what they wrote, and never sign.
```

Errors are `ODError`s with `status` (401 bad key, 403 not allowed for this module, 404 not found, 501 no fake data for that report yet) and a plain message.

### What each module may do

| Module | Open Dental | Reports |
|---|---|---|
| daysheet | read appointments, patients, providers, operatories, procedures, lab cases | daysheet, xray_history, unscheduled_treatment, insurance_remaining, lab_cases_open, patient_treatment_plan, operatories |
| finder | read patients, appointments, providers, carriers | unscheduled_treatment, no_future_appointment, insurance_remaining, xray_history, recall_overdue, patient_treatment_plan, patient_recall |
| voice | read the chart; plan procedures, priorities, status, notes, group notes, treatment plans, tooth chart | patient_treatment_plan, unsigned_notes, daysheet |
| numbers | providers | production, collections and A/R reports |

The real gateway uses the same lists: `node gateway/cli.js new-key daysheet` prints a config entry with them.

## Reports for TDC Office

Run with `POST /v1/reports/<name>` and a JSON body `{"params": {...}}` (or `GET` with the params in the address). Every answer is `{ report, count, truncated, rows }`. `GET /v1/reports` lists what your key may run, with parameters and columns.

| Report | Parameters | Each row |
|---|---|---|
| `daysheet` | `date` (required), `provider`, `op`, `include_broken` | AptNum, AptDateTime, Time, Minutes, Status, PatNum, LName, FName, Preferred, ProvNum, Provider, ProvHyg, Hygienist, OpNum, OpName, IsHygiene, IsNewPatient, Confirmed, Procedures, ScheduledFee |
| `unscheduled_treatment` | `provider`, `codes`, `min_fee`, `min_total`, `hygiene_codes`, `include_hygiene`, `patients`, `limit` | PatNum, LName, FName, ProcNum, ProcCode, Descript, ToothNum, Surf, Fee, ProvNum, Provider, DateTP, Priority, AptNum, PatientTotal, AsOf |
| `no_future_appointment` | `last_visit_after`, `last_visit_before`, `provider`, `include_never_seen`, `limit` | PatNum, LName, FName, PriProv, Provider, LastVisit, PlannedTotal, AsOf |
| `xray_history` | `patients` or `date` (one is required), `limit` | PatNum, LName, FName, Category (BWX, FMX, PANO, PA), LastDate, CountLast12Months, Carrier, Limit, NextCovered, CoveredNow, AsOf |
| `insurance_remaining` | `patients`, `carrier`, `min_remaining`, `limit` | PatNum, LName, FName, Carrier, GroupName, BenefitYearStart, AnnualMax, Used, Remaining, IsEstimate (always true), AsOf |
| `unsigned_notes` | `days` (default 90) or `from`/`to`, `provider`, `count_only`, `limit` | ProcNum, PatNum, LName, FName, ProcDate, ProcCode, Descript, ProvNum, Provider, NoteEntered (or one row `{UnsignedNotes}` with count_only) |

Notes:
- **Hygiene** is left out of `unscheduled_treatment`, and out of `no_future_appointment`'s planned total. Ryan's list (2026-11-16): D0120, D0140, D0150, D0210, D0272, D0274, D1110, D1120, D1206, D1208, D4341, D4342, D4346, D4355, D4910. To change it for every report at once, set `hygieneCodes` in the gateway config:
  ```json
  "hygieneCodes": ["D0120", "D0140", "D1110", "D1120", "D4910"]
  ```
- **X-ray limits** come from the primary plan's benefit table (frequency limitations by code or code group). `NextCovered` is the first date insurance should cover that x-ray again; `CoveredNow` is true when that's today or earlier, and null when there's no limit on file. It is not a live check with the insurer.
- **Insurance remaining** is an estimate: the primary plan's annual maximum minus what's recorded as paid or pending this benefit year.
- Dates are `yyyy-MM-dd`; `AsOf` is the Open Dental server's date when the report ran.
- Need something else? Open an issue in this repo titled **`Report request: <name>`** with the inputs and the rows you need. Build against fake data shaped like it meanwhile.

The SQL for these reports is checked by the tests for safety and shape, and the fake data mirrors it. Before the live stage, each new report gets one read-only run against the real Open Dental (test patient PatNum 8133 where a patient is needed) to confirm the SQL.
