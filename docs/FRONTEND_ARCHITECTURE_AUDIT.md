# Frontend Architecture Audit

**Project:** PROJECT100  
**Scope:** Interactive whiteboard, Lesson Room load path, subdomain routing readiness, pending marketing UI.  
**Method:** Static read of the current tree. No application code was changed.  
**Date:** 18 October 2026  
**Stack:** Next.js `^16.2.9` (App Router), React `^19.2.7`, Tailwind `^4`.

This audit is the baseline for three later pieces of work: subdomain routing (`teachers.project100.co.il` vs `app.project100.co.il`), Lesson Room load time, and GoodNotes-style whiteboard gestures. Each section states the current mechanism, the gap, and the exact change that closes it.

---

## 1. Interactive whiteboard

### 1.1 Where it lives

| Piece | Location | Role |
| --- | --- | --- |
| Engine | `components/ClassroomWhiteboard.tsx` (4,377 lines, `"use client"`) | Tools, hit-testing, history, Stream sync, PNG/PDF export |
| Host | `app/lessons/[id]/LessonRoomUI.tsx` | Mounts the board as the main pane |
| Contract | `.cursor/rules/04-whiteboard-a4-engine.mdc` | Custom canvas only. `@excalidraw/*` and any external whiteboard library are forbidden |
| Export | `app/api/excalidraw/export` + `.cursor/rules/05-vector-pdf-engine.mdc` | Server embeds per-page PNG data URLs with `pdf-lib` |

The board is a self-contained `<canvas>` renderer. `package.json` does not depend on Tldraw, Fabric.js, Perfect-Freehand, Excalidraw, Konva, or Paper.js. Ink smoothing is an in-file quadratic midpoint pass (`paintSmoothStroke`), not a stroke library.

### 1.2 Geometry model

Each page is a discrete A4 frame of `794 × 1123` CSS pixels (`PAGE_W` / `PAGE_H`), stacked vertically with a 32px gap on a stone desk (`#f5f5f4`). The drawing canvas is absolutely positioned over the page and is transparent. Strokes, shapes, text, and images are retained as elements (`StrokeEl | ShapeEl | TextEl | ImageEl`) and mirrored to the other participant over a Stream channel custom event (`BOARD_EVENT = "board_sync"`, protocol `PROTO_V = 6`).

Tools today: selection (marquee, free lasso, move, resize, image rotate, text reflow), pen, highlighter, eraser (stroke or pixel), explicit shapes, text, image paste (Base64 via `FileReader`), and a fading laser.

Shape kinds already exist as first-class elements: `rectangle | ellipse | triangle | line | arrow`. They are drawn only after the user picks the shapes tool and drags a box from `start` to `end`. On pointer-up the box is stored as a `ShapeEl` and broadcast. There is no aspect lock and no axis lock.

The pen tool stores the raw pointer samples. `paintSmoothStroke` only changes how those samples are stroked (quadratic curves, round caps). The stored geometry stays the point list. Pointer-up commits that list unchanged.

`shiftKey` is read in one place: redo (`mod + shift + z`). It does not constrain a stroke or a shape.

The word `snapshot` in the selection state is the undo copy of the elements being moved or resized. It is not geometric snapping.

### 1.3 Notebook grid — what already exists

A square grid is already the page background, which matches the A4-engine rule (“the grid is the page background, strokes render above it”).

Screen grid, applied to the page `div` behind the canvas:

```3290:3296:components/ClassroomWhiteboard.tsx
    const GRID_CSS = {
      backgroundColor: "#ffffff",
      backgroundImage:
        "linear-gradient(to right, #f1f5f9 1px, transparent 1px)," +
        "linear-gradient(to bottom, #f1f5f9 1px, transparent 1px)",
      backgroundSize: "24px 24px",
    } as const;
```

That object is spread onto each page frame at the notebook scroller (`style={{ width: PAGE_W, height: PAGE_H, ...GRID_CSS }}`).

Export paints a second grid into the PNG, at a different pitch:

- `exportPdfDirect` and `exportPngDirect` fill white, then stroke vertical and horizontal lines every **20px** in `#e2e8f0`.
- The on-screen grid is **24px** in `#f1f5f9`.

A page that looks like a 24px grid in the room exports as a 20px grid. There is one paper style, hardcoded. There is no ruled notebook, no dotted paper, no blank paper, no margin line, and no control to switch.

