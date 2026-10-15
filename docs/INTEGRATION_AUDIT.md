# Integration Status & Action Plan

Audit date: 15 October 2026. Source of truth is the application code (`lib/`, `app/api/`, `components/`, `scripts/`, `.env.example`). No provider dashboards were opened, and no application code was changed.

Sessions are custom JWTs in `lib/auth.ts` (`jose`, cookie `project8_session`). There is no NextAuth installation and nothing reads `NEXTAUTH_SECRET`.

## How to read this

Each service below has the four sections requested: current code, production env keys, dashboard setup, and the first action that unblocks that service. A key listed under "Required" is one the running code actually reads. Keys that appear in `.env.example` or `lib/env-validator.ts` but are never read are called out as unused.

## Cross-cutting: health checks look at the wrong names

`lib/env-validator.ts` boots production only when `DATABASE_URL`, `UPSTASH_REDIS_REST_URL`, and `UPSTASH_REDIS_REST_TOKEN` are set (`instrumentation.ts`). Everything else is a soft warning. Several of those warnings use names the feature code does not read, so `/api/health` can report a service as missing while it is configured, or as present while the real client is dark.

| Health check key | What the feature code actually reads |
| --- | --- |
| `WHATSAPP_CLOUD_TOKEN` | `WHATSAPP_API_URL` + `WHATSAPP_API_KEY` |
| `TWILIO_SID` | `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` + `TWILIO_FROM_NUMBER` |
| `GOOGLE_CLIENT_ID` only | `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` |
| `STRIPE_SECRET_KEY` only | also `STRIPE_WEBHOOK_SECRET` (credits are granted only in the webhook) |
| `SUPABASE_URL` only | also `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_SERVICE_KEY`) |

Daily, Stream, OpenRouter, QStash, and `AUTH_SECRET` are absent from this check. `AUTH_SECRET` falls back to a hardcoded build-time string in `lib/auth.ts` if it is unset, including in production.

Suggested order of work: Upstash Redis (process will not boot without it), Auth secret + Google, Stripe webhook, Daily token bug, Stream credentials, Supabase bucket, WhatsApp gateway contract, Twilio, then QStash schedules and OpenRouter.

---

## 1. Daily.co (video)

### Current code state

Server helpers live in `lib/daily.ts`. The classroom mounts `@daily-co/daily-js` through `components/VideoRoom.tsx`, fed by `app/lessons/[id]/page.tsx`. Booking (`app/api/lessons/route.ts`) and reschedule (`app/api/lessons/[id]/reschedule/route.ts`) create rooms. Recordings land via `POST /api/webhooks/daily` and are played back through `GET /api/daily/signed-url` (`app/dashboard/lessons/[id]/recording/`).

What is written and working as designed:

- Private rooms named `lesson-<lessonId>`.
- Meeting tokens are time-boxed: `nbf` = `scheduledAt − 15 min`, `exp` = `scheduledAt + durationMinutes + 30 min` (`computeDailyTokenWindow`). Teacher, manager, and admin tokens set `is_owner: true`. Student tokens are join-only.
- Webhook HMAC-SHA256 over `` `${X-Webhook-Timestamp}.${rawBody}` `` with a base64-decoded `DAILY_WEBHOOK_SECRET`. `recording.ready-to-download` stores `daily-rec:<recording_id>` on the lesson. Download links in the payload are discarded. Playback mints a fresh access link (1 hour TTL, under the 2-hour cap).
- Idempotency is stored in `WebhookEvent`. The registration ping `{ "test": "test" }` returns 200.
- Missing `DAILY_API_KEY` returns a mock room URL and a mock token so local booking still proceeds. `VideoRoom` then shows the "test environment" placeholder.

Logical gaps:

1. **Meeting-token `exp` can be in the past.** Room creation was patched so a room's `exp` is always at least four hours ahead (`max(now + 4h, scheduledAt + 4h)` in `createDailyRoom`). Token creation was not. `generateDailyToken` sends the raw window from `computeDailyTokenWindow`. Daily rejects `POST /v1/meeting-tokens` when `exp` is not in the future. The lesson page catches that error, leaves `dailyToken` null, and `VideoRoom` renders the test placeholder. This hits any join after `scheduledAt + duration + 30 minutes` (late join, overtime, reopening an older lesson) even though the room itself is still alive. `nbf`/`exp` are also not clamped against the room's own `exp`, so a long lesson can ask for a token that outlives the room (room expiry ignores `durationMinutes` and is a flat four hours from `scheduledAt`).

2. **Owner tokens always request cloud recording.** `generateDailyToken` adds `start_cloud_recording: true` and `enable_recording: "cloud"` for every owner, with no read of `DAILY_ENABLE_CLOUD_RECORDING`. Room creation adds `enable_recording: "cloud"` only when that flag is exactly `"true"` (the default in `.env.example` is `false`). A teacher token can therefore demand recording on a room that was created without it. Student tokens omit those fields. A teacher who cannot get a token sees the same silent placeholder as a missing API key, because `VideoRoom` swallows join errors.

3. **Docstring and call-site comments are stale.** `createDailyRoom` and the booking route still say room `exp` is `scheduledAt + duration + 10%`. The function accepts `durationMinutes` and never uses it.

4. **Re-provision failure can wipe a stored room URL.** `app/lessons/[id]/page.tsx` persists `ensureDailyRoom`'s return value whenever it differs from `lesson.dailyRoomUrl`. A failed re-create returns `null` and that null is written back.

5. **Webhook handler failures return HTTP 200** (`app/api/webhooks/daily/route.ts`), so Daily will not retry a `recording.ready-to-download` that failed to map a room name. The timestamp is verified as part of the HMAC and is not checked for freshness, so a captured delivery can be replayed until the secret rotates. The unsigned `{ "test": "test" }` body is accepted, which is what Daily's registration ping requires; it does not write a recording.

