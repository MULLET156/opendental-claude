#!/usr/bin/env node
"use strict";
/**
 * Runs the gateway and keeps it up to date (used by the TrueNAS / Docker image).
 *
 *   node gateway/runner.js /config
 *
 * /config holds gateway.config.json, .env and logs/. The runner starts
 * gateway/server.js, restarts it if it stops, and once a day (UPDATE_HOUR, local
 * time) checks GitHub for a newer REGULAR release (never test builds). A new
 * version is downloaded into /config/code/<version>, checked against the
 * release's SHA256SUMS, must pass `cli.js check` on this config, and must answer
 * /health within a minute of starting; otherwise the runner goes back to the
 * version that was working and won't try that version again.
 *
 * Settings (environment):
 *   AUTO_UPDATE   on (default) or off
 *   UPDATE_HOUR   0-23, default 3 (3 am)
 *   UPDATE_REPO   default MULLET156/opendental-claude
 *   UPDATE_API    default https://api.github.com (tests point this elsewhere)
 */

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { untar, safeName } = require("./tar");

const BAKED = path.resolve(__dirname, "..");

function log(msg) {
  console.log(`[runner ${new Date().toISOString()}] ${msg}`);
}

/** 1 if a > b, -1 if a < b, 0 if equal (x.y.z; anything else counts as older). */
function compareVersions(a, b) {
  const p = (v) => (/^\d+\.\d+\.\d+$/.test(String(v)) ? String(v).split(".").map(Number) : [-1, -1, -1]);
  const x = p(a);
  const y = p(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

const versionOf = (dir) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version;
  } catch {
    return null;
  }
};

