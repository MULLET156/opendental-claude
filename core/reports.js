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
 *   appointment.AptStatus    1 Scheduled, 2 Complete, 3 UnschedList, 5 Broken, 6 Planned
 *   benefit.BenefitType      5 Limitations (annual max, frequency limits)
 *   benefit.QuantityQualifier 1 NumberOfServices, 4 Years, 5 Months
 *   benefit.TimePeriod       1 ServiceYear, 2 CalendarYear, 3 Lifetime, 5 NumberInLast12Months
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

const cap = (n, max = 5000) => Math.min(Math.max(Number(n), 1), max);
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const truthy = (v) => v === true || v === 1 || v === "1" || v === "true";

/** "2026-11-16", "2026-11-16 00:00:00", a Date, or Open Dental's "0001-01-01" -> "yyyy-MM-dd" or null. */
function dateOnly(v) {
  if (v === null || v === undefined || v === "") return null;
  const s = v instanceof Date ? v.toISOString() : String(v);
  const d = s.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && d > "1880-01-01" ? d : null;
}

const APT_STATUS = { 1: "Scheduled", 2: "Complete", 3: "UnschedList", 4: "ASAP", 5: "Broken", 6: "Planned", 7: "PtNote", 8: "PtNoteCompleted" };

/**
 * Hygiene codes (Ryan, 2026-11-16): left out of "planned but not scheduled" lists and
 * of no_future_appointment's planned total. Reports take hygiene_codes; the gateway
 * config's hygieneCodes sets one office-wide list for every report that uses it.
 */
const DEFAULT_HYGIENE_CODES = [
  "D0120", "D0140", "D0150", "D0210", "D0272", "D0274", // exams and x-rays
  "D1110", "D1120", "D1206", "D1208", // prophy and fluoride
  "D4341", "D4342", "D4346", "D4355", "D4910", // scaling and root planing, debridement, perio maintenance
];

/** X-ray categories for xray_history. */
const XRAY_CATEGORIES = {
  BWX: ["D0270", "D0272", "D0273", "D0274", "D0277"],
  FMX: ["D0210"],
  PANO: ["D0330"],
};

// Open Dental benefit enums (benefit.QuantityQualifier, benefit.TimePeriod).
const QTY = { NumberOfServices: 1, Years: 4, Months: 5 };
const PERIOD = { None: 0, ServiceYear: 1, CalendarYear: 2, Lifetime: 3, Years: 4, NumberInLast12Months: 5 };

function addMonths(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10);
}

/** Start of the benefit year containing `today`. monthRenew 0/1 = calendar year. */
function benefitYearStart(today, monthRenew, calendar) {
  const [y, m] = today.split("-").map(Number);
  const mr = calendar || !monthRenew || Number(monthRenew) <= 1 ? 1 : Number(monthRenew);
  const year = m >= mr ? y : y - 1;
  return `${year}-${String(mr).padStart(2, "0")}-01`;
}

/**
 * Turn one xray_history query row into the report row: last date, limit text,
 * next covered date and whether it's covered today (insurance frequency only).
 */