6. **`DAILY_DOMAIN` is not used to create rooms.** The REST client always calls `https://api.daily.co/v1` and trusts the URL Daily returns. `DAILY_DOMAIN` is only a string prefix in `lib/teacher-welcome.ts` (fallback `project100.daily.co`) for the teacher's welcome link.

### Required environment variables

| Key | Role |
| --- | --- |
| `DAILY_API_KEY` | Server REST key. Required for real rooms and tokens. |
| `DAILY_WEBHOOK_SECRET` | Base64 HMAC secret from webhook creation. Required for recording events. |
| `DAILY_ENABLE_CLOUD_RECORDING` | Set to the exact string `true` to send `enable_recording: "cloud"` on room create. Any other value omits it. |
| `DAILY_DOMAIN` | Welcome-link subdomain only. Must match the domain on the Daily account or the welcome URL is wrong. |
| `APP_URL` | Used when building recording and classroom links elsewhere. Not read by `lib/daily.ts` itself. |

### External setup required

In the Daily dashboard (`https://dashboard.daily.co`):

1. Create a REST API key and set `DAILY_API_KEY`.
2. Confirm the account domain and set `DAILY_DOMAIN` to that host (for example `project100.daily.co`).
3. Enable cloud recording on the plan before setting `DAILY_ENABLE_CLOUD_RECORDING=true`. Room creation fails closed for the booking path when Daily rejects the property, and the booking is rolled back.
4. Create a webhook whose URL is `https://<APP_URL>/api/webhooks/daily`, subscribe at least to `recording.ready-to-download`, and copy the base64 HMAC secret into `DAILY_WEBHOOK_SECRET`. Daily's registration POST must get a 200, which the route already returns.
5. Keep rooms private. The app never puts a recording download link in the database; do not also publish recordings from the dashboard.

### Actionable next step

Fix `generateDailyToken` before buying recording or debugging the dashboard. Two changes, in this order: refuse to send `exp` in the past (and keep token `exp` at or before the room `exp`), and send `start_cloud_recording` / `enable_recording` only when `DAILY_ENABLE_CLOUD_RECORDING=true`. Until that lands, an on-time student can join a non-recording room and a teacher token is the request most likely to 400.

---

## 2. Stream Chat

### Current code state

Server client: `lib/stream.ts` (`stream-chat` ^9.50.2). Browser UI: `components/ClassroomChat.tsx` (`stream-chat-react`), mounted only from `app/lessons/[id]/LessonRoomUI.tsx`. Tokens are minted in `app/lessons/[id]/page.tsx` and again in `GET /api/lessons` (`attachLessonCredentials`). Channels are created at booking time (`createStreamChannel` / `ensureUnifiedPackageStreamChannel` in `lib/package-chat.ts`).

What is written:

- Server `createToken(userId, exp)` with `exp` = now + 4 hours (`STREAM_TOKEN_TTL_SECONDS`). The installed SDK treats the second argument as a Unix `exp` claim. That part is correct when both the key and the secret are set.
- Lesson channel id `lesson_<lessonId>`, package channel id `package-<packageId>`. Members are the teacher, the student, and every `MANAGER` / `ADMIN`.
- Users are upserted under a non-PII name (`User ` + first 4 characters of the id). Phone, email, and external-link regex blocklists are attached to the `messaging` channel type (best-effort; failures are logged).
- The browser censors text again in `doSendMessageRequest` via `lib/chat-moderation.ts` before `sendMessage`.
- Attachments are limited in the composer to images, PDF, and Word.

Why the client reports a missing token:

`ClassroomChat` sets the Hebrew error "חסרים פרטי התחברות לצ'אט" when `apiKey`, `userToken`, `channelId`, or `userId` is empty. The parent only mounts it when all three of key, token, and channel id are truthy, so that branch is the empty-prop guard.

The error people actually hit from the SDK is thrown inside `connectUser` / `TokenManager` (`stream-chat` 9):

- **"User token can not be empty"** when the secret is absent on the browser client and the token string is empty.
- **"userToken does not have a user_id or is not matching with user.id"** when the string is not a JWT whose `user_id` equals `user.id`.
- **"Both secret and user tokens are not set. Either client.connectUser wasn't called or client.disconnect was called"** when `channel.watch()` runs after `disconnectUser()` cleared the singleton.

Those fire for three concrete reasons in this repo:

1. **A mock token is sent to the real API.** `hasStreamCredentials()` is true only when a key and `STREAM_API_SECRET` are both set. Otherwise `generateStreamToken` returns the literal `mock-stream-token-<userId>`, which is a non-empty string, so the UI treats chat as ready. The lesson page still passes `NEXT_PUBLIC_STREAM_API_KEY` (or `STREAM_API_KEY`) into the browser. `connectUser` then validates that mock string, `UserFromToken` finds no `user_id`, and Stream throws. The catch in `ClassroomChat` replaces it with "התחברות לצ'אט נכשלה".

2. **The server and the browser prefer different key variables.** `lib/stream.ts` signs with `STREAM_API_KEY`, then `NEXT_PUBLIC_STREAM_API_KEY`. `app/lessons/[id]/page.tsx` connects with `NEXT_PUBLIC_STREAM_API_KEY`, then `STREAM_API_KEY`. If both are set and they differ, the JWT is signed for one app and presented to another.

3. **One shared `StreamChat.getInstance` plus `disconnectUser` in the effect cleanup.** `ClassroomChat` disconnects that singleton on unmount. A fast remount (React Strict Mode in development, or a dependency change) can call `channel.watch()` on a client whose token manager was just reset, which is the "Both secret and user tokens are not set" error.