### 1.4 Shape-hold and straight-line hold — what is missing

GoodNotes behaviour this board does not have:

1. **Hold to straighten.** While the pen is down, a short dwell with the pointer nearly still replaces the freehand stroke with a straight segment. Nothing in `onMove` / `onUp` measures dwell or velocity. A pen stroke always becomes a `StrokeEl` of the raw points.
2. **Hold to recognize a shape.** A rough circle, rectangle, or triangle drawn with the pen, then held, becomes the clean primitive. Recognition does not exist. Perfect shapes appear only when the shapes tool was selected first.
3. **Snap to the grid.** Endpoints of a straightened line or a recognized shape are not rounded to the grid step.
4. **Shift as the desktop equivalent of the hold.** Holding Shift does not lock a line to 45° or a box to a square.

The shapes tool can stay. It is the explicit path. The missing path is recognition on the pen.

### 1.5 Requirement to close the whiteboard gaps

Stay inside `ClassroomWhiteboard.tsx`. Do not add Tldraw, Excalidraw, Fabric, or Perfect-Freehand. The existing `ShapeEl` + `paintShape` + `toSyncEl` path is the commit target, so a snapped shape already syncs to the other client at `PROTO_V = 6` with no protocol change.

**Paper**

- Introduce one constant, `GRID_STEP = 24`, and use it for the CSS background and for both export loops. Delete the 20px export loop.
- Add `type PaperStyle = "grid" | "ruled" | "dotted" | "blank"`, default `"grid"`.
- Render paper as CSS (or a background canvas that is not part of the element list) so ink stays above it. Ruled paper is horizontal lines only, about 8mm apart (`mmToPx` already exists), plus one vertical margin. Dotted paper is a radial-gradient dot at `GRID_STEP`.
- Keep the style local. Both clients can default to `"grid"` without a new board event. A user-visible paper toggle that must match on both sides needs a new sync message and a `PROTO_V` bump; do that only if the toggle is shared.

**Hold gesture (pen tool only)**

- On pointer move, append the point as today. Also track `lastMoveAt` and distance from the previous sample.
- If the pointer stays inside ~4px for ~400ms and the stroke has more than a few points, classify:
  - Open path, low deviation from the chord → straight `line` from first point to last point.
  - Closed path, 4 significant corners after a simplify pass (Ramer–Douglas–Peucker) → `rectangle` from the bounding box.
  - Closed path, 3 corners → `triangle`.
  - Closed path, high circularity (bounding box nearly square, low radial variance) → `ellipse`.
- Preview the primitive while the finger is still down (draw it in the existing active-shape pass). On pointer-up, if a classification won, commit a `ShapeEl` and do not also commit the freehand `StrokeEl`. Otherwise commit the `StrokeEl` exactly as today.
- If `shiftKey` is down during the stroke, skip recognition and constrain the segment to the nearest 45°. That is the pointer-and-keyboard stand-in for the hold.
- When a primitive wins, round its box to `GRID_STEP` so the line sits on the notebook grid.

No new dependency is required. Quadratic smoothing stays the ink renderer for strokes that do not snap.

---

## 2. Lesson Room load path

### 2.1 The room does not stream its shells

`app/lessons/[id]/page.tsx` is a server component. It does not render until every step below has finished, in order:

1. `getCurrentUser()`
2. `getAuthorizedLessonById()`
3. `ensureDailyRoom()` — Daily REST. With a stored URL this is `GET /rooms/:name`. With no URL, or a dead room, it creates a room. Then a Prisma `lesson.update` if the URL changed.
4. `generateDailyToken()` — another Daily HTTP call when `DAILY_API_KEY` is set.
5. `generateStreamToken()` — local JWT, cheap, but it waits for step 4.
6. `resolveLessonStreamChannelId()` — may call Stream.
7. For teacher, manager, and admin: `diagnosticQuiz.findFirst` with topics.

Stream token generation, channel resolution, and the diagnostic query do not depend on the Daily room. They still run after the Daily round-trips. Time-to-first-byte of the room is the sum of those calls.

### 2.2 Client graph is one synchronous chunk

`LessonRoomUI.tsx` is a client component and imports its heavy children with static `import` statements:

