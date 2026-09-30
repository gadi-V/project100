# SYSTEM TOPOLOGY STATUS — Project 8 (Spec 1.9 / Step 7)

> Final wiring map as-built. Status: **FULLY WIRED** — every layer verified by
> `scripts/test-live-db-pipeline.ts` (Live-DB), `agents_hive/test_hive_mcp_tools.py`
> (9 FastMCP tools), `scripts/verify-closed-loop-e2e.ts` (18 dry-run checks) and
> `scripts/e2e-dry-run-verification.ts` (13 live-server checks). Readiness probe: `GET /api/health`.

---

## 1. Four Architecture Layers

| Layer | Files (responsibility) | Status |
|---|---|---|
| **L1 — Data / Prisma** | `prisma/schema.prisma` — 22 models, 9 enums; Postgres/Neon | ✅ Live (additive-only; migrations synced — see §6) |
| **L2 — Services (`lib/`)** | `matching.ts`, `teacher-vetting.ts`, `lesson-summary.ts`, `package-chat.ts`, `diagnostic-quiz.ts`, `ledger/PayoutService`, `whatsapp.ts`, `daily.ts`, `stream.ts`, `scheduling.ts`, `storage.ts`, `curriculum-agent.ts`, `curriculum-rubric.ts` + more | ✅ Live |
| **L3 — API (`app/api/`)** | teachers / diagnostic / lessons / packages / admin + whatsapp/closer + cron | ✅ Live (new endpoints verified) |
| **L4 — Agent Hive & Desks** | `agents_hive/hive_mcp.py` (FastMCP, 10 tools) + `scanner_desk.py`, `creative_factory.py`, `head_of_desk.py`, `hive_orchestrator.py` | ✅ Live |

### Six Desks

| # | Desk | File | Active route / cron | Status |
|---|---|---|---|---|
| 1 | **Scanner Desk** | `agents_hive/scanner_desk.py` | manual / cron | ✅ as-built (Playwright-optional) |
| 2 | **Creative Factory** | `agents_hive/creative_factory.py` | manual / cron | ✅ as-built (MoviePy-optional) |
| 3 | **Head of Desk (quiet)** | `agents_hive/head_of_desk.py` | `GET /api/cron/head-of-desk` (`*/15 * * * *`) | ✅ Live |
| 4 | **Teacher Vetting** | `lib/teacher-vetting.ts` + `app/admin/teachers/*` | `GET/POST /api/admin/teachers/[id]/vetting` | ✅ Live |
| 5 | **WhatsApp Closer** | `lib/whatsapp.ts` (`dispatchWhatsAppCloser`) | `POST /api/whatsapp/closer` + teaser hook | ✅ Live |
| 6 | **Fintech / Override** | `lib/services/LedgerService.ts` + `PayoutService.ts` | `POST /api/admin/override/compensation`, `POST /api/admin/payouts/settle` | ✅ Live |

---

## 2. API Endpoints

### Teacher funnel
- `POST /api/teachers/apply` — apply (creates TeacherProfile + 6 step logs). Session-only identity (Sprint 6).
- `GET/POST /api/teachers/me/vetting` — status + exam-581 submission (PENDING_REVIEW). Session-only identity (Sprint 5).
- `GET/POST /api/admin/teachers` & `GET/POST /api/admin/teachers/[id]/vetting`.
- `POST /api/careers/apply` — public job application from `/careers` (AuditLog `TEACHER_CANDIDATE_APPLIED`, no User created). Rate-limited (`api`) (Sprint 9).
- `POST /api/register` — students/parents only; `role: "TEACHER"` → `403` (Sprint 10). `/register/teacher` redirects to `/careers`.

### Staff & intake
- `POST /api/login` with `portal: "staff"` — staff gate used by `/portal/login`; non-staff roles get `403` and no cookie (Sprint 9).
- `GET/POST /api/admin/intake` — mapping-call questionnaire (`IntakeAssessment`), REPRESENTATIVE / ADMIN / MANAGER only (Sprint 9).
- Pages `/portal/dashboard` (staff dashboard) and `/portal/intake` (mapping-call workspace) — server-side role gate (Sprint 10).
- Page `/portal/students/[id]` — student CRM screen with 5 tabs (Sprint 10b).
- `GET /api/portal/students` — student directory: `search`, `status`, `grade`, `page`, `limit` (25 by default); TEACHER sees own students only (Sprint 11).
- Page `/portal/students` — customer / student directory with quick status + grade filters and pagination (Sprint 11).
- `GET/POST /api/portal/students/[id]/communication` — communication history (newest first) + save summary (AuditLog `STUDENT_COMMUNICATION_LOGGED`) (Sprint 10b). Lesson / mapping summaries are also posted to the student's quad WhatsApp group (`sendToWhatsApp`, default `true`; response `whatsappDispatched`) (Sprint 13).
- `PATCH /api/portal/students/[id]/profile` — status checkboxes + profile fields, REPRESENTATIVE / ADMIN / MANAGER (AuditLog `STUDENT_PROFILE_UPDATED`) (Sprint 10b).
- `POST /api/portal/students/[id]/attendance` — present / absent on a started lesson (AuditLog `LESSON_ATTENDANCE_MARKED`) (Sprint 10b).
- `GET/POST /api/portal/students/[id]/meetings` — meetings + approved teachers; schedule a mapping / regular lesson with an assigned teacher and open (or update) the quad WhatsApp group. REPRESENTATIVE / ADMIN / MANAGER only (AuditLog `MAPPING_LESSON_SCHEDULED`) (Sprint 12).
- `GET/POST /api/portal/students/[id]/pedagogic-decision` — 360° overview (intake call, parent / student questionnaires, mapping summary, active teachers) + the pedagogic manager's post-mapping decision: summary log, monthly recurring-lesson batch, active "תלמיד" status, learning plan posted to the quad WhatsApp group. MANAGER / ADMIN / REPRESENTATIVE only (AuditLog `PEDAGOGIC_DECISION_RECORDED`) (Sprint 14).
- `POST /api/portal/students/[id]/meetings/pending-schedule` — lock date, time and teacher for a `PENDING_SCHEDULE` private lesson → `SCHEDULED`, anti-collision `409`, quad-group update. REPRESENTATIVE / ADMIN / MANAGER only (AuditLog `PENDING_LESSON_SCHEDULED`) (Sprint 15).
- `PATCH / DELETE /api/portal/students/[id]/meetings/[meetingId]` — staff reschedule (24 h / once policy `422`, anti-collision `409`) and cancel (reason, optional credit return on the direct package track), each posted to the quad group. REPRESENTATIVE / ADMIN / MANAGER only (AuditLog `LESSON_RESCHEDULED_BY_STAFF` / `LESSON_CANCELLED_BY_STAFF`) (Sprint 15).
- `POST /api/portal/students/[id]/direct-package` — direct hours package for independent students (no mapping lesson): `lessonCredits` increment + active "תלמיד" status. MANAGER / ADMIN / REPRESENTATIVE only (AuditLog `DIRECT_PACKAGE_ASSIGNED`) (Sprint 14).

### Diagnostics & packages
- `POST /api/diagnostic/teaser` — 5-step funnel (also triggers WhatsApp Closer).
- `GET /api/diagnostic/student` — masked/full diagnostic view.
- `POST /api/diagnostic/unlock` — unlock + teacher match + quad group status (never creates a group or link; Sprint 9).
- `GET /api/diagnostic/evaluate`, `GET/POST /api/packages/[id]/quiz` — quiz + gaps.
- `GET /api/packages/[id]/report`, `GET/POST /api/packages/[id]/assets`.

### Lessons
- `POST /api/lessons/complete` — close + payout + platform fee (atomic, idempotent).
- `POST /api/lessons/[id]/summary` — pedagogical summary + gap closure.
- `POST /api/lessons/[id]/cancel` / `reschedule` / `rate` / `appeal`.

### WhatsApp
- `POST /api/whatsapp/dispatch-channel` — 1-vs-4 channel routing; opens the live quad group + welcome (Sprint 8).
- `POST /api/whatsapp/closer` — full closer engine (analysis + dispatch).

### Admin
- `GET /api/admin/audit/risk-events` — Head-of-Desk risk surface.
- `POST /api/admin/override/compensation` — make-up lesson + PLATFORM_COMPENSATION.
- `GET/POST/PUT/DELETE /api/admin/curriculum` — curriculum tree + syllabus agent.
- `GET /api/admin/payouts`, `POST /api/admin/payouts/settle`, `GET/POST /api/admin/appeals`.

### Cron / Webhooks
- `GET /api/cron/lesson-reminders` (`*/5`), `GET /api/cron/head-of-desk` (`*/15`).
- `POST /api/webhooks/daily` (stores `daily-rec:<recording_id>`), `POST /api/webhooks/stripe`.
- `GET /api/daily/signed-url` — fresh Daily access link per view (Sprint 5).
- `GET|POST /api/agents/dispatch?agent=leads` — agent swarm dispatcher, `CRON_SECRET` / QStash only (Sprint 6).

---

## 3. FastMCP (`agents_hive/hive_mcp.py`)

Verified by `test_hive_mcp_tools.py`:

