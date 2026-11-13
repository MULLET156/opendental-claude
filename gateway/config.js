"use strict";
/**
 * Gateway configuration: loading, validation, app keys and permission rules.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const METHODS = ["GET", "POST", "PUT", "DELETE"];

class ConfigError extends Error {}

// ------------------------------------------------------------------ keys

function newKey() {
  return "odg_" + crypto.randomBytes(32).toString("base64url");
}

function hashKey(key) {
  return "sha256:" + crypto.createHash("sha256").update(String(key), "utf8").digest("hex");
}

function sameHash(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ------------------------------------------------------------------ path rules

/**
 * Compile an Open Dental path pattern.
 *   "/patients"        exactly /patients
 *   "/patients/*"      one more segment (/patients/123)
 *   "/appointments/**" anything below /appointments (not /appointments itself)
 * Matching ignores letter case.
 */
function compilePattern(pattern) {
  if (typeof pattern !== "string" || !pattern.startsWith("/")) {
    throw new ConfigError(`Path pattern "${pattern}" must start with "/".`);
  }
  const parts = pattern.replace(/\/+$/, "").split("/").slice(1);
  const re = parts
    .map((p, i) => {
      if (p === "**") {
        if (i !== parts.length - 1) throw new ConfigError(`"**" may only end a pattern ("${pattern}").`);
        return "(?:/[^/]+)+";
      }
      if (p === "*") return "/[^/]+";
      if (!/^[A-Za-z0-9_.-]+$/.test(p)) throw new ConfigError(`Bad path segment "${p}" in "${pattern}".`);
      return "/" + p.replace(/\./g, "\\.");
    })
    .join("");
  return new RegExp("^" + (re || "/") + "$", "i");
}

// ------------------------------------------------------------------ validation

function validateConfig(raw, { requireApps = true } = {}) {
  if (!raw || typeof raw !== "object") throw new ConfigError("Config must be a JSON object.");
  const cfg = {
    listen: { host: "127.0.0.1", port: 8787, ...(raw.listen || {}) },
    tls: raw.tls || null,
    trustProxy: !!raw.trustProxy,
    auditLogDir: raw.auditLogDir === undefined ? "logs" : raw.auditLogDir,
    maxRows: Number(raw.maxRows || 1000),
    maxBodyBytes: Number(raw.maxBodyBytes || 1024 * 1024),
    corsOrigins: Array.isArray(raw.corsOrigins) ? raw.corsOrigins : [],
    apps: [],
  };
  if (!Number.isInteger(cfg.listen.port) || cfg.listen.port < 1 || cfg.listen.port > 65535) {
    throw new ConfigError("listen.port must be a port number.");
  }
  if (cfg.tls && (!cfg.tls.certFile || !cfg.tls.keyFile)) throw new ConfigError("tls needs certFile and keyFile.");
  for (const o of cfg.corsOrigins) {
    if (typeof o !== "string" || !/^https?:\/\/[^/]+$/.test(o)) throw new ConfigError(`corsOrigins entry "${o}" must look like https://app.example.com`);
  }

  const apps = Array.isArray(raw.apps) ? raw.apps : [];
  if (requireApps && !apps.length) throw new ConfigError('No apps configured. Add one with: node gateway/cli.js new-key "<app name>"');
  const names = new Set();
  const hashes = new Set();
  for (const [i, a] of apps.entries()) {
    const where = `apps[${i}]`;
    if (!a || typeof a !== "object") throw new ConfigError(`${where} must be an object.`);
    if (typeof a.name !== "string" || !/^[A-Za-z0-9 _.-]{1,60}$/.test(a.name)) throw new ConfigError(`${where}.name is missing or has odd characters.`);
    if (names.has(a.name)) throw new ConfigError(`Two apps are named "${a.name}".`);
    names.add(a.name);
    if (typeof a.keyHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(a.keyHash)) {
      throw new ConfigError(`${where}.keyHash must be a "sha256:..." value from: node gateway/cli.js new-key`);
    }
    if (hashes.has(a.keyHash)) throw new ConfigError(`Two apps share the same key ("${a.name}").`);
    hashes.add(a.keyHash);

    const rules = [];
    for (const [j, r] of (a.allow || []).entries()) {
      const methods = (r.methods || ["GET"]).map((m) => String(m).toUpperCase());
      for (const m of methods) if (!METHODS.includes(m)) throw new ConfigError(`${where}.allow[${j}] has unknown method "${m}".`);
      const paths = r.paths || [];
      if (!paths.length) throw new ConfigError(`${where}.allow[${j}] needs at least one path.`);
      for (const p of paths) {
        if (/^\/queries\b/i.test(p)) throw new ConfigError(`${where}: /queries can't be allowed directly; use "rawSql": true and POST /v1/query.`);
      }
      rules.push({ methods: new Set(methods), patterns: paths.map(compilePattern), source: { methods, paths } });
    }

    const reports = a.reports === undefined ? [] : a.reports;
    if (!Array.isArray(reports)) throw new ConfigError(`${where}.reports must be a list of report names or ["*"].`);

    cfg.apps.push({
      name: a.name,
      keyHash: a.keyHash,
      disabled: !!a.disabled,
      rules,
      reports: new Set(reports),
      rawSql: !!a.rawSql,
      redact: Array.isArray(a.redact) ? a.redact.map(String) : [],
      rateLimitPerMinute: Number(a.rateLimitPerMinute || 120),
      maxRows: a.maxRows ? Number(a.maxRows) : null,
    });
  }
  return cfg;
}

function loadConfig(file) {
  const full = path.resolve(file);
  let text;
  try {
    text = fs.readFileSync(full, "utf8");
  } catch {
    throw new ConfigError(`Can't read config file ${full}. Copy gateway/gateway.config.example.json to start.`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`${full} is not valid JSON: ${e.message}`);
  }
  const cfg = validateConfig(raw);
  const base = path.dirname(full);
  if (cfg.auditLogDir) cfg.auditLogDir = path.resolve(base, cfg.auditLogDir);
  if (cfg.tls) {
    cfg.tls.certFile = path.resolve(base, cfg.tls.certFile);
    cfg.tls.keyFile = path.resolve(base, cfg.tls.keyFile);
  }
  return cfg;
}

// ------------------------------------------------------------------ permission checks

function findApp(cfg, presentedKey) {
  if (!presentedKey) return null;
  const h = hashKey(presentedKey);
  for (const app of cfg.apps) if (sameHash(app.keyHash, h)) return app;
  return null;
}

function allowsPath(app, method, odPath) {
  return app.rules.some((r) => r.methods.has(method) && r.patterns.some((re) => re.test(odPath)));
}

function allowsReport(app, name) {
  return app.reports.has("*") || app.reports.has(name);
}

module.exports = {
  ConfigError,
  METHODS,
  newKey,
  hashKey,
  compilePattern,
  validateConfig,
  loadConfig,
  findApp,
  allowsPath,
  allowsReport,
};
