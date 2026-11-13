"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { startFakeOD } = require("./fake-od");
const { createClient } = require("../core/odclient");
const { validateConfig, newKey, hashKey, compilePattern, ConfigError } = require("../gateway/config");
const { createGateway } = require("../gateway/app");

const LAB = newKey();
const DASH = newKey();
const SQL = newKey();
const OFF = newKey();

function config(logDir) {
  const cfg = validateConfig({
    auditLogDir: logDir,
    maxRows: 150,
    corsOrigins: ["https://dash.example.com"],
    apps: [
      {
        name: "lab",
        keyHash: hashKey(LAB),
        allow: [
          { methods: ["GET"], paths: ["/patients", "/patients/*", "/appointments"] },
          { methods: ["POST"], paths: ["/commlogs"] },
        ],
        rateLimitPerMinute: 1000,
        maxBodyBytes: 2 * 1024 * 1024,
      },
      { name: "dash", keyHash: hashKey(DASH), reports: ["production_by_provider"], redact: ["Email"], rateLimitPerMinute: 4 },
      { name: "sql", keyHash: hashKey(SQL), rawSql: true, reports: ["*"] },
      { name: "off", keyHash: hashKey(OFF), disabled: true, reports: ["*"] },
    ],
  });
  cfg.auditLogDir = logDir;
  return cfg;
}

async function startGateway(od, logDir) {
  const client = createClient({ baseUrl: od.url, developerKey: "dev1", customerKey: "cust1", maxRows: 150 });
  const server = http.createServer(createGateway({ config: config(logDir), od: client, version: "test" }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, { key, body, headers = {} } = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const t = await res.text();
    return { status: res.status, headers: res.headers, body: t ? JSON.parse(t) : null };
  };
  return { call, close: () => new Promise((r) => server.close(r)) };
}

test("gateway end to end", async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "odgw-"));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const od = await startFakeOD();
  const gw = await startGateway(od, logDir);
  try {
    // health needs no key and never calls Open Dental
    let r = await gw.call("GET", "/health");
    assert.equal(r.status, 200);
    assert.equal(od.requests.length, 0);

    // auth
    assert.equal((await gw.call("GET", "/v1/me")).status, 401);
    assert.equal((await gw.call("GET", "/v1/me", { key: "odg_wrong" })).status, 401);
    assert.equal((await gw.call("GET", "/v1/me", { key: OFF })).status, 401);
    r = await gw.call("GET", "/v1/me", { key: LAB });
    assert.equal(r.body.app, "lab");

    // pass-through reads with redaction and paging
    r = await gw.call("GET", "/v1/od/patients/12", { key: LAB });
    assert.equal(r.status, 200);
    assert.equal(r.body.SSN, "[redacted]");
    assert.equal(r.body.Email, "a@b.c");
    r = await gw.call("GET", "/v1/od/patients?LName=smi&all=true", { key: LAB });
    assert.equal(r.body.length, 150);
    assert.equal(r.headers.get("x-truncated"), "true");
    r = await gw.call("GET", "/v1/od/patients?LName=smi&all=true&limit=20", { key: LAB });
    assert.equal(r.body.length, 20);
    const sent = od.requests.filter((q) => q.path.endsWith("/patients")).pop();
    assert.equal(sent.query.LName, "smi");
    assert.equal(sent.query.all, undefined);
    assert.equal(sent.auth, "ODFHIR dev1/cust1");

    // permission checks happen before Open Dental is called
    const before = od.requests.length;
    assert.equal((await gw.call("GET", "/v1/od/providers", { key: LAB })).status, 403);
    assert.equal((await gw.call("PUT", "/v1/od/patients/12", { key: LAB, body: { LName: "x" } })).status, 403);
    assert.equal((await gw.call("DELETE", "/v1/od/patients/12", { key: LAB })).status, 403);
    assert.equal((await gw.call("PUT", "/v1/od/queries/ShortQuery", { key: SQL, body: { SqlCommand: "DELETE FROM patient" } })).status, 403);
    assert.equal((await gw.call("GET", "/v1/od/patients/../providers", { key: LAB })).status, 403);
    assert.equal((await gw.call("POST", "/v1/reports/production_by_provider", { key: LAB, body: {} })).status, 403);
    assert.equal((await gw.call("POST", "/v1/query", { key: DASH, body: { sql: "SELECT 1" } })).status, 403);
    assert.equal(od.requests.length, before);

    // write pass-through
    r = await gw.call("POST", "/v1/od/commlogs", { key: LAB, body: { PatNum: 1, Note: "Lab case sent", Mode_: "None" } });
    assert.equal(r.status, 201);
    assert.equal(r.body.CommlogNum, 5);
    assert.equal(od.requests.at(-1).body.Note, "Lab case sent");
    assert.equal((await gw.call("POST", "/v1/od/commlogs", { key: LAB, body: "x" })).status, 400);

    // reports
    r = await gw.call("GET", "/v1/reports", { key: DASH });
    assert.deepEqual(r.body.reports.map((x) => x.name), ["production_by_provider"]);
    r = await gw.call("GET", "/v1/reports/production_by_provider?from=2026-11-01&to=2026-11-30", { key: DASH });
    assert.equal(r.status, 200);
    assert.equal(r.body.rows[0].GrossProduction, 1234.5);
    assert.equal((await gw.call("POST", "/v1/reports/production_by_provider", { key: DASH, body: { params: { from: "2026-11-01" } } })).status, 400);
    // dash allows 4/min and has made 4 calls (one refused SQL, list, run, bad params), so the 5th is limited
    assert.equal((await gw.call("GET", "/v1/reports", { key: DASH })).status, 429);

    // raw SQL only for rawSql apps, and still read-only
    r = await gw.call("POST", "/v1/query", { key: SQL, body: { sql: "SELECT ProvNum FROM provider" } });
    assert.equal(r.status, 200);
    r = await gw.call("POST", "/v1/query", { key: SQL, body: { sql: "UPDATE patient SET LName='x'" } });
    assert.equal(r.status, 403);
    r = await gw.call("POST", "/v1/reports/production_by_day", { key: SQL, body: { params: { from: "2026-11-01", to: "2026-11-02" } } });
    assert.equal(r.status, 200);

    // upstream errors map through without leaking keys
    od.state.failNext.push({ status: 401 });
    r = await gw.call("GET", "/v1/od/appointments?date=2026-11-13", { key: LAB });
    assert.equal(r.status, 401);
    assert.match(r.body.error.message, /keys rejected/);
    assert.doesNotMatch(JSON.stringify(r.body), /dev1|cust1/);

    // CORS only for listed origins
    r = await gw.call("GET", "/health", { headers: { Origin: "https://dash.example.com" } });
    assert.equal(r.headers.get("access-control-allow-origin"), "https://dash.example.com");
    r = await gw.call("GET", "/health", { headers: { Origin: "https://evil.example.com" } });
    assert.equal(r.headers.get("access-control-allow-origin"), null);

    // body size limit is per app: lab may send 2 MB, sql app keeps the 1 MB default
    od.state.failNext.length = 0;
    assert.equal((await gw.call("POST", "/v1/od/commlogs", { key: LAB, body: { Note: "x".repeat(1100000) } })).status, 201);
    r = await gw.call("POST", "/v1/od/commlogs", { key: LAB, body: { Note: "x".repeat(2200000) } });
    assert.equal(r.status, 413);
    assert.match(r.body.error.message, /2048 KB/);
    assert.equal((await gw.call("POST", "/v1/query", { key: SQL, body: { sql: "SELECT 1", pad: "x".repeat(1100000) } })).status, 413);

    // unknown route
    assert.equal((await gw.call("GET", "/v1/nope", { key: LAB })).status, 404);

    // audit log: one line per request, no patient data or keys
    await new Promise((r2) => setTimeout(r2, 200));
    const files = fs.readdirSync(logDir);
    assert.equal(files.length, 1);
    const log = fs.readFileSync(path.join(logDir, files[0]), "utf8");
    const lines = log.trim().split("\n").map(JSON.parse);
    assert.ok(lines.length >= 25);
    assert.ok(lines.some((l) => l.app === "lab" && l.target === "/patients/{id}" && l.status === 200));
    assert.doesNotMatch(log, /smi|Lab case sent|odg_|dev1|cust1|\/patients\/12/);
  } finally {
    await gw.close();
    await od.close();
  }
});