| Tool | Kind | Status |
|---|---|---|
| `parse_syllabus_to_curriculum` | infra | ✅ |
| `run_orchestration` | infra | ✅ |
| `run_typecheck` (`npx tsc --noEmit`) | infra | ✅ |
| `run_eslint` | infra | ✅ |
| `check_guardrails` | infra | ✅ |
| `verify_git_safety` | infra (extra) | ✅ |
| `handle_package_whatsapp_flow` | business | ✅ |
| `complete_lesson_and_settle` | business | ✅ |
| `admin_issue_compensation` | business | ✅ |
| `get_critical_desk_events` | business | ✅ |

---

## 4. Production Environment Variables (`.env.example`, synced)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon/Postgres |
| `AUTH_SECRET` | JWT session signer |
| `DAILY_API_KEY` / `DAILY_WEBHOOK_SECRET` | Daily.co rooms + webhook |
| `NEXT_PUBLIC_STREAM_API_KEY`, `STREAM_API_KEY`, `STREAM_API_SECRET` | Stream Chat |
| `APP_URL` | Public origin (WhatsApp deep-links) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Stripe |
| `TWILIO_*` / `SMS_API_*` | OTP delivery |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_*` | Board PDF storage |
| `WHATSAPP_API_URL`, `WHATSAPP_API_KEY` | WhatsApp transactional alerts |
| `CRON_SECRET` | Cron auth (Vercel Cron + QStash forwarded header) |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Distributed rate limiting (without them production fails open and logs `[rate-limit] DEGRADED`) |
| `CURRICULUM_AGENT_TIMEOUT_MS` | Optional syllabus-agent timeout (default 45000 ms, no retries) |
| `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL`, `MODEL_*` | Agent Hive reasoning/generation; `OPENROUTER_API_KEY` + `MODEL_AUTOMATION` also drive the serverless lead agent |
| `HIVE_MONITOR_SECRET` | Head-of-Desk server-to-server auth |
| `DAILY_ENABLE_CLOUD_RECORDING` | Daily cloud-recording opt-in |
| `NEXT_PUBLIC_APP_URL` | Public origin fallback for client + WhatsApp links |
| `INTERNAL_SERVICE_KEY` | Agent Hive → app service-to-service auth |
| `WHATSAPP_ADMIN_PHONE` | Admin member of every quad WhatsApp group (omitted when empty or invalid) |
| `WHATSAPP_TEACHER_PLACEHOLDER_PHONE` | No longer read (since Sprint 8 the quad group uses the real lesson teacher); kept in `.env.example` only |
| `DAILY_DOMAIN` | Teacher permanent room links (`lib/teacher-welcome.ts`; warns + falls back to `project100.daily.co`) |
| `NEXT_PUBLIC_EXAM_581_PDF_URL` | Teacher onboarding exam-581 PDF |
| `TELEGRAM_BOT_TOKEN`, `MANAGER_ALERT_PHONE`, `MANAGER_ALERT_TELEGRAM_CHAT_ID` | Head-of-Desk manager alerts |

---

## 5. Verification Artifacts (`scripts/`)

| Script | Purpose | Status |
|---|---|---|
| `scripts/test-live-db-pipeline.ts` | 6-station live-DB integration + teardown | ✅ (run) |
| `scripts/verify-closed-loop-e2e.ts` | 18 dry-run checks (4 layers + 6 desks + WhatsApp group lifecycle), no DB writes | ✅ 18/18 |
| `scripts/e2e-dry-run-verification.ts` | 8-station funnel against a running server (`APP_URL`), self-cleaning fixtures | ✅ 13/13 |
| `agents_hive/test_hive_mcp_tools.py` | 9 FastMCP tools | ✅ PASS |
| `scripts/test-curriculum-e2e.ts` | matching-adjacent curriculum E2E | ✅ |

**Feedback loop:** `npx tsc --noEmit` → `TSC EXIT: 0` on every station.

---

## 6. Prisma Migration History

| Migration | Content |
|---|---|
| `0_init` | Base schema |
| `20260827120000_p1_ratings_and_reschedule` | Lesson rating / reschedule counter, TeacherProfile rating aggregates |
| `20260827160000_payment_status` | Payment status |
| `20260929152923_sync_missing_models` | Catches up everything previously applied via `db push`: `Package`, `CurriculumTopic` (+ `_CurriculumTopicToDiagnosticQuiz`), `VettingStepLog`, `UnifiedPackageChat`, `PreLessonAsset`, 6 enums, new nullable/defaulted columns on `User` / `TeacherProfile` / `Lesson` / `DiagnosticQuiz`, and `Lesson.ratedAt` aligned to `TIMESTAMP(3)`. Additive only — no drops or renames. |

| `20260929190000_user_whatsapp_group_id` | `User.whatsappGroupId` (nullable) for the live quad WhatsApp group (Sprint 8) |
| `20260929194238_add_intake_assessment` | `Role.REPRESENTATIVE` enum value + `IntakeAssessment` table (FKs to `User` ×2 and `FallbackLead`, 3 indexes) (Sprint 9) |
| `20260929200238_add_student_tabs_and_communication` | `StudentProfile` (1:1 `User`, cascade) + `StudentCommunicationLog` (FK `User`, cascade, index `studentId, createdAt`) + nullable `Lesson.attendanceStatus / attendanceMarkedAt / attendanceMarkedById` (Sprint 10b) |
| `20260929220000_lesson_type_and_whatsapp_group` | `Lesson.lessonType TEXT NOT NULL DEFAULT 'REGULAR'` + nullable `Lesson.whatsappGroupId` (`ADD COLUMN IF NOT EXISTS`) (Sprint 12) |

Replaying all eight migrations reproduces `prisma/schema.prisma` exactly.

**Existing databases that were synced with `db push`** already contain these objects. Mark the sync
migration as applied instead of executing it (running it would fail with "already exists"):

```bash
npx prisma migrate resolve --applied 20260929152923_sync_missing_models
```

If the database has no `_prisma_migrations` history at all, run `migrate resolve --applied` for each
migration that is already reflected in the database, in order.

Fresh databases apply all migrations normally with `npx prisma migrate deploy`.

---

## 7. Hardening Sprints

| Sprint | Scope | Status |
|---|---|---|
| 1 | E.164 phone normalization, time-boxed Daily/Stream tokens, chat moderation (`afb23e5`) | ✅ Completed |
| 2 | Teacher-welcome WhatsApp normalization, Prisma migration sync, `.env.example` (`2ce50ad`) | ✅ Completed |
| 3 | GitHub Actions CI + distributed rate limiting on Upstash Redis (`f50e01d`, `93139be`) | ✅ Completed |
| 4 | Production 503 prevention, classroom-sized auth limit, serverless-safe curriculum agent & storage | ✅ Completed |
| 5 | `x-user-id` header-spoofing neutralized (middleware + teacher vetting), Daily recordings stored by `recording_id` with fresh signed URLs (`88f1c43`) | ✅ Completed |
| 6 | `teachers/apply` IDOR closed; serverless agent swarm: `lib/agents/core/llm.ts`, lead agent, cron-secured `/api/agents/dispatch` (`1c52282`) | ✅ Completed |
| 7 | Lead dispatch loop closed: live WhatsApp send, AuditLog-based 14-day anti-spam cooldown, QStash schedule (`49d99da`) | ✅ Completed |
| 8 | Live quad WhatsApp group (student + teacher + parent + admin) with structured welcome message and role split | ✅ Completed |
| 9 | Public/staff UI split, isolated `/portal/login`, `/careers` + candidate API, unlock placeholder link removed, `IntakeAssessment` model + intake API (`d2702e8`) | ✅ Completed |
| 10 | Public teacher registration sealed (UI + API), representative dashboard `/portal/dashboard`, mapping-call workspace `/portal/intake` (`f210ab5`) | ✅ Completed |
| 10b | Student screen `/portal/students/[id]` with 5 tabs (profile, courses, meetings, communication, standing orders) and standard summary templates for teacher, representative and pedagogic manager (`4ae5da2`) | ✅ Completed |
| 11 | Customer / student directory `/portal/students` + `GET /api/portal/students` (search, status and grade filters, pagination), shared portal header with היום / קורסים / לקוחות tabs and global student search, teacher dashboard links to student files | ✅ Completed |
| 11b | Vercel build fix: `prisma generate` runs before `next build` and on `postinstall`; `force-dynamic` confirmed on all session/DB portal pages | ✅ Completed |
| 11c | Neon migration P3018 fixed: `sync_missing_models` made idempotent, failed record resolved, all pending migrations deployed; `package.json#prisma` moved to `prisma.config.ts` | ✅ Completed |
| 11d | All-green hardening: zero build warnings (`middleware.ts` → `proxy.ts`), E2E scripts synced with the post-mapping-lesson WhatsApp group, `GET /api/health` live DB probe, Neon fully stable | ✅ Completed |
| 12 | Operational loop closed: mapping-lesson scheduler in the student meetings tab (teacher assignment + date), `POST /api/portal/students/[id]/meetings`, automatic quad WhatsApp group trigger (student + teacher + parent + admin) with welcome message, no duplicate groups | ✅ Completed |
| 13 | Daily lesson room launched from the meetings tab ("היכנס לשיעור" → `/lessons/[lessonId]`), lesson and mapping summaries saved on the communication tab auto-dispatched to the quad WhatsApp group (`whatsappGroupId`) | ✅ Completed |
| 14 | 360° pedagogic decision (intake call + parent / student questionnaires + mapping summary), subscription generator (weekly / twice weekly, extra private lessons, fixed days and hours, monthly lesson batch, quad WhatsApp announcement) and direct hours-package track for independent students | ✅ Completed |
| 15 | Lesson lifecycle on the meetings tab: scheduling pending private lessons (PENDING_SCHEDULE → SCHEDULED), staff reschedule with conflict check and cancellation with reason / credit return, all with quad WhatsApp updates | ✅ Completed |

