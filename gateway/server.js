#!/usr/bin/env node
"use strict";
/**
 * Open Dental app gateway — start the server.
 *
 *   OD_DEVELOPER_KEY=... OD_CUSTOMER_KEY=... OD_BASE_URL=... \
 *   node gateway/server.js [path/to/gateway.config.json]
 *
 * The Open Dental keys come from environment variables (or a .env file next to
 * the config), never from the config file, so the config can be shared safely.
 */

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { createClient } = require("../core/odclient");
const { loadConfig, loadEnvFile, ConfigError } = require("./config");
const { createGateway } = require("./app");
const { startLabSync } = require("./lab-sync");
const { version } = require("../package.json");

function main() {
  const configPath = path.resolve(process.argv[2] || process.env.GATEWAY_CONFIG || "gateway.config.json");
  loadEnvFile(path.join(path.dirname(configPath), ".env"));

  let config;
  try {
    config = loadConfig(configPath);
  } catch (e) {
    console.error(e instanceof ConfigError ? `Config problem: ${e.message}` : e);
    process.exit(1);
  }
  if (process.env.GATEWAY_PORT) config.listen.port = Number(process.env.GATEWAY_PORT);
  if (process.env.GATEWAY_HOST) config.listen.host = process.env.GATEWAY_HOST;

  let od;
  try {
    od = createClient({
      baseUrl: process.env.OD_BASE_URL,
      developerKey: process.env.OD_DEVELOPER_KEY,
      customerKey: process.env.OD_CUSTOMER_KEY,
      maxRows: config.maxRows,
      plan: process.env.OD_API_PLAN || config.openDental.plan,
      minIntervalMs: process.env.OD_MIN_INTERVAL_MS ?? config.openDental.minIntervalMs,
    });
  } catch (e) {
    console.error(`Open Dental settings problem: ${e.message}`);
    process.exit(1);
  }
  if (!process.env.OD_DEVELOPER_KEY || !process.env.OD_CUSTOMER_KEY) {
    console.error("Set OD_DEVELOPER_KEY and OD_CUSTOMER_KEY (environment or a .env file next to the config).");
    process.exit(1);
  }

  const handler = createGateway({ config, od, version });
  const server = config.tls
    ? https.createServer({ cert: fs.readFileSync(config.tls.certFile), key: fs.readFileSync(config.tls.keyFile) }, handler)
    : http.createServer(handler);
  server.headersTimeout = 30000;
  server.requestTimeout = 180000;

  server.listen(config.listen.port, config.listen.host, () => {
    const scheme = config.tls ? "https" : "http";
    console.log(`Open Dental gateway v${version} listening on ${scheme}://${config.listen.host}:${config.listen.port}`);
    console.log(`Open Dental: ${od.baseUrl} (${od.isCloud ? `cloud, one request every ${od.minIntervalMs / 1000} s` : "local network, not throttled"})`);
    console.log(`Apps: ${config.apps.map((a) => a.name + (a.disabled ? " (disabled)" : "")).join(", ")}`);
    if (!config.tls && !["127.0.0.1", "localhost", "::1"].includes(config.listen.host)) {
      console.log("Note: serving plain http on the network. Keep this on your office LAN or put it behind HTTPS.");
    }
  });

  // Lab tracker sync (optional): pushes lab cases out and writes "ready"/"sent" back.
  let stopSync = () => {};
  if (config.labSync) {
    try {
      stopSync = startLabSync({ od, cfg: config.labSync, secret: process.env.LAB_SYNC_SECRET, audit: handler.audit || (() => {}) });
      console.log(`Lab tracker sync: every ${config.labSync.intervalMinutes} min to ${new URL(config.labSync.trackerUrl).host}, cases created since ${config.labSync.syncFrom}`);
    } catch (e) {
      console.error(`Lab tracker sync not started: ${e.message}`);
    }
  }

  const stop = () => {
    stopSync();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main();
