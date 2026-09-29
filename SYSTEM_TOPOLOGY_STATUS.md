# SYSTEM TOPOLOGY STATUS — Project 8 (Spec 1.9 / Step 7)

> Final wiring map as-built. Status: **FULLY WIRED** — every layer verified by
> `scripts/test-live-db-pipeline.ts` (Live-DB), `agents_hive/test_hive_mcp_tools.py`
> (9 FastMCP tools) and `scripts/verify-closed-loop-e2e.ts` (13 static checks).

---

## 1. Four Architecture Layers

| Layer | Files (responsibility) | Status |
|---|---|---|
| **L1 — Data / Prisma** | `prisma/schema.prisma` — 19 models, 9 enums; Postgres/Neon | ✅ Live (additive-only; migrations synced — see §6) |
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
| `WHATSAPP_ADMIN_PHONE`, `WHATSAPP_TEACHER_PLACEHOLDER_PHONE` | Quad-group admin / teacher members (omitted when empty — no fake fallbacks) |
| `DAILY_DOMAIN` | Teacher permanent room links (`lib/teacher-welcome.ts`; warns + falls back to `project100.daily.co`) |
| `NEXT_PUBLIC_EXAM_581_PDF_URL` | Teacher onboarding exam-581 PDF |
| `TELEGRAM_BOT_TOKEN`, `MANAGER_ALERT_PHONE`, `MANAGER_ALERT_TELEGRAM_CHAT_ID` | Head-of-Desk manager alerts |

---

## 5. Verification Artifacts (`scripts/`)

| Script | Purpose | Status |
|---|---|---|
| `scripts/test-live-db-pipeline.ts` | 6-station live-DB integration + teardown | ✅ (run) |
| `scripts/verify-closed-loop-e2e.ts` | 13 static checks (4 layers + 6 desks) | ✅ 13/13 |
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

Replaying all four migrations reproduces `prisma/schema.prisma` exactly.

**Existing databases that were synced with `db push`** already contain these objects. Mark the sync
migration as applied instead of executing it (running it would fail with "already exists"):

```bash
npx prisma migrate resolve --applied 20260929152923_sync_missing_models
```

If the database has no `_prisma_migrations` history at all, run `migrate resolve --applied` for each of
the four migrations, in order.

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
| 6 | `teachers/apply` IDOR closed; serverless agent swarm: `lib/agents/core/llm.ts`, lead agent, cron-secured `/api/agents/dispatch` | ✅ Completed |

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
- **`lib/agents/lead-agent.ts`** — `runLeadAgent()` picks leads from the last 48 h (max 20 per run):
  - `User` with role `STUDENT`, no non-cancelled `Lesson`, no `BillingLedger` `CHARGE` and no `COMPLETED`
    `Payment`;
  - unhandled `FallbackLead` rows from the web form.
  Phones are normalized with `normalizeToWhatsAppJid` (`972…@c.us`). Invalid numbers and duplicate JIDs are
  skipped. The LLM receives only the first name and requested track, never the phone. It returns
  `{"message": …}` in plain Hebrew (anti-slop prompt), and the code appends a fixed opt-out line
  (`"הסר"`). The result is `{ tasks: [{ leadId, source, phoneJid, messageText }], skipped: [{ leadId,
  reason }] }`. LLM calls run 5 at a time within a 22 s budget: per-call timeouts shrink to the time left,
  and leads that no longer fit are skipped as `DEADLINE`.
  **It prepares tasks only — it does not send WhatsApp messages and does not mark leads as contacted.**
- **`app/api/agents/dispatch/route.ts`** — `GET|POST /api/agents/dispatch?agent=leads`,
  `maxDuration = 30`. Auth is `verifyCronRequest` only (`CRON_SECRET` bearer or a verified QStash
  signature), otherwise `401`. An unknown agent → `400`. Response:
  `{ success: true, agent: "leads", processedCount, skippedCount }`. The path is in the middleware's
  `PUBLIC_API_ROUTES` (as `/api/cron/*` is) so scheduler calls without a session reach the handler; the
  handler check is the only gate. No schedule is registered yet (`vercel.json` / QStash).
- Tests: `tests/lead-agent.test.ts`.

### Identity header hardening (Sprint 5)

- `middleware.ts` routes every forwarded request through one helper that **deletes** the client-supplied
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
- `middleware.ts` returns `429` JSON + `Retry-After` when a limit is exceeded. `/api/cron/*` is fully exempt.
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