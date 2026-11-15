"use strict";
/**
 * Named, parameterized report queries over the Open Dental database.
 *
 * Both the Claude connector (od_run_report) and the app gateway
 * (POST /v1/reports/:name) use this catalog, so apps can pull reports without
 * ever being allowed to send their own SQL.
 *
 * Parameters are validated by type before being placed in the SQL; nothing a
 * caller sends is pasted in unchecked.
 *
 * Status codes (Open Dental schema):
 *   procedurelog.ProcStatus  1 TP, 2 Complete, 6 Deleted ...
 *   claimproc.Status         1 Received, 4 Supplemental, 7 CapComplete ...
 *   appointment.AptStatus    1 Scheduled, 2 Complete, 3 UnschedList, 5 Broken
 *   claim.ClaimStatus        U unsent, H hold, W waiting, S sent, R received
 */

const { ODError, validDate } = require("./odclient");

// ------------------------------------------------------------------ param types

const TYPES = {
  date: {
    describe: "yyyy-MM-dd",
    parse(v) {
      if (typeof v !== "string" || !validDate(v)) throw new Error("must be a date in yyyy-MM-dd form");
      return `'${v}'`;
    },
  },
  id: {
    describe: "positive whole number",
    parse(v) {
      const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
      if (!Number.isSafeInteger(n) || n <= 0) throw new Error("must be a positive whole number");
      return String(n);
    },
  },
  int: {
    describe: "whole number",
    parse(v) {
      const n = typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : v;
      if (!Number.isSafeInteger(n)) throw new Error("must be a whole number");
      return String(n);
    },
  },
  money: {
    describe: "number",
    parse(v) {
      const n = typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
      if (typeof n !== "number" || !Number.isFinite(n)) throw new Error("must be a number");
      return String(n);
    },
  },
  codes: {
    describe: "list of procedure codes, e.g. [\"D2740\",\"D2950\"]",
    parse(v) {
      const list = Array.isArray(v) ? v : String(v).split(",");
      const clean = list.map((c) => String(c).trim()).filter(Boolean);
      if (!clean.length || clean.length > 200) throw new Error("must list 1-200 codes");
      for (const c of clean) if (!/^[A-Za-z0-9.\-]{1,15}$/.test(c)) throw new Error(`"${c}" is not a procedure code`);
      return clean.map((c) => `'${c}'`).join(",");
    },
  },
  ids: {
    describe: "list of positive whole numbers",
    parse(v) {
      const list = Array.isArray(v) ? v : String(v).split(",");
      if (!list.length || list.length > 500) throw new Error("must list 1-500 numbers");
      return list.map((x) => TYPES.id.parse(typeof x === "string" ? x.trim() : x)).join(",");
    },
  },
};

const enumType = (...values) => ({
  describe: values.join(" | "),
  values,
  parse(v) {
    if (!values.includes(v)) throw new Error(`must be one of ${values.join(", ")}`);
    return v;
  },
});

// Helpers to keep filters optional.
const and = (cond) => (cond ? ` AND ${cond}` : "");
const PROD = "pl.ProcFee * (pl.UnitQty + pl.BaseUnits)";

// ------------------------------------------------------------------ catalog