Related gap, same symptom in the UI: if a lesson was booked while credentials were unset, `ensureStreamMessagingChannel` persisted `mock-lesson_…` or `mock-package-…`. After secrets are added, the browser watches that id. Stream then fails channel lookup even if the user token is valid. Channels are not repaired on read except for package lessons, which call `createPackageStreamChannel` again.

There is no Stream webhook. Moderation is push-on-channel-create only.

### Required environment variables

| Key | Role |
| --- | --- |
| `STREAM_API_KEY` | Same app key the browser uses. Server prefers this over the public var when signing. |
| `NEXT_PUBLIC_STREAM_API_KEY` | Same value as `STREAM_API_KEY`. Required in the client bundle; the lesson page also inlines whichever is set. |
| `STREAM_API_SECRET` | Server only. Without it, every token is the mock string above. |

### External setup required

In the Stream dashboard (`https://dashboard.getstream.io`):

1. Create a Chat app (or use the existing one) and copy the key into both `STREAM_API_KEY` and `NEXT_PUBLIC_STREAM_API_KEY`. Copy the secret into `STREAM_API_SECRET` only.
2. Leave the app in a mode that accepts server-issued user JWTs. The browser never sees the secret and never calls `devToken`.
3. No webhook URL is required for the current code. Blocklists are created by the server on first channel ensure (`project8_phone_pii`, `project8_email_pii`, `project8_external_links`) and attached to the `messaging` channel type. The API key needs permission to create blocklists and update channel types.
4. After secrets are first set, existing rows whose `streamChannelId` starts with `mock-` need a new channel. The code will not rewrite those ids by itself.

### Actionable next step

Set `STREAM_API_KEY`, `NEXT_PUBLIC_STREAM_API_KEY` (identical), and `STREAM_API_SECRET` together. A public key without the secret is what produces the token error. Confirm with one lesson booked after the secret is present; a lesson booked before that still points at a `mock-` channel id.

---

## 3. WhatsApp (Meta Cloud API / Green API)

### Current code state

Outbound only. The client is `lib/whatsapp.ts`, with a second copy of the same POST in `lib/teacher-welcome.ts`. Callers include lesson reminders (`app/api/cron/lesson-reminders/route.ts`, aliased at `/api/cron/reminders`), quad groups (`POST /api/whatsapp/dispatch-channel`), the closer (`POST /api/whatsapp/closer`), pedagogic decisions, communication summaries, lesson completion, and the lead agent.

The gateway contract the code speaks:

- `POST {WHATSAPP_API_URL}/sendMessage` with `Authorization: Bearer {WHATSAPP_API_KEY}` and JSON `{ phone, chatId, message }`. `chatId` is `972…@c.us` or `…@g.us`.
- `POST {WHATSAPP_API_URL}/sendDocument` as multipart `phone`, `chatId`, `caption`, `file`.
- `POST {WHATSAPP_API_URL}/createGroup` with `{ groupName, chatIds }` where `chatIds` are JIDs. Success requires a body field `chatId` / `groupId` / `gid` / `id` ending in `@g.us`. Invite links are read from `groupInviteLink`, `inviteLink`, `inviteUrl`, or `invite_link`. Message ids are read from Green-API-style `idMessage`, WAHA `id`, or Baileys `key.id`.

That is a private gateway shaped like Green API's JSON, not either official API.

| Official API | What would have to be true | What this repo does |
| --- | --- | --- |
| Meta Cloud API | `POST https://graph.facebook.com/vXX/<PHONE_NUMBER_ID>/messages`, bearer user token, body `messaging_product: "whatsapp"`, recipient digits without `@c.us`, pre-approved templates for business-initiated sends, webhook `GET` hub challenge + `POST` statuses and inbound messages | None of this. `WHATSAPP_CLOUD_TOKEN` is only referenced by `lib/env-validator.ts`. There is no phone-number id, graph version, template name, or webhook route. Cloud API cannot `createGroup`. |
| Green API | `POST https://api.green-api.com/waInstance<id>/sendMessage/<token>` (token in the path, no bearer). Body `{ chatId, message }`. Files go to `sendFileByUpload`. `createGroup` body `{ groupName, chatIds }` matches. Response `idMessage`, `chatId`, `groupInviteLink` matches the parser. | Auth header and paths (`/sendMessage`, `/sendDocument`) do not match. Pointing `WHATSAPP_API_URL` at `api.green-api.com` will 404. |

What is missing for a real inbox:

- No `app/api/webhooks/whatsapp` (no verify token, no signature check, no inbound text/media, no delivery receipts).
- The quad welcome asks the family to reply with a weekly schedule and a photo of the last exam. Nothing stores those replies.
- The lead agent appends an opt-out line (`אם זה לא רלוונטי… השיבו "הסר"`) and has no reader for that reply, so the opt-out cannot be honored.
- No template layer, so a Meta number cannot send the first message outside a customer-care window.
- `sendDocument` has no Green API equivalent under that path.
- Unset credentials log the message and return `{ mocked: true }`. The lead agent treats `mocked` as `WHATSAPP_NOT_DELIVERED`. Other callers often treat a resolved mock as success.
- `WHATSAPP_GATEWAY_URL` is not read. `scripts/verify-production-readiness.ts` already flags that name as a misconfiguration.

Group behavior that does exist: a quad group is created only for multi-lesson packages once a teacher is assigned (`dispatch-channel`). Members are student, teacher, parent when present, and `WHATSAPP_ADMIN_PHONE`. The group id is stored on `User.whatsappGroupId`. Later lessons update that group. Single lessons stay transactional DMs.

