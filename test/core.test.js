"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { startFakeOD } = require("./fake-od");
const { createClient, normalizeBaseUrl, guardReadOnlySql, redact, recordId, checkDate, ODError } = require("../core/odclient");
const { buildReport, describeReports, REPORTS } = require("../core/reports");

const KEYS = { developerKey: "devKey123", customerKey: "custKey456" };

test("base URL: cloud default, LAN http ok, public http refused, junk refused", () => {
  assert.equal(normalizeBaseUrl(""), "https://api.opendental.com/api/v1");
  assert.equal(normalizeBaseUrl("http://192.168.1.20:30223/api/v1/"), "http://192.168.1.20:30223/api/v1");
  assert.equal(normalizeBaseUrl("http://odserver:30223/api/v1"), "http://odserver:30223/api/v1");
  assert.throws(() => normalizeBaseUrl("http://example.com/api/v1"), /Plain http/);
  assert.throws(() => normalizeBaseUrl("https://user:pw@example.com"), /username/);
  assert.throws(() => normalizeBaseUrl("ftp://x"), ODError);
  assert.throws(() => normalizeBaseUrl("not a url"), /not a valid URL/);
});

test("SQL guard allows reads, blocks writes even when hidden", () => {
  assert.ok(guardReadOnlySql("SELECT 'delete me' AS x FROM patient WHERE a<'2026'").includes("< '2026'"));
  assert.ok(guardReadOnlySql("SET @d = '2026-01-01'; SELECT @d"));
  for (const bad of [
    "DELETE FROM patient",
    "SELECT 1; UPDATE patient SET LName='x'",
    "SELECT * FROM patient INTO OUTFILE '/tmp/x'",
    "SELECT 1 /* */; DROP TABLE patient",
    "CREATE TABLE x (a int)",
    "SELECT SLEEP(10)",
    "WITH a AS (SELECT 1) DELETE FROM patient",
    "SET GLOBAL max_connections = 1",
  ]) {
    assert.throws(() => guardReadOnlySql(bad), /read-only/, bad);
  }
  assert.ok(guardReadOnlySql("CREATE TEMPORARY TABLE t AS SELECT 1; SELECT * FROM t; DROP TEMPORARY TABLE t"));
});

test("redaction removes SSN at every depth", () => {
  const r = redact([{ SSN: "1", a: { PatientSSN: "2", b: [{ ssn: "3", keep: 4 }] } }]);
  assert.deepEqual(r, [{ SSN: "[redacted]", a: { PatientSSN: "[redacted]", b: [{ ssn: "[redacted]", keep: 4 }] } }]);
});

test("validators", () => {
  assert.equal(recordId("x", "42"), 42);
  for (const bad of [0, -1, 1.5, "1e3", "abc", true, "12/3"]) assert.throws(() => recordId("x", bad), ODError, String(bad));
  assert.throws(() => checkDate("d", "2026-02-30"), /real date/);
  assert.doesNotThrow(() => checkDate("d", "2028-02-29"));
});

test("client: auth header, paging, row cap, no key leaks", async () => {
  const od = await startFakeOD();
  try {
    const c = createClient({ baseUrl: od.url, ...KEYS, maxRows: 150 });
    const { rows, truncated } = await c.getAll("/patients", { LName: "smi" });
    assert.equal(rows.length, 150);
    assert.equal(truncated, true);
    assert.equal(od.requests[0].auth, "ODFHIR devKey123/custKey456");
    assert.deepEqual(od.requests.map((r) => r.query.Offset), [undefined, "100"]);

    const all = await createClient({ baseUrl: od.url, ...KEYS }).getAll("/patients", {});
    assert.equal(all.rows.length, 207);
    assert.equal(all.truncated, false);

    await assert.rejects(c.request("GET", "/boom"), (e) => {
      assert.match(e.message, /500/);
      assert.doesNotMatch(e.message, /devKey123|custKey456/);
      return true;
    });
  } finally {
    await od.close();
  }
});

test("client: never follows redirects", async () => {
  const od = await startFakeOD();
  try {
    const c = createClient({ baseUrl: od.url, ...KEYS });
    await assert.rejects(c.request("GET", "/redirect"), /redirect/);
    assert.equal(od.requests.length, 1);
  } finally {
    await od.close();
  }
});

