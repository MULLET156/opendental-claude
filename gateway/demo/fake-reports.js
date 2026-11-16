"use strict";
/**
 * Fake report engine for the demo gateway. For each report it returns the rows
 * the real SQL would return from the fake office (same column names, before the
 * report's shared `post` step), so modules see the same shapes in the design
 * stage as they will from real Open Dental.
 *
 * A report without a fake here answers 501 with a clear message; add one when
 * a module needs it (and say so in the report request issue).
 */

const { ODError } = require("../../core/odclient");
const { XRAY_CATEGORIES } = require("../../core/reports");
const { addDays, addMonths } = require("./fake-office");

const day = (dt) => String(dt || "").slice(0, 10);
const realDate = (d) => d && d > "1880-01-01";
const fee = (p) => Math.round(p.ProcFee * (p.UnitQty + p.BaseUnits) * 100) / 100;
const sum = (list) => Math.round(list.reduce((a, b) => a + b, 0) * 100) / 100;
const cmp = (...keys) => (a, b) => {
  for (const k of keys) {
    const x = a[k];
    const y = b[k];
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
};

const STATUS_NUM = { Scheduled: 1, Complete: 2, UnschedList: 3, ASAP: 4, Broken: 5, Planned: 6, PtNote: 7, PtNoteCompleted: 8 };
const aptStatus = (a) => (typeof a.AptStatus === "number" ? a.AptStatus : STATUS_NUM[a.AptStatus] || Number(a.AptStatus));

function index(o) {
  return {
    pat: new Map(o.patient.map((p) => [p.PatNum, p])),
    code: new Map(o.procedurecode.map((c) => [c.CodeNum, c])),
    prov: new Map(o.provider.map((p) => [p.ProvNum, p])),
    op: new Map(o.operatory.map((x) => [x.OperatoryNum, x])),
    def: new Map(o.definition.map((d) => [d.DefNum, d])),
    apt: new Map(o.appointment.map((a) => [a.AptNum, a])),
    plan: new Map(o.insplan.map((p) => [p.PlanNum, p])),
    sub: new Map(o.inssub.map((s) => [s.InsSubNum, s])),
    carrier: new Map(o.carrier.map((c) => [c.CarrierNum, c])),
    lab: new Map(o.laboratory.map((l) => [l.LaboratoryNum, l])),
  };
}

const scheduledFromToday = (ix, today, aptNum) => {
  const a = ix.apt.get(aptNum);
  return !!a && aptStatus(a) === 1 && day(a.AptDateTime) >= today;
};

function primaryPlan(o, ix, patNum) {
  const pp = o.patplan.find((x) => x.PatNum === patNum && x.Ordinal === 1);
  if (!pp) return null;
  const sub = ix.sub.get(pp.InsSubNum);
  const plan = sub && ix.plan.get(sub.PlanNum);
  if (!plan) return null;
  return { pp, sub, plan, carrier: ix.carrier.get(plan.CarrierNum) };
}

const FAKES = {
  unscheduled_treatment(o, ix, p, today) {
    const hyg = new Set(p.include_hygiene === "true" ? [] : p.hygiene_codes || []);
    const codes = p.codes ? new Set(p.codes) : null;
    const pats = p.patients ? new Set(p.patients) : null;
    return o.procedurelog
      .filter((pl) => {
        const pt = ix.pat.get(pl.PatNum);
        const c = ix.code.get(pl.CodeNum).ProcCode;
        return (
          pl.ProcStatus === 1 &&
          pt && pt.PatStatus === 0 &&
          !scheduledFromToday(ix, today, pl.AptNum) &&
          !hyg.has(c) &&
          (!p.provider || pl.ProvNum === p.provider) &&
          (!codes || codes.has(c)) &&
          (p.min_fee === undefined || fee(pl) >= p.min_fee) &&
          (!pats || pats.has(pl.PatNum))
        );
      })
      .map((pl) => {
        const pt = ix.pat.get(pl.PatNum);
        const c = ix.code.get(pl.CodeNum);
        const pr = ix.prov.get(pl.ProvNum);
        const d = ix.def.get(pl.Priority);
        return { PatNum: pl.PatNum, LName: pt.LName, FName: pt.FName, ProcNum: pl.ProcNum, ProcCode: c.ProcCode, Descript: c.Descript, ToothNum: pl.ToothNum, Surf: pl.Surf, Fee: fee(pl), ProvNum: pl.ProvNum, Provider: pr ? pr.Abbr : null, DateTP: pl.DateTP, Priority: d ? d.ItemName : "", AptNum: pl.AptNum, AsOf: today };
      })
      .sort(cmp("LName", "FName", "PatNum", "DateTP", "ProcNum"))
      .slice(0, p.limit);
  },

  no_future_appointment(o, ix, p, today) {
    return o.patient
      .filter((pt) => pt.PatStatus === 0 && (!p.provider || pt.PriProv === p.provider))
      .filter((pt) => !o.appointment.some((a) => a.PatNum === pt.PatNum && aptStatus(a) === 1 && day(a.AptDateTime) >= today))
      .map((pt) => {
        const visits = o.appointment.filter((a) => a.PatNum === pt.PatNum && aptStatus(a) === 2).map((a) => day(a.AptDateTime)).sort();
        const pr = ix.prov.get(pt.PriProv);
        return {
          PatNum: pt.PatNum,
          LName: pt.LName,
          FName: pt.FName,
          PriProv: pt.PriProv,
          Provider: pr ? pr.Abbr : null,
          LastVisit: visits.length ? visits[visits.length - 1] : null,
          PlannedTotal: sum(o.procedurelog.filter((pl) => pl.PatNum === pt.PatNum && pl.ProcStatus === 1 && !(p.hygiene_codes || []).includes(ix.code.get(pl.CodeNum).ProcCode)).map(fee)),
          AsOf: today,
        };
      })
      .filter((r) => (p.include_never_seen === "true" || r.LastVisit !== null) && (!p.last_visit_after || (r.LastVisit && r.LastVisit >= p.last_visit_after)) && (!p.last_visit_before || (r.LastVisit && r.LastVisit < p.last_visit_before)))
      .sort((a, b) => String(b.LastVisit).localeCompare(String(a.LastVisit)) || a.PatNum - b.PatNum)
      .slice(0, p.limit);
  },

  xray_history(o, ix, p, today) {
    const who = p.patients
      ? p.patients.filter((n) => ix.pat.has(n))
      : [...new Set(o.appointment.filter((a) => day(a.AptDateTime) === p.date && [1, 2].includes(aptStatus(a))).map((a) => a.PatNum))];
    const tenYears = addMonths(today, -120);
    const rows = [];
    for (const patNum of who) {
      const pt = ix.pat.get(patNum);
      const ins = primaryPlan(o, ix, patNum);
      for (const [cat, codes] of Object.entries(XRAY_CATEGORIES)) {
        const set = new Set(codes);
        const dates = [
          ...new Set(
            o.procedurelog
              .filter((pl) => pl.PatNum === patNum && [2, 3, 4].includes(pl.ProcStatus) && set.has(ix.code.get(pl.CodeNum).ProcCode) && pl.ProcDate >= tenYears)
              .map((pl) => pl.ProcDate)
          ),
        ].sort().reverse();
        let frequency = null;
        if (ins) {
          const b = o.benefit
            .filter((x) => x.BenefitType === 5 && (x.PlanNum === ins.plan.PlanNum || x.PatPlanNum === ins.pp.PatPlanNum) && [1, 4, 5].includes(x.QuantityQualifier) && x.CodeNum && set.has(ix.code.get(x.CodeNum).ProcCode))
            .sort((a, c) => c.PatPlanNum - a.PatPlanNum || a.BenefitNum - c.BenefitNum)[0];
          if (b) frequency = `${b.Quantity}|${b.QuantityQualifier}|${b.TimePeriod}`;
        }
        rows.push({ PatNum: patNum, LName: pt.LName, FName: pt.FName, Category: cat, Dates: dates.join(",") || null, Carrier: ins ? ins.carrier.CarrierName : null, MonthRenew: ins ? ins.plan.MonthRenew : null, Frequency: frequency, AsOf: today });
      }
    }
    const order = Object.keys(XRAY_CATEGORIES);
    return rows.sort((a, b) => cmp("LName", "FName", "PatNum")(a, b) || order.indexOf(a.Category) - order.indexOf(b.Category)).slice(0, p.limit);
  },

  insurance_remaining(o, ix, p, today) {
    const pats = p.patients ? new Set(p.patients) : null;
    const [y, m] = today.split("-").map(Number);
    return o.patplan
      .filter((pp) => pp.Ordinal === 1 && (!pats || pats.has(pp.PatNum)))
      .map((pp) => {
        const pt = ix.pat.get(pp.PatNum);
        const sub = ix.sub.get(pp.InsSubNum);
        const plan = ix.plan.get(sub.PlanNum);
        return { pt, pp, sub, plan, carrier: ix.carrier.get(plan.CarrierNum) };
      })
      .filter((x) => x.pt.PatStatus === 0 && (!p.carrier || x.plan.CarrierNum === p.carrier))
      .map(({ pt, pp, plan, carrier }) => {
        const mr = plan.MonthRenew <= 1 ? 1 : plan.MonthRenew;
        const start = `${m >= mr ? y : y - 1}-${String(mr).padStart(2, "0")}-01`;
        const end = addMonths(start, 12);
        const maxRow = o.benefit
          .filter((b) => b.BenefitType === 5 && b.CovCatNum === 0 && b.CodeNum === 0 && b.MonetaryAmt > 0 && b.QuantityQualifier === 0 && [1, 2].includes(b.TimePeriod) && b.CoverageLevel !== 2 && (b.PlanNum === plan.PlanNum || b.PatPlanNum === pp.PatPlanNum))
          .sort((a, b) => b.PatPlanNum - a.PatPlanNum || a.BenefitNum - b.BenefitNum)[0];
        const used = sum(
          o.claimproc
            .filter((cp) => cp.PatNum === pt.PatNum && cp.InsSubNum === pp.InsSubNum && [0, 1, 3, 4, 9].includes(cp.Status) && cp.ProcDate >= start && cp.ProcDate < end)
            .map((cp) => (cp.Status === 0 ? cp.InsPayEst : cp.InsPayAmt))
        );
        return { PatNum: pt.PatNum, LName: pt.LName, FName: pt.FName, Carrier: carrier.CarrierName, GroupName: plan.GroupName, BenefitYearStart: start, AnnualMax: maxRow ? maxRow.MonetaryAmt : null, Used: used, AsOf: today };
      })
      .sort(cmp("LName", "FName", "PatNum"))
      .slice(0, p.limit);
  },

  daysheet(o, ix, p) {
    const statuses = p.include_broken === "true" ? [1, 2, 5] : [1, 2];
    return o.appointment
      .filter((a) => day(a.AptDateTime) === p.date && statuses.includes(aptStatus(a)))
      .filter((a) => (!p.provider || a.ProvNum === p.provider || a.ProvHyg === p.provider) && (!p.op || a.Op === p.op))
      .map((a) => {
        const pt = ix.pat.get(a.PatNum);
        const procs = o.procedurelog.filter((pl) => pl.AptNum === a.AptNum && [1, 2].includes(pl.ProcStatus)).sort((x, y) => x.ProcNum - y.ProcNum);
        const op = ix.op.get(a.Op);
        const pr = ix.prov.get(a.ProvNum);
        const ph = ix.prov.get(a.ProvHyg);
        const conf = ix.def.get(a.Confirmed);
        return {
          AptNum: a.AptNum,
          AptDateTime: a.AptDateTime,
          Minutes: String(a.Pattern || "").length * 5,
          AptStatus: aptStatus(a),
          PatNum: a.PatNum,
          LName: pt.LName,
          FName: pt.FName,
          Preferred: pt.Preferred,
          ProvNum: a.ProvNum,
          Provider: pr ? pr.Abbr : null,
          ProvHyg: a.ProvHyg,
          Hygienist: ph ? ph.Abbr : null,
          OpNum: a.Op,
          OpName: op ? op.OpName : null,
          IsHygiene: a.IsHygiene,
          IsNewPatient: a.IsNewPatient,
          Confirmed: conf ? conf.ItemName : "",
          Procedures: procs.map((pl) => ix.code.get(pl.CodeNum).ProcCode + (pl.ToothNum ? ` #${pl.ToothNum}` : "") + (pl.Surf ? ` ${pl.Surf}` : "")).join(", ") || null,
          ScheduledFee: sum(procs.map(fee)),
          _order: op ? op.ItemOrder : 99,
        };
      })
      .sort(cmp("AptDateTime", "_order", "AptNum"))
      .map(({ _order, ...r }) => r);
  },

  unsigned_notes(o, ix, p, today) {
    const from = p.from || addDays(today, -Math.min(Math.max(p.days, 1), 3650));
    const to = p.to || today;
    const latest = new Map();
    for (const n of o.procnote) if (!latest.has(n.ProcNum) || latest.get(n.ProcNum).ProcNoteNum < n.ProcNoteNum) latest.set(n.ProcNum, n);
    const rows = o.procedurelog
      .filter((pl) => [2, 3].includes(pl.ProcStatus) && latest.has(pl.ProcNum) && latest.get(pl.ProcNum).Signature === "" && latest.get(pl.ProcNum).Note !== "" && pl.ProcDate >= from && pl.ProcDate <= to && (!p.provider || pl.ProvNum === p.provider))
      .map((pl) => {
        const pt = ix.pat.get(pl.PatNum);
        const c = ix.code.get(pl.CodeNum);
        const pr = ix.prov.get(pl.ProvNum);
        return { ProcNum: pl.ProcNum, PatNum: pl.PatNum, LName: pt.LName, FName: pt.FName, ProcDate: pl.ProcDate, ProcCode: c.ProcCode, Descript: c.Descript, ProvNum: pl.ProvNum, Provider: pr ? pr.Abbr : null, NoteEntered: latest.get(pl.ProcNum).EntryDateTime };
      })
      .sort(cmp("ProcDate", "ProcNum"));
    return p.count_only === "true" ? [{ UnsignedNotes: rows.length }] : rows.slice(0, p.limit);
  },

  // ---- a few of the older reports, for modules that already use them

  operatories(o) {
    return [...o.operatory].sort(cmp("ItemOrder")).map(({ OperatoryNum, OpName, Abbrev, ProvDentist, ProvHygienist, IsHygiene, ClinicNum, IsHidden }) => ({ OperatoryNum, OpName, Abbrev, ProvDentist, ProvHygienist, IsHygiene, ClinicNum, IsHidden }));
  },

  patient_treatment_plan(o, ix, p) {
    return o.procedurelog
      .filter((pl) => pl.PatNum === p.patient && pl.ProcStatus === 1)
      .sort(cmp("ProcDate"))
      .map((pl) => {
        const c = ix.code.get(pl.CodeNum);
        return { ProcNum: pl.ProcNum, ProcCode: c.ProcCode, Descript: c.Descript, ToothNum: pl.ToothNum, Surf: pl.Surf, Fee: fee(pl), ProvNum: pl.ProvNum, AptNum: pl.AptNum, ProcDate: pl.ProcDate };
      });
  },

  production_by_provider(o, ix, p) {
    const by = new Map();
    for (const pl of o.procedurelog) {
      if (pl.ProcStatus !== 2 || pl.ProcDate < p.from || pl.ProcDate > p.to) continue;
      const r = by.get(pl.ProvNum) || { ProvNum: pl.ProvNum, GrossProduction: 0, ProcCount: 0 };
      r.GrossProduction = Math.round((r.GrossProduction + fee(pl)) * 100) / 100;
      r.ProcCount++;
      by.set(pl.ProvNum, r);
    }
    return [...by.values()].sort((a, b) => b.GrossProduction - a.GrossProduction);
  },

  production_by_day(o, ix, p) {
    const by = new Map();
    for (const pl of o.procedurelog) {
      if (pl.ProcStatus !== 2 || pl.ProcDate < p.from || pl.ProcDate > p.to || (p.provider && pl.ProvNum !== p.provider)) continue;
      const r = by.get(pl.ProcDate) || { ProcDate: pl.ProcDate, GrossProduction: 0, ProcCount: 0 };
      r.GrossProduction = Math.round((r.GrossProduction + fee(pl)) * 100) / 100;
      r.ProcCount++;
      by.set(pl.ProcDate, r);
    }
    return [...by.values()].sort(cmp("ProcDate"));
  },

  scheduled_production(o, ix, p) {
    const by = new Map();
    for (const a of o.appointment) {
      const d = day(a.AptDateTime);
      if (aptStatus(a) !== 1 || d < p.from || d > p.to) continue;
      const procs = o.procedurelog.filter((pl) => pl.AptNum === a.AptNum && [1, 2].includes(pl.ProcStatus));
      if (!procs.length) continue;
      const key = `${d}|${a.ProvNum}`;
      const r = by.get(key) || { AptDate: d, ProvNum: a.ProvNum, Appointments: 0, ScheduledProduction: 0 };
      r.Appointments++;
      r.ScheduledProduction = Math.round((r.ScheduledProduction + sum(procs.map(fee))) * 100) / 100;
      by.set(key, r);
    }
    return [...by.values()].sort(cmp("AptDate", "ProvNum"));
  },

  new_patients(o, ix, p) {
    return [{ NewPatients: o.patient.filter((pt) => realDate(pt.DateFirstVisit) && pt.DateFirstVisit >= p.from && pt.DateFirstVisit <= p.to && [0, 2].includes(pt.PatStatus)).length }];
  },

  lab_cases_open(o, ix, p, today) {
    const now = `${today} 12:00:00`;
    const horizon = `${addDays(today, Math.min(Math.max(p.days_ahead, 0), 365))} 12:00:00`;
    return o.labcase
      .filter((lc) => !realDate(lc.DateTimeChecked) && (!p.lab || lc.LaboratoryNum === p.lab))
      .map((lc) => {
        const pt = ix.pat.get(lc.PatNum);
        const a = ix.apt.get(lc.AptNum);
        const lab = ix.lab.get(lc.LaboratoryNum);
        const recd = realDate(lc.DateTimeRecd);
        return {
          LabCaseNum: lc.LabCaseNum,
          PatNum: lc.PatNum,
          LName: pt.LName,
          FName: pt.FName,
          Lab: lab ? lab.Description : null,
          ProvNum: lc.ProvNum,
          DateTimeCreated: lc.DateTimeCreated,
          DateTimeSent: lc.DateTimeSent,
          DateTimeDue: lc.DateTimeDue,
          DateTimeRecd: lc.DateTimeRecd,
          AptNum: lc.AptNum,
          SeatAppt: a ? a.AptDateTime : null,
          AptStatus: a ? aptStatus(a) : null,
          Status: !realDate(lc.DateTimeSent) ? "not_sent" : !recd ? "at_lab" : "received_not_checked",
          Overdue: !recd && realDate(lc.DateTimeDue) && lc.DateTimeDue < now ? 1 : 0,
          SeatRisk: !recd && a && aptStatus(a) === 1 && a.AptDateTime < horizon ? 1 : 0,
          Instructions: lc.Instructions,
        };
      })
      .sort((a, b) => String(a.DateTimeDue).localeCompare(String(b.DateTimeDue)))
      .slice(0, p.limit);
  },
};

/**
 * Rows for one report from the fake office, shaped like the real SQL's output.
 * `params` are the parsed plain values from parseReportParams().raw.
 */
function fakeReportRows(office, name, params, { limit } = {}) {
  const fn = Object.prototype.hasOwnProperty.call(FAKES, name) ? FAKES[name] : null;
  if (!fn) {
    throw new ODError(`The demo gateway has no fake data for report "${name}" yet. Ask the Connector agent (open a "Report request: ${name}" issue).`, { code: "not_implemented" });
  }
  let rows = fn(office, index(office), params, office.today);
  const truncated = !!limit && rows.length > limit;
  if (limit) rows = rows.slice(0, limit);
  return { rows: JSON.parse(JSON.stringify(rows)), truncated };
}

module.exports = { fakeReportRows, FAKE_REPORTS: Object.keys(FAKES) };