const REPORTS = {
  production_by_provider: {
    category: "production",
    description: "Gross production (completed procedures) per provider for a date range.",
    params: { from: { type: "date", required: true }, to: { type: "date", required: true }, clinic: { type: "id" } },
    sql: (p) => `SELECT pl.ProvNum, ROUND(SUM(${PROD}), 2) AS GrossProduction, COUNT(*) AS ProcCount
FROM procedurelog pl
WHERE pl.ProcStatus = 2 AND pl.ProcDate BETWEEN ${p.from} AND ${p.to}${and(p.clinic && `pl.ClinicNum = ${p.clinic}`)}
GROUP BY pl.ProvNum ORDER BY GrossProduction DESC`,
  },

  production_by_day: {
    category: "production",
    description: "Gross production per day for a date range (optionally one provider).",
    params: { from: { type: "date", required: true }, to: { type: "date", required: true }, provider: { type: "id" }, clinic: { type: "id" } },
    sql: (p) => `SELECT pl.ProcDate, ROUND(SUM(${PROD}), 2) AS GrossProduction, COUNT(*) AS ProcCount
FROM procedurelog pl
WHERE pl.ProcStatus = 2 AND pl.ProcDate BETWEEN ${p.from} AND ${p.to}${and(p.provider && `pl.ProvNum = ${p.provider}`)}${and(p.clinic && `pl.ClinicNum = ${p.clinic}`)}
GROUP BY pl.ProcDate ORDER BY pl.ProcDate`,
  },

  production_by_code: {
    category: "production",
    description: "What drove production: completed procedures by code, highest first.",
    params: { from: { type: "date", required: true }, to: { type: "date", required: true }, limit: { type: "int", default: 25 } },
    sql: (p) => `SELECT pc.ProcCode, pc.Descript, COUNT(*) AS Qty, ROUND(SUM(${PROD}), 2) AS Production
FROM procedurelog pl JOIN procedurecode pc ON pc.CodeNum = pl.CodeNum
WHERE pl.ProcStatus = 2 AND pl.ProcDate BETWEEN ${p.from} AND ${p.to}
GROUP BY pc.ProcCode, pc.Descript ORDER BY Production DESC LIMIT ${Math.min(Math.max(Number(p.limit), 1), 500)}`,
  },

  procedure_counts: {
    category: "production",
    description:
      "Count of completed procedures for specific codes in a date range, by day. Useful for supply usage (e.g. crowns milled per week).",
    params: { from: { type: "date", required: true }, to: { type: "date", required: true }, codes: { type: "codes", required: true } },
    sql: (p) => `SELECT pl.ProcDate, pc.ProcCode, pc.Descript, COUNT(*) AS Qty
FROM procedurelog pl JOIN procedurecode pc ON pc.CodeNum = pl.CodeNum
WHERE pl.ProcStatus = 2 AND pl.ProcDate BETWEEN ${p.from} AND ${p.to} AND pc.ProcCode IN (${p.codes})
GROUP BY pl.ProcDate, pc.ProcCode, pc.Descript ORDER BY pl.ProcDate, pc.ProcCode`,
  },

  adjustments_by_provider: {
    category: "production",
    description: "Adjustments (discounts are negative) per provider for a date range.",
    params: { from: { type: "date", required: true }, to: { type: "date", required: true } },
    sql: (p) => `SELECT a.ProvNum, ROUND(SUM(a.AdjAmt), 2) AS Adjustments, COUNT(*) AS AdjCount
FROM adjustment a WHERE a.AdjDate BETWEEN ${p.from} AND ${p.to} GROUP BY a.ProvNum`,
  },

  writeoffs_by_provider: {
    category: "production",
    description: "Insurance write-offs per provider. basis=procedure dates by procedure date (default), payment by payment date.",
    params: {
      from: { type: "date", required: true },
      to: { type: "date", required: true },
      basis: { type: enumType("procedure", "payment"), default: "procedure" },
    },
    sql: (p) => `SELECT cp.ProvNum, ROUND(SUM(cp.WriteOff), 2) AS WriteOffs
FROM claimproc cp
WHERE cp.Status IN (1, 4, 7) AND ${p.basis === "payment" ? "cp.DateCP" : "cp.ProcDate"} BETWEEN ${p.from} AND ${p.to}
GROUP BY cp.ProvNum`,
  },

  patient_payments_by_provider: {
    category: "collections",
    description: "Patient payments (pay splits) per provider by payment date.",
    params: { from: { type: "date", required: true }, to: { type: "date", required: true } },
    sql: (p) => `SELECT ps.ProvNum, ROUND(SUM(ps.SplitAmt), 2) AS PatientPayments, COUNT(*) AS SplitCount
FROM paysplit ps WHERE ps.DatePay BETWEEN ${p.from} AND ${p.to} GROUP BY ps.ProvNum`,
  },

  insurance_payments_by_provider: {
    category: "collections",
    description: "Insurance payments per provider by payment date.",
    params: { from: { type: "date", required: true }, to: { type: "date", required: true } },
    sql: (p) => `SELECT cp.ProvNum, ROUND(SUM(cp.InsPayAmt), 2) AS InsurancePayments
FROM claimproc cp WHERE cp.Status IN (1, 4, 7) AND cp.DateCP BETWEEN ${p.from} AND ${p.to} GROUP BY cp.ProvNum`,
  },

  scheduled_production: {
    category: "schedule",
    description: "Scheduled production per day and provider (procedures attached to scheduled appointments).",
    params: { from: { type: "date", required: true }, to: { type: "date", required: true } },
    sql: (p) => `SELECT DATE(ap.AptDateTime) AS AptDate, ap.ProvNum, COUNT(DISTINCT ap.AptNum) AS Appointments,
  ROUND(SUM(${PROD}), 2) AS ScheduledProduction
FROM appointment ap JOIN procedurelog pl ON pl.AptNum = ap.AptNum AND pl.ProcStatus IN (1, 2)
WHERE ap.AptStatus = 1 AND DATE(ap.AptDateTime) BETWEEN ${p.from} AND ${p.to}
GROUP BY DATE(ap.AptDateTime), ap.ProvNum ORDER BY AptDate, ap.ProvNum`,
  },

  new_patients: {
    category: "production",
    description: "Count of new patients (first visit) in a date range.",
    params: { from: { type: "date", required: true }, to: { type: "date", required: true } },
    sql: (p) => `SELECT COUNT(*) AS NewPatients FROM patient p
WHERE p.DateFirstVisit BETWEEN ${p.from} AND ${p.to} AND p.PatStatus IN (0, 2)`,
  },

  ar_aging: {
    category: "billing",
    description: "A/R aging by guarantor (largest balances first), or one family with guarantor=PatNum. Uses Open Dental's stored aging.",
    params: { guarantor: { type: "id" }, min_balance: { type: "money" }, limit: { type: "int", default: 200 } },
    sql: (p) => `SELECT p.PatNum, p.LName, p.FName, p.Bal_0_30, p.Bal_31_60, p.Bal_61_90, p.BalOver90,
  p.InsEst, p.BalTotal, ROUND(p.BalTotal - p.InsEst, 2) AS PatPortion
FROM patient p
WHERE p.Guarantor = p.PatNum AND p.BalTotal <> 0 AND p.PatStatus <> 4${and(p.guarantor && `p.PatNum = ${p.guarantor}`)}${and(p.min_balance && `p.BalTotal >= ${p.min_balance}`)}
ORDER BY p.BalTotal DESC LIMIT ${Math.min(Math.max(Number(p.limit), 1), 5000)}`,
  },

  ar_aging_totals: {
    category: "billing",
    description: "Office-wide A/R aging bucket totals.",
    params: {},
    sql: () => `SELECT ROUND(SUM(p.Bal_0_30), 2) AS Bal_0_30, ROUND(SUM(p.Bal_31_60), 2) AS Bal_31_60,
  ROUND(SUM(p.Bal_61_90), 2) AS Bal_61_90, ROUND(SUM(p.BalOver90), 2) AS BalOver90,
  ROUND(SUM(p.InsEst), 2) AS InsEst, ROUND(SUM(p.BalTotal), 2) AS BalTotal,
  ROUND(SUM(CASE WHEN p.BalTotal < 0 THEN p.BalTotal ELSE 0 END), 2) AS CreditBalances
FROM patient p WHERE p.Guarantor = p.PatNum AND p.PatStatus <> 4`,
  },

  outstanding_claims: {
    category: "billing",
    description: "Insurance claims sent but not received, oldest first. min_days filters by days since sent.",
    params: { min_days: { type: "int", default: 0 }, limit: { type: "int", default: 300 } },
    sql: (p) => `SELECT c.ClaimNum, c.PatNum, p.LName, p.FName, ca.CarrierName, c.DateService, c.DateSent,
  DATEDIFF(CURDATE(), c.DateSent) AS DaysOut, c.ClaimFee, c.InsPayEst, c.ClaimType
FROM claim c
JOIN patient p ON p.PatNum = c.PatNum
JOIN insplan ip ON ip.PlanNum = c.PlanNum
JOIN carrier ca ON ca.CarrierNum = ip.CarrierNum
WHERE c.ClaimStatus = 'S' AND c.ClaimType IN ('P', 'S') AND DATEDIFF(CURDATE(), c.DateSent) >= ${p.min_days}
ORDER BY DaysOut DESC LIMIT ${Math.min(Math.max(Number(p.limit), 1), 5000)}`,
  },

  unsent_claims: {
    category: "billing",
    description: "Claims unsent, waiting to send, or on hold.",
    params: {},
    sql: () => `SELECT c.ClaimNum, c.PatNum, p.LName, p.FName, ca.CarrierName, c.DateService, c.ClaimStatus, c.ClaimFee, c.ClaimType
FROM claim c
JOIN patient p ON p.PatNum = c.PatNum
JOIN insplan ip ON ip.PlanNum = c.PlanNum
JOIN carrier ca ON ca.CarrierNum = ip.CarrierNum
WHERE c.ClaimStatus IN ('U', 'W', 'H') ORDER BY c.DateService LIMIT 1000`,
  },

  recall_overdue: {
    category: "patients",
    description: "Active patients whose recall is past due and not scheduled.",
    params: { limit: { type: "int", default: 200 } },
    sql: (p) => `SELECT r.PatNum, p.LName, p.FName, rt.Description AS RecallType, r.DateDue,
  p.HmPhone, p.WirelessPhone, p.Email
FROM recall r
JOIN recalltype rt ON rt.RecallTypeNum = r.RecallTypeNum
JOIN patient p ON p.PatNum = r.PatNum
WHERE r.DateDue < CURDATE() AND r.DateDue > '0001-01-01' AND r.DateScheduled = '0001-01-01'
  AND r.IsDisabled = 0 AND p.PatStatus = 0
ORDER BY r.DateDue LIMIT ${Math.min(Math.max(Number(p.limit), 1), 5000)}`,
  },

  patient_recall: {
    category: "patients",
    description: "One patient's recall types and due dates.",
    params: { patient: { type: "id", required: true } },
    sql: (p) => `SELECT r.PatNum, rt.Description AS RecallType, r.DateDue, r.DateScheduled, r.IsDisabled
FROM recall r JOIN recalltype rt ON rt.RecallTypeNum = r.RecallTypeNum WHERE r.PatNum = ${p.patient}`,
  },

  patient_treatment_plan: {
    category: "patients",
    description: "One patient's treatment-planned procedures (AptNum 0 = not yet scheduled).",
    params: { patient: { type: "id", required: true } },
    sql: (p) => `SELECT pl.ProcNum, pc.ProcCode, pc.Descript, pl.ToothNum, pl.Surf,
  ROUND(${PROD}, 2) AS Fee, pl.ProvNum, pl.AptNum, pl.ProcDate
FROM procedurelog pl JOIN procedurecode pc ON pc.CodeNum = pl.CodeNum
WHERE pl.PatNum = ${p.patient} AND pl.ProcStatus = 1 ORDER BY pl.ProcDate`,
  },

  lab_cases_open: {
    category: "lab",
    description:
      "Open lab cases (not yet checked) with lab, patient, dates and the linked seat appointment. Status is not_sent, at_lab or received_not_checked; overdue = past due and not received; seat_risk = seat appointment within days_ahead days and case not received.",
    params: { lab: { type: "id" }, days_ahead: { type: "int", default: 7 }, limit: { type: "int", default: 500 } },
    sql: (p) => `SELECT lc.LabCaseNum, lc.PatNum, p.LName, p.FName, l.Description AS Lab, lc.ProvNum,
  lc.DateTimeCreated, lc.DateTimeSent, lc.DateTimeDue, lc.DateTimeRecd, lc.AptNum, a.AptDateTime AS SeatAppt, a.AptStatus,
  CASE WHEN lc.DateTimeSent < '1880-01-01' THEN 'not_sent'
       WHEN lc.DateTimeRecd < '1880-01-01' THEN 'at_lab'
       ELSE 'received_not_checked' END AS Status,
  (lc.DateTimeRecd < '1880-01-01' AND lc.DateTimeDue > '1880-01-01' AND lc.DateTimeDue < NOW()) AS Overdue,
  (lc.DateTimeRecd < '1880-01-01' AND a.AptStatus = 1 AND a.AptDateTime < DATE_ADD(NOW(), INTERVAL ${Math.min(Math.max(Number(p.days_ahead), 0), 365)} DAY)) AS SeatRisk,
  lc.Instructions
FROM labcase lc
JOIN patient p ON p.PatNum = lc.PatNum
LEFT JOIN laboratory l ON l.LaboratoryNum = lc.LaboratoryNum
LEFT JOIN appointment a ON a.AptNum = lc.AptNum
WHERE lc.DateTimeChecked < '1880-01-01'${and(p.lab && `lc.LaboratoryNum = ${p.lab}`)}
ORDER BY (lc.DateTimeDue < '1880-01-01'), lc.DateTimeDue LIMIT ${Math.min(Math.max(Number(p.limit), 1), 5000)}`,
  },

  lab_turnaround: {
    category: "lab",
    description: "Actual lab turnaround per lab (days from sent to received) for cases sent in a date range.",
    params: { from: { type: "date", required: true }, to: { type: "date", required: true } },
    sql: (p) => `SELECT l.Description AS Lab, COUNT(*) AS Cases,
  ROUND(AVG(DATEDIFF(lc.DateTimeRecd, lc.DateTimeSent)), 1) AS AvgDays,
  MAX(DATEDIFF(lc.DateTimeRecd, lc.DateTimeSent)) AS MaxDays,
  SUM(lc.DateTimeDue > '1880-01-01' AND lc.DateTimeRecd > lc.DateTimeDue) AS ReturnedLate
FROM labcase lc JOIN laboratory l ON l.LaboratoryNum = lc.LaboratoryNum
WHERE lc.DateTimeSent > '1880-01-01' AND lc.DateTimeRecd > '1880-01-01'
  AND DATE(lc.DateTimeSent) BETWEEN ${p.from} AND ${p.to}
GROUP BY l.Description ORDER BY AvgDays DESC`,
  },

  lab_cases_unreceived_completed: {
    category: "lab",
    description:
      "Cleanup list: lab cases never marked received although their linked appointment is Complete. Optional cutoff skips appointments on or after that date. Use count_only for the total.",
    params: { before: { type: "date" }, count_only: { type: enumType("true", "false"), default: "false" }, limit: { type: "int", default: 1000 } },
    sql: (p) =>
      p.count_only === "true"
        ? `SELECT COUNT(*) AS Cases, SUM(lc.DateTimeSent < '1880-01-01') AS NeverSent,
  MIN(DATE(a.AptDateTime)) AS EarliestAppt, MAX(DATE(a.AptDateTime)) AS LatestAppt
FROM labcase lc JOIN appointment a ON a.AptNum = lc.AptNum
WHERE lc.DateTimeRecd < '1880-01-01' AND a.AptStatus = 2${and(p.before && `a.AptDateTime < ${p.before}`)}`
        : `SELECT lc.LabCaseNum, lc.PatNum, DATE(a.AptDateTime) AS ApptDate, lc.AptNum,
  (lc.DateTimeSent < '1880-01-01') AS NeverSent, l.Description AS Lab
FROM labcase lc JOIN appointment a ON a.AptNum = lc.AptNum
LEFT JOIN laboratory l ON l.LaboratoryNum = lc.LaboratoryNum
WHERE lc.DateTimeRecd < '1880-01-01' AND a.AptStatus = 2${and(p.before && `a.AptDateTime < ${p.before}`)}
ORDER BY a.AptDateTime, lc.LabCaseNum LIMIT ${Math.min(Math.max(Number(p.limit), 1), 5000)}`,
  },

  lab_cases_received_on_appointment_date: {
    category: "lab",
    description:
      "Lab cases whose received date equals their linked Complete appointment's date and time (e.g. cases marked received by the cleanup tool). Optional cutoff keeps appointments before that date. Use count_only for the total.",
    params: { before: { type: "date" }, count_only: { type: enumType("true", "false"), default: "false" }, limit: { type: "int", default: 1000 } },
    sql: (p) =>
      p.count_only === "true"
        ? `SELECT COUNT(*) AS Cases, MIN(DATE(a.AptDateTime)) AS EarliestAppt, MAX(DATE(a.AptDateTime)) AS LatestAppt
FROM labcase lc JOIN appointment a ON a.AptNum = lc.AptNum
WHERE lc.DateTimeRecd = a.AptDateTime AND a.AptStatus = 2${and(p.before && `a.AptDateTime < ${p.before}`)}`
        : `SELECT lc.LabCaseNum, lc.PatNum, lc.AptNum, a.AptDateTime AS ApptDateTime, lc.DateTimeRecd, l.Description AS Lab
FROM labcase lc JOIN appointment a ON a.AptNum = lc.AptNum
LEFT JOIN laboratory l ON l.LaboratoryNum = lc.LaboratoryNum
WHERE lc.DateTimeRecd = a.AptDateTime AND a.AptStatus = 2${and(p.before && `a.AptDateTime < ${p.before}`)}
ORDER BY a.AptDateTime, lc.LabCaseNum LIMIT ${Math.min(Math.max(Number(p.limit), 1), 5000)}`,
  },

  lab_cases_for_sync: {
    category: "lab",
    description:
      "Lab cases for the lab-tracker sync: created on or after 'since', still open or checked within the last keep_days days. Returns the patient's first initial, last name and PatNum (the PatNum goes to the tracker only when sendPatNum is on), never DOB or chart number.",
    params: { since: { type: "date", required: true }, keep_days: { type: "int", default: 30 }, limit: { type: "int", default: 2000 } },
    sql: (p) => `SELECT lc.LabCaseNum, lc.PatNum, LEFT(TRIM(p.FName), 1) AS FirstInitial, TRIM(p.LName) AS LastName,
  lc.LaboratoryNum, l.Description AS Lab, pr.Abbr AS Provider,
  lc.DateTimeCreated, lc.DateTimeSent, lc.DateTimeDue, lc.DateTimeRecd, lc.DateTimeChecked,
  lc.AptNum, a.AptDateTime AS SeatAppt, a.AptStatus AS SeatStatus
FROM labcase lc
JOIN patient p ON p.PatNum = lc.PatNum
LEFT JOIN laboratory l ON l.LaboratoryNum = lc.LaboratoryNum
LEFT JOIN provider pr ON pr.ProvNum = lc.ProvNum
LEFT JOIN appointment a ON a.AptNum = lc.AptNum
WHERE lc.DateTimeCreated >= ${p.since}
  AND (lc.DateTimeChecked < '1880-01-01' OR lc.DateTimeChecked >= DATE_SUB(CURDATE(), INTERVAL ${Math.min(Math.max(Number(p.keep_days), 0), 365)} DAY))
ORDER BY lc.DateTimeCreated, lc.LabCaseNum LIMIT ${Math.min(Math.max(Number(p.limit), 1), 5000)}`,
  },

  operatories: {
    category: "schedule",
    description: "Operatories (chairs) with assigned providers.",
    params: {},
    sql: () => `SELECT OperatoryNum, OpName, Abbrev, ProvDentist, ProvHygienist, IsHygiene, ClinicNum, IsHidden
FROM operatory ORDER BY ItemOrder`,
  },
};

