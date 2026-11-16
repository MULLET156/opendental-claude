"use strict";
/**
 * TDC Office: gateway mode for core/, the demo gateway with fake data, the new
 * reports, presets and sync-core. Fake data only.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { execFileSync, spawnSync } = require("node:child_process");

const { createClient, ODError } = require("../core/odclient");
const { createGatewayClient, normalizeGatewayUrl, checkStage } = require("../core/gateway-client");
const { REPORTS, runReport, parseReportParams, xrayRow, DEFAULT_HYGIENE_CODES } = require("../core/reports");
const { buildClinicalTools } = require("../core/clinical-tools");
const { startDemoGateway, TEST_KEYS } = require("../gateway/demo/demo-gateway");
const { buildOffice } = require("../gateway/demo/fake-office");
const { fakeReportRows, FAKE_REPORTS } = require("../gateway/demo/fake-reports");
const { PRESETS } = require("../gateway/presets");
const { validateConfig, hashKey } = require("../gateway/config");
const { createGateway } = require("../gateway/app");
const { startFakeOD } = require("./fake-od");
const { untar } = require("../scripts/sync-core");

const TODAY = "2026-11-16"; // a Monday
const NEW_REPORTS = ["unscheduled_treatment", "no_future_appointment", "xray_history", "insurance_remaining", "daysheet", "unsigned_notes"];

let demo;
test.before(async () => {
  demo = await startDemoGateway({ keys: TEST_KEYS, port: 0, today: TODAY, log: false });
});
test.after(() => demo && demo.close());

const client = (preset) => createClient({ gatewayUrl: demo.url + "/v1/od", gatewayKey: TEST_KEYS[preset] });

// ------------------------------------------------------------------ gateway mode

test("gateway URL: /v1/od is optional, public http refused, key checked", () => {
  assert.equal(normalizeGatewayUrl("http://127.0.0.1:8787/v1/od/"), "http://127.0.0.1:8787");
  assert.equal(normalizeGatewayUrl("http://127.0.0.1:8787/v1"), "http://127.0.0.1:8787");
  assert.equal(normalizeGatewayUrl(""), "http://127.0.0.1:8787");
  assert.equal(normalizeGatewayUrl("https://demo-gw.example.com"), "https://demo-gw.example.com");
  assert.throws(() => normalizeGatewayUrl("http://demo-gw.example.com"), /Plain http/);
  assert.throws(() => normalizeGatewayUrl("https://user:pw@x.example.com"), /username/);
  assert.equal(createClient({ gatewayUrl: "http://127.0.0.1:1", gatewayKey: "x".repeat(20) }).mode, "gateway");
});

test("gateway mode: same client interface, through the gateway, key never in errors", async () => {
  const od = client("daysheet");
  const appts = await od.request("GET", "/appointments", { params: { date: TODAY } });
  assert.ok(appts.length >= 10);
  const { rows } = await od.getAll("/appointments", { date: TODAY });
  assert.equal(rows.length, appts.length);
  const p = await od.request("GET", `/patients/${appts[0].PatNum}`);
  assert.equal(p.PatNum, appts[0].PatNum);
  // Not allowed for this module: 403 with the gateway's reason.
  await assert.rejects(od.request("POST", "/procedurelogs", { body: { PatNum: 1001 } }), (e) => e instanceof ODError && e.status === 403 && /may not POST/.test(e.message));
  await assert.rejects(od.runReport("production_by_provider", { from: TODAY, to: TODAY }), (e) => e.status === 403);
  await assert.rejects(od.shortQuery("SELECT 1"), (e) => e.status === 403 && /custom SQL/.test(e.message));
  // Not found passes through as 404.
  await assert.rejects(od.request("GET", "/patients/999999"), (e) => e.status === 404);
  // Wrong key: 401, and the key is not echoed.
  const bad = createGatewayClient({ url: demo.url, key: "odg_wrong_key_but_well_formed" });
  await assert.rejects(bad.request("GET", "/providers"), (e) => e.status === 401 && !e.message.includes("odg_wrong"));
  await assert.rejects(createGatewayClient({ url: demo.url, key: "" }).request("GET", "/providers"), /GATEWAY_KEY is not set/);
  await assert.rejects(createGatewayClient({ url: "http://127.0.0.1:1", key: "x".repeat(20) }).request("GET", "/providers"), /Could not reach the Open Dental gateway/);
});

test("stage check: modules follow the gateway's \"stage\"; unset means live", async () => {
  const h = await client("daysheet").health();
  assert.deepEqual([h.stage, h.fake], ["design", true]);
  assert.equal((await checkStage(client("daysheet"), "design")).stage, "design");
  await assert.rejects(checkStage(client("daysheet"), "live"), /says stage "design"/);
  await assert.rejects(checkStage(client("daysheet"), "prod"), /TDC_STAGE/);
  assert.throws(() => validateConfig({ apps: [], stage: "demo" }, { requireApps: false }), /stage must be/);

  const od = await startFakeOD();
  const http = require("node:http");
  const start = async (extra) => {
    const real = createGateway({ config: validateConfig({ apps: [{ name: "a", keyHash: hashKey("k".repeat(30)), allow: [] }], auditLogDir: null, ...extra }), od: createClient({ baseUrl: od.url, developerKey: "dev1", customerKey: "cust1" }) });
    const srv = http.createServer(real);
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    return { srv, gw: createGatewayClient({ url: `http://127.0.0.1:${srv.address().port}`, key: "k".repeat(30) }) };
  };
  const live = await start({});
  const design = await start({ stage: "design" });
  try {
    // The real gateway: live unless set; never fake.
    assert.deepEqual([(await live.gw.health()).stage, (await live.gw.health()).fake], ["live", false]);
    await assert.rejects(checkStage(live.gw, "design"), /Refusing to serve patient pages/);
    assert.equal((await checkStage(live.gw, "live")).stage, "live");
    // The office gateway serving the Open Dental demo database in the design stage.
    const dh = await checkStage(design.gw, "design");
    assert.deepEqual([dh.stage, dh.fake], ["design", false]);
    await assert.rejects(checkStage(design.gw, "live"), /says stage "design"/);
    assert.deepEqual(Object.keys(dh).sort(), ["fake", "ok", "service", "stage", "version"]); // nothing sensitive
  } finally {
    live.srv.close();
    design.srv.close();
    await od.close();
  }
});

test("demo gateway starts where the host takes over listen() (Hostinger/LiteSpeed, issue #5)", async () => {
  const http = require("node:http");
  const net = require("node:net");
  const free = await new Promise((r) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => r(p));
    });
  });
  const realAddress = http.Server.prototype.address;
  http.Server.prototype.address = function () {
    return "/tmp/lshttpd/lsnode.sock"; // what lsnode's patched server reports
  };
  let d;
  try {
    d = await startDemoGateway({ keys: { daysheet: TEST_KEYS.daysheet }, port: free, today: TODAY, log: false });
  } finally {
    http.Server.prototype.address = realAddress;
  }
  try {
    const gw = createGatewayClient({ url: `http://127.0.0.1:${free}`, key: TEST_KEYS.daysheet });
    assert.equal((await gw.health()).stage, "design");
    assert.ok((await gw.runReport("daysheet", { date: TODAY })).rows.length >= 10);
    assert.ok((await gw.request("GET", "/appointments", { params: { date: TODAY } })).length >= 10);
  } finally {
    await d.close();
  }
});

test("the existing chart tools work unchanged in gateway mode (plan, priorities, status, group note, read-back)", async () => {
  const od = client("voice");
  const tools = Object.fromEntries(buildClinicalTools(od, { allowChartChanges: true }).map((t) => [t.name, t]));
  const pat = 1005;
  const crown = (await tools.od_plan_procedure.run({ pat_num: pat, proc_code: "D2740", tooth: "3", priority: "1" })).results.procedure;
  const buildup = (await tools.od_plan_procedure.run({ pat_num: pat, proc_code: "D2950", tooth: "3" })).results.procedure;
  assert.equal(crown.ProcStatus, "TP");
  const plan = (await tools.od_create_treatment_plan.run({ pat_num: pat, heading: "Phase 1" })).results;
  await tools.od_add_to_treatment_plan.run({ pat_num: pat, treat_plan_num: plan.TreatPlanNum, proc_nums: [crown.ProcNum, buildup.ProcNum] });
  const pri = await tools.od_set_treatment_plan_priorities.run({ pat_num: pat, treat_plan_num: plan.TreatPlanNum, items: [{ proc_nums: [buildup.ProcNum], priority: "1" }, { proc_nums: [crown.ProcNum], priority: "2" }] });
  assert.match(pri.verified, /read back/);
  await tools.od_set_procedure_status.run({ pat_num: pat, proc_num: buildup.ProcNum, status: "complete" });
  const note = await tools.od_add_group_note.run({ pat_num: pat, proc_nums: [buildup.ProcNum], note: "Fake group note." });
  assert.equal(note.signed, false);

  // The demo's reports see what was just written.
  const dev = client("dev");
  const un = (await dev.runReport("unscheduled_treatment", { patients: [pat] })).rows;
  const mine = un.find((r) => r.ProcNum === crown.ProcNum);
  assert.equal(mine.Priority, "2");
  assert.ok(!un.some((r) => r.ProcNum === buildup.ProcNum)); // completed now
  const notes = (await dev.runReport("unsigned_notes", { days: 30 })).rows;
  assert.ok(notes.some((r) => r.PatNum === pat && r.ProcCode === "~GRP~"));
});

// ------------------------------------------------------------------ the new reports

test("every new report returns exactly its declared columns from the demo gateway", async () => {
  const dev = client("dev");
  const params = {
    unscheduled_treatment: {},
    no_future_appointment: {},
    xray_history: { date: TODAY },
    insurance_remaining: {},
    daysheet: { date: TODAY },
    unsigned_notes: {},
  };
  for (const name of NEW_REPORTS) {
    const { rows } = await dev.runReport(name, params[name]);
    assert.ok(rows.length > 0, `${name} has rows`);
    for (const r of rows) assert.deepEqual(Object.keys(r).sort(), [...REPORTS[name].columns].sort(), name);
  }
});

test("every report with declared columns has fake data, and every fake report exists", () => {
  for (const [name, def] of Object.entries(REPORTS)) if (def.columns) assert.ok(FAKE_REPORTS.includes(name), name);
  for (const name of FAKE_REPORTS) assert.ok(REPORTS[name], name);
});

test("unscheduled_treatment: leaves out hygiene and anything on a future scheduled appointment; filters", async () => {
  const dev = client("dev");
  const all = (await dev.runReport("unscheduled_treatment", {})).rows;
  assert.ok(!all.some((r) => DEFAULT_HYGIENE_CODES.includes(r.ProcCode)));
  const office = demo.office();
  for (const r of all) {
    const a = office.appointment.find((x) => x.AptNum === r.AptNum);
    assert.ok(!a || a.AptStatus !== 1 || a.AptDateTime.slice(0, 10) < TODAY, `${r.ProcNum} is on a scheduled appointment`);
  }
  const withHyg = (await dev.runReport("unscheduled_treatment", { include_hygiene: "true" })).rows;
  assert.ok(withHyg.some((r) => r.ProcCode === "D1110"));
  const crowns = (await dev.runReport("unscheduled_treatment", { codes: ["D2740"], min_fee: 1000 })).rows;
  assert.ok(crowns.length && crowns.every((r) => r.ProcCode === "D2740" && r.Fee >= 1000));
  const big = (await dev.runReport("unscheduled_treatment", { min_total: 2000 })).rows;
  assert.ok(big.every((r) => r.PatientTotal >= 2000));
  const totals = new Map();
  for (const r of all) totals.set(r.PatNum, Math.round(((totals.get(r.PatNum) || 0) + r.Fee) * 100) / 100);
  for (const r of all) assert.equal(r.PatientTotal, totals.get(r.PatNum));
});

test("no_future_appointment, insurance_remaining, daysheet, unsigned_notes behave", async () => {
  const dev = client("dev");
  const office = demo.office();
  const nofa = (await dev.runReport("no_future_appointment", {})).rows;
  for (const r of nofa) assert.ok(!office.appointment.some((a) => a.PatNum === r.PatNum && a.AptStatus === 1 && a.AptDateTime.slice(0, 10) >= TODAY));
  const before = (await dev.runReport("no_future_appointment", { last_visit_before: "2026-01-01" })).rows;
  assert.ok(before.length && before.every((r) => r.LastVisit < "2026-01-01"));

  const ins = (await dev.runReport("insurance_remaining", {})).rows;
  assert.ok(ins.every((r) => r.IsEstimate === true && r.Remaining === Math.max(0, Math.round((r.AnnualMax - r.Used) * 100) / 100)));
  assert.ok(ins.some((r) => r.Remaining === 0), "someone has used their whole maximum");
  assert.ok(ins.some((r) => r.BenefitYearStart.endsWith("-07-01")), "a July benefit year");
  const rich = (await dev.runReport("insurance_remaining", { min_remaining: 1500 })).rows;
  assert.ok(rich.every((r) => r.Remaining >= 1500));

  const day = (await dev.runReport("daysheet", { date: TODAY })).rows;
  assert.ok(day.length >= 10 && day.every((r) => ["Scheduled", "Complete"].includes(r.Status)));
  assert.deepEqual(day.map((r) => r.AptDateTime), [...day.map((r) => r.AptDateTime)].sort());
  const withBroken = (await dev.runReport("daysheet", { date: TODAY, include_broken: "true" })).rows;
  assert.equal(withBroken.length, day.length + 1);
  assert.ok(day.some((r) => r.Hygienist) && day.some((r) => r.Procedures.includes("#")));

  const list = (await dev.runReport("unsigned_notes", {})).rows;
  const count = (await dev.runReport("unsigned_notes", { count_only: "true" })).rows;
  assert.deepEqual(count, [{ UnsignedNotes: list.length }]);
});

test("xray_history: limits and next-covered dates", () => {
  const row = (Frequency, Dates, extra = {}) => xrayRow({ PatNum: 1, LName: "A", FName: "B", Category: "BWX", Carrier: "Fake", MonthRenew: 0, AsOf: "2026-11-16", Frequency, Dates, ...extra });
  let r = row("12|5|0", "2026-03-10,2025-03-01");
  assert.deepEqual([r.LastDate, r.Limit, r.NextCovered, r.CoveredNow, r.CountLast12Months], ["2026-03-10", "1 per 12 months", "2027-03-10", false, 1]);
  r = row("12|5|0", "2025-10-01");
  assert.deepEqual([r.NextCovered, r.CoveredNow], ["2026-10-01", true]);
  r = row("5|4|0", "2022-01-31");
  assert.deepEqual([r.Limit, r.NextCovered, r.CoveredNow], ["1 per 5 years", "2027-01-31", false]);
  r = row("1|1|2", "2026-02-02");
  assert.deepEqual([r.Limit, r.NextCovered, r.CoveredNow], ["1 per calendar year", "2027-01-01", false]);
  r = row("2|1|1", "2026-09-01,2026-08-01", { MonthRenew: 7 });
  assert.deepEqual([r.Limit, r.NextCovered], ["2 per benefit year", "2027-07-01"]);
  r = row("2|1|1", "2026-09-01,2026-06-01", { MonthRenew: 7 });
  assert.equal(r.CoveredNow, true); // only one this benefit year (from July)
  r = row("1|1|5", "2026-01-20");
  assert.deepEqual([r.Limit, r.NextCovered], ["1 per 12 months", "2027-01-20"]);
  r = row("1|1|3", "2019-05-05");
  assert.deepEqual([r.Limit, r.NextCovered, r.CoveredNow], ["1 per lifetime", null, false]);
  r = row("12|5|0", null);
  assert.deepEqual([r.LastDate, r.NextCovered, r.CoveredNow], [null, "2026-11-16", true]);
  r = row(null, "2026-01-01");
  assert.deepEqual([r.Limit, r.CoveredNow], ["No frequency limit on file", null]);
  r = row("12|5|0", "2026-01-01", { Carrier: null });
  assert.equal(r.Limit, "No insurance on file");
});

test("report parameters: typed, validated, defaults; xray_history needs patients or date", () => {
  assert.throws(() => parseReportParams("xray_history", {}), /needs "patients" or "date"/);
  assert.throws(() => parseReportParams("daysheet", {}), /needs "date"/);
  assert.throws(() => parseReportParams("unscheduled_treatment", { codes: ["D2740'); DROP"] }), /procedure code/);
  assert.throws(() => parseReportParams("unscheduled_treatment", { patients: "1 OR 1=1" }), /positive whole number/);
  assert.throws(() => parseReportParams("insurance_remaining", { min_remaining: "lots" }), /number/);
  const { raw } = parseReportParams("unscheduled_treatment", { patients: "5,6", min_total: "500" });
  assert.deepEqual([raw.patients, raw.min_total, raw.include_hygiene], [[5, 6], 500, "false"]);
  assert.deepEqual(raw.hygiene_codes, DEFAULT_HYGIENE_CODES);
});

test("one office-wide hygiene list (hygieneCodes) for every report that uses it", async () => {
  assert.throws(() => validateConfig({ apps: [], hygieneCodes: ["D1110", "bad code!"] }, { requireApps: false }), /hygieneCodes/);
  assert.ok(DEFAULT_HYGIENE_CODES.includes("D4341") && !DEFAULT_HYGIENE_CODES.includes("D0330"));
  const office = buildOffice({ today: TODAY });
  const fake = await startFakeOD();
  const od = { ...createClient({ baseUrl: fake.url, developerKey: "dev1", customerKey: "cust1" }), fakeReportRows: (n, p, o) => fakeReportRows(office, n, p, o) };
  const key = "k".repeat(30);
  const config = validateConfig({ auditLogDir: null, hygieneCodes: ["D0120"], apps: [{ name: "a", keyHash: hashKey(key), allow: [], reports: ["unscheduled_treatment", "no_future_appointment"] }] });
  const http = require("node:http");
  const srv = http.createServer(createGateway({ config, od, fake: true }));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const gw = createGatewayClient({ url: `http://127.0.0.1:${srv.address().port}`, key });
    assert.ok((await gw.runReport("unscheduled_treatment", {})).rows.some((r) => r.ProcCode === "D1110"), "only D0120 is hygiene now");
    const withList = (await gw.runReport("no_future_appointment", {})).rows;
    const builtIn = (await runReport({ fakeReportRows: od.fakeReportRows }, "no_future_appointment", {})).rows;
    assert.ok(withList.reduce((a, r) => a + r.PlannedTotal, 0) >= builtIn.reduce((a, r) => a + r.PlannedTotal, 0));
  } finally {
    srv.close();
    await fake.close();
  }
});

test("gateway reportDefaults fill in what the app didn't send", async () => {
  assert.throws(() => validateConfig({ apps: [], labSync: undefined, reportDefaults: { unscheduled_treatment: { hygiene_codes: ["bad code!"] } } }, { requireApps: false }), /reportDefaults\.unscheduled_treatment/);
  const office = buildOffice({ today: TODAY });
  const fake = await startFakeOD();
  const od = { ...createClient({ baseUrl: fake.url, developerKey: "dev1", customerKey: "cust1" }), fakeReportRows: (n, p, o) => fakeReportRows(office, n, p, o) };
  const key = "k".repeat(30);
  const config = validateConfig({ auditLogDir: null, reportDefaults: { unscheduled_treatment: { hygiene_codes: ["D0120"] } }, apps: [{ name: "a", keyHash: hashKey(key), allow: [], reports: ["unscheduled_treatment"] }] });
  const http = require("node:http");
  const srv = http.createServer(createGateway({ config, od, fake: true }));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const gw = createGatewayClient({ url: `http://127.0.0.1:${srv.address().port}`, key });
    const rows = (await gw.runReport("unscheduled_treatment", {})).rows;
    assert.ok(rows.some((r) => r.ProcCode === "D1110"), "only D0120 is excluded now");
    const explicit = (await gw.runReport("unscheduled_treatment", { hygiene_codes: ["D1110"] })).rows;
    assert.ok(!explicit.some((r) => r.ProcCode === "D1110"));
  } finally {
    srv.close();
    await fake.close();
  }
});

test("direct mode runs the same post step on Open Dental's rows", async () => {
  const sqlRows = [{ PatNum: 1, LName: "A", FName: "B", Carrier: "C", GroupName: "G", BenefitYearStart: "2026-01-01", AnnualMax: "1000.00", Used: "250.5", AsOf: "2026-11-16" }];
  const od = { shortQuery: async (sql) => (assert.match(sql, /FROM patplan pp/), { rows: sqlRows, truncated: false }) };
  const { rows } = await runReport(od, "insurance_remaining", {});
  assert.deepEqual(rows[0], { ...sqlRows[0], AnnualMax: 1000, Used: 250.5, Remaining: 749.5, IsEstimate: true });
});

// ------------------------------------------------------------------ demo safety and fake data

test("demo gateway refuses Open Dental keys and published test keys", async () => {
  process.env.OD_DEVELOPER_KEY = "x";
  try {
    await assert.rejects(startDemoGateway({ keys: TEST_KEYS, port: 0 }), /never talks to real Open Dental/);
  } finally {
    delete process.env.OD_DEVELOPER_KEY;
  }
  const run = (env) => spawnSync(process.execPath, [path.join(__dirname, "..", "gateway", "demo", "server.js")], { env: { PATH: process.env.PATH, PORT: "0", ...env }, encoding: "utf8", timeout: 10000 });
  let r = run({ DEMO_KEY_DAYSHEET: TEST_KEYS.daysheet });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /published test keys/);
  r = run({});
  assert.match(r.stderr, /Set at least one DEMO_KEY_/);
  r = run({ DEMO_KEY_DAYSHEET: "y".repeat(40), OD_CUSTOMER_KEY: "z" });
  assert.match(r.stderr, /never talks to real Open Dental/);
});

test("fake office: fake people only, a schedule today, deterministic", () => {
  const a = buildOffice({ today: TODAY });
  assert.deepEqual(a, buildOffice({ today: TODAY }));
  assert.ok(!a.patient.some((p) => p.PatNum === 8133));
  assert.ok(a.patient.every((p) => /555-01\d\d/.test(p.WirelessPhone) && p.Email.endsWith("@example.com")));
  assert.equal(new Set(a.patient.map((p) => `${p.FName} ${p.LName}`)).size, a.patient.length);
  assert.ok(a.appointment.filter((x) => x.AptDateTime.startsWith(TODAY)).length >= 10);
  const sunday = buildOffice({ today: "2026-11-15" });
  assert.ok(sunday.appointment.some((x) => x.AptDateTime.startsWith("2026-11-15")), "today always has a schedule, even on a weekend");
});

test("presets: only Voice writes; every preset report exists", () => {
  for (const [name, p] of Object.entries(PRESETS)) {
    for (const r of p.reports) if (r !== "*") assert.ok(REPORTS[r], `${name}: ${r}`);
    const writes = p.allow.some((rule) => rule.methods.some((m) => m !== "GET"));
    assert.equal(writes, name === "voice" || name === "dev", name);
  }
});

// ------------------------------------------------------------------ sync-core

function tarGz(files) {
  const blocks = [];
  const header = (name, size, type = "0") => {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 100), 0);
    h.write("0000644\0", 100);
    h.write(size.toString(8).padStart(11, "0") + "\0", 124);
    h.write(type, 156);
    h.write("ustar\0" + "00", 257);
    h.fill(" ", 148, 156);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    return h;
  };
  const pad = (b) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    if (name.length > 99) {
      const rec = `path=${name}\n`;
      const pax = Buffer.from(`${rec.length + String(rec.length + 3).length + 1} ${rec}`);
      blocks.push(header("PaxHeader", pax.length, "x"), pad(pax));
    }
    blocks.push(header(name, data.length), pad(data));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

test("sync-core: tar reader handles long names", () => {
  const long = "opendental-claude-0.9.0/" + "d/".repeat(50) + "x.js";
  const files = untar(zlib.gunzipSync(tarGz({ "opendental-claude-0.9.0/core/a.js": "A", [long]: "B" })));
  assert.deepEqual(files.map((f) => [f.name, f.data.toString()]), [["opendental-claude-0.9.0/core/a.js", "A"], [long, "B"]]);
});

test("sync-core: copies core/ into vendor/opendental-core with VERSION and CHECKSUMS, and it works there", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-core-"));
  try {
    const script = path.join(__dirname, "..", "scripts", "sync-core.js");
    const repo = path.join(__dirname, "..");
    const version = require("../package.json").version;
    const run = (...a) => spawnSync(process.execPath, [script, ...a], { cwd: dir, encoding: "utf8" });
    let r = run(version, "--from", repo);
    assert.equal(r.status, 0, r.stderr);
    const vend = path.join(dir, "vendor", "opendental-core");
    assert.equal(fs.readFileSync(path.join(vend, "VERSION"), "utf8"), version + "\n");
    for (const f of fs.readdirSync(path.join(repo, "core"))) assert.ok(fs.existsSync(path.join(vend, f)), f);
    assert.match(fs.readFileSync(path.join(vend, "CHECKSUMS"), "utf8"), /^[0-9a-f]{64} {2}odclient\.js$/m);
    // The vendored copy runs on its own.
    const out = execFileSync(process.execPath, ["-e", `const {createClient}=require(${JSON.stringify(path.join(vend, "odclient.js"))});console.log(createClient({gatewayUrl:"http://127.0.0.1:8787",gatewayKey:"${"x".repeat(20)}"}).mode)`], { encoding: "utf8" });
    assert.equal(out.trim(), "gateway");
    // Wrong version, bad version, a folder it didn't make.
    r = run("0.0.1", "--from", repo);
    assert.match(r.stderr, /Version mismatch/);
    r = run("latest");
    assert.match(r.stderr, /isn't a version/);
    fs.writeFileSync(path.join(dir, "vendor", "opendental-core", "VERSION"), "x");
    fs.mkdirSync(path.join(dir, "other"));
    fs.writeFileSync(path.join(dir, "other", "keep.txt"), "mine");
    r = run(version, "--from", repo, "--dest", "other");
    assert.match(r.stderr, /not touching it/);
    assert.ok(fs.existsSync(path.join(dir, "other", "keep.txt")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
