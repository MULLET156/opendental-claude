"use strict";
/**
 * Helper for the Windows setup script (setup.ps1). The script does the Windows
 * parts (downloads, permissions, the startup task); this does everything that
 * touches Open Dental or the config file, so it uses the gateway's own checks.
 *
 *   node setup-helper.js test-od   <config.json>   check the keys in .env reach Open Dental
 *   node setup-helper.js labs      <config.json>   list labs as JSON
 *   node setup-helper.js get       <config.json>   current settings as JSON (no secrets)
 *   node setup-helper.js write     <config.json>   write settings from SETUP_* variables
 *   node setup-helper.js secret                    print a new lab sync secret
 *
 * Keys are read from the .env file next to the config, never from the command line.
 * Output is one line of JSON; exit code 1 on failure.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { validateConfig, loadEnvFile, ConfigError } = require("../config");
const { createClient } = require("../../core/odclient");

function out(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj) + "\n");
  process.exitCode = code;
}

function readRaw(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function client(file) {
  loadEnvFile(path.join(path.dirname(file), ".env"));
  const raw = readRaw(file);
  return createClient({
    baseUrl: process.env.OD_BASE_URL,
    developerKey: process.env.OD_DEVELOPER_KEY,
    customerKey: process.env.OD_CUSTOMER_KEY,
    plan: process.env.OD_API_PLAN || (raw && raw.openDental && raw.openDental.plan) || "standard",
    maxRetries: 1,
    timeoutMs: 15000,
  });
}

function explain(e) {
  const m = String(e && e.message ? e.message : e);
  if (/401/.test(m)) return "Open Dental refused the keys (401). Check both keys, and that the Customer Key is listed and enabled in Setup > Advanced Setup > API.";
  if (/403/.test(m)) return "The Customer Key doesn't have permission for this (403). Add the permission in the Developer Portal.";
  if (/Could not reach|network error|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND|fetch failed|timed out|abort/i.test(m))
    return "Can't reach Open Dental at that address. Check the API Service shows Started in Tools > Misc Tools > Service Manager, and the address is right.";
  return m;
}

/** Settings from the SETUP_* environment variables, merged into an existing config. */
function buildConfig(raw, env) {
  const cfg = raw && typeof raw === "object" ? JSON.parse(JSON.stringify(raw)) : {};
  cfg.listen = cfg.listen || { host: "127.0.0.1", port: 8787 };
  if (cfg.auditLogDir === undefined) cfg.auditLogDir = "logs";
  if (!Array.isArray(cfg.apps)) cfg.apps = [];
  // Drop the example apps' placeholder keys if someone copied the example file.
  cfg.apps = cfg.apps.filter((a) => !/^sha256:(\d)\1{63}$/.test(String(a && a.keyHash)));
  if (env.SETUP_OD_PLAN) cfg.openDental = { ...(cfg.openDental || {}), plan: env.SETUP_OD_PLAN };
  if (!cfg.openDental) cfg.openDental = { plan: "standard" };

  if (env.SETUP_LABSYNC === "1") {
    const inHouse = String(env.SETUP_IN_HOUSE || "")
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    cfg.labSync = {
      ...(cfg.labSync || {}),
      enabled: true,
      trackerUrl: env.SETUP_TRACKER_URL,
      syncFrom: env.SETUP_SYNC_FROM,
      inHouseLabs: inHouse,
      patientFormat: env.SETUP_PATIENT_FORMAT || "initial-last",
    };
    if (cfg.labSync.intervalMinutes === undefined) cfg.labSync.intervalMinutes = 5;
    if (cfg.labSync.keepDays === undefined) cfg.labSync.keepDays = 30;
    if (cfg.labSync.readyNote === undefined) cfg.labSync.readyNote = "Lab case ready to deliver";
  } else if (env.SETUP_LABSYNC === "0" && cfg.labSync) {
    cfg.labSync.enabled = false;
  }
  return cfg;
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const [cmd, file] = argv;
  const full = file ? path.resolve(file) : null;
  try {
    switch (cmd) {
      case "secret":
        return out({ ok: true, secret: crypto.randomBytes(32).toString("hex") });

      case "test-od": {
        const od = client(full);
        const provs = await od.request("GET", "/providers");
        return out({ ok: true, providers: Array.isArray(provs) ? provs.length : 0, cloud: od.isCloud });
      }

      case "labs": {
        const labs = await client(full).request("GET", "/laboratories");
        return out({
          ok: true,
          labs: (Array.isArray(labs) ? labs : [])
            .filter((l) => !(l.IsHidden === true || l.IsHidden === "true"))
            .map((l) => ({ num: l.LaboratoryNum, name: l.Description })),
        });
      }

      case "get": {
        const raw = readRaw(full);
        const ls = raw && raw.labSync;
        return out({
          ok: true,
          exists: !!raw,
          apps: raw && Array.isArray(raw.apps) ? raw.apps.filter((a) => !/^sha256:(\d)\1{63}$/.test(String(a && a.keyHash))).length : 0,
          labSync: ls
            ? {
                enabled: ls.enabled !== false,
                trackerUrl: ls.trackerUrl || "",
                syncFrom: ls.syncFrom || "",
                inHouseLabs: (ls.inHouseLabs || []).join(","),
                patientFormat: ls.patientFormat || "initial-last",
              }
            : null,
        });
      }

      case "write": {
        const cfg = buildConfig(readRaw(full), env);
        validateConfig(cfg, { requireApps: false }); // throws a readable ConfigError
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, JSON.stringify(cfg, null, 2) + "\n");
        const runnable = cfg.apps.length > 0 || !!(cfg.labSync && cfg.labSync.enabled !== false);
        return out({ ok: true, runnable });
      }

      default:
        return out({ ok: false, error: `Unknown command "${cmd}"` }, 1);
    }
  } catch (e) {
    return out({ ok: false, error: e instanceof ConfigError ? e.message : explain(e) }, 1);
  }
}

if (require.main === module) main();

module.exports = { buildConfig, main };
