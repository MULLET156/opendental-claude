"use strict";
/** A small stand-in for the Open Dental API, for tests. */

const http = require("node:http");

function startFakeOD({ port = 0, onRequest } = {}) {
  const requests = [];
  const state = {
    failNext: [], // e.g. [{status:429, retryAfter:"0"}]
    procs: {
      101: { ProcNum: 101, PatNum: 1, ProcStatus: "C", procCode: "D2391", ToothNum: "3" },
      102: { ProcNum: 102, PatNum: 1, ProcStatus: "C", procCode: "D0120" },
      103: { ProcNum: 103, PatNum: 1, ProcStatus: "TP", procCode: "D2740", ToothNum: "30" },
      104: { ProcNum: 104, PatNum: 2, ProcStatus: "C", procCode: "D1110" },
      105: { ProcNum: 105, PatNum: 1, ProcStatus: 1, procCode: "D2393" },
    },
  };

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
      // ---- clinical
      const procs = state.procs;
      let m;
      if ((m = p.match(/^\/procedurelogs\/(\d+)$/))) {
        const pr = procs[m[1]];
        if (!pr) return json(404, { message: "Procedure not found" });
        if (req.method === "GET") return json(200, pr);
        if (req.method === "PUT") return json(200, { ...pr, ...rec.body });
        if (req.method === "DELETE") return json(200, { ok: true });
      }
      if (p === "/procedurelogs" && req.method === "GET") {
        return json(200, Object.values(procs).filter((x) => String(x.PatNum) === rec.query.PatNum && (!rec.query.ProcStatus || x.ProcStatus === rec.query.ProcStatus)));
      }
      if (p === "/procedurelogs" && req.method === "POST") return json(201, { ProcNum: 200, ...rec.body });
      if (p === "/procedurelogs/GroupNote" && req.method === "POST") return json(201, { ProcNum: 300, procCode: "~GRP~", ...rec.body });
      if (p === "/procnotes") return json(req.method === "POST" ? 201 : 200, req.method === "POST" ? { ProcNoteNum: 7, ...rec.body } : [{ ProcNoteNum: 6, PatNum: 1, ProcNum: 101, Note: "Prior note", isSigned: "true" }]);
      if ((m = p.match(/^\/chartmodules\/(\d+)\/(ProgNotes|PatientInfo)$/))) {
        return json(200, m[2] === "ProgNotes" ? [{ ObjectType: "Procedure", ProcCode: "D2391", Note: "x", Signed: "Signed" }] : [{ Field: "Allergies", Content: "Penicillin" }]);
      }
      if (p === "/treatplans" && req.method === "GET") {
        return json(200, rec.query.PatNum === "1" ? [{ TreatPlanNum: 9, PatNum: 1, TPStatus: "Inactive", Heading: "Phase 1" }, { TreatPlanNum: 10, PatNum: 1, TPStatus: "Saved", Heading: "Old" }] : []);
      }
      if (p === "/treatplans" && req.method === "POST") return json(201, { TreatPlanNum: 11, TPStatus: "Inactive", ...rec.body });
      if ((m = p.match(/^\/treatplans\/(\d+)$/)) && req.method === "PUT") return json(200, { ok: true });
      if (p === "/treatplanattaches") return json(req.method === "POST" ? 201 : 200, req.method === "POST" ? { TreatPlanAttachNum: 70, ...rec.body } : [{ ProcNum: 103, Priority: 501 }]);
      if (p === "/proctps") return json(200, [{ ProcTPNum: 1, ProcCode: "D2740" }]);
      if (p === "/procedurecodes") {
        return json(200, [
          { CodeNum: 1, ProcCode: "D0120", Descript: "periodic oral evaluation", TreatArea: "Mouth" },
          { CodeNum: 2, ProcCode: "D2393", Descript: "resin-based composite - three surfaces, posterior", TreatArea: "Surf" },
          { CodeNum: 3, ProcCode: "D2740", Descript: "crown - porcelain/ceramic", TreatArea: "Tooth" },
        ]);
      }
      if (p === "/definitions") {
        return json(200, rec.query.Category === "20" ? [{ DefNum: 501, ItemName: "1" }, { DefNum: 502, ItemName: "Urgent" }] : [{ DefNum: 601, ItemName: "Caries" }]);
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