### Required environment variables

| Key | Role |
| --- | --- |
| `WHATSAPP_API_URL` | Base URL of the gateway, no trailing path. Required. |
| `WHATSAPP_API_KEY` | Bearer token. Required. |
| `WHATSAPP_ADMIN_PHONE` | E.164 (or any format `normalizeToE164` accepts). Omitted from the group when empty. |
| `WHATSAPP_TEACHER_PLACEHOLDER_PHONE` | Present in `.env.example`. Not read by `lib/whatsapp.ts`. |
| `APP_URL` or `NEXT_PUBLIC_APP_URL` | Classroom and questionnaire links inside message bodies. |
| `WHATSAPP_CLOUD_TOKEN` | Unused by the sender. Setting it only clears the health warning. |

Do not set a Meta token under `WHATSAPP_API_KEY` and expect Cloud API behavior. The body shape will be rejected.

### External setup required

Pick one path. The dashboard work is different, and only the first path matches today's code.

**Path A — keep this client (custom gateway or a thin adapter in front of Green API).** The adapter must implement the three routes above with bearer auth and return `@g.us` plus `idMessage`. Green API's own dashboard still needs an authorized instance (`idInstance` / `apiTokenInstance`), the phone linked by QR, and the instance allowed to create groups. There is no inbound URL to register until a webhook route exists.

**Path B — official Meta Cloud API.** In Meta Business Manager / WhatsApp Manager: a WhatsApp Business Account, a phone number, a permanent system-user token, a phone number id, and message templates for reminders, summaries, and lead follow-ups (Hebrew). Webhook callback URL would be `https://<APP_URL>/api/webhooks/whatsapp` with a verify token. That route does not exist, and group creation would have to be dropped or done outside Cloud API. This path needs new code before any dashboard URL will succeed.

**Path C — official Green API, no adapter.** Change the client to put the token in the URL, call `sendFileByUpload` instead of `sendDocument`, and drop the bearer header. Dashboard: instance, linked device, optional webhook URL (again, no route yet).

### Actionable next step

Do not create a Meta app yet if the goal is to use the code as it stands. Stand up a gateway whose base URL answers `POST /sendMessage`, `POST /sendDocument`, and `POST /createGroup` as specified above, set `WHATSAPP_API_URL` and `WHATSAPP_API_KEY`, and set `WHATSAPP_ADMIN_PHONE` to a real E.164 number. The first code change, if the provider is Meta or raw Green API, is a new sender in `lib/whatsapp.ts` (and the duplicate in `lib/teacher-welcome.ts`) plus an inbound webhook. Until one of those exists, quad groups and the lead agent cannot deliver.

---

## 4. Stripe

### Current code state

One-time Checkout only. `POST /api/payments` (`app/api/payments/route.ts`) creates a `mode: "payment"` session in ILS for `SINGLE` (200 / 1 credit), `TRIO` (540 / 3), `MULTI` (850 / 5), or `TEN` (1600 / 10). Amounts are inline `price_data` (agorot = shekels × 100), not pre-created Price ids. Metadata carries `userId`, `packageType`, `credits`, and `amountPaid`. The caller must be a `STUDENT`.

Credits are granted only in `POST /api/webhooks/stripe` on `checkout.session.completed`, after `stripe.webhooks.constructEvent`. The handler writes `Payment`, increments `User.lessonCredits`, and appends a ledger `CHARGE`. Idempotency is `WebhookEvent.externalId` (the Stripe event id) plus a lookup on `transactionId` (the PaymentIntent id, or the session id if the intent is missing).

`lib/student-portal.ts` reads the card brand and last 4 from the PaymentIntent for the billing tab. That is display-only.

Gaps:

- **`payment_status` is not checked.** A `checkout.session.completed` event with `payment_status` other than `paid` still grants credits. Card payments are usually `paid` at that event; delayed methods are not.
- **No refund, dispute, or `payment_intent.payment_failed` handler.** A refund issued in the Stripe dashboard does not remove credits. In-app cancellation refunds are ledger rows, not Stripe refunds.
- **`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is unused.** Checkout is a redirect; the publishable key is never imported. It is safe to set and currently does nothing.
- **No Customer, `customer_email`, or receipt.** The session is not attached to a Stripe Customer, so the dashboard history is a list of guest payments.
- **Webhook not configured returns 503**, and the student has already paid. Credits never appear until the endpoint and `STRIPE_WEBHOOK_SECRET` exist and the event is resent.
- **Mock mode** (`STRIPE_SECRET_KEY` unset or the string `mock`) grants credits immediately when `NODE_ENV !== "production"`. In production the same request returns 503. That split is correct.
- Success and cancel URLs are same-origin relative paths. `APP_URL` / `NEXT_PUBLIC_APP_URL` build the absolute URL Stripe redirects to. A wrong `APP_URL` sends the student to the wrong host after payment; the webhook would still grant credits.

### Required environment variables

| Key | Role |
| --- | --- |
| `STRIPE_SECRET_KEY` | Secret key (`sk_live_…` in production). Required. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret (`whsec_…`) for this endpoint. Required or the route stays 503. |
| `APP_URL` or `NEXT_PUBLIC_APP_URL` | Absolute origin for `success_url` and `cancel_url`. |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Unused by current code. |

### External setup required

In the Stripe dashboard, on the same mode (test vs live) as the secret key:

1. Enable ILS if the account does not already charge in shekels. `currency: "ils"` is hardcoded.
2. Developers → Webhooks → add endpoint `https://<APP_URL>/api/webhooks/stripe`.
3. Subscribe to `checkout.session.completed`. That is the only event the handler acts on. Subscribing to `charge.refunded` or `charge.dispute.created` does nothing until a handler exists.
4. Copy that endpoint's signing secret into `STRIPE_WEBHOOK_SECRET`. A secret from a different endpoint, or from the Stripe CLI, will 401.
5. Use a live secret key and a live webhook secret together. Mixing `sk_test_` with a live `whsec_` fails verification.
6. After the first real payment, confirm a `Payment` row and a credit increment. If the endpoint was down, resend the event from the dashboard; the handler is idempotent.

