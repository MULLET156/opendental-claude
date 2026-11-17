#!/usr/bin/env node
"use strict";
/**
 * Gateway helper commands.
 *
 *   node gateway/cli.js new-key "<app name>" [--preset daysheet|finder|voice|numbers]
 *                                              create an app key and print its config entry (a TDC Office
 *                                              module's preset gives it that module's narrowest permissions)
 *   node gateway/cli.js hash <key>             print the hash of an existing key
 *   node gateway/cli.js check [config.json]    validate the config file
 *   node gateway/cli.js new-secret             create a LAB_SYNC_SECRET for the lab tracker sync
 *   node gateway/cli.js init <folder> [--stage design|live] [--modules daysheet,finder,voice,numbers]
 *                                              set up a gateway folder (TrueNAS/Docker): gateway.config.json with a
 *                                              key per TDC Office module, an .env to fill in, and module-keys.txt
 *   node gateway/cli.js lab-sync [config.json] [--dry-run]
 *                                              run one lab tracker sync now (--dry-run: read Open Dental and
 *                                              show what would be sent, without sending or writing anything)
 */

const path = require("node:path");
const crypto = require("node:crypto");
const { newKey, hashKey, loadConfig, loadEnvFile, ConfigError } = require("./config");
const { presetApp, PRESETS } = require("./presets");

const [cmd, arg] = process.argv.slice(2);

