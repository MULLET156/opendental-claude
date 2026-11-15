"use strict";
/**
 * Lab tracker sync.
 *
 * Runs inside the gateway in the office. Every few minutes it:
 *   1. reads recent lab cases from Open Dental,
 *   2. pushes them to the lab tracker (patient as "J. Smith" or "J.S."; no DOB or chart
 *      number; the patient's PatNum only when "sendPatNum" is turned on; no other Open
 *      Dental numbers; cases are matched by a keyed hash the tracker can't reverse),
 *   3. asks the tracker for staff updates and writes them back to Open Dental:
 *        ready -> lab case Checked + a note on the seat appointment
 *        sent  -> lab case Sent (outside labs only)
 *   4. tells the tracker which updates were applied.
 *
 * All traffic starts in the office (nothing can reach in), goes over HTTPS, and is
 * signed with a shared secret (HMAC-SHA256 over "timestamp.body").
 */

const crypto = require("node:crypto");
const { ODError, validDate } = require("../core/odclient");
const { buildReport } = require("../core/reports");

const KEY_RE = /^od-[a-f0-9]{24}$/;

class SyncError extends Error {}

// ------------------------------------------------------------------ config

function validateLabSync(raw) {
  if (!raw || raw.enabled === false) return null;
  const cfg = {
    trackerUrl: String(raw.trackerUrl || ""),
    intervalMinutes: Number(raw.intervalMinutes ?? 5),
    syncFrom: String(raw.syncFrom || ""),
    keepDays: Number(raw.keepDays ?? 30),
    inHouseLabs: Array.isArray(raw.inHouseLabs) ? raw.inHouseLabs.map(Number) : [],
    patientFormat: raw.patientFormat || "initial-last",
    sendPatNum: raw.sendPatNum === true,
    readyNote: String(raw.readyNote || "Lab case ready to deliver"),
    timeoutMs: Number(raw.timeoutMs || 30000),
  };
  let u;
  try {
    u = new URL(cfg.trackerUrl);
  } catch {
    throw new SyncError("labSync.trackerUrl must be the tracker's od-sync.php address, e.g. https://lab.example.com/od-sync.php");
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new SyncError("labSync.trackerUrl must use https://.");
  if (u.username || u.password || u.hash) throw new SyncError("labSync.trackerUrl must not contain a username, password or #fragment.");
  if (!Number.isFinite(cfg.intervalMinutes) || cfg.intervalMinutes < 1 || cfg.intervalMinutes > 60) throw new SyncError("labSync.intervalMinutes must be 1-60.");
  if (!validDate(cfg.syncFrom)) throw new SyncError('labSync.syncFrom must be the first date to sync (yyyy-MM-dd), so old cases are not sent.');
  if (!Number.isInteger(cfg.keepDays) || cfg.keepDays < 0 || cfg.keepDays > 365) throw new SyncError("labSync.keepDays must be 0-365.");
  if (cfg.inHouseLabs.some((n) => !Number.isSafeInteger(n) || n <= 0)) throw new SyncError("labSync.inHouseLabs must list LaboratoryNums.");
  if (!["initial-last", "initials"].includes(cfg.patientFormat)) throw new SyncError('labSync.patientFormat must be "initial-last" (J. Smith) or "initials" (J.S.).');
  if (raw.sendPatNum !== undefined && typeof raw.sendPatNum !== "boolean") throw new SyncError("labSync.sendPatNum must be true or false.");
  if (cfg.readyNote.length > 200) throw new SyncError("labSync.readyNote is too long.");
  return cfg;
}

function checkSecret(secret) {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new SyncError("Set LAB_SYNC_SECRET (at least 32 characters; create one with: node gateway/cli.js new-secret). The tracker's config.php needs the same value.");
  }
  return secret;
}

// ------------------------------------------------------------------ helpers

const hmac = (secret, text) => crypto.createHmac("sha256", secret).update(text, "utf8").digest("hex");

/** Stable, non-reversible case key: the tracker never sees Open Dental's numbers. */
function caseKey(secret, labCaseNum) {
  return "od-" + hmac(secret, "labcase:" + labCaseNum).slice(0, 24);
}

const blank = (v) => !v || String(v).startsWith("0001") || String(v) < "1880";
const day = (v) => (blank(v) ? null : String(v).slice(0, 10));