### Actionable next step

Create the live webhook endpoint for `checkout.session.completed` and set `STRIPE_SECRET_KEY` plus `STRIPE_WEBHOOK_SECRET`. Checkout without the webhook takes money and grants nothing. The first code gap to close after that is refusing to grant credits unless `session.payment_status === "paid"`.

---

## 5. Twilio (SMS)

### Current code state

SMS exists only for password reset. `lib/otp.ts` posts to `https://api.twilio.com/2010-04-01/Accounts/{TWILIO_ACCOUNT_SID}/Messages.json` with HTTP Basic auth and form fields `To`, `From`, `Body`. `To` is passed through `normalizeToE164` (Israeli `05…` becomes `+972…`).

`POST /api/auth/forgot-password` stores a bcrypt hash of a 6-digit code, 10-minute TTL, purpose `PASSWORD_RESET`, then calls `sendSmsOtp`. `POST /api/auth/reset-password` checks the hash, allows 5 attempts, and replaces `User.password`. There is no login OTP and no Twilio Verify service.

Provider order: Twilio if all three Twilio vars are non-empty, else `SMS_API_URL` + `SMS_API_KEY` as a generic bearer JSON POST `{ phone, message }`, else in development a console log, else throw. The forgot-password route catches a send failure and still returns `{ sent: true }` with the same copy used when the phone is unknown, so a Twilio outage is indistinguishable from success.

Gaps:

- **Lookup format does not match stored phones.** Registration stores `User.phone` as local Israeli mobile `05XXXXXXXX` (`normalizeIsraeliMobile`). Forgot-password looks up `normalizePhone`, which only strips spaces, dashes, and parentheses. `050-123-4567` matches. `+972501234567` or `972501234567` does not, the route returns the uniform success body, and no SMS is sent.
- **`TWILIO_SID` is the health-check name and is never read.** A correct `TWILIO_ACCOUNT_SID` still leaves `/api/health` reporting Twilio as missing.
- **OTP entropy is `Math.random`.** Fine for a prototype; production should use `crypto.randomInt`.
- **No alphanumeric sender handling and no Messaging Service SID.** `From` must be a Twilio number (or an approved sender) in `TWILIO_FROM_NUMBER`. Israeli delivery often needs a local number or a registered sender; a US long code will be filtered.
- Console fallback is compiled out of production by `NODE_ENV`. An unset Twilio config in production throws inside the route and is then swallowed.

### Required environment variables

| Key | Role |
| --- | --- |
| `TWILIO_ACCOUNT_SID` | Account SID (`AC…`). The code does not read `TWILIO_SID`. |
| `TWILIO_AUTH_TOKEN` | Auth token. |
| `TWILIO_FROM_NUMBER` | E.164 sender, for example `+972…`. |
| `SMS_API_URL` | Optional fallback. Used only when Twilio is not fully set. |
| `SMS_API_KEY` | Bearer token for that fallback. |

### External setup required

In the Twilio console:

1. Copy Account SID and Auth Token into `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`.
2. Buy or port a number that can send SMS to Israel. Put it in `TWILIO_FROM_NUMBER` in E.164.
3. Geo permissions: allow Israel as a destination (Messaging → Settings → Geo permissions).
4. If the account is still in trial, verify every destination number or upgrade. Trial accounts reject unverified `To` numbers.
5. No webhook is required. Status callbacks are not implemented.

### Actionable next step

Set the three `TWILIO_*` variables the sender reads (not `TWILIO_SID`), with a From number allowed to reach Israeli mobiles. Then align forgot-password lookup with `normalizeIsraeliMobile` so `+972…` finds the `05…` row. Until that lookup matches, a correctly configured Twilio account still sends nothing for the numbers people paste from their phone.

---

## 6. Supabase Storage

### Current code state

`lib/storage.ts` uploads with the Storage REST API and the service-role key. No Supabase JS client and no user-scoped RLS policies are involved; the service role bypasses them.

| Function | Object path | Callers |
| --- | --- | --- |
| `uploadLessonPdf` | `lessons/<lessonId>/<fileName>` (default `board-summary.pdf`) | `app/api/lessons/complete/route.ts`, `app/api/excalidraw/export/route.ts`, teacher exam upload in `app/api/teachers/me/vetting/route.ts` (`exam-581-<userId>/…` in the same bucket) |
| `uploadBoardImage` | `board-images/<id>.webp\|png\|jpg` | `POST /api/upload` (any logged-in user, JPEG/PNG/WebP/GIF, 5 MB) |

Default bucket name is `lesson-boards`. `SUPABASE_STORAGE_PUBLIC` defaults to **true**. Public mode returns `{SUPABASE_URL}/storage/v1/object/public/<bucket>/<path>`. Private mode (`SUPABASE_STORAGE_PUBLIC=false`) returns a signed URL, default TTL 7 days (`SUPABASE_SIGNED_URL_TTL`).

When the URL or service key is missing, PDF upload returns `null` (the lesson can still complete; WhatsApp is sent without a PDF link). Board images write to `public/uploads/board/` only when `NODE_ENV !== "production"` and the process is not Vercel/Lambda/Netlify. Production without Supabase throws on image upload and the route returns 500.

