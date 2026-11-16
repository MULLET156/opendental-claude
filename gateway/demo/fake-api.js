"use strict";
/**
 * Open Dental API routes over the fake office, for test/fake-od.js's onRequest
 * hook. Reads come from the office tables; writes (plan a procedure, change its
 * status or priority, add a note or group note, treatment plans, tooth chart)
 * change them, so the demo reports reflect what a module just wrote. It all
 * lives in memory and starts over when the demo gateway restarts.
 *
 * Shapes follow Open Dental's API: status words ("TP", "Scheduled"),
 * "true"/"false" strings, "yyyy-MM-dd HH:mm:ss" date-times.
 */

const PROC_STATUS = { 1: "TP", 2: "C", 3: "EC", 4: "EO", 5: "R", 6: "D", 7: "Cn", 8: "TPi" };
const PROC_NUM = Object.fromEntries(Object.entries(PROC_STATUS).map(([k, v]) => [v, Number(k)]));
const APT_STATUS = { 1: "Scheduled", 2: "Complete", 3: "UnschedList", 4: "ASAP", 5: "Broken", 6: "Planned", 7: "PtNote", 8: "PtNoteCompleted" };
const PAT_STATUS = { 0: "Patient", 1: "NonPatient", 2: "Inactive", 3: "Archived", 4: "Deceased", 5: "Prospective" };
const tf = (v) => (v ? "true" : "false");