function createRunner({ configDir, env = process.env, fetchImpl = globalThis.fetch, nodeBin = process.execPath, startupMs = 60000, quiet = false } = {}) {
  const say = quiet ? () => {} : log;
  const codeDir = path.join(configDir, "code");
  const stateFile = path.join(codeDir, "state.json");
  const configFile = path.join(configDir, "gateway.config.json");
  const repo = env.UPDATE_REPO || "MULLET156/opendental-claude";
  const api = (env.UPDATE_API || "https://api.github.com").replace(/\/+$/, "");

  const readState = () => {
    try {
      return JSON.parse(fs.readFileSync(stateFile, "utf8"));
    } catch {
      return { current: null, previous: null, bad: [] };
    }
  };
  const writeState = (s) => {
    fs.mkdirSync(codeDir, { recursive: true });
    fs.writeFileSync(stateFile + ".tmp", JSON.stringify(s, null, 2));
    fs.renameSync(stateFile + ".tmp", stateFile);
  };

  /** The folder to run: a downloaded version if it's newer than the image's own, else the image's. */
  function activeDir() {
    const s = readState();
    const baked = versionOf(BAKED);
    if (s.current) {
      const dir = path.join(codeDir, s.current);
      if (versionOf(dir) === s.current && compareVersions(s.current, baked) > 0) return { dir, version: s.current };
    }
    return { dir: BAKED, version: baked };
  }

  /** Newest regular release, if it's newer than what's running and not marked bad. */
  async function findUpdate(running) {
    const res = await fetchImpl(`${api}/repos/${repo}/releases/latest`, { headers: { Accept: "application/vnd.github+json", "User-Agent": "opendental-gateway-runner" }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for the latest release`);
    const rel = await res.json();
    if (rel.prerelease || rel.draft) return null;
    const version = String(rel.tag_name || "").replace(/^v/, "");
    if (compareVersions(version, running) <= 0) return null;
    if (readState().bad.includes(version)) return null;
    const asset = (n) => (rel.assets || []).find((a) => a.name === n);
    const tarAsset = asset(`opendental-gateway-${version}.tar.gz`);
    const sums = asset("SHA256SUMS");
    if (!tarAsset || !sums) throw new Error(`Release v${version} has no gateway download or SHA256SUMS`);
    return { version, tarUrl: tarAsset.browser_download_url, sumsUrl: sums.browser_download_url, tarName: tarAsset.name };
  }

  async function download(url) {
    const res = await fetchImpl(url, { headers: { "User-Agent": "opendental-gateway-runner" }, signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Download, verify and unpack a release; check it against this config. Returns the folder. */
  async function install(update) {
    const [tgz, sums] = await Promise.all([download(update.tarUrl), download(update.sumsUrl)]);
    const want = String(sums)
      .split(/\r?\n/)
      .map((l) => l.trim().split(/\s+/))
      .find((p) => p[1] === update.tarName || p[1] === `*${update.tarName}`);
    const got = crypto.createHash("sha256").update(tgz).digest("hex");
    if (!want || want[0].toLowerCase() !== got) throw new Error(`Checksum mismatch for ${update.tarName}`);
    const dest = path.join(codeDir, update.version);
    const tmp = dest + ".tmp";
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const f of untar(zlib.gunzipSync(tgz))) {
      const rel = safeName(f.name);
      if (!rel) throw new Error(`Unsafe file name in download: ${f.name}`);
      fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
      fs.writeFileSync(path.join(tmp, rel), f.data);
    }
    if (versionOf(tmp) !== update.version) throw new Error("The download's version doesn't match the release");
    const check = spawnSync(nodeBin, [path.join(tmp, "gateway", "cli.js"), "check", configFile], { encoding: "utf8", timeout: 30000 });
    if (check.status !== 0) throw new Error(`v${update.version} doesn't accept this config: ${(check.stderr || check.stdout).trim()}`);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(tmp, dest);
    return dest;
  }

  let child = null;
  let stopping = false;
  let probing = null;

  function healthUrl() {
    try {
      const cfg = JSON.parse(fs.readFileSync(configFile, "utf8"));
      const host = !cfg.listen || !cfg.listen.host || cfg.listen.host === "0.0.0.0" ? "127.0.0.1" : cfg.listen.host;
      return `${cfg.tls ? "https" : "http"}://${host.includes(":") ? `[${host}]` : host}:${(cfg.listen && cfg.listen.port) || 8787}/health`;
    } catch {
      return "http://127.0.0.1:8787/health";
    }
  }

  function start() {
    const { dir, version } = activeDir();
    say(`starting gateway v${version}${dir === BAKED ? "" : " (downloaded)"}`);
    const started = Date.now();
    const c = spawn(nodeBin, [path.join(dir, "gateway", "server.js"), configFile], { env, stdio: quiet ? "ignore" : "inherit" });
    child = { proc: c, version, started };
    c.on("exit", (code, signal) => {
      if (stopping || !child || child.proc !== c) return;
      const quick = Date.now() - started < startupMs;
      say(`gateway v${version} stopped (${signal || code})`);
      if (quick && rollBack(version)) return start();
      setTimeout(() => !stopping && start(), quick ? 10000 : 1000);
    });
    return c;
  }

  /** Mark a version bad and go back to the previous one. True if it switched. */
  function rollBack(version) {
    const s = readState();
    if (s.current !== version) return false;
    say(`v${version} didn't start properly; going back to ${s.previous ? `v${s.previous}` : "the built-in version"}`);
    writeState({ current: s.previous, previous: null, bad: [...new Set([...(s.bad || []), version])] });
    return true;
  }

  /** True once /health answers with this version (not an older one we fell back to). */
  async function waitHealthy(ms, version) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      try {
        const res = await fetchImpl(healthUrl(), { signal: AbortSignal.timeout(3000) });
        if (res.ok && (await res.json()).version === version) return true;
      } catch {}
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  }

  function stopChild() {
    return new Promise((resolve) => {
      if (!child || child.proc.exitCode !== null) return resolve();
      const c = child.proc;
      child = null;
      c.once("exit", resolve);
      c.kill("SIGTERM");
      setTimeout(() => c.exitCode === null && c.kill("SIGKILL"), 10000);
    });
  }

  /** One update check: install, switch, confirm health, or roll back. Returns what happened. */
  async function checkForUpdate() {
    if (String(env.AUTO_UPDATE || "on").toLowerCase() === "off") return "off";
    const running = activeDir().version;
    const update = await findUpdate(running);
    if (!update) return "current";
    say(`installing v${update.version} (running v${running})`);
    await install(update);
    const s = readState();
    writeState({ current: update.version, previous: s.current, bad: s.bad || [] });
    await stopChild();
    start();
    probing = waitHealthy(startupMs, update.version);
    const ok = await probing;
    probing = null;
    if (ok) {
      say(`v${update.version} is running`);
      // Keep only the running and the previous downloads.
      const keep = new Set([update.version, s.current].filter(Boolean));
      for (const d of fs.readdirSync(codeDir)) if (/^\d+\.\d+\.\d+(\.tmp)?$/.test(d) && !keep.has(d)) fs.rmSync(path.join(codeDir, d), { recursive: true, force: true });
      return `updated:${update.version}`;
    }
    rollBack(update.version);
    await stopChild();
    start();
    return `rolled-back:${update.version}`;
  }

  let timer = null;
  let lastDay = null;
  function schedule() {
    const hour = Math.min(23, Math.max(0, Number(env.UPDATE_HOUR ?? 3) || 0));
    timer = setInterval(() => {
      const d = new Date();
      const day = d.toDateString();
      if (d.getHours() === hour && lastDay !== day) {
        lastDay = day;
        checkForUpdate().then((r) => r !== "current" && say(`update check: ${r}`), (e) => say(`update check failed: ${e.message}`));
      }
    }, 5 * 60000);
    timer.unref();
  }

  async function stop() {
    stopping = true;
    if (timer) clearInterval(timer);
    await stopChild();
  }

  return { start, stop, schedule, checkForUpdate, activeDir, readState, compareVersions };
}

if (require.main === module) {
  const configDir = path.resolve(process.argv[2] || "/config");
  const r = createRunner({ configDir });
  r.start();
  if (String(process.env.AUTO_UPDATE || "on").toLowerCase() !== "off") {
    r.schedule();
    // Also check a couple of minutes after starting, so a restart picks up a release.
    setTimeout(() => r.checkForUpdate().then((x) => log(`update check: ${x}`), (e) => log(`update check failed: ${e.message}`)), 120000).unref();
  } else log("automatic updates are off (AUTO_UPDATE=off)");
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => r.stop().then(() => process.exit(0)));
}

module.exports = { createRunner, compareVersions };