switch (cmd) {
  case "new-key": {
    const name = arg && !arg.startsWith("--") ? arg : "my-app";
    const pi = process.argv.indexOf("--preset");
    const preset = pi > 0 ? process.argv[pi + 1] : PRESETS[name] && name !== "dev" ? name : null;
    if (preset && (!PRESETS[preset] || preset === "dev")) {
      console.error(`Unknown preset "${preset}". Use one of: ${Object.keys(PRESETS).filter((p) => p !== "dev").join(", ")}`);
      process.exit(1);
    }
    const key = newKey();
    const entry = preset
      ? presetApp(name, preset, hashKey(key))
      : {
          name,
          keyHash: hashKey(key),
          allow: [{ methods: ["GET"], paths: ["/appointments", "/providers", "/operatories"] }],
          reports: [],
          rawSql: false,
        };
    if (preset) console.log(`Using the "${preset}" preset: ${PRESETS[preset].description}\n`);
    console.log(`App key for "${name}" (shown once; store it in that app's server-side settings):\n\n  ${key}\n`);
    console.log("Add this to the \"apps\" list in gateway.config.json, then adjust what it may do:\n");
    console.log(JSON.stringify(entry, null, 2));
    break;
  }
  case "hash":
    if (!arg) {
      console.error("Usage: node gateway/cli.js hash <key>");
      process.exit(1);
    }
    console.log(hashKey(arg));
    break;
  case "check": {
    try {
      const cfg = loadConfig(arg || "gateway.config.json");
      console.log(`Config OK: ${cfg.apps.length} app(s), listening on ${cfg.listen.host}:${cfg.listen.port}${cfg.tls ? " (https)" : ""}.`);
      for (const a of cfg.apps) {
        const rules = a.rules.map((r) => `${[...r.methods].join("/")} ${r.source.paths.join(", ")}`).join("; ") || "none";
        console.log(`- ${a.name}${a.disabled ? " (disabled)" : ""}: API ${rules}; reports ${[...a.reports].join(", ") || "none"}; SQL ${a.rawSql ? "yes" : "no"}`);
      }
    } catch (e) {
      console.error(e instanceof ConfigError ? `Config problem: ${e.message}` : e);
      process.exit(1);
    }
    break;
  }
  case "new-secret":
    console.log("Lab sync secret (put the same value in the gateway's .env as LAB_SYNC_SECRET and in the tracker's config.php as OD_SYNC_SECRET):\n");
    console.log("  " + crypto.randomBytes(32).toString("hex"));
    break;
  case "lab-sync": {
    const args = process.argv.slice(3);
    const dryRun = args.includes("--dry-run");
    const file = path.resolve(args.find((a) => !a.startsWith("--")) || "gateway.config.json");
    const envFile = path.join(path.dirname(file), ".env");
    loadEnvFile(envFile);
    let cfg;
    try {
      cfg = loadConfig(file);
    } catch (e) {
      console.error(e instanceof ConfigError ? `Config problem: ${e.message}` : e);
      process.exit(1);
    }
    if (!cfg.labSync) {
      console.error('No "labSync" section in the config (see docs/lab-tracker-sync.md).');
      process.exit(1);
    }
    const { createClient } = require("../core/odclient");
    const { runLabSync } = require("./lab-sync");
    const od = createClient({
      baseUrl: process.env.OD_BASE_URL,
      developerKey: process.env.OD_DEVELOPER_KEY,
      customerKey: process.env.OD_CUSTOMER_KEY,
      plan: process.env.OD_API_PLAN || cfg.openDental.plan,
      maxRows: 2000,
    });
    runLabSync({ od, cfg: cfg.labSync, secret: process.env.LAB_SYNC_SECRET, dryRun })
      .then((s) => console.log(JSON.stringify(s, null, 2)))
      .catch((e) => {
        console.error(`Lab sync failed: ${e.message}`);
        process.exit(1);
      });
    break;
  }
  case "init": {
    const fs = require("node:fs");
    const dir = path.resolve(arg && !arg.startsWith("--") ? arg : ".");
    const opt = (n, d) => {
      const i = process.argv.indexOf(`--${n}`);
      return i > 0 ? process.argv[i + 1] : d;
    };
    const stage = opt("stage", "design");
    const modules = String(opt("modules", "daysheet,finder,voice,numbers")).split(",").map((m) => m.trim()).filter(Boolean);
    if (stage !== "design" && stage !== "live") {
      console.error('--stage must be "design" or "live".');
      process.exit(1);
    }
    for (const m of modules) {
      if (!PRESETS[m] || m === "dev") {
        console.error(`Unknown module "${m}". Use: ${Object.keys(PRESETS).filter((p) => p !== "dev").join(", ")}`);
        process.exit(1);
      }
    }
    const cfgFile = path.join(dir, "gateway.config.json");
    if (fs.existsSync(cfgFile) && !process.argv.includes("--force")) {
      console.error(`${cfgFile} already exists; not changing it. (Add --force to start over with new keys.)`);
      process.exit(1);
    }
    fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
    const keys = {};
    const apps = modules.map((m) => {
      keys[m] = newKey();
      return presetApp(m, m, hashKey(keys[m]));
    });
    const cfg = {
      stage,
      listen: { host: "127.0.0.1", port: 8787 },
      trustProxy: ["127.0.0.1", "::1"],
      auditLogDir: "logs",
      apps,
    };
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + "\n");
    const envFile = path.join(dir, ".env");
    if (!fs.existsSync(envFile)) {
      fs.writeFileSync(
        envFile,
        [
          "# Open Dental API Service this gateway uses. In the design stage: the DEMO database's API Service.",
          "OD_BASE_URL=http://<open dental server address>:30223/api/v1",
          "OD_DEVELOPER_KEY=",
          "OD_CUSTOMER_KEY=",
          "",
        ].join("\n"),
        { mode: 0o600 }
      );
    }
    const keysFile = path.join(dir, "module-keys.txt");
    fs.writeFileSync(
      keysFile,
      [
        "TDC Office module keys for this gateway. Put each one in that module's Hostinger app as GATEWAY_KEY,",
        "then DELETE THIS FILE. They can't be shown again (the gateway keeps only their hashes).",
        "",
        ...modules.map((m) => `${m.padEnd(9)} ${keys[m]}`),
        "",
      ].join("\n"),
      { mode: 0o600 }
    );
    try {
      fs.chmodSync(envFile, 0o600);
      fs.chmodSync(keysFile, 0o600);
    } catch {}
    console.log(`Set up ${dir} (stage: ${stage}):
  gateway.config.json  a key and the narrowest permissions for: ${modules.join(", ")}
  .env                 fill in the Open Dental API address and keys
  module-keys.txt      the module keys: copy each into its Hostinger app, then delete this file`);
    break;
  }
  default:
    console.log('Usage:\n  node gateway/cli.js new-key "<app name>"\n  node gateway/cli.js hash <key>\n  node gateway/cli.js check [gateway.config.json]\n  node gateway/cli.js new-secret\n  node gateway/cli.js init <folder> [--stage design|live] [--modules daysheet,finder,voice,numbers]\n  node gateway/cli.js lab-sync [gateway.config.json] [--dry-run]');
}
