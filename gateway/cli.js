#!/usr/bin/env node
"use strict";
/**
 * Gateway helper commands.
 *
 *   node gateway/cli.js new-key "<app name>"   create an app key and print its config entry
 *   node gateway/cli.js hash <key>             print the hash of an existing key
 *   node gateway/cli.js check [config.json]    validate the config file
 *   node gateway/cli.js new-secret             create a LAB_SYNC_SECRET for the lab tracker sync
 *   node gateway/cli.js lab-sync [config.json] [--dry-run]
 *                                              run one lab tracker sync now (--dry-run: read Open Dental and
 *                                              show what would be sent, without sending or writing anything)
 */

const path = require("node:path");
const crypto = require("node:crypto");
const { newKey, hashKey, loadConfig, loadEnvFile, ConfigError } = require("./config");

const [cmd, arg] = process.argv.slice(2);

switch (cmd) {
  case "new-key": {
    const name = arg || "my-app";
    const key = newKey();
    const entry = {
      name,
      keyHash: hashKey(key),
      allow: [{ methods: ["GET"], paths: ["/appointments", "/providers", "/operatories"] }],
      reports: [],
      rawSql: false,
    };
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
  default:
    console.log('Usage:\n  node gateway/cli.js new-key "<app name>"\n  node gateway/cli.js hash <key>\n  node gateway/cli.js check [gateway.config.json]\n  node gateway/cli.js new-secret\n  node gateway/cli.js lab-sync [gateway.config.json] [--dry-run]');
}
