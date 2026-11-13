---
name: od-production
description: Use when the user asks for production, collections or practice performance from Open Dental — "what did we produce yesterday", "month-to-date production by provider", "collections this week", "hygiene production", "compare this month to last month", "how many new patients in September", "scheduled production for tomorrow". Covers gross and net production, adjustments, write-offs, collections, scheduled production, and new-patient counts.
---

# Open Dental production & collections

## Method

1. Turn the user's period into explicit `yyyy-MM-dd` start and end dates (inclusive). State the dates you used in the answer.
2. Run built-in reports with `od_run_report` (call `od_list_reports` once to see parameters):
   - `production_by_provider`, `production_by_day`, `production_by_code`, `procedure_counts` (specific codes)
   - `adjustments_by_provider`, `writeoffs_by_provider` (`basis`: procedure | payment)
   - `patient_payments_by_provider`, `insurance_payments_by_provider`
   - `scheduled_production`, `new_patients`
3. Fall back to `od_run_query` only when no report fits; `references/queries.md` has the schema conventions and status codes to follow.
4. Compute totals from the returned rows; don't estimate. Round money to cents.
5. Map ProvNum to names with `od_list_providers`.

## Definitions (Open Dental conventions)

- **Gross production** = completed procedures (`ProcStatus = 2`) dated in the period, `ProcFee * (UnitQty + BaseUnits)`.
- **Adjustments** = `adjustment.AdjAmt` by `AdjDate` (negative = discounts).
- **Write-offs** = `claimproc.WriteOff` on received/supplemental claim procs. Open Dental can date write-offs by procedure date or by payment date (Report Setup); default to procedure date and say so.
- **Net production** = gross + adjustments − write-offs.
- **Collections** = patient payments (`paysplit.SplitAmt` by `DatePay`) + insurance payments (`claimproc.InsPayAmt` by `DateCP`, status received/supplemental).
- **Scheduled production** = fees on procedures attached to scheduled appointments in the period.

## Output

- Lead with the headline numbers for the period, then a table by provider (and by clinic if they use clinics).
- For comparisons, show both periods and the change in $ and %.
- If a number is likely to differ from the built-in Daily P&I or Production & Income report (write-off dating, provider attribution of payments), say so in one line and suggest tying out once against that report.