test("gateway config validation", () => {
  const ok = { name: "a", keyHash: hashKey("k") };
  assert.throws(() => validateConfig({ apps: [] }), /No apps/);
  assert.throws(() => validateConfig({ apps: [{ ...ok, keyHash: "plain" }] }), /keyHash/);
  assert.throws(() => validateConfig({ apps: [ok, { ...ok }] }), /Two apps are named/);
  assert.throws(() => validateConfig({ apps: [ok, { ...ok, name: "b" }] }), /share the same key/);
  assert.throws(() => validateConfig({ apps: [{ ...ok, allow: [{ methods: ["PATCH"], paths: ["/x"] }] }] }), /unknown method/);
  assert.throws(() => validateConfig({ apps: [{ ...ok, allow: [{ paths: ["/queries/ShortQuery"] }] }] }), /queries/);
  assert.throws(() => validateConfig({ corsOrigins: ["*"], apps: [ok] }), ConfigError);
  assert.ok(compilePattern("/patients/*").test("/patients/5"));
  assert.ok(!compilePattern("/patients/*").test("/patients/5/x"));
  assert.ok(compilePattern("/appointments/**").test("/appointments/5/Break"));
  assert.ok(!compilePattern("/appointments/**").test("/appointments"));
  assert.ok(compilePattern("/Patients").test("/patients"));
  assert.throws(() => validateConfig({ openDental: { plan: "gold" }, apps: [ok] }), /openDental.plan/);
  assert.throws(() => validateConfig({ openDental: { minIntervalMs: -5 }, apps: [ok] }), /minIntervalMs/);
  assert.throws(() => validateConfig({ apps: [{ ...ok, maxBodyBytes: 10 }] }), /maxBodyBytes/);
  assert.equal(validateConfig({ openDental: { plan: "enterprise" }, apps: [ok] }).openDental.plan, "enterprise");
  const example = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "gateway", "gateway.config.example.json"), "utf8"));
  assert.equal(validateConfig(example).apps.length, 3);
});
