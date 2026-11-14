"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { startFakeOD } = require("./fake-od");
const { buildConfig } = require("../gateway/windows/setup-helper");
const { loadConfig, loadEnvFile } = require("../gateway/config");
const { buildGatewayWindows } = require("../scripts/build");

const HELPER = path.join(__dirname, "..", "gateway", "windows", "setup-helper.js");

function helper(args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [HELPER, ...args], { env: { PATH: process.env.PATH, ...env } }, (err, stdout) => {
      resolve({ code: err ? err.code : 0, json: JSON.parse(stdout.trim()) });
    });
  });
}

function tmpDir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "odgw-setup-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

test("setup: new config with lab sync, example apps dropped, other apps kept", () => {
  const example = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "gateway", "gateway.config.example.json"), "utf8"));
  const env = { SETUP_LABSYNC: "1", SETUP_TRACKER_URL: "https://lab.example.com/od-sync.php", SETUP_IN_HOUSE: "1, 3", SETUP_SYNC_FROM: "2026-11-16", SETUP_PATIENT_FORMAT: "initials" };
  const cfg = buildConfig(example, env);
  assert.equal(cfg.apps.length, 0);
  assert.deepEqual(cfg.labSync, { ...example.labSync, enabled: true, trackerUrl: env.SETUP_TRACKER_URL, syncFrom: "2026-11-16", inHouseLabs: [1, 3], patientFormat: "initials" });

  const withApp = buildConfig({ apps: [{ name: "x", keyHash: "sha256:" + "ab".repeat(32), allow: [] }], labSync: cfg.labSync }, { SETUP_LABSYNC: "0" });
  assert.equal(withApp.apps.length, 1);
  assert.equal(withApp.labSync.enabled, false);
  assert.equal(withApp.labSync.trackerUrl, env.SETUP_TRACKER_URL); // kept for next time
});

test("setup helper: tests keys, lists labs, writes a config the gateway accepts", async (t) => {
  const od = await startFakeOD();
  t.after(() => od.close());
  const dir = tmpDir(t);
  const config = path.join(dir, "gateway.config.json");
  // .env written the way setup.ps1 writes it (CRLF, no BOM); also try with a BOM.
  fs.writeFileSync(path.join(dir, ".env"), `\uFEFFOD_DEVELOPER_KEY=dev1\r\nOD_CUSTOMER_KEY=cust1\r\nOD_BASE_URL=${od.url}\r\nLAB_SYNC_SECRET=${"a".repeat(64)}\r\n`);

  let r = await helper(["test-od", config]);
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true);
  assert.ok(r.json.providers > 0);

  r = await helper(["labs", config]);
  assert.deepEqual(r.json.labs, [{ num: 1, name: "Smile Lab" }]); // hidden lab left out

  r = await helper(["get", config]);
  assert.deepEqual(r.json, { ok: true, exists: false, apps: 0, labSync: null });

  r = await helper(["write", config], { SETUP_LABSYNC: "0" });
  assert.deepEqual(r.json, { ok: true, runnable: false });

  r = await helper(["write", config], { SETUP_LABSYNC: "1", SETUP_TRACKER_URL: "https://lab.example.com/od-sync.php", SETUP_IN_HOUSE: "1", SETUP_SYNC_FROM: "2026-11-16" });
  assert.deepEqual(r.json, { ok: true, runnable: true });
  const cfg = loadConfig(config);
  assert.equal(cfg.labSync.trackerUrl, "https://lab.example.com/od-sync.php");
  assert.equal(cfg.auditLogDir, path.join(dir, "logs"));

  r = await helper(["get", config]);
  assert.equal(r.json.labSync.inHouseLabs, "1");

  r = await helper(["write", config], { SETUP_LABSYNC: "1", SETUP_TRACKER_URL: "http://lab.example.com/od-sync.php", SETUP_SYNC_FROM: "2026-11-16" });
  assert.equal(r.code, 1);
  assert.match(r.json.error, /https/);

  r = await helper(["secret"]);
  assert.match(r.json.secret, /^[a-f0-9]{64}$/);
});

test("setup helper: explains bad keys and an unreachable server", async (t) => {
  const od = await startFakeOD();
  t.after(() => od.close());
  const dir = tmpDir(t);
  const config = path.join(dir, "gateway.config.json");
  od.state.failNext.push({ status: 401 });
  fs.writeFileSync(path.join(dir, ".env"), `OD_DEVELOPER_KEY=dev1\nOD_CUSTOMER_KEY=wrong\nOD_BASE_URL=${od.url}\n`);
  let r = await helper(["test-od", config]);
  assert.equal(r.code, 1);
  assert.match(r.json.error, /refused the keys/);
  assert.doesNotMatch(r.json.error, /wrong|dev1/);

  fs.writeFileSync(path.join(dir, ".env"), `OD_DEVELOPER_KEY=dev1\nOD_CUSTOMER_KEY=cust1\nOD_BASE_URL=http://127.0.0.1:1/api/v1\n`);
  r = await helper(["test-od", config]);
  assert.match(r.json.error, /Can't reach Open Dental/);
});

test(".env and config files saved by Notepad with a byte-order mark still load", (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, ".env"), "\uFEFFODGW_TEST_BOM=yes\n");
  loadEnvFile(path.join(dir, ".env"));
  assert.equal(process.env.ODGW_TEST_BOM, "yes");
  fs.writeFileSync(path.join(dir, "c.json"), '\uFEFF{"labSync":{"trackerUrl":"https://a.example.com/od-sync.php","syncFrom":"2026-11-16"}}');
  assert.equal(loadConfig(path.join(dir, "c.json")).labSync.syncFrom, "2026-11-16");
});

test("Windows download has Setup.cmd at the top and the gateway under app/", () => {
  const names = buildGatewayWindows().names;
  for (const n of ["Setup.cmd", "README.txt", "settings.txt", "app/package.json", "app/LICENSE", "app/core/odclient.js", "app/core/reports.js", "app/gateway/server.js", "app/gateway/lab-sync.js", "app/gateway/windows/setup.ps1", "app/gateway/windows/setup-helper.js", "app/gateway/windows/Setup.cmd"]) {
    assert.ok(names.includes(n), n);
  }
  assert.ok(!names.some((n) => /(^|\/)\.env$|gateway\.config\.json$|node_modules/.test(n)));
});

test("settings.txt template has no values for keys or the secret", () => {
  const text = fs.readFileSync(path.join(__dirname, "..", "gateway", "windows", "settings.txt"), "utf8");
  for (const k of ["DEVELOPER_KEY", "CUSTOMER_KEY", "SHARED_SECRET", "LAB_TRACKER_ADDRESS", "LAB_SYNC"]) assert.match(text, new RegExp(`^${k}=$`, "m"), k);
  assert.match(text, /^OPEN_DENTAL_ADDRESS=http:\/\/127\.0\.0\.1:30223\/api\/v1$/m);
});