/** Validate params and return the SQL for a named report. */
function buildReport(name, input = {}) {
  const def = Object.prototype.hasOwnProperty.call(REPORTS, name) ? REPORTS[name] : null;
  if (!def) throw new ODError(`Unknown report "${name}". Available: ${Object.keys(REPORTS).join(", ")}`, { code: "not_found" });
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ODError("Report parameters must be an object.", { code: "bad_input" });
  }
  for (const k of Object.keys(input)) {
    if (!def.params[k]) throw new ODError(`Report "${name}" has no parameter "${k}".`, { code: "bad_input" });
  }
  const values = {};
  for (const [k, spec] of Object.entries(def.params)) {
    let v = input[k];
    if (v === undefined || v === null || v === "") v = spec.default;
    if (v === undefined) {
      if (spec.required) throw new ODError(`Report "${name}" needs "${k}" (${typeOf(spec).describe}).`, { code: "bad_input" });
      continue;
    }
    try {
      values[k] = typeOf(spec).parse(v);
    } catch (e) {
      throw new ODError(`Report "${name}" parameter "${k}" ${e.message}.`, { code: "bad_input" });
    }
  }
  if (values.from && values.to && values.from > values.to) {
    throw new ODError(`Report "${name}": "from" is after "to".`, { code: "bad_input" });
  }
  return def.sql(values);
}

function typeOf(spec) {
  return typeof spec.type === "string" ? TYPES[spec.type] : spec.type;
}

/** Catalog description for listing (no SQL). */
function describeReports() {
  return Object.entries(REPORTS).map(([name, def]) => ({
    name,
    category: def.category,
    description: def.description,
    params: Object.fromEntries(
      Object.entries(def.params).map(([k, s]) => [
        k,
        { type: typeOf(s).describe, required: !!s.required, ...(s.default !== undefined ? { default: s.default } : {}) },
      ])
    ),
  }));
}

module.exports = { REPORTS, buildReport, describeReports };