### Lesson lifecycle: pending private lessons, reschedule and cancel (Sprint 15)

- **Meetings tab** (`MeetingsTab.tsx`): a "פעולות" column for REPRESENTATIVE / ADMIN / MANAGER only. A `PENDING_SCHEDULE`
  row shows "טרם נקבע מועד", an amber "ש.פ - ממתין לשיבוץ" badge and a green "שבץ מועד" button
  (`SchedulePendingLessonModal`: teacher, date, time). An upcoming `SCHEDULED` row shows "שנה מועד"
  (`RescheduleLessonModal`: new date / time + optional reason; disabled with a tooltip inside 24 h or after one move)
  and "בטל שיעור" (`CancelLessonModal`: required reason + "להחזיר שיעור אחד ליתרת החבילה", offered only when the
  student has a direct package). After each action: status banner (honest about the WhatsApp result) + table refresh.
- **`MeetingRow`** gains `teacherId`, `durationMinutes` and server-computed staff flags `canSchedulePending`,
  `canReschedule`, `rescheduleBlock` (`WITHIN_24H` / `ALREADY_RESCHEDULED`) and `canCancel`, which are always false for teachers.
- **Shared helpers** (`lib/student-portal.ts`): `findLessonConflict` (60-minute window, student + teacher, excludes the
  moved lesson), `releaseTeacherSlot` / `bookTeacherSlot` (`TeacherAvailability.isBooked` via `updateMany`),
  `studentHasDirectPackage`. Parsers and policy in `lib/lesson-lifecycle.ts`.
- **`POST …/meetings/pending-schedule`:** lesson must belong to the student and be `PENDING_SCHEDULE` (`409`
  otherwise), teacher must be an approved TEACHER. Transaction: conflict check, claim via
  `updateMany({ id, status: PENDING_SCHEDULE })` (parallel request → `409`) → `SCHEDULED`, exact `scheduledAt`,
  `teacherId`, `whatsappGroupId`, `reminderSent: false`; the teacher's open slot at that time is booked. Group post "📌
  *שיבוץ שיעור פרטי - Project 100*".
- **`PATCH …/meetings/[meetingId]`** `{ newScheduledAt, reason? }`: same policy as `/api/lessons/[id]/reschedule` (more
  than 24 h ahead, once per lesson → `422`). Transaction: conflict check, optimistic
  `updateMany({ id, status: SCHEDULED, rescheduledCount })`, `rescheduledCount + 1`, `reminderSent: false`,
  `dailyRoomUrl: null` (the classroom page provisions a new room; the old one is deleted best-effort), old slot freed /
  new slot booked, `GENERAL` communication entry (`structuredData.source = "LESSON_RESCHEDULED"`, from / to / reason).
  Group post: "🗓️ *עדכון מועד שיעור - Project 100*" with the new day, date and time range.
