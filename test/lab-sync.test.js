"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const { startFakeOD } = require("./fake-od");
const { createClient } = require("../core/odclient");
const { validateLabSync, runLabSync, caseKey, patientLabel, eventTime, SyncError } = require("../gateway/lab-sync");
const { validateConfig } = require("../gateway/config");

const SECRET = "s".repeat(40);

/** A stand-in lab tracker that checks signatures like od-sync.php does. */
function startTracker({ secret = SECRET, events = [] } = {}) {
  const calls = [];
  const state = { events, cases: new Map(), acks: [] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const ts = req.headers["x-odgw-timestamp"];
      const sig = req.headers["x-odgw-signature"];
      const good = crypto.createHmac("sha256", secret).update(ts + "." + body).digest("hex");
      const send = (code, obj) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (sig !== good || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return send(401, { ok: false, error: "bad_signature" });
      const msg = JSON.parse(body);
      calls.push(msg);
      if (msg.op === "push") {
        let created = 0;
        for (const c of msg.cases) {
          if (!state.cases.has(c.key)) created++;
          state.cases.set(c.key, c);
        }
        return send(200, { ok: true, created, updated: msg.cases.length - created });
      }
      if (msg.op === "updates") return send(200, { ok: true, events: state.events });
      if (msg.op === "ack") {
        state.acks.push(msg);
        return send(200, { ok: true });
      }
      send(400, { ok: false });
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}/od-sync.php`, calls, state, close: () => new Promise((r) => server.close(r)) })
    )
  );
}

const ROWS = [
  // in-house CEREC case, seat appointment scheduled
  { LabCaseNum: 501, FirstInitial: "j", LastName: "smith", LaboratoryNum: 1, Lab: "TDC In-house", Provider: "DOC1", DateTimeCreated: "2026-11-15 09:00:00", DateTimeSent: "0001-01-01 00:00:00", DateTimeDue: "2026-11-18 00:00:00", DateTimeRecd: "0001-01-01 00:00:00", DateTimeChecked: "0001-01-01 00:00:00", AptNum: 52, SeatAppt: "2026-11-20 09:00:00", SeatStatus: 1 },
  // outside lab, not yet sent
  { LabCaseNum: 502, FirstInitial: "A", LastName: "de la Cruz", LaboratoryNum: 2, Lab: "Smile Lab", Provider: "DOC1", DateTimeCreated: "2026-11-15 10:00:00", DateTimeSent: "0001-01-01 00:00:00", DateTimeDue: "2026-11-25 00:00:00", DateTimeRecd: "0001-01-01 00:00:00", DateTimeChecked: "0001-01-01 00:00:00", AptNum: 0, SeatAppt: null, SeatStatus: null },
];

async function setup(t, { events = [], rows = ROWS } = {}) {
  const od = await startFakeOD({
    onRequest: (rec) => (rec.path.endsWith("/queries/ShortQuery") && /FirstInitial/.test(rec.body.SqlCommand) ? { body: rows } : null),
  });
  od.state.labcases[501] = { LabCaseNum: 501, PatNum: 1, DateTimeSent: "0001-01-01 00:00:00", DateTimeChecked: "0001-01-01 00:00:00" };
  od.state.labcases[502] = { LabCaseNum: 502, PatNum: 1, DateTimeSent: "0001-01-01 00:00:00", DateTimeChecked: "0001-01-01 00:00:00" };
  const tracker = await startTracker({ events });
  t.after(async () => {
    await od.close();
    await tracker.close();
  });
  const client = createClient({ baseUrl: od.url, developerKey: "dev1", customerKey: "cust1" });
  const cfg = validateLabSync({ trackerUrl: tracker.url, syncFrom: "2026-11-15", inHouseLabs: [1] });
  return { od, tracker, cfg, run: (extra = {}) => runLabSync({ od: client, cfg, secret: SECRET, ...extra }) };
}

test("config: tracker URL, start date, secret", () => {
  assert.throws(() => validateLabSync({ trackerUrl: "http://lab.example.com/od-sync.php", syncFrom: "2026-11-15" }), /https/);
  assert.throws(() => validateLabSync({ trackerUrl: "https://lab.example.com/od-sync.php" }), /syncFrom/);
  assert.throws(() => validateLabSync({ trackerUrl: "https://lab.example.com/od-sync.php", syncFrom: "2026-11-15", patientFormat: "full" }), /patientFormat/);
  assert.equal(validateLabSync({ enabled: false }), null);
  const cfg = validateConfig({ labSync: { trackerUrl: "https://lab.example.com/od-sync.php", syncFrom: "2026-11-15" } });
  assert.equal(cfg.labSync.intervalMinutes, 5);
  assert.equal(cfg.apps.length, 0); // a sync-only gateway needs no apps
});

test("patient label and case key never expose Open Dental identifiers", () => {
  assert.equal(patientLabel({ FirstInitial: "j", LastName: "smith" }, "initial-last"), "J. Smith");
  assert.equal(patientLabel({ FirstInitial: "A", LastName: "de la Cruz" }, "initial-last"), "A. De la Cruz");
  assert.equal(patientLabel({ FirstInitial: "j", LastName: "smith" }, "initials"), "J.S.");
  const k = caseKey(SECRET, 501);
  assert.match(k, /^od-[a-f0-9]{24}$/);
  assert.equal(caseKey(SECRET, 501), k);
  assert.notEqual(caseKey("t".repeat(40), 501), k);
  assert.ok(!k.includes("501"));
});

test("event times are sanity-checked", () => {
  const now = new Date("2026-11-15T10:00:00");
  assert.equal(eventTime(new Date("2026-11-15T09:30:00").getTime(), now), "2026-11-15 09:30:00");
  assert.equal(eventTime("2026-11-14", now), "2026-11-14 12:00:00");
  assert.equal(eventTime("2026-11-15", now), "2026-11-15 10:00:00");
  assert.equal(eventTime(new Date("2030-01-01").getTime(), now), "2026-11-15 10:00:00"); // future -> now
  assert.equal(eventTime("garbage", now), "2026-11-15 10:00:00");
});

test("dry run reads Open Dental and sends nothing", async (t) => {
  const { run, tracker, od } = await setup(t);
  const r = await run({ dryRun: true });
  assert.equal(r.cases, 2);
  assert.equal(r.sample[0].patient, "J. Smith");
  assert.equal(tracker.calls.length, 0);
  assert.ok(!od.requests.some((q) => q.method === "PUT" && !q.path.endsWith("/queries/ShortQuery")));
});

test("push sends only the agreed fields", async (t) => {
  const { run, tracker } = await setup(t);
  const r = await run();
  assert.deepEqual({ cases: r.cases, created: r.created, events: r.events }, { cases: 2, created: 2, events: 0 });
  const push = tracker.calls.find((c) => c.op === "push");
  assert.deepEqual(Object.keys(push.cases[0]).sort(), ["checked", "created", "doctor", "due", "key", "lab", "lab_in_house", "patient", "received", "seat", "seat_done", "sent"]);
  const a = push.cases[0];
  assert.deepEqual(
    { patient: a.patient, lab: a.lab, inHouse: a.lab_in_house, due: a.due, seat: a.seat, sent: a.sent },
    { patient: "J. Smith", lab: "TDC In-house", inHouse: true, due: "2026-11-18", seat: "2026-11-20", sent: null }
  );
  const text = JSON.stringify(push);
  for (const banned of ["501", "502", "PatNum", "LabCaseNum", "AptNum", "Birthdate", "smith\""]) assert.ok(!text.includes(banned), banned);
  assert.equal(tracker.calls.filter((c) => c.op === "ack").length, 0); // no events, no ack
});

test("ready and sent are written back to Open Dental, read back, and acknowledged", async (t) => {
  const k1 = caseKey(SECRET, 501);
  const k2 = caseKey(SECRET, 502);
  const atDate = new Date(Date.now() - 3 * 60000);
  atDate.setMilliseconds(0);
  const at = atDate.getTime();
  const p2 = (n) => String(n).padStart(2, "0");
  const expected = `${atDate.getFullYear()}-${p2(atDate.getMonth() + 1)}-${p2(atDate.getDate())} ${p2(atDate.getHours())}:${p2(atDate.getMinutes())}:${p2(atDate.getSeconds())}`;
  const yesterday = new Date(Date.now() - 86400000);
  const yDay = `${yesterday.getFullYear()}-${p2(yesterday.getMonth() + 1)}-${p2(yesterday.getDate())}`;
  const { run, tracker, od } = await setup(t, {
    events: [
      { key: k1, event: "ready", at },
      { key: k2, event: "sent", at: yDay },
      { key: k1, event: "sent", at },
      { key: "od-" + "0".repeat(24), event: "ready", at },
      { key: "../etc", event: "ready" },
    ],
  });
  const r = await run();
  assert.equal(r.applied, 2);
  assert.equal(r.failed, 3);
  assert.equal(od.state.labcases[501].DateTimeChecked, expected);
  assert.match(od.state.appts[52].Note, /Lab case ready to deliver \(TDC In-house\)/);
  assert.equal(od.state.labcases[502].DateTimeSent, `${yDay} 12:00:00`);
  const ack = tracker.state.acks[0];
  assert.deepEqual(ack.done, [{ key: k1, event: "ready" }, { key: k2, event: "sent" }]);
  assert.deepEqual(ack.failed.map((f) => f.reason), ["in-house case: sent is not written to Open Dental", "not found in Open Dental's recent lab cases", "bad case key"]);
  // Only lab cases and the seat appointment's note were written.
  const writes = od.requests.filter((q) => q.method !== "GET").map((q) => `${q.method} ${q.path.replace("/api/v1", "")}`);
  assert.deepEqual(writes.filter((w) => !w.includes("ShortQuery")), ["PUT /labcases/501", "PUT /appointments/52/Note", "PUT /labcases/502"]);
});

test("a case already checked in Open Dental isn't written again", async (t) => {
  const rows = [{ ...ROWS[0], DateTimeChecked: "2026-11-15 08:00:00" }];
  const { run, od } = await setup(t, { rows, events: [{ key: caseKey(SECRET, 501), event: "ready", at: Date.now() }] });
  const r = await run();
  assert.equal(r.applied, 1);
  assert.ok(!od.requests.some((q) => q.method === "PUT" && q.path.includes("/labcases/")));
  assert.ok(!od.requests.some((q) => q.path.includes("/Note")));
});

test("a write Open Dental ignores is reported as not applied", async (t) => {
  const { run, od, tracker } = await setup(t, { events: [{ key: caseKey(SECRET, 501), event: "ready", at: Date.now() }] });
  od.state.ignoreLabPut = true;
  const r = await run();
  assert.equal(r.applied, 0);
  assert.match(tracker.state.acks[0].failed[0].reason, /did not save the checked date/);
});

test("wrong secret or unreachable tracker stops the round", async (t) => {
  const { od, tracker, cfg } = await setup(t);
  const client = createClient({ baseUrl: od.url, developerKey: "dev1", customerKey: "cust1" });
  await assert.rejects(runLabSync({ od: client, cfg, secret: "x".repeat(40) }), /401.*bad_signature/);
  await assert.rejects(runLabSync({ od: client, cfg, secret: "short" }), /LAB_SYNC_SECRET/);
  await tracker.close();
  await assert.rejects(runLabSync({ od: client, cfg, secret: SECRET }), SyncError);
});