Gaps:

- **Public-by-default board PDFs and images.** Anyone with the URL can fetch them. The bucket must actually be public in the dashboard or those URLs 400. A private bucket with the default `SUPABASE_STORAGE_PUBLIC=true` produces links that do not open.
- **No bucket-creation step in repo.** The first upload 404s until the bucket exists.
- **GIF is stored with a `.jpg` path** (`uploadBoardImage` maps anything that is not webp/png to jpg) while `Content-Type` stays `image/gif`.
- **`POST /api/upload` checks only that a session exists.** It does not check lesson membership.
- **`upsert` via `x-upsert: true`.** Re-exporting a lesson PDF overwrites the same object. A previously issued 7-day signed URL keeps working for the old bytes until it expires; a public URL shows the new bytes immediately.
- Health checks `SUPABASE_URL` only. A URL without `SUPABASE_SERVICE_ROLE_KEY` looks healthy and uploads stay in mock mode.
- `SUPABASE_SERVICE_KEY` is accepted as an alias of `SUPABASE_SERVICE_ROLE_KEY`. The anon key must not be placed in either variable; Storage writes would then depend on policies this code does not create.

This client does not use Supabase Auth or the Supabase database. `DATABASE_URL` may point at Neon or anywhere else.

### Required environment variables

| Key | Role |
| --- | --- |
| `SUPABASE_URL` | Project URL, `https://<ref>.supabase.co`. |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role. Server only. `SUPABASE_SERVICE_KEY` is an accepted alias. |
| `SUPABASE_STORAGE_BUCKET` | Optional. Default `lesson-boards`. |
| `SUPABASE_STORAGE_PUBLIC` | Optional. Default `true`. Set `false` for signed URLs. |
| `SUPABASE_SIGNED_URL_TTL` | Optional seconds. Default `604800` (7 days). Used only when the bucket is private. |

### External setup required

In the Supabase project (Storage, not Auth):

1. Create a bucket named `lesson-boards` (or the name in `SUPABASE_STORAGE_BUCKET`).
2. If `SUPABASE_STORAGE_PUBLIC` stays at its default, set the bucket to **public**. If the bucket is private, set `SUPABASE_STORAGE_PUBLIC=false` so the app returns signed URLs.
3. Copy the project URL and the **service_role** key into `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Do not use the anon key.
4. No CORS change is required for the current flow: uploads are server-side, and the browser loads the returned URL as a normal image or PDF link.
5. Service role bypasses RLS. Extra Storage policies are optional hardening if any other client uses the anon key against this bucket. This app does not.

### Actionable next step

Create the `lesson-boards` bucket and set it public, then set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. That is the minimum for whiteboard images and board PDFs on Vercel. Switch the bucket to private and set `SUPABASE_STORAGE_PUBLIC=false` before real student work is stored; the upload code already supports signed URLs.

---

## 7. Upstash (Redis and QStash)

### Current code state

**Redis.** `lib/security/rate-limit.ts` uses `@upstash/ratelimit` sliding windows: `auth` = 15 requests / 60 s, `api` = 30 requests / 60 s, key `pathname:clientIp`, prefix `project8:ratelimit:<type>`. `proxy.ts` applies `auth` to `/api/login`, `/api/register`, `/api/register/student`, and every `/api/auth/*` path, and applies `api` to `/api/leads` and `/api/careers/apply`. `/api/cron/*` is exempt. Payments, webhooks, lesson booking, and uploads are not rate limited.

Missing Redis env in production is fatal at Node boot (`assertProductionEnv`). If the variables are set but Redis errors or the REST call exceeds 2 seconds, the limiter **fails open** and logs `[rate-limit] DEGRADED` at most once a minute. Outside production the limiter is skipped. The proxy runs on the edge runtime, which does not execute `instrumentation.ts`; the edge bundle still needs the same two Redis variables or it fails open while the Node server refuses to start.

**QStash.** `lib/auth/cron.ts` accepts either `Authorization: Bearer <CRON_SECRET>` or a verified `Upstash-Signature` JWT (issuer `Upstash`, HS256, body SHA-256, `sub` path must match the route). `scripts/setup-qstash-schedules.ts` (`npm run qstash:schedules`) upserts two schedules and forwards the bearer secret:

| Schedule id | Cron | Target |
| --- | --- | --- |
| `lesson-reminders` | `*/5 * * * *` (UTC) | `GET /api/cron/reminders` |
| `agent-leads` | `CRON_TZ=Asia/Jerusalem 0 10,17 * * *` | `POST /api/agents/dispatch?agent=leads` |

`vercel.json` has a single Vercel Cron: `GET /api/cron/head-of-desk` at `0 3 * * *` UTC. Vercel Hobby cannot run the 5-minute reminder, which is why QStash exists. Nothing in the app creates the QStash schedules at boot. If the script has not been run against the production `APP_URL`, reminders and the lead agent never fire. Head-of-desk still runs from Vercel Cron, provided `CRON_SECRET` is set (Vercel sends it as the bearer token).

Reminder copy says "15 minutes" while the query selects lessons starting within **20** minutes (`REMINDER_LOOKAHEAD_MS`). A lesson 18 minutes out gets the 15-minute text. `reminderSent` is set only after both student and teacher sends resolve; one failure leaves the row eligible for the next run.

`QSTASH_TOKEN` is used by the setup script only. Runtime verification uses the signing keys, not the token.

### Required environment variables

| Key | Role |
| --- | --- |
| `UPSTASH_REDIS_REST_URL` | P0. Production boot fails without it. |
| `UPSTASH_REDIS_REST_TOKEN` | P0. |
| `CRON_SECRET` | Bearer secret for Vercel Cron and for the header QStash forwards. Routes fail closed when it is unset. |
| `QSTASH_TOKEN` | Setup script only (`npm run qstash:schedules`). |
| `QSTASH_CURRENT_SIGNING_KEY` | Optional at runtime if the bearer secret is forwarded. Required to accept a raw QStash signature. |
| `QSTASH_NEXT_SIGNING_KEY` | Rotation partner for the current signing key. |
| `APP_URL` | Public `https` origin the setup script registers. `http://localhost` is rejected by the script. |
| `QSTASH_URL` | Optional regional QStash base. Default `https://qstash.upstash.io`. |

