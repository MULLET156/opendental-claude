"use strict";
/**
 * Open Dental app gateway: request handling.
 *
 * Your own apps call this service with their own app key. It checks what that
 * app is allowed to do, calls Open Dental with the office's keys (which never
 * leave this server), removes SSNs, and writes an audit line for every request.
 *
 * Routes
 *   GET  /health                     liveness (no auth, no Open Dental call)
 *   GET  /v1/me                      the calling app's name and permissions
 *   GET  /v1/reports                 built-in reports this app may run
 *   GET  /v1/reports/:name?from=..   run a report (params in the query string)
 *   POST /v1/reports/:name           run a report (params as JSON body)
 *   POST /v1/query  {"sql": "..."}   read-only SQL, only for apps with rawSql
 *   ANY  /v1/od/<open dental path>   pass-through to the Open Dental API,
 *                                    e.g. GET /v1/od/appointments?date=2026-11-13
 *                                    add all=true to follow paging (limit=N caps rows)
 */

const fs = require("node:fs");
const path = require("node:path");
const { ODError, makeRedactor } = require("../core/odclient");
const { buildReport, describeReports } = require("../core/reports");
const { findApp, allowsPath, allowsReport } = require("./config");

const ERROR_STATUS = {
  bad_input: 400,
  auth: 401,
  forbidden: 403,
  not_found: 404,
  too_large: 413,
  rate_limited: 429,
  unreachable: 502,
  redirect: 502,
  bad_response: 502,
  config: 500,
};

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function createGateway({ config, od, version = "dev", now = () => Date.now() }) {
  const buckets = new Map(); // app name -> { tokens, updated }
  const redactors = new Map(config.apps.map((a) => [a.name, makeRedactor(a.redact)]));

  // ---------------------------------------------------------------- audit
  function audit(entry) {
    if (!config.auditLogDir) return;
    const day = new Date(now()).toISOString().slice(0, 10);
    const line = JSON.stringify({ ts: new Date(now()).toISOString(), ...entry }) + "\n";
    fs.mkdir(config.auditLogDir, { recursive: true }, () => {
      fs.appendFile(path.join(config.auditLogDir, `audit-${day}.jsonl`), line, { mode: 0o600 }, () => {});
    });
  }

  // ---------------------------------------------------------------- helpers
  function rateLimit(app) {
    const per = app.rateLimitPerMinute;
    if (!per || per <= 0) return;
    const t = now();
    const b = buckets.get(app.name) || { tokens: per, updated: t };
    b.tokens = Math.min(per, b.tokens + ((t - b.updated) / 60000) * per);
    b.updated = t;
    if (b.tokens < 1) {
      buckets.set(app.name, b);
      throw new HttpError(429, "rate_limited", `Rate limit of ${per} requests/minute reached for "${app.name}".`);
    }
    b.tokens -= 1;
    buckets.set(app.name, b);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      if (req.method === "GET" || req.method === "DELETE") {
        req.resume();
        return resolve(undefined);
      }
      const ct = String(req.headers["content-type"] || "");
      if (Number(req.headers["content-length"] || 0) > config.maxBodyBytes) {
        return reject(new HttpError(413, "too_large", "Request body is too large."));
      }
      const chunks = [];
      let size = 0;
      let tooBig = false;
      req.on("data", (c) => {
        if (tooBig) return;
        size += c.length;
        if (size > config.maxBodyBytes) {
          tooBig = true;
          chunks.length = 0;
          req.pause();
          reject(new HttpError(413, "too_large", "Request body is too large."));
        } else chunks.push(c);
      });
      req.on("end", () => {
        if (tooBig) return;
        const text = Buffer.concat(chunks).toString("utf8");
        if (!text.trim()) return resolve(undefined);
        if (!/application\/json/i.test(ct)) return reject(new HttpError(415, "bad_input", "Send the body as application/json."));
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new HttpError(400, "bad_input", "Body is not valid JSON."));
        }
      });
      req.on("error", reject);
    });
  }

  function clientIp(req) {
    if (config.trustProxy && req.headers["x-forwarded-for"]) return String(req.headers["x-forwarded-for"]).split(",")[0].trim();
    return req.socket.remoteAddress;
  }

  function corsHeaders(req) {
    const origin = req.headers.origin;
    if (!origin || !config.corsOrigins.includes(origin)) return {};
    return {
      "Access-Control-Allow-Origin": origin,
      Vary: "Origin",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Max-Age": "600",
    };
  }

  function send(res, status, body, headers = {}) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...headers,
    });
    res.end(text);
  }

  function authenticate(req) {
    const h = String(req.headers.authorization || "");
    const m = h.match(/^Bearer\s+(\S+)$/i);
    const app = m ? findApp(config, m[1]) : null;
    if (!app || app.disabled) throw new HttpError(401, "auth", "Missing or invalid app key. Send: Authorization: Bearer <app key>");
    return app;
  }

  const pageLimit = (app, q) => {
    const cap = Math.min(app.maxRows || config.maxRows, config.maxRows);
    const asked = Number(q.get("limit"));
    return Number.isFinite(asked) && asked > 0 ? Math.min(asked, cap) : cap;
  };

  // ---------------------------------------------------------------- routes
  async function route(req, app, url, body, ctx) {
    const method = req.method;
    const p = url.pathname.replace(/\/+$/, "") || "/";
    const redact = redactors.get(app.name);

    if (p === "/v1/me" && method === "GET") {
      return {
        status: 200,
        body: {
          app: app.name,
          allow: app.rules.map((r) => r.source),
          reports: [...app.reports],
          rawSql: app.rawSql,
          rateLimitPerMinute: app.rateLimitPerMinute,
          openDental: { mode: od.isCloud ? "cloud" : "local" },
        },
      };
    }

    if (p === "/v1/reports" && method === "GET") {
      return { status: 200, body: { reports: describeReports().filter((r) => allowsReport(app, r.name)) } };
    }

    const rm = p.match(/^\/v1\/reports\/([a-z0-9_]+)$/);
    if (rm && (method === "GET" || method === "POST")) {
      const name = rm[1];
      ctx.target = `report:${name}`;
      if (!allowsReport(app, name)) throw new HttpError(403, "forbidden", `App "${app.name}" may not run report "${name}".`);
      let params;
      if (method === "GET") {
        params = {};
        for (const [k, v] of url.searchParams) {
          if (k === "limit") continue;
          params[k] = params[k] === undefined ? v : [].concat(params[k], v);
        }
      } else {
        params = body && body.params !== undefined ? body.params : body || {};
      }
      const sql = buildReport(name, params);
      const { rows, truncated } = await od.shortQuery(sql, { limit: pageLimit(app, url.searchParams) });
      ctx.rows = rows.length;
      return { status: 200, body: { report: name, count: rows.length, truncated, rows: redact(rows) } };
    }

    if (p === "/v1/query" && method === "POST") {
      ctx.target = "query";
      if (!app.rawSql) throw new HttpError(403, "forbidden", `App "${app.name}" may not run custom SQL. Use a built-in report.`);
      const sql = body && body.sql;
      const limit = Math.min(Number(body && body.limit) || Infinity, pageLimit(app, url.searchParams));
      const { rows, truncated } = await od.shortQuery(sql, { limit });
      ctx.rows = rows.length;
      return { status: 200, body: { count: rows.length, truncated, rows: redact(rows) } };
    }

    if (p.startsWith("/v1/od/")) {
      const odPath = p.slice("/v1/od".length);
      ctx.target = odPath.replace(/\/\d+(?=\/|$)/g, "/{id}");
      if (!/^\/[A-Za-z0-9_\-/]+$/.test(odPath) || odPath.includes("//")) throw new HttpError(400, "bad_input", "Invalid Open Dental path.");
      if (/^\/queries(\/|$)/i.test(odPath)) {
        throw new HttpError(403, "forbidden", "Use POST /v1/query (rawSql apps) or /v1/reports instead of /queries.");
      }
      if (!allowsPath(app, method, odPath)) {
        throw new HttpError(403, "forbidden", `App "${app.name}" may not ${method} ${odPath}.`);
      }
      if ((method === "POST" || method === "PUT") && body !== undefined && (typeof body !== "object" || body === null)) {
        throw new HttpError(400, "bad_input", "Body must be a JSON object or array.");
      }
      const params = {};
      let all = false;
      for (const [k, v] of url.searchParams) {
        if (k === "all") all = v === "true" || v === "1";
        else if (k === "limit") continue;
        else params[k] = v;
      }
      if (method === "GET" && all) {
        const { rows, truncated } = await od.getAll(odPath, params, { limit: pageLimit(app, url.searchParams) });
        ctx.rows = rows.length;
        return { status: 200, body: redact(rows), headers: { "X-Row-Count": String(rows.length), "X-Truncated": String(truncated) } };
      }
      const result = await od.request(method, odPath, { params, body });
      if (Array.isArray(result)) ctx.rows = result.length;
      return { status: method === "POST" ? 201 : 200, body: redact(result) };
    }

    throw new HttpError(404, "not_found", `No route for ${method} ${p}.`);
  }

  // ---------------------------------------------------------------- handler
  return async function handle(req, res) {
    const started = now();
    const cors = corsHeaders(req);
    let url;
    try {
      url = new URL(req.url, "http://gateway.local");
    } catch {
      return send(res, 400, { error: { code: "bad_input", message: "Bad URL." } }, cors);
    }

    if (req.method === "OPTIONS") {
      res.writeHead(cors["Access-Control-Allow-Origin"] ? 204 : 403, cors);
      return res.end();
    }
    if (url.pathname === "/health" && req.method === "GET") {
      return send(res, 200, { ok: true, service: "opendental-gateway", version }, cors);
    }

    const ctx = { target: url.pathname.replace(/\/\d+(?=\/|$)/g, "/{id}"), rows: undefined };
    let app = null;
    let status = 500;
    try {
      app = authenticate(req);
      rateLimit(app);
      const body = await readBody(req);
      const out = await route(req, app, url, body, ctx);
      status = out.status;
      send(res, out.status, out.body, { ...cors, ...(out.headers || {}) });
    } catch (e) {
      let code = "internal";
      let message = "Unexpected gateway error.";
      if (e instanceof HttpError) {
        status = e.status;
        code = e.code;
        message = e.message;
      } else if (e instanceof ODError) {
        code = e.code || "upstream";
        status = e.status && e.status >= 400 && e.status < 500 ? e.status : ERROR_STATUS[code] || 502;
        message = e.message;
      } else {
        console.error("[gateway]", e && e.stack);
      }
      if (status === 413) {
        // Don't read the rest of an oversized upload; close once the answer is sent.
        send(res, status, { error: { code, message } }, { ...cors, Connection: "close" });
        res.on("finish", () => req.destroy());
      } else {
        send(res, status, { error: { code, message } }, cors);
      }
    } finally {
      // Audit: who, what, outcome. No query values, bodies or patient data.
      audit({
        app: app ? app.name : null,
        ip: clientIp(req),
        method: req.method,
        target: ctx.target,
        status,
        rows: ctx.rows,
        ms: now() - started,
      });
    }
  };
}

module.exports = { createGateway, HttpError };
