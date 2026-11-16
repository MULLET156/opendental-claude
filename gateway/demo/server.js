#!/usr/bin/env node
"use strict";
/**
 * Demo gateway for the TDC Office design stage, as its own app (Hostinger
 * Node.js app; `npm start` runs this). Fake data only: it never talks to real
 * Open Dental, and /health says "fake": true.
 *
 * Settings (environment variables, e.g. in Hostinger's app settings):
 *   PORT               given by Hostinger (default 8787)
 *   HOST               default 0.0.0.0 when PORT is set, else 127.0.0.1
 *   DEMO_KEY_DAYSHEET  app key for the Daysheet module      ┐ at least one;
 *   DEMO_KEY_FINDER    app key for the Treatment Finder     │ make each with
 *   DEMO_KEY_VOICE     app key for Voice Charting           │ node gateway/cli.js new-key x
 *   DEMO_KEY_NUMBERS   app key for Practice Numbers         ┘ (keep them out of GitHub)
 *   DEMO_TODAY         optional fixed date (yyyy-MM-dd) for "today"
 *   TZ                 e.g. America/Los_Angeles, so "today" is the office's day
 */

const path = require("node:path");
const { loadEnvFile } = require("../config");
const { startDemoGateway, TEST_KEYS } = require("./demo-gateway");

loadEnvFile(path.join(__dirname, "..", "..", ".env"));

const MODULES = ["daysheet", "finder", "voice", "numbers"];
const published = new Set(Object.values(TEST_KEYS));

function keysFromEnv(env) {
  const keys = {};
  for (const m of MODULES) {
    const k = String(env[`DEMO_KEY_${m.toUpperCase()}`] || "").trim();
    if (!k) continue;
    if (published.has(k)) throw new Error(`DEMO_KEY_${m.toUpperCase()} is one of the published test keys. Make a private one with: node gateway/cli.js new-key ${m}`);
    if (!/^[A-Za-z0-9_\-]{32,200}$/.test(k)) throw new Error(`DEMO_KEY_${m.toUpperCase()} should be a key from: node gateway/cli.js new-key ${m}`);
    keys[m] = k;
  }
  if (!Object.keys(keys).length) throw new Error("Set at least one DEMO_KEY_... (for example DEMO_KEY_DAYSHEET). Make keys with: node gateway/cli.js new-key daysheet");
  return keys;
}

(async () => {
  try {
    const port = Number(process.env.PORT || 8787);
    const host = process.env.HOST || (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
    const demo = await startDemoGateway({ keys: keysFromEnv(process.env), port, host, today: process.env.DEMO_TODAY || undefined });
    console.log(`Demo gateway (FAKE DATA) listening on ${host}:${demo.port}. Modules: ${demo.modules.join(", ")}. Today: ${demo.office().today}`);
  } catch (e) {
    console.error(`Demo gateway not started: ${e.message}`);
    process.exit(1);
  }
})();