### External setup required

1. Upstash console → Redis → create a database → copy the REST URL and REST token into the two `UPSTASH_REDIS_REST_*` variables on **both** the Node environment and the edge/proxy environment (Vercel: same project env is usually enough).
2. Upstash console → QStash → copy the token into `QSTASH_TOKEN` where the setup script runs, and copy both signing keys into `QSTASH_CURRENT_SIGNING_KEY` and `QSTASH_NEXT_SIGNING_KEY` on the deployed app.
3. Generate `CRON_SECRET` (`openssl rand -hex 32`) and set it on Vercel so the daily head-of-desk cron is authorized.
4. From a machine that has `QSTASH_TOKEN`, `CRON_SECRET`, and `APP_URL=https://<production host>`, run `npm run qstash:schedules`. Re-running overwrites the same schedule ids. QStash must be able to reach that origin on the public internet.
5. In Vercel → Project → Cron, confirm the `head-of-desk` entry from `vercel.json` is active. Do not expect Vercel Cron to run the 5-minute reminder.

### Actionable next step

Create the Upstash Redis database and set the two REST variables. Production will not boot without them. Immediately after the first successful deploy, run `npm run qstash:schedules` against the production `APP_URL`; until that script succeeds, lesson reminders and the 10:00/17:00 lead agent do not exist as jobs.

---

## 8. OpenRouter (AI)

### Current code state

Two independent clients. Neither calls the Python FastMCP process at request time. `agents_hive/.env` is not loaded by Next.js.

**Syllabus breakdown.** `lib/curriculum-agent.ts` uses the OpenAI SDK with `baseURL` default `https://openrouter.ai/api/v1`, model `MODEL_ARCHITECT` default `deepseek/deepseek-r1`, timeout `CURRICULUM_AGENT_TIMEOUT_MS` default 45 s, `maxRetries: 0`. `POST /api/admin/curriculum` (ADMIN or MANAGER) sends the syllabus text, strips a markdown fence if the model added one, and returns a sanitized preview. `PUT /api/admin/curriculum` inserts the reviewed topics. The route comment still says "FastMCP"; the HTTP call is direct to OpenRouter. The OpenAI client does not set OpenRouter's `HTTP-Referer` or `X-Title` headers.

**Lead agent.** `lib/agents/core/llm.ts` is a raw `fetch` to `https://openrouter.ai/api/v1/chat/completions` (the base URL override is **not** used here). Header `X-Title: project8-agents`. Model `MODEL_AUTOMATION` default `deepseek/deepseek-chat`, `response_format: json_object`, hard cap 25 s. `lib/agents/lead-agent.ts` drafts a Hebrew follow-up for students and fallback leads from the last 48 hours who have not booked, appends an opt-out line, sends WhatsApp, and writes `AuditLog` action `LEAD_REENGAGEMENT_SENT` (14-day cooldown). Caps: 12 leads per run, 4 at a time, 24 s budget. The route `app/api/agents/dispatch/route.ts` allows 30 s (`maxDuration = 30`) and only the `leads` agent. It is authorized like any other cron route.

Gaps:

- **`OPENROUTER_API_KEY` unset:** syllabus returns 502 with "OPENROUTER_API_KEY is not configured". The lead agent skips every lead with `LLM_ERROR` / `CONFIG` once WhatsApp is configured, or skips earlier with `WHATSAPP_NOT_CONFIGURED` and never calls the model.
- **Vercel Hobby function limit is 10 s.** `maxDuration = 30` and the 45 s syllabus timeout only apply on a plan that allows them. A hobby deploy will kill both calls first.
- **DeepSeek R1 and `json_object`.** The syllabus parser does not request JSON mode; it asks for raw JSON and strips fences. The lead agent does request JSON mode. If the chosen model rejects `response_format`, every draft fails with `LLM_ERROR`.
- **No `HTTP-Referer`.** Some OpenRouter keys are configured to require it. Those keys will 403 until the header is added.
- **Opt-out is write-only.** See WhatsApp. The model is instructed not to invent discounts; enforcement is the prompt plus a 600-character cap.
- **Schedule depends on QStash** (section 7). There is no in-process timer.
- The other `MODEL_*` names in `.env.example` (`MODEL_QA`, `MODEL_SECURITY`, `MODEL_MEDIA`, `MODEL_FINTECH`, `MODEL_FRONTEND`, `MODEL_DELIVERY`, `MODEL_CREATIVE`) are not read by these two clients.

### Required environment variables

| Key | Role |
| --- | --- |
| `OPENROUTER_API_KEY` | Bearer key. Required for both clients. |
| `OPENROUTER_BASE_URL` | Syllabus client only. Default `https://openrouter.ai/api/v1`. The lead agent ignores it and always uses the hardcoded chat-completions URL. |
| `MODEL_ARCHITECT` | Syllabus model. Default `deepseek/deepseek-r1`. |
| `MODEL_AUTOMATION` | Lead-agent model. Default `deepseek/deepseek-chat`. |
| `CURRICULUM_AGENT_TIMEOUT_MS` | Optional. Default `45000`. |
| `APP_URL`, `CRON_SECRET`, QStash keys | Required for the lead agent to be invoked on a schedule. See section 7. |
| WhatsApp keys | Required for a draft to be sent. See section 3. |

