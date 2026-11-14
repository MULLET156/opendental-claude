"use strict";
/** A small stand-in for the Open Dental API, for tests. */

const http = require("node:http");

function startFakeOD({ port = 0, onRequest } = {}) {
  const requests = [];
  const state = {
    failNext: [], // e.g. [{status:429, retryAfter:"0"}]
    commlogs: [],
    slots: [
      { DateTimeStart: "2026-11-16 08:00:00", DateTimeEnd: "2026-11-16 09:00:00", ProvNum: 1, OpNum: 3 },
      { DateTimeStart: "2026-11-16 11:00:00", DateTimeEnd: "2026-11-16 14:00:00", ProvNum: 1, OpNum: 3 },
      { DateTimeStart: "2026-11-16 12:30:00", DateTimeEnd: "2026-11-16 13:00:00", ProvNum: 1, OpNum: 4 },
      { DateTimeStart: "2026-11-16 12:30:00", DateTimeEnd: "2026-11-16 13:00:00", ProvNum: 1, OpNum: 5 },
    ],
    blockouts: [{ ScheduleNum: 1, SchedDate: "2026-11-16", StartTime: "12:00:00", StopTime: "13:00:00", SchedType: "Blockout", Note: "Lunch", operatories: "3,4" }],
    nextProc: 200,
    nextAttach: 70,
    nextTooth: 400,
    attaches: [
      { TreatPlanAttachNum: 60, TreatPlanNum: 9, ProcNum: 103, Priority: 501 },
      { TreatPlanAttachNum: 61, TreatPlanNum: 9, ProcNum: 105, Priority: 0 },
    ],
    toothinitials: [
      { ToothInitialNum: 301, PatNum: 1, ToothNum: "1", InitialType: "Missing" },
      { ToothInitialNum: 302, PatNum: 1, ToothNum: "4", InitialType: "Primary" },
      { ToothInitialNum: 303, PatNum: 1, ToothNum: "16", InitialType: "Hidden" },
      { ToothInitialNum: 304, PatNum: 2, ToothNum: "17", InitialType: "Missing" },
    ],
    labcases: {
      1: { LabCaseNum: 1, PatNum: 1, AptNum: 50, DateTimeSent: "2019-03-01 09:00:00", DateTimeRecd: "0001-01-01 00:00:00", DateTimeChecked: "0001-01-01 00:00:00" },
      2: { LabCaseNum: 2, PatNum: 1, AptNum: 50, DateTimeSent: "0001-01-01 00:00:00", DateTimeRecd: "0001-01-01 00:00:00" },
      3: { LabCaseNum: 3, PatNum: 1, AptNum: 51, DateTimeSent: "2026-10-20 09:00:00", DateTimeRecd: "0001-01-01 00:00:00" },
      4: { LabCaseNum: 4, PatNum: 1, AptNum: 52, DateTimeSent: "2026-11-01 09:00:00", DateTimeRecd: "0001-01-01 00:00:00" },
      5: { LabCaseNum: 5, PatNum: 1, AptNum: 50, DateTimeSent: "2019-03-01 09:00:00", DateTimeRecd: "2019-03-10 10:00:00" },
      6: { LabCaseNum: 6, PatNum: 1, AptNum: 0, DateTimeSent: "2019-03-01 09:00:00", DateTimeRecd: "0001-01-01 00:00:00" },
      7: { LabCaseNum: 7, PatNum: 2, AptNum: 53, DateTimeSent: "2020-01-01 09:00:00", DateTimeRecd: "0001-01-01 00:00:00" },
      8: { LabCaseNum: 8, PatNum: 3, AptNum: 50, PlannedAptNum: 0, DateTimeSent: "2018-01-01 09:00:00", DateTimeRecd: "0001-01-01 00:00:00" },
      9: { LabCaseNum: 9, PatNum: 1, AptNum: 50, DateTimeSent: "2019-03-01 09:00:00", DateTimeRecd: "2019-03-15 10:30:00" },
    },
    appts: {
      50: { AptNum: 50, PatNum: 1, AptStatus: "Complete", AptDateTime: "2019-03-15 10:30:00" },
      51: { AptNum: 51, PatNum: 1, AptStatus: "Complete", AptDateTime: "2026-10-28 08:00:00" },
      52: { AptNum: 52, PatNum: 1, AptStatus: "Scheduled", AptDateTime: "2026-11-20 09:00:00" },
      53: { AptNum: 53, PatNum: 2, AptStatus: 2, AptDateTime: "2020-02-02 14:00:00" },
      54: { AptNum: 54, PatNum: 2, AptStatus: "Scheduled", AptDateTime: "2026-12-01 09:00:00" },
      55: { AptNum: 55, PatNum: 1, AptStatus: "Planned", AptDateTime: "0001-01-01 00:00:00" },
    },
    procs: {
      101: { ProcNum: 101, PatNum: 1, ProcStatus: "C", procCode: "D2391", ToothNum: "3" },
      102: { ProcNum: 102, PatNum: 1, ProcStatus: "C", procCode: "D0120" },
      103: { ProcNum: 103, PatNum: 1, ProcStatus: "TP", procCode: "D2740", ToothNum: "30" },
      104: { ProcNum: 104, PatNum: 2, ProcStatus: "C", procCode: "D1110" },
      105: { ProcNum: 105, PatNum: 1, ProcStatus: 1, procCode: "D2393" },
      106: { ProcNum: 106, PatNum: 1, ProcStatus: "EO", procCode: "D2750", ToothNum: "19" },
      107: { ProcNum: 107, PatNum: 1, ProcStatus: "D", procCode: "D0120" },
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
      if (p === "/appointments" && req.method === "POST") {
        const ap = { AptNum: 77, AptStatus: "Scheduled", Note: "", Confirmed: 19, confirmed: "Unconfirmed", ...rec.body };
        state.appts[77] = ap;
        return json(201, ap);
      }
      if (p === "/commlogs" && req.method === "POST") {
        const c = { CommlogNum: 5, ...rec.body };
        state.commlogs.push(c);
        return json(201, c);
      }
      if (p === "/commlogs" && req.method === "GET") return json(200, state.commlogs.filter((c) => String(c.PatNum) === rec.query.PatNum));
      {
        const am = p.match(/^\/appointments\/(\d+)(?:\/(\w+))?$/);
        if (am && req.method === "PUT") {
          const ap = state.appts[am[1]];
          if (!ap) return json(404, { message: "Appointment not found" });
          if (!state.ignoreApptPut) {
            if (!am[2]) Object.assign(ap, rec.body);
            else if (am[2] === "Note") ap.Note = (ap.Note ? ap.Note + "\r\n" : "") + rec.body.Note;
            else if (am[2] === "Confirm") ap.confirmed = rec.body.confirmVal;
            else if (am[2] === "Break") ap.AptStatus = rec.body.sendToUnscheduledList === "true" ? "UnschedList" : "Broken";
          }
          res.writeHead(200);
          return res.end();
        }
      }
      if (p === "/schedules") return json(200, state.blockouts.filter((b) => !rec.query.SchedType || rec.query.SchedType === "Blockout"));
      if (p === "/appointments/Slots") return json(200, state.slots);
      // ---- clinical
      const procs = state.procs;
      let m;
      if ((m = p.match(/^\/procedurelogs\/(\d+)$/))) {
        const pr = procs[m[1]];
        if (!pr) return json(404, { message: "Procedure not found" });
        if (req.method === "GET") return json(200, pr);
        if (req.method === "PUT") {
          // Like Open Dental: PUT applies Priority/Dx DefNums but silently ignores the POST-only text names.
          const { priority, dxName, ...apply } = rec.body || {};
          if (state.ignoreProcPut) return json(200, pr);
          Object.assign(pr, apply);
          return json(200, pr);
        }
        if (req.method === "DELETE") {
          delete procs[m[1]];
          return json(200, { ok: true });
        }
      }
      if (p === "/procedurelogs" && req.method === "GET") {
        return json(200, Object.values(procs).filter((x) => String(x.PatNum) === rec.query.PatNum && (!rec.query.ProcStatus || x.ProcStatus === rec.query.ProcStatus)));
      }
      if (p === "/procedurelogs" && req.method === "POST") {
        const ProcNum = state.nextProc++;
        procs[ProcNum] = { ProcNum, Priority: 0, ...rec.body };
        return json(201, procs[ProcNum]);
      }
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
      if (p === "/treatplanattaches" && req.method === "GET") return json(200, state.attaches.filter((x) => String(x.TreatPlanNum) === rec.query.TreatPlanNum));
      if (p === "/treatplanattaches" && req.method === "POST") {
        const at = { TreatPlanAttachNum: state.nextAttach++, Priority: 0, ...rec.body };
        state.attaches.push(at);
        return json(201, at);
      }
      if ((m = p.match(/^\/treatplanattaches\/(\d+)$/)) && req.method === "PUT") {
        const at = state.attaches.find((x) => String(x.TreatPlanAttachNum) === m[1]);
        if (!at) return json(404, { message: "TreatPlanAttach not found" });
        if (!state.ignoreAttachPut) at.Priority = rec.body.Priority;
        return json(200, at);
      }
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
      // ---- lab
      const labcases = state.labcases;
      if (p === "/laboratories") return json(200, [{ LaboratoryNum: 1, Description: "Smile Lab", IsHidden: "false" }, { LaboratoryNum: 2, Description: "Old Lab", IsHidden: "true" }]);
      if ((m = p.match(/^\/laboratories\/(\d+)$/))) return m[1] === "1" || m[1] === "2" ? json(200, { LaboratoryNum: Number(m[1]) }) : json(404, { message: "Laboratory not found" });
      if (p === "/labturnarounds") return json(200, [{ LabTurnaroundNum: 4, LaboratoryNum: 1, Description: "Zirconia crown", DaysPublished: 7, DaysActual: 9 }]);
      if ((m = p.match(/^\/labturnarounds\/(\d+)$/))) return json(200, { LabTurnaroundNum: 4, LaboratoryNum: 1, DaysActual: 9 });
      if ((m = p.match(/^\/labcases\/(\d+)$/))) {
        const lc = labcases[m[1]];
        if (!lc) return json(404, { message: "LabCase not found" });
        if (req.method === "GET") return json(200, lc);
        if (req.method === "PUT") {
          if (!state.ignoreLabPut) Object.assign(lc, rec.body);
          return json(200, lc);
        }
      }
      if (p === "/labcases" && req.method === "GET") return json(200, Object.values(labcases).filter((x) => !rec.query.PatNum || String(x.PatNum) === rec.query.PatNum));
      if (p === "/labcases" && req.method === "POST") return json(201, { LabCaseNum: 900, ...rec.body });
      if ((m = p.match(/^\/appointments\/(\d+)$/)) && req.method === "GET") {
        const ap = state.appts[m[1]];
        return ap ? json(200, ap) : json(404, { message: "Appointment not found" });
      }
      // ---- tooth chart
      if (p === "/toothinitials" && req.method === "GET") return json(200, state.toothinitials.filter((x) => String(x.PatNum) === rec.query.PatNum));
      if (p === "/toothinitials" && req.method === "POST") {
        const ti = { ToothInitialNum: state.nextTooth++, ...rec.body };
        if (!state.ignoreToothPost) state.toothinitials.push(ti);
        return json(201, ti);
      }
      if ((m = p.match(/^\/toothinitials\/(\d+)$/)) && req.method === "DELETE") {
        state.toothinitials = state.toothinitials.filter((x) => String(x.ToothInitialNum) !== m[1]);
        return json(200, { ok: true });
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
