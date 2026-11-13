"use strict";
/** A small stand-in for the Open Dental API, for tests. */

const http = require("node:http");

function startFakeOD({ port = 0, onRequest } = {}) {
  const requests = [];
  const state = { failNext: [] }; // e.g. [{status:429, retryAfter:"0"}]

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const u = new URL(req.url, "http://x");
      const rec = { method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), auth: req.headers.authorization, body: body ? JSON.parse(body) : undefined };
      requests.push(rec);
      const json = (status, data, headers = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(data));
      };
      if (state.failNext.length) {
        const f = state.failNext.shift();
        return json(f.status, { message: "fail" }, f.retryAfter !== undefined ? { "retry-after": f.retryAfter } : {});
      }
      if (onRequest) {
        const r = onRequest(rec);
        if (r) return json(r.status || 200, r.body, r.headers);
      }
      const p = u.pathname.replace(/^\/api\/v1/, "");
      const off = Number(u.searchParams.get("Offset") || 0);
      if (p === "/redirect") {
        res.writeHead(302, { location: "http://evil.example/steal" });
        return res.end();
      }
      if (p === "/providers") return json(200, [{ ProvNum: 1, Abbr: "DOC1", FName: "A", LName: "B", SSN: "123-45-6789" }]);
      if (p === "/operatories") return json(200, [{ OperatoryNum: 1, OpName: "Op 1" }]);
      if (p === "/patients") {
        const n = off < 200 ? 100 : 7;
        return json(200, Array.from({ length: n }, (_, i) => ({ PatNum: off + i + 1, LName: "Smith", SSN: "999-99-9999", nested: { PatientSSN: "x" } })));
      }
      if (/^\/patients\/\d+$/.test(p)) return json(200, { PatNum: Number(p.split("/")[2]), LName: "Smith", SSN: "999", Email: "a@b.c" });
      if (p === "/queries/ShortQuery") return json(200, [{ ProvNum: 1, GrossProduction: 1234.5 }]);
      if (p === "/appointments" && req.method === "GET") return json(200, [{ AptNum: 9, PatNum: 1, AptDateTime: "2026-11-13 08:00:00" }]);
      if (p === "/appointments" && req.method === "POST") return json(201, { AptNum: 77, ...rec.body });
      if (p === "/commlogs" && req.method === "POST") return json(201, { CommlogNum: 5, ...rec.body });
      if (/^\/appointments\/\d+(\/\w+)?$/.test(p) && req.method === "PUT") {
        res.writeHead(200);
        return res.end();
      }
      if (p === "/boom") return json(500, { message: `server error with key ${req.headers.authorization}` });
      json(404, { message: "not found" });
    });
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const { port: actual } = server.address();
      resolve({
        url: `http://127.0.0.1:${actual}/api/v1`,
        requests,
        state,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

module.exports = { startFakeOD };
