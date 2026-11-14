---
name: od-clinical
description: Use when the user wants to read or write clinical chart notes or treatment plans in Open Dental — "write today's note for Jane Smith", "add the group note for this visit", "what did we do last visit", "add an addendum", "treatment plan a crown on 30", "plan MOD composite on 3 and 14", "put the implant workup in phase 2", "what's treatment planned", "check her meds and allergies". Covers progress notes, group notes, addenda, treatment-planned procedures and treatment-plan groupings.
---

# Open Dental chart notes and treatment planning

## Ground rules (always)

- **The dentist decides; Claude records.** Never diagnose, never choose or suggest treatment unless the dentist explicitly asks for options, and never add findings, materials, anesthetic amounts, or tooth numbers the user didn't give. If something needed is missing, ask.
- **Never sign.** Notes and plans are saved unsigned; the dentist signs in Open Dental. Say so after each note.
- **Confirm every change.** Before any CHART CHANGE tool, show the patient (name, birthdate), the exact procedures or codes with tooth/surface, and the exact note text, then wait for a clear yes. One yes covers one change.
- **Right patient.** Identify the patient with od-patient-lookup rules: never guess between similar names; confirm birthdate when there is any doubt.
- **Notes are permanent.** Open Dental keeps every version. Add to notes (addenda, corrections); never try to rewrite or remove them.
- If a change tool says chart changes are off, tell the user to turn on "Allow chart changes" in Claude's Settings > Extensions > Open Dental (and that Open Dental's API plan must include ProcedureLogs).

## Reading the chart

- **Progress notes:** `od_get_progress_notes` (newest first). Summarize by visit date: procedures, teeth, provider, note, signed or not.
- **Procedures:** `od_get_procedures` with `status` (TP, C, EC, EO, R, Cn) and/or `date`.
- **Notes on a procedure:** `od_get_procedure_notes`.
- **Medical:** `od_get_medical_summary` (premedication, allergies, medications, problems, medical urgent note). Check it before planning surgery, extractions, implants or anything with anesthesia, and point out anything relevant (e.g. premedication required, anticoagulants, bisphosphonates) as information for the dentist, not advice.
- **Treatment plans:** `od_get_treatment_plans` (Active/Inactive plans list attached procedures; Saved plans are presented copies).

## Writing the visit note (the office uses group notes)

1. Find the visit's completed procedures: `od_get_procedures` with `status: "C"` and `date` = the visit date (default today). Show them (code, description, tooth/surface).
2. Draft the note from what the user dictated. Keep the user's words and clinical shorthand; organize into a clean note (for example: reason for visit / medical history reviewed / anesthetic / procedure / materials / patient tolerance / next visit). Don't invent details. Mark anything unclear with [?] and ask.
3. Show the procedures and the final note text; get a yes.
4. Call `od_add_group_note` with all of the visit's completed ProcNums (or the subset the user chooses).
5. Report: note added to N procedures, unsigned, dentist to sign in Open Dental.

If procedures aren't marked complete yet, say so; the group note covers completed procedures only (complete them in Open Dental first).

**Addenda and corrections:** `od_append_procedure_note` on the procedure or the group note's ProcNum (find it in progress notes). Start the text with "Addendum:" or "Correction:" and the date. Appending removes the signature on that note until it is signed again; mention this.

## Treatment planning

1. Confirm the patient, then check `od_get_medical_summary` and the existing plan (`od_get_treatment_plans`, `od_get_procedures` status TP) to avoid duplicates.
2. Turn what the dentist said into codes with `od_lookup_procedure_code` (by code or words). Use the office's codes; check `TreatArea`:
   - Tooth → needs `tooth`; Surf → needs `tooth` and `surfaces`; ToothRange → needs `tooth_range` (bridges, partials); Quad/Arch/Sextant/Mouth → no tooth.
   - Universal numbering: permanent 1-32, primary A-T.
   - Bridges: plan each unit (abutments and pontics) on its own tooth with the matching codes.
3. Get priority names with `od_list_treatment_priorities` if the user mentions priority or phases.
4. Show a table: tooth, surfaces, code, description, priority, plan. Get a yes.
5. Create each with `od_plan_procedure`. Open Dental fills in the fee from the patient's fee schedule and insurance; report the fees it returns, not your own estimates.
6. **Grouping into plans:** `od_create_treatment_plan` for a named group (e.g. "Phase 1 - Urgent", "Option A - Implant", "Option B - Bridge"), then `od_add_to_treatment_plan` or pass `treat_plan_num` when planning. Plans start Inactive; the office activates and presents them in Open Dental.
7. Changes: `od_update_planned_procedure` (planned only), `od_remove_planned_procedure` (planned only, confirm first), `od_update_treatment_plan` for names and notes.

Do not mark procedures complete, schedule them, or estimate insurance here; those happen in Open Dental (or with od-schedule for appointments).