- `ClassroomWhiteboard` (the 4,377-line engine, plus `react-draggable` and `nanoid`)
- `ClassroomChat` (`stream-chat`, `stream-chat-react`, and `stream-chat-react/dist/css/index.css`)
- `VideoRoom` (`@daily-co/daily-js`, `@daily-co/daily-react`)
- `RatingModal`, `PreLessonAssetsSection`, `DiagnosticSummaryCard`, `CompleteLessonModal`

A repository-wide search finds **no** `next/dynamic` and **no** `dynamic()` call. Daily, Stream Chat, and the whiteboard parse and evaluate together before the room can hydrate. After hydration all three start immediately: `VideoRoom` builds a Daily call object, `ClassroomChat` connects the Stream client, and the whiteboard mounts a canvas per page.

`ClassroomWhiteboard` imports `Channel` from `stream-chat` as a type only, so that import is erased. The chat UI is what pulls `stream-chat` into the bundle.

Two further costs sit on the same first paint:

- **Root layout always mounts `AmbientCanvas` and `AppShell`.** `AppShell` returns children only for `/lessons/*`, so the navbar stays off, but the ambient canvas still mounts and observes section ids that the classroom does not have.
- **Package lessons fetch twice more on mount.** When `lesson.packageId` is set, `DiagnosticSummaryCard` calls `GET /api/packages/:id/quiz` and `PreLessonAssetsSection` calls `GET /api/packages/:id/assets`. The assets section value-imports `PreLessonAssetType` from `@prisma/client` inside a client component, so the lesson chunk is coupled to the Prisma enum module.
- **Drawing re-renders the whole board.** Each pen sample calls `setActive` (`onMove`, around the pen branch). That is a React state update through a 4,000-line component on every pointer event. It is a runtime cost, separate from the download, and it is why the board feels heavy after it has loaded.

The public homepage is already isolated from this graph. `tests/portal-subdomain-routing.test.ts` asserts that `app/page.tsx` does not import Daily, Stream, Prisma, or the classroom modules. The lesson route has no equivalent split.

### 2.3 Requirement to close the load gap

Do these in this order. Each one is independently shippable.

1. **Parallelize the server wait.** After the lesson row is authorized, run three branches with `Promise.all`:
   - Daily: `ensureDailyRoom` then `generateDailyToken`
   - Stream: `generateStreamToken` and `resolveLessonStreamChannelId`
   - Pedagogy: the diagnostic query, only for staff roles  
   Persist a changed Daily URL without blocking token minting on the Prisma write (fire it after the URL is known).

2. **Stop blocking HTML on Daily provisioning.** If `lesson.dailyRoomUrl` is already stored, pass it through and mint the token. Move “room missing or expired → create” off the document request onto `GET` or `POST /api/daily/...` that `VideoRoom` calls when it mounts. The board can paint before Daily answers.

3. **Split the client graph with `next/dynamic` and `ssr: false`.**
   - Load `ClassroomWhiteboard` as the primary dynamic import (the room is the board).
   - Load `VideoRoom` and `ClassroomChat` in separate dynamic imports, after the board chunk, or on idle. Give each a sized skeleton in the existing aside slots (`h-64` for video, `min-h-[240px]` for chat) so layout does not jump.
   - Keep the type-only Stream import on the board. The board still needs the channel object; it does not need `stream-chat-react` in its own chunk. Pass the channel in only after `ClassroomChat` reports `onChannelReady` (that callback already exists). Until then the board already runs as `"לוח מקומי"`.

4. **Draw the live stroke from a ref.** Keep `activeRef` as the source of truth during a gesture and paint it in the canvas effect. Call `setActive` on pointer-down and pointer-up only. That removes a full component render per sample.

5. **Skip `AmbientCanvas` on `/lessons` and `/portal`.** Gate it in the root layout the same way `AppShell` already gates the navbar.

6. **Move `PreLessonAssetType` to a string union** in a file that does not import `@prisma/client`, and use that union in `PreLessonAssetsSection`. The API route can keep the Prisma enum.

---

## 3. Routing tree and subdomain readiness

### 3.1 Current `app/` tree

There are **no route groups**. A search for `app/(*)` directories returns nothing. Layouts exist only at `app/layout.tsx` and `app/lessons/[id]/layout.tsx` (the classroom is `fixed inset-0` and drops marketing chrome).

Page routes, grouped by who they serve today:

