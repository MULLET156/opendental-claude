# Lab tracker sync

The gateway can keep a web-hosted lab case tracker in step with Open Dental's lab cases. It was built for the TDC Lab Tracker (PHP + MySQL), whose `od-sync.php` implements the tracker side, but any tracker that speaks the small protocol below can use it.

```
 Open Dental ◀──API Service──  gateway (office)  ──HTTPS, signed──▶  lab tracker (web host)
                                 every 5 minutes:
                                 1. read recent lab cases
                                 2. push them to the tracker
                                 3. ask the tracker for staff updates
                                 4. write those to Open Dental, read them back
                                 5. tell the tracker what was applied
```

Every request starts in the office. Nothing on the internet can reach into the office or Open Dental, and the tracker never holds Open Dental keys.

## What staff see

1. **Add the lab case in Open Dental** as usual (patient, lab, due date, seat appointment).
2. Within a few minutes it appears in the tracker with the patient, lab, doctor, due date and seat date filled in, marked **OD** and **Pick case type**.
3. Pick the case type in the tracker; its steps appear. Log steps as you work.
4. When every step is done (or the case is marked delivered), Open Dental's lab case is marked **Checked** and the seat appointment gets the note *"Lab case ready to deliver (lab name)"*.
5. For **outside labs only**, setting the sent date in the tracker marks the Open Dental case **Sent**. In-house cases never write "sent" back.

Later changes in Open Dental (due date, seat appointment, doctor, lab, sent date) update the tracker and are written to the case's log. Fields staff change in the tracker are kept unless Open Dental changes that same field again.

## What leaves the office

Per case, only:

| Field | Example |
|---|---|
| `key` | `od-3f9c…` (a keyed hash of the LabCaseNum; the tracker can't reverse it) |
| `patient` | `J. Smith` (first initial + last name), or `J.S.` with `"patientFormat": "initials"` |
| `lab`, `lab_in_house` | `Smile Lab`, `false` |
| `doctor` | provider abbreviation |
| `created`, `sent`, `due`, `received`, `checked`, `seat` | dates only (`yyyy-MM-dd`) or `null` |
| `seat_done` | whether the seat appointment is complete |
| `patnum` | Open Dental's PatNum, **only with `"sendPatNum": true`** (off by default) |

Not sent: date of birth, chart number, LabCaseNum, AptNum, phone, address, lab instructions, fees; PatNum unless `sendPatNum` is on.

> **HIPAA:** initials together with dates are still protected health information. A web host that won't sign a BAA (most shared hosting, including Hostinger) is a risk you accept by turning this on. `"patientFormat": "initials"` sends less. See [hipaa-and-security.md](hipaa-and-security.md).

## Set up

You need the gateway installed in the office (see [gateway.md](gateway.md)); a sync-only gateway doesn't need any apps.

1. **Make a shared secret** on the office computer:

   ```bash
   node gateway/cli.js new-secret
   ```

   Put it in the gateway's `.env`:

   ```
   LAB_SYNC_SECRET=<the 64-character secret>
   ```

   and in the tracker's `config.php`:

   ```php
   define('OD_SYNC_SECRET', '<the same secret>');
   ```

   Don't email it or paste it into chat; copy it directly between the two files.

2. **Find your in-house lab's number** (Open Dental: Lists → Laboratories, or ask Claude "list our labs"). In-house cases never write "sent" back.

3. **Add `labSync`** to `gateway.config.json`:

   ```json
   "labSync": {
     "trackerUrl": "https://lab.example.com/od-sync.php",
     "syncFrom": "2026-11-15",
     "inHouseLabs": [1],
     "intervalMinutes": 5,
     "keepDays": 30,
     "patientFormat": "initial-last",
     "readyNote": "Lab case ready to deliver"
   }
   ```

   | Setting | Meaning |
   |---|---|
   | `trackerUrl` | The tracker's `od-sync.php`. Must be `https://` (plain `http://` only for `localhost` testing). |
   | `syncFrom` | **Required.** Only cases created on or after this date are sent, so years of old cases don't flood the tracker. Use the day you turn it on. |
   | `inHouseLabs` | LaboratoryNums of your own lab(s). |
   | `intervalMinutes` | 1–60, default 5. |
   | `keepDays` | Keep sending checked cases for this many days so late edits still flow (default 30). |
   | `patientFormat` | `initial-last` (J. Smith, default) or `initials` (J.S.). |
   | `sendPatNum` | `true` also sends Open Dental's PatNum with each case so staff can find the patient (default `false`). It's one more identifier on the web host, so it adds to the HIPAA note above. Windows setup: `SEND_PATIENT_NUMBER=yes`. |
   | `readyNote` | Text added to the seat appointment's note when a case is ready. The lab name is added in brackets. |
   | `enabled` | `false` turns the sync off without removing the settings. |

4. **Check, preview, then start**:

   ```bash
   node gateway/cli.js check
   node gateway/cli.js lab-sync --dry-run   # reads Open Dental, sends nothing, shows a sample
   node gateway/cli.js lab-sync             # one real round, prints the result
   node gateway/server.js                   # runs the sync every few minutes
   ```

   Run `server.js` as a service so the sync keeps going after a restart ([gateway.md](gateway.md#run-it-as-a-service)).

The gateway needs these Open Dental API permissions: Queries (to read cases), and write access to LabCases and Appointments.

## What gets written to Open Dental

| Tracker event | Open Dental change | Skipped when |
|---|---|---|
| `ready` (all steps done, or delivered) | Lab case `DateTimeChecked`; seat appointment note gets `readyNote (lab)` if the appointment is still Scheduled | Already checked |
| `sent` (sent date set, outside lab) | Lab case `DateTimeSent` | In-house lab, or already sent |

Each write is read back. If Open Dental didn't save it, the tracker is told it failed and shows the reason on the case. Nothing is ever deleted, and no other Open Dental data is changed. Every round is written to the gateway's audit log as app `lab-sync`.

## Protocol (for other trackers)

Every request is a `POST` of a JSON body to `trackerUrl` with:

- `X-ODGW-Timestamp`: Unix seconds
- `X-ODGW-Signature`: hex HMAC-SHA256 of `timestamp + "." + body` using the shared secret

The body always includes `op` and a random `nonce`. The tracker must reject a bad signature (401), a timestamp more than 5 minutes off (401), and a signature it has already seen (409). Every reply is JSON with `"ok": true` on success.

| `op` | Request | Reply |
|---|---|---|
| `push` | `cases`: the case objects above | `created`, `updated` counts |
| `updates` | — | `events`: `[{ key, event: "ready" \| "sent", at }]`; `at` is epoch ms or `yyyy-MM-dd` |
| `ack` | `done`: `[{ key, event }]`, `failed`: `[{ key, event, reason }]` | — |

The tracker should keep returning an event until it's acknowledged as done, and match cases on `key` only.

## Troubleshooting

- **`401 bad_signature`**: the secrets in `.env` and `config.php` differ, or one has extra spaces.
- **`401 stale`**: the office computer's clock is off by more than 5 minutes.
- **A case never appears**: it was created before `syncFrom`, or it was checked more than `keepDays` ago.
- **"not found in Open Dental's recent lab cases"**: the case was deleted in Open Dental or is outside the sync window; the tracker stops retrying it.