### External setup required

In OpenRouter (`https://openrouter.ai`):

1. Create a key and set `OPENROUTER_API_KEY` on the server. Add credits; a zero balance returns HTTP errors the lead agent records as `LLM_ERROR`.
2. Confirm `deepseek/deepseek-r1` and `deepseek/deepseek-chat` are allowed for that key, or set `MODEL_ARCHITECT` and `MODEL_AUTOMATION` to models that are.
3. If the key has an allowed-app / referer restriction, the syllabus client will fail until it sends `HTTP-Referer`. The lead client sends only `X-Title`.
4. No OpenRouter webhook exists. Scheduling is QStash → `/api/agents/dispatch?agent=leads`.

### Actionable next step

Put a funded `OPENROUTER_API_KEY` in the server environment and call `POST /api/admin/curriculum` once with a short syllabus as an admin. That exercises the syllabus client without WhatsApp. The lead agent stays dark until section 3 (gateway) and section 7 (QStash schedule) are both done; creating the OpenRouter key alone does not send messages.

---

## 9. Auth (Google OAuth)

### Current code state

Custom authorization-code flow in `lib/auth/google-oauth.ts`. Not NextAuth.

| Step | Route |
| --- | --- |
| Start | `GET /api/auth/google` redirects to Google with `openid email profile`, `prompt=select_account`, and a random `state`. |
| Callback | `GET /api/auth/google/callback` checks `state` against cookie `project8_google_state`, exchanges the code, verifies the ID token against Google's JWKS (`https://www.googleapis.com/oauth2/v3/certs`), issuer `accounts.google.com`, audience = `GOOGLE_CLIENT_ID`, and requires `email_verified`. |
| Existing student | Links `googleSub` if needed and sets the session cookie. |
| Staff email | Rejected (`?google=staff`). Staff use password login. |
| New identity | Signed pending cookie `project8_google_pending` (15 minutes, purpose `google_signup`) and redirect to `/auth/callback`, which collects a phone via `POST /api/auth/google/complete`. |

Session JWT: HS256, `AUTH_SECRET`, 7 days, cookie `project8_session`, `httpOnly`, `sameSite=lax`, `secure` in production. `SESSION_COOKIE_DOMAIN` (for example `.project100.co.il`) is applied to the session cookie so `teachers.<domain>` sees the same login. The Google state cookie does **not** set a Domain attribute; it is host-only and its path is `/api/auth/google` (the callback sits under that path, so the cookie is sent when the host matches).

Gaps:

- **Redirect URI is `APP_URL` (else `NEXT_PUBLIC_APP_URL`, else the request origin) + `/api/auth/google/callback`.** Google will reject the exchange if the authorized redirect URI is not that exact string. If the user starts on a host that is not `APP_URL` (www vs apex, preview vs production, teachers subdomain), the state cookie was set on the start host and the callback lands on `APP_URL`, so `state` is missing and the wizard gets `?google=failed`.
- **Missing either client id or secret** redirects to `/register/student?google=unavailable`. The button does not error in the Google UI.
- **`AUTH_SECRET` is not a P0 check.** Unset, `getSecretKey()` uses the hardcoded build fallback. Every environment that shares that fallback can forge session cookies. Google pending cookies are signed with the same key.
- **Health checks `GOOGLE_CLIENT_ID` only.** A secret-less config looks healthy and the route returns `unavailable`.
- Password login, forgot-password, and reset-password are separate (`/api/login`, section 5). Google does not set a password; `google/complete` creates the student account with its own hash.

### Required environment variables

| Key | Role |
| --- | --- |
| `GOOGLE_CLIENT_ID` | OAuth web client id. |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret. |
| `AUTH_SECRET` | HS256 key for session and pending-signup cookies. `openssl rand -hex 32`. Required in production even though boot does not enforce it. |
| `APP_URL` | Origin used to build the redirect URI. Must be the origin users actually hit. |
| `NEXT_PUBLIC_APP_URL` | Fallback origin if `APP_URL` is empty. |
| `SESSION_COOKIE_DOMAIN` | Optional. Leading-dot parent domain so the teachers subdomain shares the session. Empty = host-only cookie. |

### External setup required

In Google Cloud Console → APIs & Services → Credentials:

1. OAuth consent screen: external or internal, app name, support email, scopes `openid`, `email`, `profile` (the default identity scopes; no extra sensitive scopes).
2. Create an OAuth client of type **Web application**.
3. Authorized redirect URI, character for character: `https://<APP_URL host>/api/auth/google/callback`. Add `http://localhost:3000/api/auth/google/callback` only on a separate dev client. Do not add a trailing slash. Do not add `/auth/callback` (that is an app page, not the Google redirect).
4. Authorized JavaScript origins: the same origins (`https://<APP_URL host>`, and the teachers host if users start Google from it). If both www and apex are live, pick one canonical `APP_URL` and redirect the other to it before `/api/auth/google`, or the state cookie will not survive.
5. Paste the client id and secret into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

No Google webhook. Token revocation and account linking beyond `googleSub` are not implemented.

### Actionable next step

Generate `AUTH_SECRET` and set it in production first, so session cookies are not signed with the build fallback. Then create the Web client and register the single redirect URI `https://<canonical APP_URL>/api/auth/google/callback`, and set both Google variables plus `APP_URL` to that same origin. The Google button stays on "unavailable" until both client id and secret are present, and it fails the state check until the browser host and `APP_URL` are the same host.
