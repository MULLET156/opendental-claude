---
name: od-billing
description: Use when the user asks about money owed in Open Dental — "what's our A/R", "aging report", "who owes over $500 past 90 days", "what does the Johnson family owe", "outstanding claims over 30 days", "which insurance claims haven't been paid", "unsent claims". Covers guarantor balances, A/R aging, and outstanding, unsent and aging insurance claims.
---

# Open Dental billing & A/R

Use the built-in reports through `od_run_report`: `ar_aging` (optional `guarantor`, `min_balance`, `limit`), `ar_aging_totals`, `outstanding_claims` (optional `min_days`), `unsent_claims`. Use `od_run_query` only for questions these don't cover, following the conventions in `../od-production/references/queries.md`.

## A/R aging

- Use `ar_aging` for accounts and `ar_aging_totals` for bucket totals. Balances live on the guarantor row (`patient.Guarantor = patient.PatNum`).
- Aging columns (`Bal_0_30`, `Bal_31_60`, `Bal_61_90`, `BalOver90`, `InsEst`, `BalTotal`) are refreshed by Open Dental's aging calculation. If numbers look stale, tell the user aging may need to be run (Tools > Misc Tools > Calculate Aging, or automatic nightly aging if set up).
- Present totals per bucket first, then the top accounts sorted by the bucket the user cares about. Patient portion ≈ `BalTotal - InsEst`.
- Credit balances (negative `BalTotal`) are worth calling out separately.

## Insurance claims

- **Outstanding** — claims sent but not received (`ClaimStatus = 'S'`), aged from `DateSent`. Group by carrier and 0–30 / 31–60 / 61–90 / 90+.
- **Unsent** — `ClaimStatus` in `'U'` (unsent) or `'W'` (waiting to send).
- **Hold** — `'H'`.
- Show carrier, patient, date of service, date sent, claim fee, and estimated insurance payment.

## One family

For "what does X owe": find the patient (od-patient-lookup), get their `Guarantor`, then run `ar_aging` with `guarantor` set to that PatNum.

## Accuracy

Query results are a live read, not Open Dental's built-in report. When totals matter (month-end, a meeting), suggest the user tie them out once against Reports > Standard > Aging of A/R or Outstanding Insurance Claims, and tell you about any difference so the query can be adjusted.
