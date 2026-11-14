---
name: od-lab
description: Use when the user asks about dental lab cases in Open Dental — "what's at the lab", "is Mrs. Lee's crown back", "any lab cases overdue", "anything due back before its seat appointment", "send a case to Smile Lab", "mark the case received", "case is checked and ready", "which lab is slowest", "clean up old lab cases that were never marked received". Covers labs and turnarounds, the open-case board, creating and updating lab cases, and bulk cleanup.
---

# Open Dental lab cases

## Reading

- **Labs and turnarounds:** `od_list_labs` (LaboratoryNum, contact, services with published vs actual days).
- **One patient / appointment:** `od_get_lab_cases` with `pat_num` or `apt_num`.
- **The board:** `od_get_open_lab_cases`. Group by status (not sent, at lab, back but not checked). Lead with problems:
  - **Seat risk:** seat appointment within the window and the case isn't back. Give the appointment date and the lab's phone.
  - **Overdue:** past due and not received.
- **Turnaround performance:** `od_run_report` `lab_turnaround` with a date range (average and longest days, late returns per lab).

Empty dates in Open Dental show as 0001-01-01; say "not yet" rather than showing that.

## Creating and updating (needs "Allow schedule changes")

1. Identify the patient (od-patient-lookup rules), the lab (`od_list_labs`), the provider, and the seat appointment if one exists (`od_get_appointments` for the patient; only a Scheduled appointment can be linked as the seat appointment, a Planned one as the planned appointment).
2. Due date: use the date the user gives, or a lab turnaround (`turnaround_num`), which adds the lab's actual days to the sent date (calendar days; mention that weekends aren't skipped). If the due date lands after the seat appointment, warn before creating.
3. Show the details (patient, lab, provider, instructions, due, seat appointment, sent now?) and get a yes, then `od_create_lab_case`.
4. Steps after that: `od_update_lab_case_status` with `sent`, `received` (back from lab) or `checked` (inspected, ready to seat), in that order. Other edits: `od_update_lab_case`.

Never delete lab cases. If a case was cancelled, say so in its instructions with `od_update_lab_case` and leave the record.

## Cleanup: cases never marked received

For old cases whose appointment is Complete but the case was never marked received:

1. Count: `od_run_report` `lab_cases_unreceived_completed` with `count_only: "true"` (and `before` as the cutoff, e.g. "2026-10-01", so recent cases aren't touched). Report total, never-sent count, and date span.
2. List: the same report without `count_only` gives LabCaseNums in date order.
3. Test first: run `od_mark_lab_cases_received` on 1-2 cases with `preview: true`, show the result, get a yes, run with `preview: false`, and have the user check those cases in Open Dental.
4. Then batches of up to 50: preview, show the summary (would mark / skipped with reasons), get a yes for that batch, run with `preview: false`. The received date is the appointment's date; nothing is deleted.
5. If a batch reports "Stopped early", stop and show the reason (keys, permissions, network) before doing anything else.
6. Re-run the count to confirm it reached zero (or only the skipped cases remain), and report the final numbers.
