"use strict";
/**
 * The TrueNAS/Docker side: self-updating runner, init, tar, and the gateway's
 * protections for being reachable through a tunnel. Fake data only.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const { createRunner, compareVersions } = require("../gateway/runner");
const { tar, untar, safeName } = require("../gateway/tar");
const { buildGatewayTar } = require("../scripts/build");
const { validateConfig, hashKey } = require("../gateway/config");
const { createGateway } = require("../gateway/app");
const { createGatewayClient } = require("../core/gateway-client");

const ROOT = path.join(__dirname, "..");
const CLI = path.join(ROOT, "gateway", "cli.js");
const freePort = () =>
  new Promise((r) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => r(p));
    });
  });
const tmp = (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "odgw-runner-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

test("tar: write and read back, long names, unsafe names refused", () => {
  const long = "gateway/" + "deep/".repeat(25) + "x.js";
  const files = untar(tar([{ name: "a.txt", data: Buffer.from("A") }, { name: long, data: Buffer.from("B") }]));
  assert.deepEqual(files.map((f) => [f.name, f.data.toString()]), [["a.txt", "A"], [long, "B"]]);
  assert.equal(safeName("gateway/x.js"), "gateway/x.js");
  for (const bad of ["../x", "/etc/passwd", "a/../../b", "C:/x", "..\\x"]) assert.equal(safeName(bad), null, bad);
  const names = buildGatewayTar().names;
  for (const n of ["package.json", "core/odclient.js", "gateway/server.js", "gateway/runner.js", "gateway/tar.js"]) assert.ok(names.includes(n), n);
  assert.ok(!names.some((n) => /demo\/|windows\/|\.env$/.test(n)));
});

test("versions compare numerically", () => {
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("0.9.0-test.1", "0.1.0"), -1); // test builds never count as newer
});

test("init: config with a key per module, .env and module-keys.txt (private), refuses to overwrite", (t) => {
  const dir = tmp(t);
  let r = spawnSync(process.execPath, [CLI, "init", dir, "--stage", "design", "--modules", "daysheet,voice"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, "gateway.config.json"), "utf8"));
  assert.equal(cfg.stage, "design");
  assert.deepEqual(cfg.listen, { host: "127.0.0.1", port: 8787 });
  assert.deepEqual(cfg.trustProxy, ["127.0.0.1", "::1"]);
  assert.deepEqual(cfg.apps.map((a) => a.name), ["daysheet", "voice"]);
  const keys = fs.readFileSync(path.join(dir, "module-keys.txt"), "utf8");
  const daysheetKey = keys.match(/^daysheet\s+(\S+)$/m)[1];
  assert.equal(cfg.apps[0].keyHash, hashKey(daysheetKey));
  assert.ok(!JSON.stringify(cfg).includes(daysheetKey), "the config holds only hashes");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(dir, "module-keys.txt")).mode & 0o077, 0);
    assert.equal(fs.statSync(path.join(dir, ".env")).mode & 0o077, 0);
  }
  assert.equal(spawnSync(process.execPath, [CLI, "check", path.join(dir, "gateway.config.json")]).status, 0);
  r = spawnSync(process.execPath, [CLI, "init", dir], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /already exists/);
  assert.match(spawnSync(process.execPath, [CLI, "init", dir, "--force", "--modules", "nope"], { encoding: "utf8" }).stderr, /Unknown module/);
});

// ------------------------------------------------------------------ gateway protections

async function gateway(t, extra = {}) {
  const key = "k".repeat(30);
  const config = validateConfig({ auditLogDir: null, apps: [{ name: "a", keyHash: hashKey(key), allow: [{ methods: ["GET"], paths: ["/providers"] }] }], ...extra });
  const od = { request: async () => [{ ProvNum: 1 }], getAll: async () => ({ rows: [], truncated: false }), shortQuery: async () => ({ rows: [] }) };
  let clock = Date.now();
  const srv = http.createServer(createGateway({ config, od, now: () => clock }));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const url = `http://127.0.0.1:${srv.address().port}`;
  return { url, key, tick: (ms) => (clock += ms) };
}

test("wrong keys: after 10 from one address, that address waits 15 minutes; /health stays open", async (t) => {
  const g = await gateway(t);
  const bad = createGatewayClient({ url: g.url, key: "w".repeat(30) });
  for (let i = 0; i < 10; i++) await assert.rejects(bad.request("GET", "/providers"), (e) => e.status === 401);
  await assert.rejects(bad.request("GET", "/providers"), (e) => e.status === 429 && /Too many wrong app keys/.test(e.message));
  // Even the right key from that address waits now.
  const good = createGatewayClient({ url: g.url, key: g.key });
  await assert.rejects(good.request("GET", "/providers"), (e) => e.status === 429);
  assert.equal((await good.health()).ok, true); // /health stays open
  g.tick(16 * 60000);
  assert.deepEqual(await good.request("GET", "/providers"), [{ ProvNum: 1 }]);
});

test("the visitor-address headers (X-Forwarded-For, CF-Connecting-IP) are trusted only from the listed proxies", async (t) => {
  // Trusted (loopback, like a Cloudflare tunnel on the same box): each visitor is counted separately.
  const g = await gateway(t, { trustProxy: ["127.0.0.1", "::1"] });
  const hit = (ip) => fetch(`${g.url}/v1/od/providers`, { headers: { Authorization: "Bearer " + "w".repeat(30), "X-Forwarded-For": ip } }).then((r) => r.status);
  for (let i = 0; i < 10; i++) assert.equal(await hit("100.64.0.1"), 401);
  assert.equal(await hit("100.64.0.1"), 429);
  assert.equal(await hit("100.64.0.2"), 401, "another visitor isn't blocked");
  // Cloudflare Tunnel's header counts too.
  const cf = (ip) => fetch(`${g.url}/v1/od/providers`, { headers: { Authorization: "Bearer " + "w".repeat(30), "CF-Connecting-IP": ip } }).then((r) => r.status);
  for (let i = 0; i < 10; i++) assert.equal(await cf("203.0.113.7"), 401);
  assert.equal(await cf("203.0.113.7"), 429);
  assert.equal(await cf("203.0.113.8"), 401);
  // Not trusted from elsewhere: the header is ignored, so all requests count as the real peer.
  const h = await gateway(t, { trustProxy: ["10.9.9.9"] });
  const hit2 = (ip) => fetch(`${h.url}/v1/od/providers`, { headers: { Authorization: "Bearer " + "w".repeat(30), "X-Forwarded-For": ip } }).then((r) => r.status);
  for (let i = 0; i < 10; i++) await hit2(`100.64.0.${i}`);
  assert.equal(await hit2("100.64.0.99"), 429, "a forged header doesn't dodge the block");
});

// ------------------------------------------------------------------ the self-updating runner

/** A copy of this repo as release version `version`, as a tar.gz (optionally with a broken server). */
function releaseTar(version, { broken = false } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const files = untar(zlib.gunzipSync(buildGatewayTar().data)).map((f) => {
    if (f.name === "package.json") return { name: f.name, data: Buffer.from(JSON.stringify({ ...pkg, version })) };
    if (broken && f.name === "gateway/server.js") return { name: f.name, data: Buffer.from("process.exit(3)") };
    return f;
  });
  return zlib.gzipSync(tar(files));
}