| Audience | Paths |
| --- | --- |
| Marketing | `/` (`HomeLanding`), `/pricing`, `/careers`, `/register` |
| Student app | `/login`, `/forgot-password`, `/auth/callback`, `/dashboard`, `/dashboard/lessons/[id]/recording`, `/onboarding/diagnostic`, `/packages/[id]/report`, `/packages/[id]/quiz/run`, `/lessons/[id]`, `/register/student` |
| Teacher / staff | `/portal/login`, `/portal/dashboard`, `/portal/intake`, `/portal/students`, `/portal/students/[id]`, `/teachers/apply`, `/teachers/onboarding/status`, `/teachers/onboarding/exam-581`, `/register/teacher` |
| Admin | `/admin`, `/admin/teachers`, `/admin/teachers/[id]/vetting`, `/admin/lessons`, `/admin/curriculum`, `/admin/payouts` |

`/lessons/[id]` is shared. Teacher and student enter the same room; the server component decides the pedagogical brief and the completion button from `user.role`.

### 3.2 What host routing already does

Next.js 16 in this repo uses a root **`proxy.ts`** (the request interceptor). There is no `middleware.ts`. Host policy is pure functions in `lib/routing/teacher-subdomain.ts`, covered by `tests/portal-subdomain-routing.test.ts`.

Recognized host: any hostname that starts with `teachers.` (`teachers.project100.co.il`, `teachers.localhost:3000`).

| Request on `teachers.*` | Decision |
| --- | --- |
| `GET /` with a session | Rewrite to `/portal/dashboard` |
| `GET /` without a session | Redirect to `/login` |
| `GET /login` | Rewrite to `/portal/login` |
| Marketing prefixes (`/pricing`, `/diagnostic`, `/onboarding`, `/register`, `/careers`, `/packages`) | Redirect to `/` on the teachers host |
| Signed-in student, page | Redirect to `{apex}/dashboard` via `mainSiteOrigin` (`teachers.project100.co.il` → `https://project100.co.il`) |
| Signed-in student, API | Only `/api/login` and `/api/logout` pass; everything else is 403 |
| Other paths, including `/lessons/*`, `/portal/*`, `/admin/*` | Pass through |

On every other host the proxy skips session work for `/login`, `/register`, `/forgot-password`, `/`, and the marketing prefixes, then enforces a session for `/dashboard` and `/lessons` and `/admin`.

Cross-subdomain cookies are already supported. `sessionCookieOptions` sets `Domain` from `SESSION_COOKIE_DOMAIN` (tests expect `.project100.co.il`). When the env var is empty the cookie stays host-only.

The string `app.project100.co.il` does not appear anywhere. There is no `isAppHost`, no student subdomain, and no split between the marketing apex and a student app host. Today the apex (`project100.co.il`) is both the marketing site and the student application.

### 3.3 Why route groups alone will not do this

Route groups change layout nesting. They do not change the URL, and two groups cannot both own `app/(students)/page.tsx` and `app/(teachers)/page.tsx` — that is two `page.tsx` files for `/`. The teachers host already solves “`/` means something else” with a **rewrite** to a distinct pathname (`/portal/dashboard`). The student app host has to use the same mechanism.

`/portal/*` and `/dashboard` must remain distinct pathnames. Groups then give each audience its own layout.

### 3.4 Matcher holes

`proxy.ts` `config.matcher` is an allowlist. These page trees are **not** in it, so the teachers-host rules never see them:

- `/teachers/*` (apply, onboarding, exam)
- `/auth/*` (Google callback)

A teacher who opens `teachers.project100.co.il/teachers/apply` bypasses the host router. `/portal` itself is matched.

### 3.5 Requirement to support both hosts

Target hosts:

| Host | Serves |
| --- | --- |
| `project100.co.il` | Marketing only: `/`, `/pricing`, `/careers`, `/register` |
| `app.project100.co.il` | Student application: dashboard, lessons, onboarding, packages, student auth |
| `teachers.project100.co.il` | Staff cockpit, already sketched |

**1. Host module.** Extend `lib/routing/teacher-subdomain.ts` (or add `lib/routing/hosts.ts` beside it) with:

- `APP_SUBDOMAIN = "app"`
- `isAppHost(host)` — same shape as `isTeachersHost`, prefix `app.`
- `resolveAppHostRoute({ pathname, hasSession, role })` returning the same decision union the teachers resolver uses