function xrayRow(r) {
  const today = dateOnly(r.AsOf) || new Date().toISOString().slice(0, 10);
  const dates = String(r.Dates || "").split(",").map(dateOnly).filter(Boolean).sort().reverse();
  const last = dates[0] || null;
  const yearAgo = addMonths(today, -12);
  const countLast12 = dates.filter((d) => d > yearAgo && d <= today).length;
  const out = {
    PatNum: r.PatNum,
    LName: r.LName,
    FName: r.FName,
    Category: r.Category,
    LastDate: last,
    CountLast12Months: countLast12,
    Carrier: r.Carrier || null,
    Limit: null,
    NextCovered: null,
    CoveredNow: null,
    AsOf: today,
  };
  if (!r.Carrier) {
    out.Limit = "No insurance on file";
    return out;
  }
  const f = String(r.Frequency || "").split("|").map(Number);
  if (f.length < 3 || f.some((x) => !Number.isFinite(x))) {
    out.Limit = "No frequency limit on file";
    return out;
  }
  const [qty, qual, period] = f;
  const n = Math.max(1, qty || 1);
  let next = today;
  if (qual === QTY.Months || qual === QTY.Years) {
    const months = qual === QTY.Months ? n : n * 12;
    out.Limit = qual === QTY.Months ? `1 per ${n} months` : `1 per ${n} year${n === 1 ? "" : "s"}`;
    if (last) next = addMonths(last, months);
  } else if (qual === QTY.NumberOfServices) {
    if (period === PERIOD.NumberInLast12Months) {
      out.Limit = `${n} per 12 months`;
      const recent = dates.filter((d) => d > yearAgo && d <= today);
      if (recent.length >= n) next = addMonths(recent[n - 1], 12);
    } else if (period === PERIOD.Lifetime) {
      out.Limit = `${n} per lifetime`;
      if (dates.length >= n) next = null;
    } else {
      const calendar = period === PERIOD.CalendarYear;
      out.Limit = `${n} per ${calendar ? "calendar" : "benefit"} year`;
      const start = benefitYearStart(today, r.MonthRenew, calendar);
      if (dates.filter((d) => d >= start && d <= today).length >= n) next = addMonths(start, 12);
    }
  } else {
    out.Limit = "No frequency limit on file";
    return out;
  }
  out.NextCovered = next;
  out.CoveredNow = next !== null && next <= today;
  return out;
}

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

  // ---------------------------------------------------------------- TDC Office reports
  // Each lists its output `columns`; `post` runs after the query (here and in the
  // demo gateway) to add values that are clearer in code than in SQL.

  unscheduled_treatment: {
    category: "treatment",
    description:
      "Treatment-planned procedures that are not on a scheduled (future) appointment, for active patients. Hygiene codes are left out unless include_hygiene=true; hygiene_codes sets that list. min_fee filters single procedures, min_total filters patients by their unscheduled total.",
    params: {
      provider: { type: "id" },
      codes: { type: "codes" },
      min_fee: { type: "money" },
      min_total: { type: "money" },
      hygiene_codes: { type: "codes", default: DEFAULT_HYGIENE_CODES },
      include_hygiene: { type: enumType("true", "false"), default: "false" },
      patients: { type: "ids" },
      limit: { type: "int", default: 2000 },
    },
    columns: ["PatNum", "LName", "FName", "ProcNum", "ProcCode", "Descript", "ToothNum", "Surf", "Fee", "DateTP", "Priority", "PatientTotal", "PatientOldestDateTP", "AsOf"],
    sql: (p) => `SELECT pl.PatNum, p.LName, p.FName, pl.ProcNum, pc.ProcCode, pc.Descript, pl.ToothNum, pl.Surf,
  ROUND(${PROD}, 2) AS Fee, pl.ProvNum, pr.Abbr AS Provider, pl.DateTP, IFNULL(d.ItemName, '') AS Priority, pl.AptNum, CURDATE() AS AsOf
FROM procedurelog pl
JOIN patient p ON p.PatNum = pl.PatNum
JOIN procedurecode pc ON pc.CodeNum = pl.CodeNum
LEFT JOIN provider pr ON pr.ProvNum = pl.ProvNum
LEFT JOIN definition d ON d.DefNum = pl.Priority
WHERE pl.ProcStatus = 1 AND p.PatStatus = 0
  AND NOT EXISTS (SELECT 1 FROM appointment a WHERE a.AptNum = pl.AptNum AND a.AptStatus = 1 AND a.AptDateTime >= CURDATE())${and(p.include_hygiene !== "true" && `pc.ProcCode NOT IN (${p.hygiene_codes})`)}${and(p.provider && `pl.ProvNum = ${p.provider}`)}${and(p.codes && `pc.ProcCode IN (${p.codes})`)}${and(p.min_fee && `${PROD} >= ${p.min_fee}`)}${and(p.patients && `pl.PatNum IN (${p.patients})`)}
ORDER BY p.LName, p.FName, pl.PatNum, pl.DateTP, pl.ProcNum LIMIT ${cap(p.limit)}`,
    post(rows, p) {
      const totals = new Map();
      const oldest = new Map();
      for (const r of rows) {
        totals.set(r.PatNum, round2((totals.get(r.PatNum) || 0) + Number(r.Fee || 0)));
        const d = dateOnly(r.DateTP);
        if (d && (!oldest.has(r.PatNum) || d < oldest.get(r.PatNum))) oldest.set(r.PatNum, d);
      }
      return rows
        .map((r) => ({ ...r, Fee: Number(r.Fee), DateTP: dateOnly(r.DateTP), AsOf: dateOnly(r.AsOf), PatientTotal: totals.get(r.PatNum), PatientOldestDateTP: oldest.get(r.PatNum) || null }))
        .filter((r) => p.min_total === undefined || r.PatientTotal >= p.min_total);
    },
  },

  no_future_appointment: {
    category: "patients",
    description:
      "Active patients with no scheduled appointment from today on, with their last completed visit and planned treatment total (hygiene codes left out of the total). Patients never seen are left out unless include_never_seen=true.",
    params: {
      hygiene_codes: { type: "codes", default: DEFAULT_HYGIENE_CODES },
      last_visit_after: { type: "date" },
      last_visit_before: { type: "date" },
      provider: { type: "id" },
      include_never_seen: { type: enumType("true", "false"), default: "false" },
      limit: { type: "int", default: 2000 },
    },
    columns: ["PatNum", "LName", "FName", "LastVisit", "PlannedTotal", "AsOf"],
    sql: (p) => `SELECT p.PatNum, p.LName, p.FName, p.PriProv, pr.Abbr AS Provider,
  (SELECT DATE(MAX(a.AptDateTime)) FROM appointment a WHERE a.PatNum = p.PatNum AND a.AptStatus = 2) AS LastVisit,
  (SELECT ROUND(IFNULL(SUM(${PROD}), 0), 2) FROM procedurelog pl JOIN procedurecode pc ON pc.CodeNum = pl.CodeNum
    WHERE pl.PatNum = p.PatNum AND pl.ProcStatus = 1 AND pc.ProcCode NOT IN (${p.hygiene_codes})) AS PlannedTotal,
  CURDATE() AS AsOf
FROM patient p
LEFT JOIN provider pr ON pr.ProvNum = p.PriProv
WHERE p.PatStatus = 0
  AND NOT EXISTS (SELECT 1 FROM appointment a WHERE a.PatNum = p.PatNum AND a.AptStatus = 1 AND a.AptDateTime >= CURDATE())${and(p.provider && `p.PriProv = ${p.provider}`)}
HAVING ${p.include_never_seen === "true" ? "1 = 1" : "LastVisit IS NOT NULL"}${and(p.last_visit_after && `LastVisit >= ${p.last_visit_after}`)}${and(p.last_visit_before && `LastVisit < ${p.last_visit_before}`)}
ORDER BY LastVisit DESC, p.PatNum LIMIT ${cap(p.limit)}`,
    post: (rows) => rows.map((r) => ({ ...r, LastVisit: dateOnly(r.LastVisit), PlannedTotal: Number(r.PlannedTotal || 0), AsOf: dateOnly(r.AsOf) })),
  },

  xray_history: {
    category: "patients",
    description:
      "Last bitewing (BWX), full-mouth (FMX), and panoramic (PANO) x-ray dates per patient (what the Daysheet shows), with the primary plan's frequency limit and the date it's next covered. Give patients (PatNums) or date (everyone on that day's schedule). Insurance limits come from the plan's benefit table; it is not a live eligibility check.",
    params: { patients: { type: "ids" }, date: { type: "date" }, limit: { type: "int", default: 2000 } },
    columns: ["PatNum", "LName", "FName", "Category", "LastDate", "Limit", "NextCovered", "CoveredNow", "AsOf"],
    check(p) {
      if (!p.patients && !p.date) throw new Error('needs "patients" or "date"');
    },
    sql: (p) => {
      const who = p.patients
        ? `(SELECT p0.PatNum FROM patient p0 WHERE p0.PatNum IN (${p.patients}))`
        : `(SELECT DISTINCT a0.PatNum FROM appointment a0 WHERE a0.AptDateTime >= ${p.date} AND a0.AptDateTime < DATE_ADD(${p.date}, INTERVAL 1 DAY) AND a0.AptStatus IN (1, 2))`;
      const blocks = Object.entries(XRAY_CATEGORIES).map(([cat, codes]) => {
        const list = codes.map((c) => `'${c}'`).join(",");
        const inGroup = codes.map((c) => `LOCATE('${c}', cg.ProcCodes) > 0`).join(" OR ");
        return `SELECT ps.PatNum, p.LName, p.FName, '${cat}' AS Category,
  (SELECT GROUP_CONCAT(DISTINCT DATE(pl.ProcDate) ORDER BY pl.ProcDate DESC SEPARATOR ',') FROM procedurelog pl JOIN procedurecode pc ON pc.CodeNum = pl.CodeNum
    WHERE pl.PatNum = ps.PatNum AND pl.ProcStatus IN (2, 3, 4) AND pc.ProcCode IN (${list}) AND pl.ProcDate >= DATE_SUB(CURDATE(), INTERVAL 10 YEAR)) AS Dates,
  ca.CarrierName AS Carrier, ip.MonthRenew,
  (SELECT CONCAT_WS('|', b.Quantity, b.QuantityQualifier, b.TimePeriod) FROM benefit b
    WHERE b.BenefitType = 5 AND (b.PlanNum = ip.PlanNum OR b.PatPlanNum = pp.PatPlanNum) AND b.QuantityQualifier IN (1, 4, 5)
      AND (b.CodeNum IN (SELECT pc2.CodeNum FROM procedurecode pc2 WHERE pc2.ProcCode IN (${list}))
        OR b.CodeGroupNum IN (SELECT cg.CodeGroupNum FROM codegroup cg WHERE ${inGroup}))
    ORDER BY b.PatPlanNum DESC, b.BenefitNum LIMIT 1) AS Frequency,
  CURDATE() AS AsOf
FROM ${who} ps
JOIN patient p ON p.PatNum = ps.PatNum
LEFT JOIN patplan pp ON pp.PatNum = ps.PatNum AND pp.Ordinal = 1
LEFT JOIN inssub isub ON isub.InsSubNum = pp.InsSubNum
LEFT JOIN insplan ip ON ip.PlanNum = isub.PlanNum
LEFT JOIN carrier ca ON ca.CarrierNum = ip.CarrierNum`;
      });
      return `SELECT * FROM (\n${blocks.join("\nUNION ALL\n")}\n) x ORDER BY x.LName, x.FName, x.PatNum, FIELD(x.Category, ${Object.keys(XRAY_CATEGORIES).map((c) => `'${c}'`).join(", ")}) LIMIT ${cap(p.limit)}`;
    },
    post: (rows) => rows.map(xrayRow),
  },

  insurance_remaining: {
    category: "patients",
    description:
      "ESTIMATE of each patient's primary dental plan for the current benefit year: annual maximum, insurance used so far (paid plus pending estimates) and remaining. Based on what's recorded in Open Dental, not a live check with the insurer.",
    params: { patients: { type: "ids" }, carrier: { type: "id" }, min_remaining: { type: "money" }, limit: { type: "int", default: 2000 } },
    columns: ["PatNum", "LName", "FName", "Carrier", "Remaining", "IsEstimate", "AsOf"],
    sql: (p) => `SELECT t.PatNum, t.LName, t.FName, t.Carrier, t.GroupName, t.BenefitYearStart, t.AnnualMax,
  (SELECT ROUND(IFNULL(SUM(CASE WHEN cp.Status = 0 THEN cp.InsPayEst ELSE cp.InsPayAmt END), 0), 2) FROM claimproc cp
    WHERE cp.PatNum = t.PatNum AND cp.InsSubNum = t.InsSubNum AND cp.Status IN (0, 1, 3, 4, 9)
      AND cp.ProcDate >= t.BenefitYearStart AND cp.ProcDate < DATE_ADD(t.BenefitYearStart, INTERVAL 1 YEAR)) AS Used,
  t.AsOf
FROM (SELECT pp.PatNum, p.LName, p.FName, pp.InsSubNum, ca.CarrierName AS Carrier, ip.GroupName,
    CASE WHEN ip.MonthRenew IN (0, 1) THEN MAKEDATE(YEAR(CURDATE()), 1)
         WHEN ip.MonthRenew <= MONTH(CURDATE()) THEN STR_TO_DATE(CONCAT(YEAR(CURDATE()), '-', ip.MonthRenew, '-01'), '%Y-%m-%d')
         ELSE STR_TO_DATE(CONCAT(YEAR(CURDATE()) - 1, '-', ip.MonthRenew, '-01'), '%Y-%m-%d') END AS BenefitYearStart,
    (SELECT b.MonetaryAmt FROM benefit b
      WHERE b.BenefitType = 5 AND b.CovCatNum = 0 AND b.CodeNum = 0 AND b.MonetaryAmt > 0 AND b.QuantityQualifier = 0
        AND b.TimePeriod IN (1, 2) AND b.CoverageLevel <> 2 AND (b.PlanNum = ip.PlanNum OR b.PatPlanNum = pp.PatPlanNum)
      ORDER BY b.PatPlanNum DESC, b.BenefitNum LIMIT 1) AS AnnualMax,
    CURDATE() AS AsOf
  FROM patplan pp
  JOIN patient p ON p.PatNum = pp.PatNum
  JOIN inssub isub ON isub.InsSubNum = pp.InsSubNum
  JOIN insplan ip ON ip.PlanNum = isub.PlanNum
  JOIN carrier ca ON ca.CarrierNum = ip.CarrierNum
  WHERE pp.Ordinal = 1 AND p.PatStatus = 0${and(p.patients && `pp.PatNum IN (${p.patients})`)}${and(p.carrier && `ip.CarrierNum = ${p.carrier}`)}) t
ORDER BY t.LName, t.FName, t.PatNum LIMIT ${cap(p.limit)}`,
    post(rows, p) {
      return rows
        .map((r) => {
          const max = r.AnnualMax === null || r.AnnualMax === undefined || r.AnnualMax === "" ? null : Number(r.AnnualMax);
          const used = round2(Number(r.Used || 0));
          return {
            ...r,
            BenefitYearStart: dateOnly(r.BenefitYearStart),
            AnnualMax: max,
            Used: used,
            Remaining: max === null ? null : Math.max(0, round2(max - used)),
            IsEstimate: true,
            AsOf: dateOnly(r.AsOf),
          };
        })
        .filter((r) => p.min_remaining === undefined || (r.Remaining !== null && r.Remaining >= p.min_remaining));
    },
  },

  daysheet: {
    category: "schedule",
    description:
      "One day's appointments (scheduled and complete; broken too with include_broken=true) with patient, provider, hygienist, operatory, confirmation, length and procedures.",
    params: { date: { type: "date", required: true }, provider: { type: "id" }, op: { type: "id" }, include_broken: { type: enumType("true", "false"), default: "false" } },
    columns: ["AptNum", "AptDateTime", "Time", "Minutes", "Status", "PatNum", "LName", "FName", "Preferred", "Provider", "Hygienist", "OpName", "IsHygiene", "IsNewPatient", "Confirmed", "Procedures"],
    sql: (p) => `SELECT a.AptNum, a.AptDateTime, LENGTH(a.Pattern) * 5 AS Minutes, a.AptStatus, a.PatNum, p.LName, p.FName, p.Preferred,
  a.ProvNum, pr.Abbr AS Provider, a.ProvHyg, ph.Abbr AS Hygienist, a.Op AS OpNum, o.OpName, a.IsHygiene, a.IsNewPatient,
  IFNULL(dc.ItemName, '') AS Confirmed,
  (SELECT GROUP_CONCAT(CONCAT(pc.ProcCode, IF(pl.ToothNum <> '', CONCAT(' #', pl.ToothNum), ''), IF(pl.Surf <> '', CONCAT(' ', pl.Surf), '')) ORDER BY pl.ProcNum SEPARATOR ', ')
    FROM procedurelog pl JOIN procedurecode pc ON pc.CodeNum = pl.CodeNum WHERE pl.AptNum = a.AptNum AND pl.ProcStatus IN (1, 2)) AS Procedures,
  (SELECT ROUND(IFNULL(SUM(${PROD}), 0), 2) FROM procedurelog pl WHERE pl.AptNum = a.AptNum AND pl.ProcStatus IN (1, 2)) AS ScheduledFee
FROM appointment a
JOIN patient p ON p.PatNum = a.PatNum
LEFT JOIN provider pr ON pr.ProvNum = a.ProvNum
LEFT JOIN provider ph ON ph.ProvNum = a.ProvHyg
LEFT JOIN operatory o ON o.OperatoryNum = a.Op
LEFT JOIN definition dc ON dc.DefNum = a.Confirmed
WHERE a.AptDateTime >= ${p.date} AND a.AptDateTime < DATE_ADD(${p.date}, INTERVAL 1 DAY)
  AND a.AptStatus IN (${p.include_broken === "true" ? "1, 2, 5" : "1, 2"})${and(p.provider && `(a.ProvNum = ${p.provider} OR a.ProvHyg = ${p.provider})`)}${and(p.op && `a.Op = ${p.op}`)}
ORDER BY a.AptDateTime, o.ItemOrder, a.AptNum`,
    post: (rows) =>
      rows.map(({ AptStatus, ...r }) => ({
        ...r,
        AptDateTime: String(r.AptDateTime).replace("T", " ").slice(0, 19),
        Time: String(r.AptDateTime).replace("T", " ").slice(11, 16),
        Minutes: Number(r.Minutes || 0),
        Status: APT_STATUS[Number(AptStatus)] || String(AptStatus),
        IsHygiene: truthy(r.IsHygiene),
        IsNewPatient: truthy(r.IsNewPatient),
        Procedures: r.Procedures || "",
        ScheduledFee: Number(r.ScheduledFee || 0),
      })),
  },

  unsigned_notes: {
    category: "patients",
    description:
      "Completed procedures and group notes whose latest procedure note is not signed, in the last 'days' days (or from/to). count_only=true gives just the number.",
    params: {
      from: { type: "date" },
      to: { type: "date" },
      days: { type: "int", default: 90 },
      provider: { type: "id" },
      count_only: { type: enumType("true", "false"), default: "false" },
      limit: { type: "int", default: 500 },
    },
    columns: ["ProcNum", "PatNum", "LName", "FName", "ProcDate", "ProcCode", "Provider"],
    columnsFor: (p) => (p.count_only === "true" ? ["UnsignedNotes"] : null),
    sql: (p) => {
      const range = p.from
        ? `pl.ProcDate BETWEEN ${p.from} AND ${p.to || "CURDATE()"}`
        : `pl.ProcDate >= DATE_SUB(CURDATE(), INTERVAL ${Math.min(Math.max(Number(p.days), 1), 3650)} DAY)${p.to ? ` AND pl.ProcDate <= ${p.to}` : ""}`;
      const from = `FROM procedurelog pl
JOIN procnote pn ON pn.ProcNoteNum = (SELECT MAX(pn2.ProcNoteNum) FROM procnote pn2 WHERE pn2.ProcNum = pl.ProcNum)
JOIN patient p ON p.PatNum = pl.PatNum
JOIN procedurecode pc ON pc.CodeNum = pl.CodeNum
LEFT JOIN provider pr ON pr.ProvNum = pl.ProvNum
WHERE pl.ProcStatus IN (2, 3) AND pn.Signature = '' AND pn.Note <> '' AND ${range}${and(p.provider && `pl.ProvNum = ${p.provider}`)}`;
      return p.count_only === "true"
        ? `SELECT COUNT(*) AS UnsignedNotes ${from}`
        : `SELECT pl.ProcNum, pl.PatNum, p.LName, p.FName, pl.ProcDate, pc.ProcCode, pc.Descript, pl.ProvNum, pr.Abbr AS Provider, pn.EntryDateTime AS NoteEntered
${from}
ORDER BY pl.ProcDate, pl.ProcNum LIMIT ${cap(p.limit)}`;
    },
    post: (rows, p) =>
      p.count_only === "true"
        ? rows.map((r) => ({ UnsignedNotes: Number(r.UnsignedNotes || 0) }))
        : rows.map((r) => ({ ...r, ProcDate: dateOnly(r.ProcDate), NoteEntered: String(r.NoteEntered || "").replace("T", " ").slice(0, 19) })),
  },

  operatories: {
    category: "schedule",
    description: "Operatories (chairs) with assigned providers.",
    params: {},
    sql: () => `SELECT OperatoryNum, OpName, Abbrev, ProvDentist, ProvHygienist, IsHygiene, ClinicNum, IsHidden
FROM operatory ORDER BY ItemOrder`,
  },
};

