# SYSTEM TOPOLOGY STATUS — Project 8 (Spec 1.9 / Step 7)

> Final wiring map as-built. Status: **FULLY WIRED** — every layer verified by
> `scripts/test-live-db-pipeline.ts` (Live-DB), `agents_hive/test_hive_mcp_tools.py`
> (9 FastMCP tools) and `scripts/verify-closed-loop-e2e.ts` (13 static checks).

---

## 1. Four Architecture Layers

| Layer | Files (responsibility) | Status |
|---|---|---|
| **L1 — Data / Prisma** | `prisma/schema.prisma` — 15 models, 12 enums; Postgres/Neon | ✅ Live (db push, additive-only) |
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
- `POST /api/teachers/apply` — apply (creates TeacherProfile + 6 step logs).
- `GET/POST /api/teachers/me/vetting` — status + exam-581 submission (PENDING_REVIEW).
- `GET/POST /api/admin/teachers` & `GET/POST /api/admin/teachers/[id]/vetting`.

### Diagnostics & packages
- `POST /api/diagnostic/teaser` — 5-step funnel (also triggers WhatsApp Closer).
- `GET /api/diagnostic/student` — masked/full diagnostic view.
- `POST /api/diagnostic/unlock` — unlock + teacher match + Quad invite.
- `GET /api/diagnostic/evaluate`, `GET/POST /api/packages/[id]/quiz` — quiz + gaps.
- `GET /api/packages/[id]/report`, `GET/POST /api/packages/[id]/assets`.

### Lessons
- `POST /api/lessons/complete` — close + payout + platform fee (atomic, idempotent).
- `POST /api/lessons/[id]/summary` — pedagogical summary + gap closure.
- `POST /api/lessons/[id]/cancel` / `reschedule` / `rate` / `appeal`.

### WhatsApp
- `POST /api/whatsapp/dispatch-channel` — 1-vs-4 channel routing.
- `POST /api/whatsapp/closer` — full closer engine (analysis + dispatch).

### Admin
- `GET /api/admin/audit/risk-events` — Head-of-Desk risk surface.
- `POST /api/admin/override/compensation` — make-up lesson + PLATFORM_COMPENSATION.
- `GET/POST/PUT/DELETE /api/admin/curriculum` — curriculum tree + syllabus agent.
- `GET /api/admin/payouts`, `POST /api/admin/payouts/settle`, `GET/POST /api/admin/appeals`.

### Cron / Webhooks
- `GET /api/cron/lesson-reminders` (`*/5`), `GET /api/cron/head-of-desk` (`*/15`).
- `POST /api/webhooks/daily`, `POST /api/webhooks/stripe`.

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
| `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL`, `MODEL_*` | Agent Hive reasoning/generation |
| `HIVE_MONITOR_SECRET` | Head-of-Desk server-to-server auth |
| `DAILY_ENABLE_CLOUD_RECORDING` | Daily cloud-recording opt-in |

---

## 5. Verification Artifacts (`scripts/`)

| Script | Purpose | Status |
|---|---|---|
| `scripts/test-live-db-pipeline.ts` | 6-station live-DB integration + teardown | ✅ (run) |
| `scripts/verify-closed-loop-e2e.ts` | 13 static checks (4 layers + 6 desks) | ✅ 13/13 |
| `agents_hive/test_hive_mcp_tools.py` | 9 FastMCP tools | ✅ PASS |
| `scripts/test-curriculum-e2e.ts` | matching-adjacent curriculum E2E | ✅ |

**Feedback loop:** `npx tsc --noEmit` → `TSC EXIT: 0` on every station.