App-host decisions:

- `/` with a student session → rewrite `/dashboard`
- `/` without a session → redirect `/login`
- Staff role (`TEACHER`, `MANAGER`, `ADMIN`) on a page → redirect to `https://teachers.project100.co.il` plus the staff home
- Marketing prefixes → redirect to the apex origin
- `/portal/*` → redirect to the teachers host (do not render the cockpit on `app.`)
- `/lessons/*`, `/dashboard/*`, `/onboarding/*`, `/packages/*` → pass when a session exists; otherwise the existing login redirect

Teachers-host decisions to add on top of what already exists:

- Student redirect target becomes `https://app.project100.co.il/dashboard`, not the apex `/dashboard`
- `/lessons/*` stays pass-through for staff (the room is shared). A student who opens a lesson link on the teachers host is sent to the same path on `app.`

Apex decisions:

- Authenticated student hitting `/dashboard` or `/lessons` → redirect to `app.`
- Authenticated staff hitting `/portal` → redirect to `teachers.`
- `/`, `/pricing`, `/careers`, `/register` stay on the apex

**2. Wire it in `proxy.ts`.** Branch `onTeachersHost` / `onAppHost` / apex before the current “everyone else” block. Keep using `NextResponse.rewrite` and `trustedHeaders` the way the teachers branch already does. Point `mainSiteOrigin`’s student counterpart at the `app.` host rather than assuming “strip `teachers.`”.

**3. Route groups, for layouts only.** Move files; do not rename URLs.

```
app/
  (marketing)/          layout: Navbar + Footer
    page.tsx            /
    pricing/
    careers/
    register/
  (student)/            layout: InternalAppHeader
    dashboard/
    lessons/
    onboarding/
    packages/
    login/
    forgot-password/
    auth/
  (teacher)/            layout: none (staff chrome lives inside portal pages)
    portal/
    teachers/
  (admin)/
    admin/
  api/                  stays outside groups
```

`AppShell`’s pathname switches can then shrink, because each group layout owns its chrome. The classroom layout at `(student)/lessons/[id]/layout.tsx` stays `fixed inset-0`.

**4. Cookie.** Production must set `SESSION_COOKIE_DOMAIN=.project100.co.il` or a login on `app.` will not be visible on `teachers.` and the reverse. The setter already exists; this is configuration, not a new mechanism. `sameSite: "lax"` is already set and is correct for top-level navigations between these hosts.

**5. Matcher.** Add `/teachers/:path*` and `/auth/:path*`, or replace the allowlist with a negative matcher that skips only static assets. New pages should not ship unprotected because someone forgot the list.

**6. Tests.** Extend `tests/portal-subdomain-routing.test.ts` with an `app.project100.co.il` table that mirrors the teachers table: home rewrite, student pass, staff redirect, marketing redirect to apex, lesson redirect from teachers host to app host.

Do not put teacher and student `page.tsx` files on the same URL inside two groups. Rewrites stay the host switch.

---

## 4. Pending UI and design state

Git status for `app/pricing`, `components/pricing`, `components/landing`, and `package.json` is clean. Nothing in this set is uncommitted. `framer-motion` is a committed dependency and is imported in exactly one file, `components/landing/StatsBar.tsx`. There is no unused whiteboard or animation library waiting to be wired.

### 4.1 `app/pricing/page.tsx`

Finished client page. It reads `package`, `quizId`, and `returnUrl` (the return path is restricted to a same-origin relative URL), renders `BenefitsBar`, `PricingPlans`, `Testimonials`, and an FAQ accordion, and wraps the search-params reader in `Suspense` with a Hebrew loading line. No placeholder blocks.

### 4.2 `components/pricing/PricingPlans.tsx`

Finished. Four packages are a typed constant (`SINGLE` ₪200, `TRIO` ₪540, `MULTI` ₪850, `TEN` ₪1600). Purchase calls `GET /api/me`, then `POST /api/payments`, and either follows `checkoutUrl` or, in the dev mock, sends the browser to the post-purchase URL. A two-column comparison (“הלמידה הישנה” / “המעטפת”) is implemented under the cards.

The prices live only in this client module. The server payment route is the authority at charge time; if those amounts ever diverge, the cards will lie. That is a consistency risk, not an unfinished layout.