function createFakeApi(office) {
  const o = office;
  const next = (table, key) => Math.max(0, ...o[table].map((r) => r[key])) + 1;
  const code = (n) => o.procedurecode.find((c) => c.CodeNum === n);
  const codeByProc = (c) => o.procedurecode.find((x) => x.ProcCode.toUpperCase() === String(c || "").toUpperCase());
  const def = (n) => o.definition.find((d) => d.DefNum === n);
  const now = () => `${o.today} ${new Date().toTimeString().slice(0, 8)}`;

  const patientOut = (p) => ({ ...p, PatStatus: PAT_STATUS[p.PatStatus] || p.PatStatus, priProvAbbr: (o.provider.find((x) => x.ProvNum === p.PriProv) || {}).Abbr || "" });
  const procOut = (pl) => {
    const c = code(pl.CodeNum) || {};
    const pri = def(pl.Priority);
    return { ...pl, ProcStatus: PROC_STATUS[pl.ProcStatus] || pl.ProcStatus, procCode: c.ProcCode, descript: c.Descript, priority: pri ? pri.ItemName : "", ProcFee: String(pl.ProcFee) };
  };
  const aptOut = (a) => {
    const c = def(a.Confirmed);
    return { ...a, AptStatus: APT_STATUS[a.AptStatus] || a.AptStatus, confirmed: c ? c.ItemName : "", IsHygiene: tf(a.IsHygiene), IsNewPatient: tf(a.IsNewPatient) };
  };
  const status = (v) => (typeof v === "number" ? v : PROC_NUM[String(v)] || null);

  const ok = (body, st = 200) => ({ status: st, body });
  const notFound = (what) => ({ status: 404, body: { message: `${what} not found` } });
  const bad = (message) => ({ status: 400, body: { message } });
  const page = (rows, q) => {
    const off = Number(q.Offset || 0);
    return ok(rows.slice(off, off + 1000));
  };

  return function onRequest(rec) {
    const p = rec.path.replace(/^\/api\/v1/, "");
    const q = rec.query || {};
    const b = rec.body || {};
    const M = rec.method;
    let m;

    // ---- reference lists
    if (p === "/providers" && M === "GET") return ok(o.provider);
    if ((m = p.match(/^\/providers\/(\d+)$/))) {
      const x = o.provider.find((r) => r.ProvNum === Number(m[1]));
      return x ? ok(x) : notFound("Provider");
    }
    if (p === "/operatories" && M === "GET") return ok(o.operatory);
    if (p === "/definitions" && M === "GET") return ok(o.definition.filter((d) => !q.Category || String(d.Category) === String(q.Category)));
    if (p === "/procedurecodes" && M === "GET") return page(o.procedurecode, q);
    if (p === "/laboratories" && M === "GET") return ok(o.laboratory.map((l) => ({ ...l, IsHidden: tf(l.IsHidden) })));
    if ((m = p.match(/^\/laboratories\/(\d+)$/))) {
      const x = o.laboratory.find((r) => r.LaboratoryNum === Number(m[1]));
      return x ? ok(x) : notFound("Laboratory");
    }
    if (p === "/labturnarounds") return ok([]);
    if (p === "/carriers" && M === "GET") return ok(o.carrier);

    // ---- patients
    if (p === "/patients" && M === "GET") {
      const l = String(q.LName || "").toLowerCase();
      const f = String(q.FName || "").toLowerCase();
      const rows = o.patient.filter((x) => (!l || x.LName.toLowerCase().startsWith(l)) && (!f || x.FName.toLowerCase().startsWith(f)) && (!q.PatStatus || PAT_STATUS[x.PatStatus] === q.PatStatus));
      return page(rows.map(patientOut), q);
    }
    if ((m = p.match(/^\/patients\/(\d+)$/)) && M === "GET") {
      const x = o.patient.find((r) => r.PatNum === Number(m[1]));
      return x ? ok(patientOut(x)) : notFound("Patient");
    }
    if ((m = p.match(/^\/chartmodules\/(\d+)\/(ProgNotes|PatientInfo)$/))) {
      const pat = Number(m[1]);
      if (m[2] === "PatientInfo") return ok([{ Field: "Allergies", Content: "None on file (fake)" }, { Field: "Medications", Content: "None on file (fake)" }]);
      const notes = o.procnote.filter((n) => n.PatNum === pat);
      return ok(
        o.procedurelog
          .filter((pl) => pl.PatNum === pat && [2, 3, 4].includes(pl.ProcStatus))
          .sort((a, c) => String(c.ProcDate).localeCompare(String(a.ProcDate)))
          .map((pl) => {
            const n = notes.filter((x) => x.ProcNum === pl.ProcNum).sort((a, c) => c.ProcNoteNum - a.ProcNoteNum)[0];
            return { ObjectType: "Procedure", ProcNum: pl.ProcNum, ProcDate: pl.ProcDate, ProcCode: (code(pl.CodeNum) || {}).ProcCode, Note: n ? n.Note : "", Signed: n && n.Signature ? "Signed" : "" };
          })
      );
    }

    // ---- insurance
    if (p === "/patplans" && M === "GET") return ok(o.patplan.filter((x) => !q.PatNum || String(x.PatNum) === q.PatNum));
    if ((m = p.match(/^\/inssubs\/(\d+)$/))) {
      const x = o.inssub.find((r) => r.InsSubNum === Number(m[1]));
      return x ? ok(x) : notFound("InsSub");
    }
    if ((m = p.match(/^\/insplans\/(\d+)$/))) {
      const x = o.insplan.find((r) => r.PlanNum === Number(m[1]));
      return x ? ok(x) : notFound("InsPlan");
    }
    if (p === "/benefits" && M === "GET") return ok(o.benefit.filter((x) => (!q.PlanNum || String(x.PlanNum) === q.PlanNum) && (!q.PatPlanNum || String(x.PatPlanNum) === q.PatPlanNum)));

    // ---- appointments
    if (p === "/appointments" && M === "GET") {
      const rows = o.appointment.filter((a) => {
        const d = String(a.AptDateTime).slice(0, 10);
        return (
          (!q.PatNum || String(a.PatNum) === q.PatNum) &&
          (!q.date || d === q.date) &&
          (!q.dateStart || d >= q.dateStart) &&
          (!q.dateEnd || d <= q.dateEnd) &&
          (!q.AptStatus || APT_STATUS[a.AptStatus] === q.AptStatus) &&
          (!q.Op || String(a.Op) === q.Op)
        );
      });
      return page(rows.sort((a, c) => String(a.AptDateTime).localeCompare(String(c.AptDateTime))).map(aptOut), q);
    }
    if ((m = p.match(/^\/appointments\/(\d+)(?:\/(Note|Confirm|Break))?$/))) {
      const a = o.appointment.find((r) => r.AptNum === Number(m[1]));
      if (!a) return notFound("Appointment");
      if (M === "GET" && !m[2]) return ok(aptOut(a));
      if (M === "PUT" && m[2] === "Note") {
        a.Note = (a.Note ? a.Note + "\r\n" : "") + String(b.Note || "");
        return ok({ ok: true });
      }
      if (M === "PUT" && m[2] === "Confirm") {
        const d = o.definition.find((x) => x.Category === 2 && (x.ItemName === b.confirmVal || String(x.DefNum) === String(b.defNum)));
        if (d) a.Confirmed = d.DefNum;
        return ok({ ok: true });
      }
      if (M === "PUT" && m[2] === "Break") {
        a.AptStatus = b.sendToUnscheduledList === "true" ? 3 : 5;
        return ok({ ok: true });
      }
      if (M === "PUT" && !m[2]) {
        for (const k of ["AptDateTime", "Op", "ProvNum", "ProvHyg", "Pattern", "Note"]) if (b[k] !== undefined) a[k] = b[k];
        if (b.AptStatus) a.AptStatus = Number(Object.keys(APT_STATUS).find((k) => APT_STATUS[k] === b.AptStatus)) || a.AptStatus;
        return ok(aptOut(a));
      }
    }
    if (p === "/appointments" && M === "POST") {
      if (!o.patient.some((x) => x.PatNum === Number(b.PatNum))) return bad("PatNum is invalid.");
      const a = {
        AptNum: next("appointment", "AptNum"),
        PatNum: Number(b.PatNum),
        AptStatus: 1,
        AptDateTime: b.AptDateTime,
        Pattern: b.Pattern || "XXXXXXXXXXXX",
        ProvNum: Number(b.ProvNum) || 1,
        ProvHyg: Number(b.ProvHyg) || 0,
        Op: Number(b.Op) || 0,
        Confirmed: 21,
        IsHygiene: 0,
        IsNewPatient: 0,
        ProcDescript: "",
        Note: b.Note || "",
        ClinicNum: 0,
      };
      o.appointment.push(a);
      return ok(aptOut(a), 201);
    }
    if (p === "/appointments/Slots" || p === "/schedules") return ok([]);

    // ---- procedures
    if (p === "/procedurelogs" && M === "GET") {
      const rows = o.procedurelog.filter(
        (pl) => (!q.PatNum || String(pl.PatNum) === q.PatNum) && (!q.ProcStatus || PROC_STATUS[pl.ProcStatus] === q.ProcStatus) && (!q.AptNum || String(pl.AptNum) === q.AptNum)
      );
      return page(rows.map(procOut), q);
    }
    if (p === "/procedurelogs" && M === "POST") {
      if (!o.patient.some((x) => x.PatNum === Number(b.PatNum))) return bad("PatNum is invalid.");
      const c = codeByProc(b.procCode);
      if (!c) return bad(`procCode "${b.procCode}" was not found.`);
      const st = status(b.ProcStatus);
      if (!st) return bad("ProcStatus is invalid.");
      const pl = {
        ProcNum: next("procedurelog", "ProcNum"),
        PatNum: Number(b.PatNum),
        AptNum: Number(b.AptNum) || 0,
        PlannedAptNum: 0,
        ProcDate: b.ProcDate || o.today,
        DateTP: o.today,
        ProcStatus: st,
        CodeNum: c.CodeNum,
        ProcFee: c.Fee,
        UnitQty: 1,
        BaseUnits: 0,
        ToothNum: b.ToothNum || "",
        Surf: b.Surf || "",
        ProvNum: Number(b.ProvNum) || 1,
        Priority: Number(b.Priority) || 0,
        ClinicNum: 0,
      };
      o.procedurelog.push(pl);
      return ok(procOut(pl), 201);
    }
    if (p === "/procedurelogs/GroupNote" && M === "POST") {
      if (!o.patient.some((x) => x.PatNum === Number(b.PatNum))) return bad("PatNum is invalid.");
      const pl = { ProcNum: next("procedurelog", "ProcNum"), PatNum: Number(b.PatNum), AptNum: 0, PlannedAptNum: 0, ProcDate: o.today, DateTP: o.today, ProcStatus: 3, CodeNum: codeByProc("~GRP~").CodeNum, ProcFee: 0, UnitQty: 1, BaseUnits: 0, ToothNum: "", Surf: "", ProvNum: Number(b.ProvNum) || 1, Priority: 0, ClinicNum: 0 };
      o.procedurelog.push(pl);
      o.procnote.push({ ProcNoteNum: next("procnote", "ProcNoteNum"), PatNum: pl.PatNum, ProcNum: pl.ProcNum, EntryDateTime: now(), UserNum: 0, Note: String(b.Note || ""), Signature: "", SigIsTopaz: 0 });
      return ok({ ...procOut(pl), Note: b.Note, isSigned: "false" }, 201);
    }
    if ((m = p.match(/^\/procedurelogs\/(\d+)$/))) {
      const pl = o.procedurelog.find((r) => r.ProcNum === Number(m[1]));
      if (!pl) return notFound("Procedure");
      if (M === "GET") return ok(procOut(pl));
      if (M === "PUT") {
        // Like Open Dental: PUT takes Priority/Dx DefNums and ignores the POST-only text names.
        if (b.ProcStatus !== undefined) {
          const st = status(b.ProcStatus);
          if (!st) return bad("ProcStatus is invalid.");
          pl.ProcStatus = st;
        }
        if (b.procCode !== undefined) {
          const c = codeByProc(b.procCode);
          if (!c) return bad(`procCode "${b.procCode}" was not found.`);
          pl.CodeNum = c.CodeNum;
          pl.ProcFee = c.Fee;
        }
        for (const k of ["ProcDate", "ToothNum", "Surf"]) if (b[k] !== undefined) pl[k] = b[k];
        for (const k of ["Priority", "ProvNum", "AptNum"]) if (b[k] !== undefined) pl[k] = Number(b[k]) || 0;
        return ok(procOut(pl));
      }
      if (M === "DELETE") {
        if (pl.ProcStatus !== 1) return bad("Only treatment-planned procedures can be deleted.");
        o.procedurelog.splice(o.procedurelog.indexOf(pl), 1);
        return ok({ ok: true });
      }
    }
    if (p === "/procnotes" && M === "GET") {
      return ok(o.procnote.filter((n) => (!q.PatNum || String(n.PatNum) === q.PatNum) && (!q.ProcNum || String(n.ProcNum) === q.ProcNum)).map((n) => ({ ...n, isSigned: tf(!!n.Signature) })));
    }
    if (p === "/procnotes" && M === "POST") {
      const pl = o.procedurelog.find((r) => r.ProcNum === Number(b.ProcNum));
      if (!pl || pl.PatNum !== Number(b.PatNum)) return bad("ProcNum is invalid for this patient.");
      const prev = o.procnote.filter((n) => n.ProcNum === pl.ProcNum).sort((a, c) => c.ProcNoteNum - a.ProcNoteNum)[0];
      const text = b.doAppendNote === "true" && prev ? `${prev.Note}\r\n${b.Note}` : String(b.Note || "");
      const n = { ProcNoteNum: next("procnote", "ProcNoteNum"), PatNum: pl.PatNum, ProcNum: pl.ProcNum, EntryDateTime: now(), UserNum: 0, Note: text, Signature: "", SigIsTopaz: 0 };
      o.procnote.push(n);
      return ok({ ...n, isSigned: "false" }, 201);
    }

    // ---- treatment plans
    if (p === "/treatplans" && M === "GET") return ok(o.treatplan.filter((t) => !q.PatNum || String(t.PatNum) === q.PatNum));
    if (p === "/treatplans" && M === "POST") {
      const t = { TreatPlanNum: next("treatplan", "TreatPlanNum") || 1, PatNum: Number(b.PatNum), Heading: b.Heading || "", Note: b.Note || "", TPStatus: "Inactive", DateTP: o.today };
      o.treatplan.push(t);
      return ok(t, 201);
    }
    if ((m = p.match(/^\/treatplans\/(\d+)$/)) && M === "PUT") {
      const t = o.treatplan.find((r) => r.TreatPlanNum === Number(m[1]));
      if (!t) return notFound("TreatPlan");
      for (const k of ["Heading", "Note"]) if (b[k] !== undefined) t[k] = b[k];
      return ok(t);
    }
    if (p === "/treatplanattaches" && M === "GET") return ok(o.treatplanattach.filter((t) => !q.TreatPlanNum || String(t.TreatPlanNum) === q.TreatPlanNum));
    if (p === "/treatplanattaches" && M === "POST") {
      const t = { TreatPlanAttachNum: next("treatplanattach", "TreatPlanAttachNum") || 1, TreatPlanNum: Number(b.TreatPlanNum), ProcNum: Number(b.ProcNum), Priority: Number(b.Priority) || 0 };
      o.treatplanattach.push(t);
      return ok(t, 201);
    }
    if ((m = p.match(/^\/treatplanattaches\/(\d+)$/)) && M === "PUT") {
      const t = o.treatplanattach.find((r) => r.TreatPlanAttachNum === Number(m[1]));
      if (!t) return notFound("TreatPlanAttach");
      if (b.Priority !== undefined) t.Priority = Number(b.Priority) || 0;
      return ok(t);
    }

    // ---- tooth chart
    if (p === "/toothinitials" && M === "GET") return ok(o.toothinitial.filter((t) => !q.PatNum || String(t.PatNum) === q.PatNum));
    if (p === "/toothinitials" && M === "POST") {
      const t = { ToothInitialNum: next("toothinitial", "ToothInitialNum") || 1, PatNum: Number(b.PatNum), ToothNum: String(b.ToothNum), InitialType: b.InitialType };
      o.toothinitial.push(t);
      return ok(t, 201);
    }
    if ((m = p.match(/^\/toothinitials\/(\d+)$/)) && M === "DELETE") {
      o.toothinitial = o.toothinitial.filter((t) => t.ToothInitialNum !== Number(m[1]));
      return ok({ ok: true });
    }

    // ---- lab cases
    if (p === "/labcases" && M === "GET") return page(o.labcase.filter((l) => !q.PatNum || String(l.PatNum) === q.PatNum), q);
    if ((m = p.match(/^\/labcases\/(\d+)$/))) {
      const l = o.labcase.find((r) => r.LabCaseNum === Number(m[1]));
      if (!l) return notFound("LabCase");
      if (M === "GET") return ok(l);
      if (M === "PUT") {
        for (const k of ["DateTimeSent", "DateTimeRecd", "DateTimeChecked", "DateTimeDue", "Instructions", "AptNum"]) if (b[k] !== undefined) l[k] = b[k];
        return ok(l);
      }
    }
    if (p === "/labcases" && M === "POST") {
      const l = { LabCaseNum: next("labcase", "LabCaseNum"), DateTimeCreated: now(), DateTimeSent: "0001-01-01 00:00:00", DateTimeRecd: "0001-01-01 00:00:00", DateTimeChecked: "0001-01-01 00:00:00", AptNum: 0, PlannedAptNum: 0, ...b };
      o.labcase.push(l);
      return ok(l, 201);
    }

    // ---- commlogs
    if (p === "/commlogs" && M === "GET") return ok(o.commlog.filter((c) => !q.PatNum || String(c.PatNum) === q.PatNum));
    if (p === "/commlogs" && M === "POST") {
      const c = { CommlogNum: next("commlog", "CommlogNum") || 1, CommDateTime: now(), ...b };
      o.commlog.push(c);
      return ok(c, 201);
    }

    // The demo never answers SQL directly: reports come from the fake report engine.
    if (p === "/queries/ShortQuery") return { status: 400, body: { message: "The demo Open Dental has no database. Use a built-in report." } };
    return { status: 404, body: { message: `The demo Open Dental doesn't know ${M} ${p}` } };
  };
}

module.exports = { createFakeApi, PROC_STATUS, APT_STATUS };