function pad(n) {
  return String(n).padStart(2, "0");
}
function localStamp(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Event time from the tracker (ms epoch, "yyyy-MM-dd" or "yyyy-MM-dd HH:mm[:ss]") -> Open Dental local time, sanity-checked. */
function eventTime(at, now = new Date()) {
  let d;
  if (typeof at === "number" && Number.isFinite(at)) d = new Date(at);
  else if (typeof at === "string" && /^\d{4}-\d{2}-\d{2}$/.test(at) && validDate(at)) {
    const today = localStamp(now).slice(0, 10);
    return at === today ? localStamp(now) : `${at} 12:00:00`;
  } else if (typeof at === "string" && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(at) && validDate(at.slice(0, 10))) {
    d = new Date(at.replace(" ", "T"));
  }
  if (!d || Number.isNaN(d.getTime())) return localStamp(now);
  if (d.getTime() > now.getTime() + 10 * 60000 || d.getTime() < now.getTime() - 400 * 86400000) return localStamp(now);
  return localStamp(d);
}

function patientLabel(row, format) {
  const fi = String(row.FirstInitial || "").trim().slice(0, 1).toUpperCase();
  const last = String(row.LastName || "").trim().replace(/\s+/g, " ");
  if (format === "initials") return [fi, last.slice(0, 1).toUpperCase()].filter(Boolean).map((x) => x + ".").join("");
  const cap = last ? last.charAt(0).toUpperCase() + last.slice(1) : "";
  return [fi ? fi + "." : "", cap].filter(Boolean).join(" ").slice(0, 80);
}

function toTracker(row, cfg, secret) {
  const seatScheduled = Number(row.SeatStatus) === 1 || String(row.SeatStatus) === "Scheduled";
  const seatDone = Number(row.SeatStatus) === 2 || String(row.SeatStatus) === "Complete";
  return {
    key: caseKey(secret, row.LabCaseNum),
    patient: patientLabel(row, cfg.patientFormat),
    lab: String(row.Lab || "").slice(0, 100),
    lab_in_house: cfg.inHouseLabs.includes(Number(row.LaboratoryNum)),
    doctor: String(row.Provider || "").slice(0, 40),
    created: day(row.DateTimeCreated),
    sent: day(row.DateTimeSent),
    due: day(row.DateTimeDue),
    received: day(row.DateTimeRecd),
    checked: day(row.DateTimeChecked),
    seat: (seatScheduled || seatDone) ? day(row.SeatAppt) : null,
    seat_done: seatDone,
    // Open Dental's patient number, so staff can find the patient: only when turned on.
    ...(cfg.sendPatNum && Number.isSafeInteger(Number(row.PatNum)) && Number(row.PatNum) > 0 ? { patnum: Number(row.PatNum) } : {}),
  };
}

// ------------------------------------------------------------------ transport

async function call(cfg, secret, payload, fetchImpl) {
  // A one-time value makes every request's signature unique, so the tracker's replay
  // check never confuses two identical requests sent in the same second.
  const body = JSON.stringify({ ...payload, nonce: crypto.randomBytes(12).toString("hex") });
  const ts = String(Math.floor(Date.now() / 1000));
  let res;
  try {
    res = await fetchImpl(cfg.trackerUrl, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-ODGW-Timestamp": ts,
        "X-ODGW-Signature": hmac(secret, ts + "." + body),
      },
      body,
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (e) {
    throw new SyncError(`Could not reach the lab tracker (${(e && e.cause && e.cause.code) || (e && e.name) || "network error"}).`);
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (res.status >= 300 || !json || json.ok !== true) {
    const msg = (json && (json.message || json.error)) || text.slice(0, 200).replace(/\s+/g, " ");
    throw new SyncError(`Lab tracker answered ${res.status} to "${payload.op}": ${msg}`);
  }
  return json;
}

// ------------------------------------------------------------------ one round

/**
 * @returns {Promise<object>} summary (counts only; no patient data)
 */
async function runLabSync({ od, cfg, secret, fetch: fetchImpl = globalThis.fetch, dryRun = false }) {
  checkSecret(secret);
  const { rows } = await od.shortQuery(buildReport("lab_cases_for_sync", { since: cfg.syncFrom, keep_days: cfg.keepDays }), { limit: 2000 });
  const byKey = new Map();
  for (const r of rows) byKey.set(caseKey(secret, r.LabCaseNum), r);
  const cases = rows.map((r) => toTracker(r, cfg, secret));
  if (dryRun) return { dryRun: true, cases: cases.length, sample: cases.slice(0, 3) };

  const pushed = await call(cfg, secret, { op: "push", cases }, fetchImpl);
  const upd = await call(cfg, secret, { op: "updates" }, fetchImpl);
  const events = Array.isArray(upd.events) ? upd.events.slice(0, 200) : [];

  const done = [];
  const failed = [];
  for (const ev of events) {
    const key = ev && ev.key;
    const event = ev && ev.event;
    const fail = (reason) => failed.push({ key: String(key || "").slice(0, 40), event: String(event || "").slice(0, 20), reason });
    if (typeof key !== "string" || !KEY_RE.test(key)) {
      fail("bad case key");
      continue;
    }
    const row = byKey.get(key);
    if (!row) {
      fail("not found in Open Dental's recent lab cases");
      continue;
    }
    const num = Number(row.LabCaseNum);
    try {
      if (event === "sent") {
        if (cfg.inHouseLabs.includes(Number(row.LaboratoryNum))) {
          fail("in-house case: sent is not written to Open Dental");
          continue;
        }
        if (blank(row.DateTimeSent)) {
          const when = eventTime(ev.at);
          await od.request("PUT", `/labcases/${num}`, { body: { DateTimeSent: when } });
          const after = await od.request("GET", `/labcases/${num}`);
          if (String(after.DateTimeSent || "").trim() !== when) throw new ODError("Open Dental did not save the sent date");
        }
        done.push({ key, event });
      } else if (event === "ready") {
        if (blank(row.DateTimeChecked)) {
          const when = eventTime(ev.at);
          await od.request("PUT", `/labcases/${num}`, { body: { DateTimeChecked: when } });
          const after = await od.request("GET", `/labcases/${num}`);
          if (String(after.DateTimeChecked || "").trim() !== when) throw new ODError("Open Dental did not save the checked date");
          const aptNum = Number(row.AptNum);
          if (aptNum && (Number(row.SeatStatus) === 1 || String(row.SeatStatus) === "Scheduled")) {
            const text = `${cfg.readyNote}${row.Lab ? ` (${String(row.Lab).slice(0, 60)})` : ""}`;
            await od.request("PUT", `/appointments/${aptNum}/Note`, { body: { Note: text } });
            const ap = await od.request("GET", `/appointments/${aptNum}`);
            if (!String((ap && ap.Note) || "").includes(text)) throw new ODError("case marked checked, but the appointment note didn't save");
          }
        }
        done.push({ key, event });
      } else {
        fail("unknown event");
      }
    } catch (e) {
      // Problems reaching Open Dental stop the round; the tracker keeps the update for next time.
      if (e instanceof ODError && ["unreachable", "redirect"].includes(e.code)) throw new SyncError(e.message);
      fail(e.message.slice(0, 200));
    }
  }
  if (events.length) await call(cfg, secret, { op: "ack", done, failed }, fetchImpl);
  return {
    cases: cases.length,
    created: Number(pushed.created || 0),
    updated: Number(pushed.updated || 0),
    events: events.length,
    applied: done.length,
    failed: failed.length,
    failures: failed.map((f) => `${f.event}: ${f.reason}`),
  };
}

/** Run on a timer without overlapping rounds. Returns a stop() function. */
function startLabSync({ od, cfg, secret, log = console.log, audit = () => {}, fetch: fetchImpl }) {
  checkSecret(secret);
  let running = false;
  const round = async () => {
    if (running) return;
    running = true;
    const started = Date.now();
    try {
      const s = await runLabSync({ od, cfg, secret, fetch: fetchImpl });
      audit({ app: "lab-sync", target: "lab-sync", status: 200, rows: s.cases, ms: Date.now() - started, created: s.created, updated: s.updated, applied: s.applied, failed: s.failed });
      if (s.created || s.applied || s.failed) log(`lab sync: ${s.cases} cases, ${s.created} new in tracker, ${s.applied} updates written to Open Dental${s.failed ? `, ${s.failed} not applied (${s.failures.join("; ")})` : ""}`);
    } catch (e) {
      audit({ app: "lab-sync", target: "lab-sync", status: 502, ms: Date.now() - started, error: e.message.slice(0, 200) });
      log(`lab sync failed: ${e.message}`);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(round, 5000);
  const timer = setInterval(round, cfg.intervalMinutes * 60000);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

module.exports = { validateLabSync, runLabSync, startLabSync, caseKey, patientLabel, eventTime, toTracker, SyncError };