`HomeLanding` mounts the same component, collapsed behind “למחירון המלא”, with `resumePath={() => "/#pricing"}`. Opening the section and buying from the homepage is wired.

### 4.3 `components/landing/HomeLanding.tsx`

The page is largely built: hero, benefits, bento, flip cards, stats, reviews slot, pricing disclosure, about, FAQ, lead form posting to `POST /api/leads`.

One tile is still a stub. The wide bento cell “כל המורים עברו תהליך הכשרה פדגוגי קשיח” renders a gray band and this visible string:

`// צילום מאקרו: כתיבה פדגוגית חכמה על טאבלט דיגיטלי`

The comment above it says a close-up photo (digital pen on a tablet) belongs there. Height is fixed at `h-32`. Replacing that node with a real image or a short loop, the way the scheduling cell uses `/videos/student-scheduling.webm`, is the remaining design close-out.

The hero video is a remote file on `https://haformula.co.il/...mp4`, not an asset in this repo. If that URL moves, the phone frame goes blank. Hosting it under `public/` the way `student-scheduling.webm` is hosted removes that dependency.

The landing and the pricing page use two visual systems on purpose today: the landing is `liquid-glass`, `#0071e3`, `font-black`; the pricing page is `frostCard` / stone neutrals from `lib/ui`. Both are complete. Unifying them is a design pass, not a missing component.

### 4.4 `components/landing/StatsBar.tsx`

The component is complete. Digit reels use `framer-motion` (`useInView`, `useReducedMotion`, a two-cycle reel, stagger). The section is in the homepage between the method cards and the reviews.

The six figures are hardcoded constants (`3412`, `97%`, `93%`, `95%`, `87%`, `10%`). They are not loaded from an API. Shipping them as marketing copy is fine; they should not be described as live product metrics until a source exists.

### 4.5 Close-out list

| Item | State | Close it by |
| --- | --- | --- |
| Pricing page | Done | — |
| Pricing cards and checkout | Done | Optional: read display prices from the same map `/api/payments` uses |
| Homepage pricing disclosure | Done | — |
| Bento “macro photo” cell | Visible placeholder | Swap the `h-32` band for an image or video in `public/` |
| Hero video | Remote third-party URL | Copy the file into `public/videos/` and point `src` at it |
| Stats bar | Done, static numbers | Leave, unless product wants a real source |
| `framer-motion` | Installed, used once, committed | No library work left |
| Uncommitted design files | None | — |

---

## 5. Implementation order

The three workstreams do not block each other. Suggested sequence, because each later step sits on a smaller bundle and a stable host map:

1. **Lesson Room split** — `Promise.all` on the server, dynamic import of Daily and Stream, live-stroke ref. This is the user-visible wait.
2. **Whiteboard gestures** — shared `GRID_STEP`, then hold-to-line, then shape classification, committed as `ShapeEl`.
3. **Hosts** — `isAppHost` + tests first, proxy branch second, route-group file moves last (layouts only; URLs stay).
4. **Landing close-out** — replace the macro placeholder and self-host the hero video. Independent of the three above.

---

## 6. File index

| Concern | Files |
| --- | --- |
| Whiteboard engine | `components/ClassroomWhiteboard.tsx` |
| Whiteboard rules | `.cursor/rules/04-whiteboard-a4-engine.mdc`, `.cursor/rules/05-vector-pdf-engine.mdc` |
| Room UI | `app/lessons/[id]/LessonRoomUI.tsx`, `app/lessons/[id]/page.tsx`, `app/lessons/[id]/layout.tsx` |
| Video | `components/VideoRoom.tsx`, `lib/daily.ts` |
| Chat | `components/ClassroomChat.tsx`, `lib/stream.ts`, `lib/package-chat.ts` |
| Host routing | `proxy.ts`, `lib/routing/teacher-subdomain.ts`, `lib/auth.ts` (`SESSION_COOKIE_DOMAIN`) |
| Routing tests | `tests/portal-subdomain-routing.test.ts` |
| Chrome | `app/layout.tsx`, `components/AppShell.tsx`, `components/AmbientCanvas.tsx` |
| Pricing | `app/pricing/page.tsx`, `components/pricing/PricingPlans.tsx` |
| Landing | `app/page.tsx`, `components/landing/HomeLanding.tsx`, `components/landing/StatsBar.tsx` |
