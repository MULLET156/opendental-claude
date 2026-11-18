"use strict";
/**
 * What each TDC Office module may do through the gateway (CONTRACT.md §7: each
 * module has its own key with the narrowest allow list that works). Used by the
 * demo gateway, and by `node gateway/cli.js new-key <name> --preset <module>` for
 * the real one.
 *
 * Only Voice Charting writes, and only to the chart. Nothing here signs notes.
 */

const READ_PATIENT = ["/patients", "/patients/*"];

const PRESETS = {
  daysheet: {
    description: "Dental Daysheet: read today's schedule, x-rays, unscheduled treatment and lab cases.",
    allow: [{ methods: ["GET"], paths: [...READ_PATIENT, "/appointments", "/appointments/*", "/providers", "/operatories", "/definitions", "/procedurelogs", "/labcases", "/labcases/*", "/laboratories"] }],
    reports: ["daysheet", "xray_history", "unscheduled_treatment", "insurance_remaining", "lab_cases_open", "patient_treatment_plan", "operatories"],
  },
  finder: {
    description: "Treatment Finder: read-only patient filters and lists.",
    allow: [{ methods: ["GET"], paths: [...READ_PATIENT, "/appointments", "/providers", "/carriers", "/definitions"] }],
    reports: ["unscheduled_treatment", "no_future_appointment", "insurance_remaining", "xray_history", "recall_overdue", "patient_treatment_plan", "patient_recall"],
  },
  voice: {
    description: "Voice Charting: read the chart; plan procedures, set priorities and status, add notes and group notes (never signs).",
    allow: [
      {
        methods: ["GET"],
        paths: [...READ_PATIENT, "/procedurelogs", "/procedurelogs/*", "/procedurecodes", "/definitions", "/treatplans", "/treatplanattaches", "/procnotes", "/chartmodules/**", "/providers", "/toothinitials", "/appointments", "/appointments/*"],
      },
      { methods: ["POST"], paths: ["/procedurelogs", "/procedurelogs/GroupNote", "/procnotes", "/treatplans", "/treatplanattaches", "/toothinitials"] },
      { methods: ["PUT"], paths: ["/procedurelogs/*", "/treatplans/*", "/treatplanattaches/*"] },
      { methods: ["DELETE"], paths: ["/procedurelogs/*", "/toothinitials/*"] },
    ],
    reports: ["patient_treatment_plan", "unsigned_notes", "daysheet"],
    maxBodyBytes: 256 * 1024,
  },
  numbers: {
    description: "Practice Numbers: production, collections and A/R reports only.",
    allow: [{ methods: ["GET"], paths: ["/providers"] }],
    reports: [
      "production_by_provider",
      "production_by_day",
      "production_by_month",
      "production_by_code",
      "procedure_counts",
      "adjustments_by_provider",
      "writeoffs_by_provider",
      "patient_payments_by_provider",
      "insurance_payments_by_provider",
      "collections_by_month",
      "scheduled_production",
      "new_patients",
      "ar_aging",
      "ar_aging_totals",
      "outstanding_claims",
      "unsent_claims",
    ],
  },
};

/** Everything every module may do (local development only). */
PRESETS.dev = {
  description: "Local development only: everything the modules can do.",
  allow: Object.entries(PRESETS)
    .filter(([k]) => k !== "dev")
    .flatMap(([, p]) => p.allow),
  reports: ["*"],
};

/** Config entry for an app from a preset. */
function presetApp(name, preset, keyHash) {
  const p = PRESETS[preset];
  if (!p) throw new Error(`Unknown preset "${preset}". Use one of: ${Object.keys(PRESETS).join(", ")}`);
  return { name, keyHash, allow: p.allow, reports: p.reports, ...(p.maxBodyBytes ? { maxBodyBytes: p.maxBodyBytes } : {}) };
}

module.exports = { PRESETS, presetApp };