test("client: retries 429 with Retry-After, bounded", async () => {
  const od = await startFakeOD();
  try {
    const c = createClient({ baseUrl: od.url, ...KEYS, maxRetries: 2 });
    od.state.failNext.push({ status: 429, retryAfter: "0" }, { status: 503, retryAfter: "0" });
    const r = await c.request("GET", "/providers");
    assert.equal(r[0].ProvNum, 1);
    assert.equal(od.requests.length, 3);

    od.state.failNext.push({ status: 429, retryAfter: "0" }, { status: 429, retryAfter: "0" }, { status: 429, retryAfter: "0" });
    await assert.rejects(c.request("GET", "/providers"), /429/);

    od.state.failNext.push({ status: 429, retryAfter: "3600" });
    await assert.rejects(c.request("GET", "/providers"), /429/);
  } finally {
    await od.close();
  }
});

test("client: rejects bad paths and missing keys before any request", async () => {
  const od = await startFakeOD();
  try {
    const c = createClient({ baseUrl: od.url, ...KEYS });
    for (const p of ["/patients/../x", "patients", "/a?b=1", "/a#x"]) await assert.rejects(c.request("GET", p), /Invalid API path/);
    await assert.rejects(createClient({ baseUrl: od.url }).request("GET", "/providers"), /Developer Key is not set/);
    assert.equal(od.requests.length, 0);
  } finally {
    await od.close();
  }
});

test("client: paces cloud-style requests", async () => {
  const od = await startFakeOD();
  try {
    const c = createClient({ baseUrl: od.url, ...KEYS, minIntervalMs: 150 });
    const t = Date.now();
    await Promise.all([c.request("GET", "/providers"), c.request("GET", "/providers"), c.request("GET", "/providers")]);
    assert.ok(Date.now() - t >= 290, "three requests should take at least two intervals");
  } finally {
    await od.close();
  }
});

test("reports: every report builds valid read-only SQL", () => {
  const sample = { from: "2026-01-01", to: "2026-01-31", codes: ["D2740", "D2950"], patient: 5, since: "2026-11-15" };
  for (const [name, def] of Object.entries(REPORTS)) {
    const params = {};
    for (const [k, s] of Object.entries(def.params)) if (s.required) params[k] = sample[k];
    const sql = buildReport(name, params);
    assert.doesNotThrow(() => guardReadOnlySql(sql), name);
  }
  assert.equal(describeReports().length, Object.keys(REPORTS).length);
});

test("reports: parameters are validated, never pasted raw", () => {
  assert.throws(() => buildReport("production_by_provider", { from: "2026-01-01" }), /needs "to"/);
  assert.throws(() => buildReport("production_by_provider", { from: "2026-01-01' OR 1=1 --", to: "2026-01-31" }), /date/);
  assert.throws(() => buildReport("procedure_counts", { from: "2026-01-01", to: "2026-01-31", codes: ["D2740'); DROP"] }), /procedure code/);
  assert.throws(() => buildReport("patient_recall", { patient: "1 OR 1=1" }), /positive whole number/);
  assert.throws(() => buildReport("production_by_provider", { from: "2026-02-01", to: "2026-01-01" }), /after/);
  assert.throws(() => buildReport("production_by_provider", { from: "2026-01-01", to: "2026-01-31", extra: 1 }), /no parameter "extra"/);
  assert.throws(() => buildReport("__proto__", {}), /Unknown report/);
  assert.throws(() => buildReport("writeoffs_by_provider", { from: "2026-01-01", to: "2026-01-31", basis: "x" }), /one of/);
  assert.match(buildReport("writeoffs_by_provider", { from: "2026-01-01", to: "2026-01-31", basis: "payment" }), /cp\.DateCP BETWEEN/);
  assert.match(buildReport("procedure_counts", { from: "2026-01-01", to: "2026-01-31", codes: "D2740, D6058" }), /IN \('D2740','D6058'\)/);
});

test("pacing follows the Open Dental plan for the cloud, none for local", () => {
  const cloud = (o) => createClient({ ...KEYS, ...o }).minIntervalMs;
  assert.equal(cloud({}), 1000);
  assert.equal(cloud({ plan: "read-all" }), 5000);
  assert.equal(cloud({ plan: "Enterprise" }), 500);
  assert.equal(cloud({ plan: "standard", minIntervalMs: 1500 }), 1500);
  assert.equal(cloud({ minIntervalMs: "" }), 1000);
  assert.equal(createClient({ ...KEYS, baseUrl: "http://192.168.1.5:30223/api/v1", plan: "read-all" }).minIntervalMs, 0);
  assert.throws(() => cloud({ plan: "gold" }), /Unknown Open Dental API plan/);
  assert.throws(() => cloud({ minIntervalMs: -1 }), /between 0 and 60000/);
});