function reportDef(name) {
  const def = typeof name === "string" && Object.prototype.hasOwnProperty.call(REPORTS, name) ? REPORTS[name] : null;
  if (!def) throw new ODError(`Unknown report "${name}". Available: ${Object.keys(REPORTS).join(", ")}`, { code: "not_found" });
  return def;
}

/**
 * Validate a report's parameters. Returns { def, values, raw }: `values` are SQL-safe
 * fragments for def.sql(); `raw` are the same values as plain data (numbers, dates,
 * lists) for def.post() and the demo gateway's fake engine. partial: only check the
 * parameters given (for config defaults).
 */
function parseReportParams(name, input = {}, { partial = false } = {}) {
  const def = reportDef(name);
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ODError("Report parameters must be an object.", { code: "bad_input" });
  }
  for (const k of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(def.params, k)) throw new ODError(`Report "${name}" has no parameter "${k}".`, { code: "bad_input" });
  }
  const values = {};
  const raw = {};
  for (const [k, spec] of Object.entries(def.params)) {
    let v = input[k];
    if (v === undefined || v === null || v === "") v = spec.default;
    if (v === undefined) {
      if (spec.required && !partial) throw new ODError(`Report "${name}" needs "${k}" (${typeOf(spec).describe}).`, { code: "bad_input" });
      continue;
    }
    try {
      values[k] = typeOf(spec).parse(v);
    } catch (e) {
      throw new ODError(`Report "${name}" parameter "${k}" ${e.message}.`, { code: "bad_input" });
    }
    raw[k] = rawValue(typeOf(spec), values[k]);
  }
  if (values.from && values.to && values.from > values.to) {
    throw new ODError(`Report "${name}": "from" is after "to".`, { code: "bad_input" });
  }
  if (def.check && !partial) {
    try {
      def.check(raw);
    } catch (e) {
      throw new ODError(`Report "${name}" ${e.message}.`, { code: "bad_input" });
    }
  }
  return { def, values, raw };
}