- **`DELETE …/meetings/[meetingId]`** `{ cancellationReason, restoreCredit }`: only `SCHEDULED` lessons (`409` "השיעור
  כבר בוטל"). Transaction: `CANCELLED`, `canceledAt`, `canceledById`, slot freed, `lessonCredits + 1` only when
  `restoreCredit` and the student has a direct package, `GENERAL` entry (`source = "LESSON_CANCELLED"`, reason,
  `creditRestored`). The reason is kept on the communication tab + AuditLog (no new `Lesson` column, so no migration)
  and is **not** posted to the group ("❌ *ביטול שיעור - Project 100*"). No `BillingLedger` row; the protected
  `/api/lessons/[id]/cancel` and `/reschedule` routes are unchanged.
- **WhatsApp** (`lib/whatsapp.ts`): `formatQuadLessonDate`, `buildLessonRescheduledMessage`,
  `buildPrivateLessonScheduledMessage`, `buildLessonCancelledMessage` + senders over one never-throwing `postToQuadGroup`.
  Target: `Lesson.whatsappGroupId`, falling back to `User.whatsappGroupId`. Any gateway failure → `200` with
  `whatsappDispatched: false`; the DB change stays.
- **Tests:** `tests/portal-lesson-lifecycle.test.ts` (39 tests) covers:
  - scheduling a pending lesson, with collision `409` and race `409`;
  - reschedule: exact message, self-excluded conflict check, foreign lesson `404`;
  - cancel: reason stored and not posted, credit returned only on the direct package track, double cancel `409`;
  - TEACHER / STUDENT `403` (including the lesson's own teacher and student) and `401`;
  - unreachable, 503 and throwing WhatsApp, and a failed Daily teardown, all keep the DB change;
  - staff flags in `buildMeetingRows` (including the 24 h / once block) and the request-body parsers.
- **Verified:** `npm run build` exit `0`; `npm test` 22 files / 468 tests exit `0`; `tsc --noEmit` 0.

### Pedagogic decision 360° and direct package track (Sprint 14)

- **Courses tab** (`CoursesTab.tsx`, now a client component): for REPRESENTATIVE / ADMIN / MANAGER two actions at the
  top: "הכרעה פדגוגית ומנוי שנתי" (`PedagogicDecisionModal`) and "שיוך חבילת שעות ישירה" (`DirectPackageModal`). Two new
  tables above the enrollments table: "מנויים שבועיים קבועים" (subject, track, teacher, fixed slots, start date, extra
  private lessons) and "חבילות שעות" (package, subject, lessons, preferred teacher, date) with the `lessonCredits`
  balance (billing viewers only). After saving: toast + `router.refresh()`.
- **`StudentPortalData.plans`** (`EnrollmentPlans`) comes from `loadEnrollmentPlans`: communication-log rows whose
  `structuredData.source` is `PEDAGOGIC_DECISION` (subscriptions) or `DIRECT_PACKAGE` (packages).
- **`PedagogicDecisionModal`:** loads `GET …/pedagogic-decision` and shows four 360° cards: intake call (representative,
  grade, level, notes), parent questionnaire (yearly goal, target / average score, motivation, difficulties), student
  questionnaire (last score, aspirations, main difficulty, diagnostic gaps; `IntakeAssessment` + latest
  `DiagnosticQuiz`) and the mapping teacher's `MAPPING_SUMMARY` (4-topic ranking, class / home learning, motivation,
  personal connection, format fit, recommendation). The form holds the "סיכום שיחה לאחר מיפוי" fields (background,
  personal / learning notes, main goal, parent type, subscription, extra private lessons 0/1/2, professional manager
  yes/no, approved teacher, subject, 1 or 2 weekday+time slots, start date). Defaults come from the mapping lesson
  teacher / subject and the mapping recommendation.
- **`POST …/pedagogic-decision`** (`requireAuth(ENROLLMENT_DECISION_ROLES)`, others `403`): parsed by
  `parsePedagogicDecisionInput` (slot count must match the track, two slots on different weekdays, start date from
  today up to 180 days, first lesson in the future, teacher must be an approved TEACHER). One transaction:
  anti-collision check of every generated slot for student and teacher (60-minute window, `409` names the conflicting
  time), `StudentCommunicationLog` `type: "POST_MAPPING_CALL"` (label "סיכום שיחה לאחר מיפוי", `authorRole`
  `PEDAGOGIC_MANAGER` for MANAGER) whose `content` re-parses as the template and whose `structuredData` holds the
  template fields + `decision`, `lesson.createMany` of the next 4 weeks (4 / 8 lessons, `SCHEDULED`, `REGULAR`, 50 min,
  DST-aware Israel time, `whatsappGroupId`), 1–2 extra private lessons as `PENDING_SCHEDULE` (placeholder
  `scheduledAt` = first lesson), and `markStudentActive` (adds `STUDENT`, removes `MAPPING_FAILED` / `CALL_BACK_PARENT`).
  Then `sendQuadGroupPedagogicDecision` posts the official learning plan (track, fixed teacher, fixed slots) to the
  group. No group or any gateway failure → `201` with `whatsappDispatched: false`; the decision is never rolled back.
- **`PENDING_SCHEDULE`** ("ממתין לשיבוץ"): not on the weekly board, not in anti-collision or reminders (all filter
  SCHEDULED / IN_PROGRESS), excluded from recurring slots, attendance marking and the directory's last-lesson date.
- **`POST …/direct-package`:** `DIRECT_PACKAGES` = חבילת 5 שיעורים (5) / חבילת 10 שיעורים (10) / חבילת מרתון בחינה (8);
  subject required, preferred teacher optional (approved TEACHER or `404`). One transaction: `lessonCredits`
  increment, `GENERAL` log with `structuredData.source = "DIRECT_PACKAGE"`, `markStudentActive`. No mapping lesson is
  checked. Writes no `Payment` / `BillingLedger` row (billing stays on the payment flow).
- **Tests:** `tests/pedagogic-decision-and-packages.test.ts` (34 tests) — summary log + 4 / 8 lessons with exact UTC
  times (incl. the 25.10 DST switch) + PENDING_SCHEDULE extras + exact WhatsApp text, status activation, template
  round-trip, 409 collision, validation `400`s, 360° overview composition, direct package credits / status / audit
  without mapping, plans split, TEACHER / STUDENT `403` and anonymous `401` on all three handlers, 503 / network /
  thrown / not-configured WhatsApp keeps the decision.
- **Verified:** `npm run build` exit `0`; `npm test` 21 files / 429 tests exit `0`; `tsc --noEmit` 0.

### Lesson room entry and summary dispatch to the quad group (Sprint 13)

- **Meetings tab** (`MeetingsTab.tsx`): new "חדר שיעור" column. `LessonRoomAction` renders a green "היכנס לשיעור" link
  (lucide `Video` icon) to `lessonRoomHref(lessonId)` = `/lessons/[lessonId]` when `MeetingRow.canEnterRoom`. A
  COMPLETED / CANCELLED lesson gets a disabled button that shows the status label; an open lesson the viewer may not
  enter (e.g. REPRESENTATIVE, another teacher) gets a disabled "היכנס לשיעור" with an explanatory tooltip.
- **`lib/student-portal-shared.ts`:** `lessonRoomHref`, `isLessonRoomOpen` (SCHEDULED / IN_PROGRESS) and
  `canEnterLessonRoom(viewer, lesson)`, which mirrors the classroom guard `getAuthorizedLessonById`: assigned TEACHER,
  the STUDENT, MANAGER (pedagogic manager) or ADMIN. `buildMeetingRows` sets `canEnterRoom` (lesson select now includes
  `studentId`). `StudentPortalData.whatsappGroupLinked` comes from `User.whatsappGroupId`.
- **`POST /api/portal/students/[id]/communication`:** optional `sendToWhatsApp` (default `true`; non-boolean → `400`
  before saving). After the log is created, a `LESSON_SUMMARY` or `MAPPING_SUMMARY` is posted to the student's
  `whatsappGroupId` through `sendQuadGroupCommunicationSummary` (never throws). No group, flag off, other summary types
  or any gateway failure (non-2xx, network, not configured, DB lookup error) → logged with `console.error` and
  `whatsappDispatched: false`; the summary is never rolled back. Response `201 { success: true, data, whatsappDispatched }`;
  the audit metadata includes `sendToWhatsApp` and `whatsappDispatched`.
- **`lib/whatsapp.ts`:** `buildQuadCommunicationSummaryMessage` — lesson summary "📚 *סיכום שיעור - Project 100*" with
  *עבדנו על* / *שיעורי בית* / *בשיעור הבא* (empty optional lines omitted); mapping summary is a short "המיפוי הושלם" note
  saying the pedagogic manager will follow up with the learning plan (no internal mapping fields are posted).
- **Communication tab** (`CommunicationTab.tsx`): for lesson / mapping summaries the modal shows a checkbox (checked by
  default) "שלח סיכום זה ישירות לקבוצת הוואטסאפ", or "טרם הוגדרה קבוצת וואטסאפ לתלמיד" when no group is linked. The
  toast reports only what the backend confirmed (saved and sent / saved but not sent).
- **Tests:** `tests/lesson-summary-whatsapp-dispatch.test.ts` (16 tests) — exact lesson-summary text to the right group,
  mapping message, `sendToWhatsApp: false`, no group, GENERAL not posted, invalid flag `400`, 503 / network /
  not-configured keep the summary (`201`, `whatsappDispatched: false`), join link → `/lessons/[lessonId]`, disabled
  states for COMPLETED / CANCELLED, role matrix and `buildMeetingRows.canEnterRoom`.
- **Verified:** `npm run build` exit `0` with no warnings; `npm test` 20 files / 395 tests; `tsc --noEmit` 0.

### Mapping lesson scheduler and quad group trigger (Sprint 12)

- **Schema (additive):** `Lesson.lessonType` (`MAPPING` | `REGULAR`, default `REGULAR`) and `Lesson.whatsappGroupId`
  (group opened or notified for that lesson). Migration `20260929220000_lesson_type_and_whatsapp_group`, deployed to
  Neon ("Database schema is up to date!").
- **`POST /api/portal/students/[id]/meetings`** (`requireAuth(INTAKE_RECORDER_ROLES)`): anonymous → `401`,
  TEACHER / STUDENT → `403`, identity from the session only. Body `{ teacherId, subject, scheduledAt (ISO, future),
  durationMinutes?, lessonType? }` parsed by `parseScheduleMeetingInput` (MAPPING by default, 45 min; REGULAR 50 min;
  15–180). The target must be a STUDENT (`resolveStudentAccess`, else 404) and `teacherId` a TEACHER (else 404).
  - Lesson: in a `$transaction`, the ±60-minute anti-collision window (`lessonAntiCollisionWindow`) is checked for both
    the student and the teacher (`409` on overlap), then `Lesson { status: SCHEDULED, title: subject, lessonType,
    durationMinutes }` is created. No credits, availability slots or ledger rows are touched; the Daily room is created
    lazily by `ensureDailyRoom` when the classroom opens.
  - WhatsApp: student with `User.whatsappGroupId` → `sendQuadGroupLessonUpdate` posts the new date into that group
    (`EXISTING`, no second group). No group + MAPPING → `createWhatsAppQuadGroup` with student / teacher / parent from
    the DB, admin from `WHATSAPP_ADMIN_PHONE`, the lesson window and `buildDiagnosticQuestionnaireUrl()`; the chat id is
    claimed with `user.updateMany({ where: { id, whatsappGroupId: null } })` so a parallel request cannot store a second
    group (the loser links the lesson to the stored group and audits `duplicate: true`). The chat id is also written to
    `Lesson.whatsappGroupId`. REGULAR without a group → `NOT_OPENED` (the welcome copy is mapping-specific).
  - Gateway failures (`GATEWAY_ERROR` / 503, `NETWORK`, `TIMEOUT`, `NOT_CONFIGURED`, unexpected throw) are logged and
    never roll back the lesson: `201 { whatsappGroupCreated: false, groupStatus: "FAILED", whatsappErrorCode }`.
  - Audit: `MAPPING_LESSON_SCHEDULED` (REGULAR: `LESSON_SCHEDULED`), `entityType: "Lesson"`, `entityId: lessonId`, with
    group status / error code; plus `WHATSAPP_QUAD_GROUP_CREATED` on the student when a group opens.
  - Response `{ success, data: { lessonId, lessonType, scheduledAt, durationMinutes, teacherName, groupStatus:
    OPENED | EXISTING | FAILED | NOT_OPENED, whatsappGroupCreated, whatsappGroupLinked, groupUpdateSent, whatsappErrorCode } }`.
- **`GET /api/portal/students/[id]/meetings`**: same roles; `{ meetings: MeetingRow[], teachers }` (approved
  `role = TEACHER` users by name), `Cache-Control: no-store`.
- **`lib/whatsapp.ts`:** `createWhatsAppQuadGroup` accepts `existingGroupId` and returns `ALREADY_EXISTS` without any
  gateway call when set; new `buildDiagnosticQuestionnaireUrl`, `buildQuadLessonUpdateMessage`,
  `sendQuadGroupLessonUpdate` (never throws, `{ sent, messageId | error }`).
- **Meetings tab** (`MeetingsTab.tsx` + `ScheduleMeetingModal.tsx`): "+ הוסף מפגש" for REPRESENTATIVE / ADMIN / MANAGER
  (`viewer.canEditProfile`), also on the empty state. Modal: lesson type (שיעור מיפוי ראשוני default / שיעור שוטף),
  teacher dropdown from the GET route, subject (default מתמטיקה), Israel date (default tomorrow) + time (08:00–22:00,
  15-minute steps, default 17:00, converted DST-aware by `israelLocalToIso`), duration 45 min fixed for mapping.
  Submit shows a spinner with "מתאם שיעור ופותח קבוצת וואטסאפ..."; on success the modal closes, the table reloads from
  the GET route and a banner reports only what the backend confirmed: green "שיעור המיפוי תואם בהצלחה וקבוצת הוואטסאפ
  הוקמה" (OPENED) / update sent to the existing group, amber when the group could not be opened or notified. Rows show a
  "שיעור מיפוי ראשוני" tag and a green WhatsApp icon when `Lesson.whatsappGroupId` is set.
- **Tests:** `tests/schedule-mapping-whatsapp.test.ts` (34 tests) — real `requireAuth` over a mocked session (401 / 403 /
  allowed roles), validation + anti-collision `409`, exact `lesson.create` payload, `createWhatsAppQuadGroup` call args
  and the gateway `createGroup` roster (4 JIDs), welcome text, conditional claim + lesson link + both audits, existing
  group → update only, parallel-claim race, lib `ALREADY_EXISTS` guard, 503 / network / not-configured / thrown errors
  keep the lesson (`201`), GET route, Israel time helpers.
- **Verified:** `npm run build` exit `0` with no warnings (route listed as `ƒ /api/portal/students/[id]/meetings`);
  `npm test` 19 files / 379 tests; `tsc --noEmit` 0.

### All-green hardening (Sprint 11d)

- **Zero build warnings.** `npm run build` (`prisma generate && next build`) exits `0` with no warnings: the Prisma
  `package.json#prisma` deprecation is gone (Sprint 11c) and the Next 16 "middleware → proxy" deprecation is fixed by
  renaming `middleware.ts` → `proxy.ts` and its export `middleware` → `proxy`. Logic, matcher and public-route lists are
  unchanged; the build lists `ƒ Proxy (Middleware)`. Tests import `proxy` from `../proxy`.
- **WhatsApp group lifecycle in E2E.** The group is never opened at the diagnostic stage; it opens only after a
  mapping lesson with an assigned teacher is scheduled. No `mock-quad-*` links anywhere in `lib/` or `scripts/`.
  - `scripts/verify-closed-loop-e2e.ts` (dry-run, no DB writes, no gateway calls when configured): closer returns
    `isGroupOpened=false` + no invite link; `dispatch-channel` source gates `createWhatsAppQuadGroup` behind the
    SCHEDULED-future-lesson lookup and `PENDING_TEACHER_ASSIGNMENT`; no teacher → `MISSING_REQUIRED_PARTICIPANT`;
    teacher + mapping lesson → roster `STUDENT+TEACHER`, welcome names the mapping lesson, gateway → `NOT_CONFIGURED`.
  - `scripts/e2e-dry-run-verification.ts` station 4: TRIO before a mapping lesson → `PENDING_TEACHER_ASSIGNMENT`,
    no group, no `whatsappGroupId`; after scheduling the mapping lesson → the route leaves the pending gate
    (fixture phones are invalid on purpose, so it stops at `MISSING_REQUIRED_PARTICIPANT` and never opens a real group).
    Expected amounts now match the routes: TRIO `540` ILS, override compensation `200` ILS.
- **`GET /api/health`** (`app/api/health/route.ts`, public in `proxy.ts`): live `SELECT 1` to Neon with a 5 s timeout →
  `200 { success, data: { status: "UP", database: "UP", latencyMs, timestamp } }`, else `503 DOWN` with no driver
  details. `Cache-Control: no-store`, `force-dynamic`. Covered by `tests/health.test.ts`.
- **Neon:** `prisma migrate status` → "Database schema is up to date!"; `migrate deploy` → "No pending migrations to apply."
- **Verified:** `npm test` 18 files / 345 tests; `tsc --noEmit` 0; both E2E scripts all-pass against Neon
  (fixtures cleaned up); live `/api/health` → `200 UP`.

### Neon migration recovery (Sprint 11c)

- **Symptom:** `prisma migrate deploy` failed with P3018 / `42710` — `type "TeacherVettingStage" already exists` in
  `20260929152923_sync_missing_models`. The record stayed failed, blocking `user_whatsapp_group_id`,
  `add_intake_assessment` and `add_student_tabs_and_communication`.
- **Root cause:** the production DB already contained every object in that migration (schema earlier synced via
  `db push`): all 6 enums, the 6 tables, the added columns, indexes and FKs. Guarding only the enums would have failed
  on the next statement (`ADD COLUMN "academicYear"`).
- **Fix (`prisma/migrations/20260929152923_sync_missing_models/migration.sql`):** the whole file is idempotent with
  identical definitions — `CREATE TYPE` and `ADD CONSTRAINT … FOREIGN KEY` wrapped in
  `DO $$ BEGIN … EXCEPTION WHEN duplicate_object THEN null; END $$;`, plus `ADD COLUMN IF NOT EXISTS`,
  `CREATE TABLE IF NOT EXISTS`, `CREATE [UNIQUE] INDEX IF NOT EXISTS`. Safe on both fresh and pre-synced databases.
- **Recovery:** `prisma migrate resolve --rolled-back 20260929152923_sync_missing_models` → `prisma migrate deploy`
  applied all four migrations ("All migrations have been successfully applied."). Pre-deploy
  `migrate diff` (live DB → `schema.prisma`) showed exactly the three pending migrations and nothing else.
- **Config:** the deprecated `package.json#prisma` block was removed; the seed command now lives in
  `prisma.config.ts` (`migrations.seed: "tsx prisma/seed.ts"`), silencing the CLI deprecation warning.
- **Known:** `_prisma_migrations` also holds five legacy 2025 records (`20250708093000_init` …
  `20260821144500_add_lesson_duration`) with no local folder; `migrate status` reports them but they do not block deploy.
- **Verified:** `prisma validate`, `tsc --noEmit`, `npm test` (17 files / 342 tests).

### Vercel build pipeline fix (Sprint 11b)

- **Symptom:** Vercel build failed in `Running TypeScript` with
  `Property 'intakeAssessment' does not exist on type 'PrismaClient'`. The `build` script ran only `next build`,
  so Vercel's cached `node_modules/@prisma/client` was never regenerated from the new schema models.
- **Fix (`package.json`):** `"build": "prisma generate && next build"` and `"postinstall": "prisma generate"`, so the
  client matches `prisma/schema.prisma` both after dependency install and right before compilation.
- **Dynamic rendering:** `export const dynamic = "force-dynamic"` is set on `/portal/dashboard`, `/portal/intake`,
  `/portal/students` and `/portal/students/[id]` (all read the session / DB), so none are prerendered at build time.
  `/portal/login` is a client page with no DB access and stays static.
- **Verified locally:** `npm run build` exits `0` (Prisma Client generated, Turbopack compile + TypeScript pass,
  the four portal routes are listed as `ƒ` dynamic); `npm test` 17 files / 342 tests passing.

### Student directory, portal header and teacher links (Sprint 11)

- **`GET /api/portal/students`** (`app/api/portal/students/route.ts`): `requireAuth(STAFF_PORTAL_ROLES)`, so
  anonymous → `401` and STUDENT → `403` before any DB call. Identity comes from the session only; `teacherId` /
  `userId` in the query string are ignored. Response `{ success, data: { students, totalCount, page, limit, totalPages } }`,
  `Cache-Control: no-store`.
  - **Scope** (`lib/student-directory.ts` → `buildStudentDirectoryWhere`): always `role = STUDENT`. REPRESENTATIVE /
    ADMIN / MANAGER see everyone. A TEACHER sees only students with at least one `Lesson` where `teacherId = me`
    (scheduled or past), and the next / last lesson columns use only that teacher's lessons. Stricter than
    `resolveStudentAccess`: a `TeacherReferral` alone opens the student file but does not list the student.
  - **Search** (`search`, max 80 chars, up to 5 words): every word must match one of `User.name / phone / email` or
    `StudentProfile.firstName / lastName / city` (case-insensitive `contains`). Digit words also try phone spellings
    (`05…` ↔ `9725…` ↔ `5…`), so `0521112233` finds `+972521112233`. Stored phones with dashes only match a term typed
    with the same dashes.
  - **Status** (`status`, repeatable or comma-separated, codes or Hebrew labels such as `רותח 160`; `הכל` = none):
    `StudentProfile.studentStatus hasSome`. Unknown value → `400`.
  - **Grade** (`grade` ∈ ז׳…יב׳): profile grade in the spelling variants from `gradeVariants` (`י`, `י׳`, `י'`,
    `10`, `כיתה י׳`, `י״א` …); a student without a profile grade matches when any `IntakeAssessment` has that grade.
    Unknown value → `400`.
  - **Pagination** (`paginationMeta`): `page` / `limit` default to 1 / 25, `limit` capped at 100, malformed values
    fall back to the defaults, and a page past the end is pulled back to the last page. `totalPages ≥ 1`.
  - **Row**: id, full name (profile first + last, else `User.name`), phone + `wa.me` link, grade / study group (same
    fallbacks as the student screen: profile → latest intake → `classTrack`), city, status codes, next lesson
    (`IN_PROGRESS`, or `SCHEDULED` in the future), last non-cancelled past lesson, and the teacher of the next lesson
    (else of the last one). Order: newest registration first.
- **`/portal/students`** (server gate + `components/portal/StudentDirectory.tsx`): anonymous / STUDENT →
  `/portal/login`. Title "לקוחות" (teachers: "התלמידים שלי"), "נמצאו X תוצאות", search with a 300 ms debounce
  (`components/portal/useDebouncedValue.ts`), status chips הכל / תלמיד / לחזור להורה / רותח 160 / ביטול מנוי, grade
  chips ז׳–יב׳. Table: name + city, phone + WhatsApp, grade · group, status badges, next / last lesson (Israel time),
  teacher, "פתח תיק תלמיד" → `/portal/students/[id]`. Skeleton rows on first load, previous rows dimmed while
  reloading, error with retry, empty state with "איפוס סינונים". Pagination: previous / next + a 5-page window.
  Filters are mirrored into the URL (`history.replaceState`), and `?search=&status=&grade=&page=` seed the screen.
- **Portal header** moved from `app/portal/PortalHeader.tsx` to `components/portal/PortalHeader.tsx`; props are now
  `{ userName, role }`. Used on `/portal/dashboard`, `/portal/intake`, `/portal/students` and `/portal/students/[id]`.
  - Logo PROJECT100 (→ `/portal/dashboard`, teachers `/dashboard`), user name + Hebrew role label
    (`STAFF_ROLE_LABELS`), logout → `/portal/login`.
  - Tabs from `lib/portal-nav.ts` (`portalNavTabs`): **היום** → `/portal/dashboard` (teachers `/dashboard`);
    **קורסים** → `/admin/lessons` for ADMIN / MANAGER, `/dashboard#teacher-lessons` for teachers; **לקוחות** →
    `/portal/students`. Extra links: "שיחת מיפוי" (REPRESENTATIVE / ADMIN / MANAGER) and "לוח ניהול" (ADMIN / MANAGER).
  - Global search: from 2 characters, 300 ms debounce, `GET /api/portal/students?search=…&limit=6`; arrows +
    Enter open the highlighted student file, Enter on a term with no settled results opens the directory filtered by
    it, Escape / outside click closes. A footer link opens all results in the directory.
- **Teacher dashboard** (`app/dashboard/page.tsx`, approved teachers): "התלמידים שלי" button → `/portal/students`;
  a "השיעור הקרוב" / "שיעור מתקיים עכשיו" card with the student and "תיק תלמיד / סיכומים"; a "התלמידים שלי" card
  (unique students from the teacher's lessons) with a link per student; and a "תיק תלמיד / סיכומים · <name>" link
  under every lesson in the lesson list (`#teacher-lessons`). All links go to `/portal/students/[id]`, where
  `resolveStudentAccess` re-checks the teacher and the teacher view keeps profile / courses / meetings /
  communication only. ADMIN / MANAGER get a "לקוחות" button.
- **Known gaps:** representatives have no lessons / course catalog page, so their header has no "קורסים" tab; the
  weekly board (`WeeklyScheduleBoard`) itself has no student-file link; grade filtering on intakes matches any past
  intake, not only the latest.
- Tests: `tests/portal-students-directory.test.ts` (38 tests) — Prisma is replaced by an in-memory store whose
  `where` evaluator throws on unknown operators, so the real filters run. `tests/staff-intake-portal.test.ts` updated
  for the moved header and its `role` prop.

### Student CRM screen and summary templates (Sprint 10b)

- **Schema (additive):** `StudentProfile` (first/last name, grade, study group, ID, city, birth date, invoice name + ID,
  `studentStatus String[]`, `statusUpdatedAt/ById`), `StudentCommunicationLog` (`authorId/authorName/authorRole` from the
  session, `type`, `courseContext`, `content @db.Text`, `structuredData Json?`), and nullable attendance columns on
  `Lesson`. Name, phone, email, school and parent contact stay on `User`. Migration
  `20260929200238_add_student_tabs_and_communication` was generated with `prisma migrate diff` from the committed schema
  (`--from-migrations` needs a shadow DB). **Run `npx prisma migrate deploy` before deploying.**
- **Access** (`lib/student-portal.ts` → `resolveStudentAccess`): REPRESENTATIVE / ADMIN / MANAGER see every student; a
  TEACHER only students with a shared `Lesson` or `TeacherReferral`. The page answers `notFound()` otherwise (no
  enumeration); anonymous / STUDENT → `/portal/login`. The target must have role STUDENT (else 404).
- **`/portal/students/[id]`** (server gate + `components/portal/student/StudentPortalTabs.tsx`): header with name, id and
  join date; `?tab=` selects the initial tab. All panels stay mounted, so local edits survive tab switches.
  - **Profile** (`ProfileTab.tsx`): personal + parent details with WhatsApp buttons (`https://wa.me/<E.164>`), age from
    birth date. Missing profile values fall back to `User.name` split and the latest `IntakeAssessment` grade / units.
    Staff managers edit fields inline and toggle 10 status checkboxes (`STUDENT_STATUS_OPTIONS`: תלמיד, לחזור להורה,
    לחזור לתלמיד, לא רלוונטי, לא עונה בכלל, ביטול מנוי, תקוע/זורם/רותח 160, מיפוי נכשל), saved immediately with rollback on
    failure. Teachers see statuses read-only and no invoice fields.
  - **Courses** (`CoursesTab.tsx`): lessons grouped by package (or title + teacher), recurring weekday/hours in Israel
    time, one-time vs subscription (package credits > 1, or several active lessons without a package), teacher, next
    meeting + count. Intake assessments appear as mapping rows.
  - **Meetings** (`MeetingsTab.tsx`): last 100 lessons, "נוכח" (green) / "לא נוכח" (grey) on started, non-cancelled
    lessons. Only the lesson's teacher or a staff manager may mark; `Lesson.status`, payouts and credits are untouched.
  - **Communication** (`CommunicationTab.tsx`): history table (date, type, context, author + role, content with
    expand) and "הוסף סיכום / הודעה". The modal's dropdown loads a template into the editor at once; choice fields get
    quick-pick buttons that rewrite their line. Save validates in the browser, POSTs, then reloads via GET.
  - **Standing orders** (`StandingOrdersTab.tsx`, staff managers only): status (cancelled flag → בוטל, credits > 0 →
    פעיל, paid but 0 credits → החבילה נוצלה, else אין מנוי), credit balance, card brand + last 4 read from Stripe for the
    latest completed `pi_…` payment (4 s timeout, never throws, not stored), and charge history from `Payment`. Checkout is
    one-time (`mode: "payment"`), so the tab states there is no automatic recurring charge.
- **Templates** (`lib/communication-templates.ts`): סיכום שיחה לאחר מיפוי (REPRESENTATIVE / MANAGER / ADMIN),
  סיכום שיעור and סיכום מיפוי (TEACHER / MANAGER / ADMIN), plus כללי for every staff role. The text is the source of truth:
  `parseTemplateContent` reads labelled lines back into `structuredData` (multi-line values, ״/" tolerant), checks choices
  against the spec lists, scores 0–100 and required lines, and parses topic ranking lines into `{ rank, topic, score }`.
  MANAGER is stored as `authorRole: "PEDAGOGIC_MANAGER"`.
- **Entry point:** recent intakes on `/portal/dashboard` link to the student screen (`RecentIntake.studentId`).
- **Known gaps:** `User` name / phone / parent contact are read-only on this screen. (The student directory and the
  teacher links from `/dashboard` were added in Sprint 11.)
- Tests: `tests/student-tabs-and-templates.test.ts` (20 tests).

### Teacher sign-up sealed, staff intake portal (Sprint 10)

- **Public registration = students and parents only.**
  - `app/register/page.tsx` has a single "תלמיד/ה, סטודנט/ית או הורה" card → `/register/student`, the heading
    "הרשמה ל-PROJECT100", and a small footnote "מעוניין ללמד אצלנו? הגש מועמדות להוראה" → `/careers`.
  - `app/register/teacher/page.tsx` only calls `redirect("/careers")`; the old direct sign-up form is gone.
  - `POST /api/register` now returns `403` for `role: "TEACHER"` (any case) before touching the DB, and always
    creates `STUDENT`. The TeacherProfile branch was removed. Without this, the API alone still opened teacher
    accounts after the UI was removed.
  - **Known gap:** there is no admin flow yet that turns an accepted `/careers` candidate into a teacher
    account. Until one is built, teacher users can only be created directly in the database.
- **Role routing** (`lib/auth/staff-roles.ts`): `staffPortalHome` → ADMIN/MANAGER `/admin`, REPRESENTATIVE
  `/portal/dashboard`, TEACHER `/dashboard`. `/dashboard` sends a REPRESENTATIVE on to `/portal/dashboard`.
- **Mapping-call queue** (`lib/intake-queue.ts`, server only): a candidate is pending until it has an
  `IntakeAssessment`.
  - Leads: `FallbackLead` with `isHandled = false` and no intake.
  - Students: `role = STUDENT`, registered within 30 days (`NEW_STUDENT_WINDOW_DAYS`), no intake.
  - Helpers: `countPendingIntakes`, `getPendingIntakeCandidates` (≤100 of each, merged newest first),
    `getIntakeCandidate(kind, id)` for deep links, `getRecentIntakes(10)`.
- **`/portal/dashboard`** (server component, `force-dynamic`): anonymous / STUDENT → `redirect("/portal/login")`;
  TEACHER → `redirect("/dashboard")` (weekly board stays there); REPRESENTATIVE / ADMIN / MANAGER see the pending
  count (leads + new students), one primary action "התחל שיחת מיפוי חדשה" → `/portal/intake`, the next 5 in queue
  (deep links `?leadId=` / `?studentId=`), and the 10 latest intakes (name, grade, weak topic, representative,
  date in Israel time). ADMIN/MANAGER also get a "לוח ניהול" link to `/admin`.
- **`/portal/intake`** (server gate + `IntakeWorkspace.tsx` client): anything other than REPRESENTATIVE / ADMIN /
  MANAGER → `redirect("/portal/login")`.
  - Left panel: searchable queue (name or phone digits) showing name, phone, source, date and requested
    subject / class track. A deep-linked candidate that is no longer pending is still loaded and preselected.
  - Right panel: two tabs, "שאלון תלמיד" and "שאלון הורה". The field list lives in `lib/intake-form.ts`
    (`STUDENT_INTAKE_FIELDS` / `PARENT_INTAKE_FIELDS`), covering every `IntakeAssessment` questionnaire field. It
    uses text with suggestions, number, date, yes/no toggles and 1–5 ratings, and required fields are marked.
  - Submit: `buildIntakePayload` turns form strings into the API body (numbers, booleans, `null` for blanks;
    unparseable numbers are sent as-is so validation reports them). The same `parseIntakeAssessment` runs in the
    browser first, then `POST /api/admin/intake`. Success shows "השאלון של … נשמר", removes the candidate from the
    queue and offers the next call.
- **Portal chrome:** `app/portal/PortalHeader.tsx` (staff nav, admin link, logout → `/portal/login`; moved to
  `components/portal/PortalHeader.tsx` in Sprint 11); the
  marketing Navbar/Footer stay hidden on `/portal/*`.
- Tests: `tests/staff-intake-portal.test.ts` (27 tests): register hub/redirect/API seal, page gates for
  anonymous/STUDENT/TEACHER, queue filters, form ↔ API field and required-flag parity, payload → `POST` round trip.

### Public/staff split, careers and intake (Sprint 9)

- **Public UI is for students and parents only.** `components/Navbar.tsx` and the home-page hero contain no staff
  or teacher-recruitment entry (verified; there were none to remove). `components/Footer.tsx` has one discreet link,
  "הצטרפות לנבחרת ההוראה" → `/careers`. `/login` heading reads "כניסה למנויים"; `/register` hub card reads "תלמיד/סטודנט".
- **Staff gate `/portal/login`** (`app/portal/login/page.tsx`): rendered without the marketing Navbar/Footer
  (`AppShell` treats `/portal/*` like the classroom). It posts to `/api/login` with `portal: "staff"`; the route
  verifies the password, then returns `403` **before** signing a session if the role is not in
  `STAFF_PORTAL_ROLES` (`TEACHER`, `REPRESENTATIVE`, `ADMIN`, `MANAGER`; `lib/auth/staff-roles.ts`). ADMIN/MANAGER
  land on `/admin`, TEACHER/REPRESENTATIVE on `/dashboard`. The regular `/login` still accepts every role.
- **New role `REPRESENTATIVE`** (additive enum value). `/api/register` can still only create STUDENT/TEACHER, so
  the role is assigned by an admin only. Representatives are redirected away from `/lessons/[id]`; their
  dashboard is `/portal/dashboard` (Sprint 10).
- **`/careers`** (`app/careers/page.tsx`): full name, phone, email, education/degree, years of experience, teaching
  frameworks (`SCHOOL` / `INSTITUTE` / `PRIVATE` / `ACADEMIA` / `OTHER`) + previous institutions, subjects, and an
  https CV link (no anonymous file upload — `/api/upload` requires a session).
- **`POST /api/careers/apply`**: validated by `parseTeacherCandidateApplication` (`lib/teacher-candidate.ts`), phone
  normalized with `normalizeToE164` (invalid → `400`). Stored as `AuditLog { action: "TEACHER_CANDIDATE_APPLIED",
  entityType: "TeacherCandidate", entityId: <E.164 phone>, actorId: null, metadata: { …application, status: "NEW",
  submittedAt } }`. A repeat from the same phone within 24 h returns the original id (`duplicate: true`). Never
  creates a User, TeacherProfile or session. Public in middleware and rate-limited as `api` (30/min).
- **`/api/diagnostic/unlock`**: the invented `https://chat.whatsapp.com/quad-…` link and its `user.update` are
  gone, as is the `sendQuadGroupInvite` call. The response carries `groupStatus` (`EXISTING` when
  `User.whatsappGroupId` is set, else `PENDING_TEACHER_ASSIGNMENT`), and `quadGroupUrl` is returned only for a live
  group, so legacy placeholder links stored before Sprint 8 are hidden. Groups are opened only by
  `/api/whatsapp/dispatch-channel`.
- **`IntakeAssessment`** model: `studentId → User` (cascade), `fallbackLeadId → FallbackLead` (cascade),
  `representativeId → User` (set null), plus the student questionnaire (grade, levelUnits, hobbies, exam dates/score,
  strong/weak topic, perception, goals, first-month target, …) and the parent questionnaire (yearly goal, target and
  average score, motivation, success definition, home study time, quiet space, equipment, siblings, learning
  disabilities, emotional difficulties, past help + 1–5 progress, home language, 1–5 involvement, notes,
  representative notes).
- **`/api/admin/intake`**: `requireAuth(["REPRESENTATIVE", "ADMIN", "MANAGER"])`. `POST` validates with
  `parseIntakeAssessment` (`lib/intake-assessment.ts`: required texts, strict booleans, scores 0–100, ratings 1–5,
  hobby frequency 0–14, dates 2000–2100; at least one of `studentId` / `fallbackLeadId`; all errors reported in
  Hebrew), checks the student exists with role STUDENT and/or the lead exists (`404`), stores
  `representativeId = session user` (a body value is ignored), and writes AuditLog `INTAKE_ASSESSMENT_RECORDED`.
  `GET ?studentId=` / `?leadId=` returns the latest 20.
- **Migration** `20260929194238_add_intake_assessment` was generated with `prisma migrate diff` from the committed
  schema (the `--from-migrations` form needs a shadow database). **Run `npx prisma migrate deploy` before deploying.**
- Tests: `tests/intake-and-routing.test.ts` (31 tests).

### Live quad WhatsApp group (Sprint 8)

- **`createWhatsAppQuadGroup({ student, teacher, parent?, lesson, questionnaireUrl? })`** in `lib/whatsapp.ts`
  replaces the old scaffold, which posted to `/groups` and fell back to invented `mock-quad-…` invite links.
  - **Members:** student, teacher, parent (optional) and `WHATSAPP_ADMIN_PHONE`, each normalized with
    `normalizeToWhatsAppJid`. Missing, invalid or duplicate numbers are dropped and listed in `droppedRoles`.
    A valid, distinct student **and** teacher are required.
  - **Group name:** `"<student> <subject> | PROJECT100"`, max 25 characters. The brand suffix is kept; the
    prefix steps down from full name + subject to first name + subject, then full name, then first name,
    then a hard cut (e.g. `מתן מתמטיקה | PROJECT100`).
  - **Gateway call:** `POST {WHATSAPP_API_URL}/createGroup` with `{ groupName, chatIds }`, Bearer
    `WHATSAPP_API_KEY`, 10 s timeout. The group id is read from `chatId`, `groupId`, `gid(._serialized)` or `id`
    and must end in `@g.us`. The invite link is read from `groupInviteLink` / `inviteLink` / `inviteUrl`.
  - **Welcome message:** built by `buildQuadWelcomeMessage`, with the day, `DD.MM.YYYY` and `HH:MM-HH:MM`
    shown in Israel time. It is posted into the group with `sendWhatsAppMessage`. The questionnaire link
    defaults to `/onboarding/diagnostic`.
  - **Never throws.** Failures return `{ ok: false, error: { code } }` with code `NOT_CONFIGURED |
    MISSING_REQUIRED_PARTICIPANT | TIMEOUT | NETWORK | GATEWAY_ERROR | INVALID_RESPONSE`. A group that was
    created but whose welcome message failed returns `ok: true` with `welcome.sent = false`.
- **`POST /api/whatsapp/dispatch-channel`** (TRIO/MULTI/TEN):
  - The group opens only when the student has a future `SCHEDULED` lesson with a teacher; until then the
    status is `PENDING_TEACHER_ASSIGNMENT` (tone rule: "ייפתח לאחר שיבוץ"). An existing
    `User.whatsappGroupId` → `EXISTING`, and the group is never opened twice.
  - Members come from the DB (student, parent, lesson teacher). A `studentPhone` in the request body never
    joins a group. The subject comes from the latest `DiagnosticQuiz`, falling back to `Lesson.title`.
  - On success it stores `User.whatsappGroupId = <chatId>` and `quadGroupUrl = <invite link | null>`
    (clearing old placeholder links), then writes AuditLog `WHATSAPP_QUAD_GROUP_CREATED` with chat id, lesson,
    teacher, roles, dropped roles and welcome status.
  - On failure the response is `{ success: false, data: { groupStatus: "FAILED", errorCode } }` with status
    `503` (not configured), `422` (missing member) or `502` (gateway). Nothing is persisted.
  - Response `data` now includes `groupStatus`, and `modeLabel` only says the group opened when it did.
    The separate invite-link message is gone because members are added directly.
- **WhatsApp Closer** (`dispatchWhatsAppCloser`, diagnostic teaser + `/api/whatsapp/closer`): it no longer
  creates groups (no teacher or lesson exists yet at that stage). It only shares an existing group link.
  `isGroupOpened` is always `false` there.
- **Schema:** `User.whatsappGroupId String?` (additive), migration `20260929190000_user_whatsapp_group_id`.
  **Run `npx prisma migrate deploy` before deploying this code** — the route selects the column.
- Tests: `tests/whatsapp-quad-group.test.ts`.

### Teacher apply IDOR (Sprint 6)

- `POST /api/teachers/apply` previously resolved the applicant as `x-user-id || body.userId`, so any
  logged-in user could create or overwrite another account's `TeacherProfile`, including bank details.
- Identity now comes only from `requireAuth()` (session cookie → DB user). `body.userId` and client
  `x-user-id` are ignored. No session or a forged one → `401` before the body is read.
- Tests: `tests/teacher-apply-security.test.ts`.

### Serverless agent swarm (Sprint 6)

- **`lib/agents/core/llm.ts`** — `callAgentLLM({ systemPrompt, userPrompt, model, temperature,
  responseFormat, timeoutMs })`. Uses plain `fetch` to `https://openrouter.ai/api/v1/chat/completions`.
  `OPENROUTER_API_KEY` and `MODEL_AUTOMATION` (default `deepseek/deepseek-chat`) are read per call. An
  `AbortController` enforces a hard **25 s** deadline, and callers can only shorten it. The timer is
  cleared in `finally`. Failures throw a typed `AgentLLMError` with `code` = `CONFIG | TIMEOUT | HTTP |
  EMPTY_RESPONSE | NETWORK`, so an abort never crashes the function.
- **`lib/agents/lead-agent.ts`** — `runLeadAgent()` picks leads from the last 48 h:
  - `User` with role `STUDENT`, no non-cancelled `Lesson`, no `BillingLedger` `CHARGE` and no `COMPLETED`
    `Payment`;
  - unhandled `FallbackLead` rows from the web form.
  Phones are normalized with `normalizeToWhatsAppJid` (`972…@c.us`). Invalid numbers and duplicate JIDs are
  skipped. The LLM receives only the first name and requested track, never the phone. It returns
  `{"message": …}` in plain Hebrew (anti-slop prompt), and the code appends a fixed opt-out line
  (`"הסר"`). Sending, dedup and the per-run cap are described under Sprint 7 below.
- **`app/api/agents/dispatch/route.ts`** — `GET|POST /api/agents/dispatch?agent=leads`,
  `maxDuration = 30`. Auth is `verifyCronRequest` only (`CRON_SECRET` bearer or a verified QStash
  signature), otherwise `401`. An unknown agent → `400`. Response:
  `{ success: true, agent: "leads", processedCount, sentCount, failedCount, skippedCount }`. The path is in
  the middleware's `PUBLIC_API_ROUTES` (as `/api/cron/*` is) so scheduler calls without a session reach
  the handler; the handler check is the only gate.
- Tests: `tests/lead-agent.test.ts`.

### Lead dispatch loop (Sprint 7)

- **Live send:** after drafting, each lead is sent with `sendWhatsAppMessage(phoneJid, text, { timeoutMs:
  5000 })` from `lib/whatsapp.ts`. This function was added in Sprint 7: it returns `{ messageId, mocked }`,
  and `sendWhatsAppText` now wraps it. Every send has its own `try/catch`, so one failure (`failedCount`,
  reason `WHATSAPP_ERROR`) never stops the rest of the queue.
- **AuditLog record:** after a successful send the agent writes `AuditLog { action:
  "LEAD_REENGAGEMENT_SENT", entityType: "User" | "FallbackLead", entityId: <lead id>, actorId: null,
  metadata: { agent, source, phoneJid, messageId, sentAt } }`. If that write fails, the message still counts
  as sent and a `console.error` warns that the lead is not protected by the cooldown.
- **14-day cooldown:** each run first loads `LEAD_REENGAGEMENT_SENT` rows from the last 14 days.
  - Those lead ids are excluded **inside** the candidate query (`id: { notIn }`), so contacted leads can
    never fill the cap and block newer ones. They are still reported as `ALREADY_CONTACTED` in
    `skippedCount`.
  - Contacted phone JIDs are matched too, so a web lead and a registered user with the same number are
    messaged once.
- **Per-run cap:** 12 leads (`MAX_LEADS_PER_RUN`). Draft and send run 4 leads at a time within a 24 s budget
  (the LLM window is the time left minus the 5 s send reserve). Leads that no longer fit are skipped as
  `DEADLINE` and picked up by the next run.
- **Truthful results:** if `WHATSAPP_API_URL` / `WHATSAPP_API_KEY` are unset, no drafts or sends happen
  (`WHATSAPP_NOT_CONFIGURED`). A gateway that only mocked a send → failed `WHATSAPP_NOT_DELIVERED`, with no
  AuditLog row. Nothing is marked as sent unless the gateway accepted it.
- **Result:** `{ processedCount, sentCount, failedCount, skippedCount, sent[], failed[], skipped[] }`.
  `processedCount` = `sentCount + failedCount`, i.e. leads that reached the send step.
- **Known gap:** a send that times out after the gateway already accepted it is counted as failed with no
  AuditLog row, so that lead may be messaged again on the next run.
- **QStash schedule** (`scripts/setup-qstash-schedules.ts`, id `agent-leads`): `POST
  /api/agents/dispatch?agent=leads`, cron `CRON_TZ=Asia/Jerusalem 0 10,17 * * *` (10:00 and 17:00 Israel
  time), 1 retry, forwarded `Authorization: Bearer <CRON_SECRET>`. QStash also signs each delivery with
  `Upstash-Signature`. Apply it with `npm run qstash:schedules`.
- Tests: `tests/lead-agent-execution.test.ts`.

### Identity header hardening (Sprint 5)

- `proxy.ts` (formerly `middleware.ts`) routes every forwarded request through one helper that **deletes** the client-supplied
  `x-user-id` header and re-sets it **only** from a verified session JWT (`verifySession` on
  `project8_session`). Public routes, auth pages, the Hive M2M bearer path and forged/expired cookies all
  forward without `x-user-id`. It uses `NextResponse.next({ request: { headers } })`, so Next replaces the
  downstream request headers instead of passing the originals through.
- `GET/POST /api/teachers/me/vetting` no longer reads `x-user-id`. Identity comes from `requireAuth()`
  (`getCurrentUser()` → session cookie + DB). No session → `401`. The profile is looked up by the session
  user (`teacherProfile.findUnique({ userId })`). Before this, a missing header meant an unfiltered
  `findFirst`, which returned, and accepted exam-581 submissions for, the newest teacher profile of any user.
- The same route's multipart exam-581 upload no longer calls `request.json()` before `formData()`, which
  had consumed the body.
- Tests: `tests/vetting-security.test.ts`.

### Daily.co recordings (Sprint 5)

- `POST /api/webhooks/daily` (`recording.ready-to-download`) stores `Lesson.videoRecordingUrl =
  "daily-rec:<recording_id>"` (from `payload.recording_id`, falling back to `payload.id`). Any expiring
  `download_link` in the payload is ignored. Missing or malformed ids (only `[A-Za-z0-9-]` is allowed) are
  recorded on `WebhookEvent.error` and nothing is persisted.
- `GET /api/daily/signed-url?lessonId=` (participant or ADMIN/MANAGER only) parses the reference with
  `parseDailyRecordingRef` (`daily-rec:<id>` or a bare id). On **every** request it calls
  `GET https://api.daily.co/v1/recordings/:id/access-link?valid_for_secs=3600` with `DAILY_API_KEY` and
  returns `{ url, expiresAt }` with `Cache-Control: no-store`. The link lasts 1 h, inside the 2 h
  presigned-URL cap. A Daily API failure → `502`.
- Legacy rows that still hold a raw download URL return `410` (those links have already expired and carry
  no usable id). The stored URL is never served.
- Helpers in `lib/daily.ts`: `toDailyRecordingRef`, `parseDailyRecordingRef`, `getRecordingAccessLink`
  (replaces `getRecordingDownloadUrl`), `DAILY_RECORDING_LINK_TTL_SECONDS`.
- Tests: `tests/daily-recording.test.ts`.

### Rate limiting (Sprints 3–4)

- `lib/security/rate-limit.ts` — `checkRateLimit(req, "auth" | "api")`, Upstash sliding window keyed by
  `path + client IP` (first `x-forwarded-for` hop, then `x-real-ip`).
  - `auth`: 15 requests / 60 s — `/api/login`, `/api/register`, `/api/auth/*` (sized for a classroom behind
    one school NAT IP; raised from 5 in Sprint 4).
  - `api`: 30 requests / 60 s — `/api/leads`.
- `proxy.ts` returns `429` JSON + `Retry-After` when a limit is exceeded. `/api/cron/*` is fully exempt.
  It never returns `503` for rate-limiter problems.
- The per-instance in-memory `Map` limiter (`lib/rate-limit.ts`) was **removed**; no rate-limit state lives
  in instance memory anymore.
- Failure policy (monitored fail-open since Sprint 4):
  - Redis unset outside production → bypass + one-time `console.warn`.
  - Redis unset in production, or a Redis runtime error → request allowed, result flagged `degraded`, and
    `console.error("[rate-limit] DEGRADED …")` at most once per minute per instance — alert on that string.

### Serverless hardening (Sprint 4)

- `lib/curriculum-agent.ts` no longer loads `agents_hive/.env` via dotenv; config is read per call from the
  platform env. OpenRouter calls use a 45 s timeout (`CURRICULUM_AGENT_TIMEOUT_MS`) with `maxRetries: 0`,
  and timeouts return a clear error instead of hanging the admin route.
- `lib/storage.ts` — the `public/uploads` local-disk fallback for board images runs only in development.
  On Vercel / Lambda / Netlify or in production without Supabase, `uploadBoardImage` throws a clear
  configuration error instead of attempting a write to the read-only filesystem.

### CI (`.github/workflows/ci.yml`)

On push / PR to `main` (Node 22): `npm ci` → `prisma generate` + `prisma validate` → `tsc --noEmit` → `npm test`.

Vercel runs `npm run build`, which itself runs `prisma generate` before `next build` (Sprint 11b).