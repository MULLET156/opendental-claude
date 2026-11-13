---
name: od-patient-lookup
description: Use when the user asks about a specific patient in Open Dental — "pull up Jane Smith", "what's Mr. Patel's phone number", "when is the Garcia kid due for recall", "what treatment is planned for PatNum 1432", "has anyone called this patient back", "when's her next appointment". Covers patient search, demographics, recall due dates, treatment plans, appointment history and commlogs.
---

# Open Dental patient lookup

## Finding the right patient

1. Call `od_search_patients` with what the user gave (last name prefix, first name, birthdate `yyyy-MM-dd`, phone, email, chart number).
2. If more than one match, list them briefly (name, birthdate, status, PatNum) and ask which one. Never guess between patients.
3. Once identified, use the PatNum for everything else in the conversation.

## What to pull

- **Demographics / contact** — `od_get_patient`. SSN is redacted by the server; never try to retrieve it another way.
- **Appointments** — `od_get_appointments` with `pat_num`. Split into upcoming vs. past; note broken and unscheduled ones.
- **Communication history** — `od_get_commlogs`.
- **Recall due** — `od_run_report` with `patient_recall` (`patient`: PatNum). Office-wide overdue list: `recall_overdue`.
- **Treatment plan** — `od_run_report` with `patient_treatment_plan` (`patient`: PatNum).
- **Family / guarantor balance** — see the od-billing skill.

## Privacy

- Pull only what the question needs (minimum necessary). Don't dump full records when the user asked for a phone number.
- Don't paste patient details into other apps (email, chat, docs) unless the user asks for that specific action.
- Don't keep patient lists in memory or notes.