/** The plain value behind a parsed SQL fragment. */
function rawValue(type, sql) {
  if (type === TYPES.date) return sql.slice(1, -1);
  if (type === TYPES.id || type === TYPES.int || type === TYPES.money) return Number(sql);
  if (type === TYPES.codes) return sql.split(",").map((c) => c.slice(1, -1));
  if (type === TYPES.ids) return sql.split(",").map(Number);
  return sql;
}

/** Validate params and return the SQL for a named report. */
function buildReport(name, input = {}) {
  const { def, values } = parseReportParams(name, input);
  return def.sql(values);
}

/**
 * Run a named report on any client and return { rows, truncated }:
 *  - gateway client (TDC Office modules): POST /v1/reports/<name> on the gateway
 *  - demo client (fake data): the fake engine's rows, then the same post step
 *  - direct client: the SQL through Open Dental's ShortQuery, then the post step
 */
async function runReport(od, name, input = {}, { limit } = {}) {
  if (od && typeof od.runReport === "function") return od.runReport(name, input, { limit });
  const { def, values, raw } = parseReportParams(name, input);
  const result =
    od && typeof od.fakeReportRows === "function" ? await od.fakeReportRows(name, raw, { limit }) : await od.shortQuery(def.sql(values), { limit });
  let rows = def.post ? def.post(result.rows, raw) : result.rows;
  // Only the columns the pages use leave the gateway (issue #6: minimal data).
  const cols = (def.columnsFor && def.columnsFor(raw)) || def.columns;
  if (cols) rows = rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] === undefined ? null : r[c]])));
  return { rows, truncated: !!result.truncated };
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
    ...(def.columns ? { columns: def.columns } : {}),
    params: Object.fromEntries(
      Object.entries(def.params).map(([k, s]) => [
        k,
        { type: typeOf(s).describe, required: !!s.required, ...(s.default !== undefined ? { default: s.default } : {}) },
      ])
    ),
  }));
}

module.exports = {
  REPORTS,
  buildReport,
  parseReportParams,
  runReport,
  describeReports,
  DEFAULT_HYGIENE_CODES,
  XRAY_CATEGORIES,
  APT_STATUS,
  dateOnly,
  xrayRow,
  benefitYearStart,
  addMonths,
};