/** A stand-in for GitHub's API and release downloads. */
async function fakeGitHub(t) {
  const state = { release: null, files: {} };
  const srv = http.createServer((req, res) => {
    if (req.url === "/repos/MULLET156/opendental-claude/releases/latest") {
      if (!state.release) return res.writeHead(404).end();
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(state.release));
    }
    const f = state.files[req.url];
    if (!f) return res.writeHead(404).end();
    res.writeHead(200);
    res.end(f);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  state.publish = (version, tgz, { badSum = false, prerelease = false } = {}) => {
    const name = `opendental-gateway-${version}.tar.gz`;
    const sum = badSum ? "0".repeat(64) : crypto.createHash("sha256").update(tgz).digest("hex");
    state.files[`/dl/${name}`] = tgz;
    state.files[`/dl/${version}/SHA256SUMS`] = Buffer.from(`${sum}  ${name}\n`);
    state.release = { tag_name: `v${version}`, prerelease, draft: false, assets: [{ name, browser_download_url: `${base}/dl/${name}` }, { name: "SHA256SUMS", browser_download_url: `${base}/dl/${version}/SHA256SUMS` }] };
  };
  return { base, state };
}

async function setupRunner(t, env = {}) {
  const dir = tmp(t);
  const port = await freePort();
  spawnSync(process.execPath, [CLI, "init", dir, "--modules", "daysheet"]);
  const cfgFile = path.join(dir, "gateway.config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
  cfg.listen.port = port;
  cfg.auditLogDir = null;
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  fs.writeFileSync(path.join(dir, ".env"), "OD_BASE_URL=http://127.0.0.1:9/api/v1\nOD_DEVELOPER_KEY=testDeveloperKey\nOD_CUSTOMER_KEY=testCustomerKey\n");
  const gh = await fakeGitHub(t);
  const runner = createRunner({ configDir: dir, env: { PATH: process.env.PATH, UPDATE_API: gh.base, ...env }, startupMs: 15000, quiet: true });
  t.after(() => runner.stop());
  const health = async () => {
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`);
        if (r.ok) return r.json();
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("gateway never answered");
  };
  return { dir, gh, runner, health };
}

test("runner: update, then a broken release rolls back and is never retried; bad checksums and test builds are ignored", async (t) => {
  const { dir, gh, runner, health } = await setupRunner(t);
  const baked = require("../package.json").version;
  runner.start();
  assert.equal((await health()).version, baked);

  // Older or equal: nothing to do. Test builds (prereleases) never count.
  gh.state.publish(baked, releaseTar(baked));
  assert.equal(await runner.checkForUpdate(), "current");
  gh.state.publish("98.0.0", releaseTar("98.0.0"), { prerelease: true });
  assert.equal(await runner.checkForUpdate(), "current");

  // A good new release: downloaded, checked, switched, healthy.
  gh.state.publish("98.0.0", releaseTar("98.0.0"));
  assert.equal(await runner.checkForUpdate(), "updated:98.0.0");
  assert.equal((await health()).version, "98.0.0");
  assert.equal(runner.activeDir().version, "98.0.0");
  assert.ok(fs.existsSync(path.join(dir, "code", "98.0.0", "gateway", "server.js")));

  // A wrong checksum: refused, nothing changes.
  gh.state.publish("98.0.1", releaseTar("98.0.1"), { badSum: true });
  await assert.rejects(runner.checkForUpdate(), /Checksum mismatch/);
  assert.equal(runner.activeDir().version, "98.0.0");

  // A release that won't start: rolled back to 98.0.0 and marked bad.
  gh.state.publish("98.0.2", releaseTar("98.0.2", { broken: true }));
  assert.equal(await runner.checkForUpdate(), "rolled-back:98.0.2");
  assert.equal((await health()).version, "98.0.0");
  assert.deepEqual(runner.readState().bad, ["98.0.2"]);
  assert.equal(await runner.checkForUpdate(), "current", "a bad version isn't tried again");
});

test("runner: AUTO_UPDATE=off never checks", async (t) => {
  const { runner, gh } = await setupRunner(t, { AUTO_UPDATE: "off" });
  gh.state.publish("98.0.0", releaseTar("98.0.0"));
  assert.equal(await runner.checkForUpdate(), "off");
});
