import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) =>
    createElement("a", { href, ...rest }, children as never),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

import { proxy, config } from "../proxy";
import {
  SESSION_COOKIE,
  clearSessionCookieOptions,
  sessionCookieOptions,
  signSession,
  verifySession,
} from "../lib/auth";
import {
  isMarketingPath,
  isTeachersHost,
  mainSiteOrigin,
  resolveTeachersHostRoute,
} from "../lib/routing/teacher-subdomain";
import Navbar from "../components/Navbar";
import Footer from "../components/Footer";
import RegisterHubPage from "../app/register/page";

const ROOT = process.cwd();
const readSource = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const TEACHERS_LOCAL = "http://teachers.localhost:3000";
const TEACHERS_PROD = "https://teachers.project100.co.il";
const MAIN_LOCAL = "http://localhost:3000";

async function requestFor(url: string, session?: { userId: string; role?: string }) {
  const headers = new Headers({ host: new URL(url).host });
  if (session) {
    headers.set("cookie", `${SESSION_COOKIE}=${await signSession(session.userId, session.role)}`);
  }
  return new NextRequest(url, { headers });
}

const TEACHER = { userId: "teacher-1", role: "TEACHER" };
const STUDENT = { userId: "student-1", role: "STUDENT" };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("teachers subdomain host detection", () => {
  it("recognizes the teachers subdomain locally and in production", () => {
    expect(isTeachersHost("teachers.localhost:3000")).toBe(true);
    expect(isTeachersHost("teachers.project100.co.il")).toBe(true);
    expect(isTeachersHost("TEACHERS.Project100.co.il")).toBe(true);
  });

  it("does not treat the public site or look-alike hosts as the teachers subdomain", () => {
    expect(isTeachersHost("localhost:3000")).toBe(false);
    expect(isTeachersHost("project100.co.il")).toBe(false);
    expect(isTeachersHost("www.project100.co.il")).toBe(false);
    expect(isTeachersHost("myteachers.project100.co.il")).toBe(false);
    expect(isTeachersHost(null)).toBe(false);
    expect(isTeachersHost("")).toBe(false);
  });

  it("derives the public site origin from a teachers host", () => {
    expect(mainSiteOrigin("teachers.localhost:3000", "http:")).toBe("http://localhost:3000");
    expect(mainSiteOrigin("teachers.project100.co.il", "https:")).toBe("https://project100.co.il");
  });

  it("classifies marketing paths", () => {
    for (const p of ["/pricing", "/diagnostic", "/onboarding/diagnostic", "/register", "/register/student", "/careers", "/packages"]) {
      expect(isMarketingPath(p), p).toBe(true);
    }
    for (const p of ["/", "/portal/dashboard", "/login", "/dashboard", "/lessons/abc", "/pricingx"]) {
      expect(isMarketingPath(p), p).toBe(false);
    }
  });
});

describe("teachers subdomain route decisions", () => {
  it("serves the cockpit at / for a signed-in teacher and sends guests to /login", () => {
    expect(resolveTeachersHostRoute({ pathname: "/", hasSession: true, role: "TEACHER" })).toEqual({
      action: "rewrite",
      pathname: "/portal/dashboard",
    });
    expect(resolveTeachersHostRoute({ pathname: "/", hasSession: false })).toEqual({
      action: "redirect",
      pathname: "/login",
    });
  });

  it("renders the staff gate at /login", () => {
    expect(resolveTeachersHostRoute({ pathname: "/login", hasSession: false })).toEqual({
      action: "rewrite",
      pathname: "/portal/login",
    });
  });

  it("bounces public marketing paths back to the portal root", () => {
    for (const p of ["/pricing", "/diagnostic", "/onboarding/diagnostic", "/register", "/careers"]) {
      expect(resolveTeachersHostRoute({ pathname: p, hasSession: true, role: "TEACHER" }), p).toEqual({
        action: "redirect",
        pathname: "/",
      });
    }
  });

  it("leaves portal, classroom and API paths untouched for staff", () => {
    for (const p of ["/portal/students", "/portal/dashboard", "/lessons/l1", "/dashboard", "/api/me"]) {
      expect(resolveTeachersHostRoute({ pathname: p, hasSession: true, role: "TEACHER" }), p).toEqual({ action: "pass" });
    }
  });

  it("sends students to their own space and refuses their API calls", () => {
    expect(resolveTeachersHostRoute({ pathname: "/", hasSession: true, role: "STUDENT" })).toEqual({
      action: "redirect-main-site",
      pathname: "/dashboard",
    });
    expect(resolveTeachersHostRoute({ pathname: "/portal/dashboard", hasSession: true, role: "STUDENT" })).toEqual({
      action: "redirect-main-site",
      pathname: "/dashboard",
    });
    expect(resolveTeachersHostRoute({ pathname: "/api/portal/students", hasSession: true, role: "STUDENT" })).toEqual({
      action: "forbidden",
    });
    expect(resolveTeachersHostRoute({ pathname: "/api/logout", hasSession: true, role: "STUDENT" })).toEqual({
      action: "pass",
    });
  });
});

describe("proxy: teachers subdomain routing", () => {
  it("rewrites / to /portal/dashboard for a signed-in teacher and forwards the verified identity", async () => {
    const res = await proxy(await requestFor(`${TEACHERS_LOCAL}/`, TEACHER));
    expect(new URL(res.headers.get("x-middleware-rewrite") ?? "").pathname).toBe("/portal/dashboard");
    expect(res.headers.get("x-middleware-request-x-user-id")).toBe(TEACHER.userId);
    expect(res.headers.get("location")).toBeNull();
  });

  it("rewrites / on the production teachers host too", async () => {
    const res = await proxy(await requestFor(`${TEACHERS_PROD}/`, TEACHER));
    const rewrite = new URL(res.headers.get("x-middleware-rewrite") ?? "");
    expect(rewrite.host).toBe("teachers.project100.co.il");
    expect(rewrite.pathname).toBe("/portal/dashboard");
  });

  it("redirects a guest from / to /login and renders the staff gate there", async () => {
    const home = await proxy(await requestFor(`${TEACHERS_LOCAL}/`));
    expect(home.status).toBe(307);
    expect(home.headers.get("location")).toBe(`${TEACHERS_LOCAL}/login`);

    const login = await proxy(await requestFor(`${TEACHERS_LOCAL}/login`));
    expect(new URL(login.headers.get("x-middleware-rewrite") ?? "").pathname).toBe("/portal/login");
  });

  it("drops a spoofed identity header on the teachers host", async () => {
    const req = await requestFor(`${TEACHERS_LOCAL}/login`);
    req.headers.set("x-user-id", "attacker");
    const res = await proxy(req);
    expect(res.headers.get("x-middleware-request-x-user-id")).toBeNull();
  });

  it("blocks marketing paths on the teachers host and returns to the portal", async () => {
    for (const p of ["/pricing", "/diagnostic", "/onboarding/diagnostic", "/register/student"]) {
      const res = await proxy(await requestFor(`${TEACHERS_PROD}${p}`, TEACHER));
      expect(res.status, p).toBe(307);
      expect(res.headers.get("location"), p).toBe(`${TEACHERS_PROD}/`);
    }
  });

  it("leaves the public landing page and marketing paths alone on the main host", async () => {
    for (const p of ["/", "/pricing", "/register", "/onboarding/diagnostic"]) {
      const res = await proxy(await requestFor(`${MAIN_LOCAL}${p}`));
      expect(res.headers.get("x-middleware-next"), p).toBe("1");
      expect(res.headers.get("x-middleware-rewrite"), p).toBeNull();
      expect(res.headers.get("location"), p).toBeNull();
    }
  });

  it("still guards protected pages on the main host", async () => {
    const res = await proxy(await requestFor(`${MAIN_LOCAL}/dashboard`));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${MAIN_LOCAL}/login?from=%2Fdashboard`);
  });

  it("registers the root, portal and marketing paths in the matcher", () => {
    for (const p of ["/", "/portal", "/portal/:path*", "/pricing", "/diagnostic", "/onboarding/:path*", "/register/:path*"]) {
      expect(config.matcher, p).toContain(p);
    }
  });
});

describe("proxy: students on the teachers subdomain", () => {
  it("redirects a student from the teachers root to the student space on the main site", async () => {
    const local = await proxy(await requestFor(`${TEACHERS_LOCAL}/`, STUDENT));
    expect(local.status).toBe(307);
    expect(local.headers.get("location")).toBe(`${MAIN_LOCAL}/dashboard`);

    const prod = await proxy(await requestFor(`${TEACHERS_PROD}/portal/dashboard`, STUDENT));
    expect(prod.headers.get("location")).toBe("https://project100.co.il/dashboard");
  });

  it("returns 403 for student API calls on the teachers host", async () => {
    const res = await proxy(await requestFor(`${TEACHERS_LOCAL}/api/portal/students`, STUDENT));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("does not affect students on the main site", async () => {
    const res = await proxy(await requestFor(`${MAIN_LOCAL}/dashboard`, STUDENT));
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("x-middleware-request-x-user-id")).toBe(STUDENT.userId);
  });

  it("falls back to the page-level staff guard for legacy tokens without a role claim", async () => {
    const res = await proxy(await requestFor(`${TEACHERS_LOCAL}/`, { userId: "legacy-1" }));
    expect(new URL(res.headers.get("x-middleware-rewrite") ?? "").pathname).toBe("/portal/dashboard");
    const dashboard = readSource("app/portal/dashboard/page.tsx");
    expect(dashboard).toContain('if (!isIntakeRecorderRole(user.role)) redirect("/portal/login")');
  });
});

describe("cross-subdomain session", () => {
  it("round-trips the role claim and keeps legacy tokens valid", async () => {
    expect(await verifySession(await signSession("u1", "TEACHER"))).toEqual({ userId: "u1", role: "TEACHER" });
    expect(await verifySession(await signSession("u2"))).toEqual({ userId: "u2" });
  });

  it("scopes the session cookie to the shared parent domain when configured", () => {
    vi.stubEnv("SESSION_COOKIE_DOMAIN", ".project100.co.il");
    expect(sessionCookieOptions("t").domain).toBe(".project100.co.il");
    expect(clearSessionCookieOptions().domain).toBe(".project100.co.il");
  });

  it("keeps a host-only cookie when no shared domain is configured", () => {
    vi.stubEnv("SESSION_COOKIE_DOMAIN", "");
    expect("domain" in sessionCookieOptions("t")).toBe(false);
    expect("domain" in clearSessionCookieOptions()).toBe(false);
  });

  it("embeds the role in every session issued at sign-in", () => {
    expect(readSource("app/api/login/route.ts")).toContain("signSession(user.id, user.role)");
    expect(readSource("app/api/register/route.ts")).toContain("signSession(newUser.id, newUser.role)");
    expect(readSource("app/api/register/student/route.ts")).toContain('signSession(result.user.id, "STUDENT")');
    expect(readSource("app/api/auth/google/complete/route.ts")).toContain('signSession(result.user.id, "STUDENT")');
    expect(readSource("app/api/auth/google/callback/route.ts")).toContain("signSession(existing.id, existing.role)");
  });
});

const STAFF_ENTRY_MARKERS = ["/portal", "כניסת צוות", "כניסת מורים", "כניסה למורים", "teachers."];

describe("public landing has no teacher login entry points", () => {
  it("renders the navbar without staff or teacher login links", () => {
    const html = renderToStaticMarkup(createElement(Navbar));
    for (const marker of STAFF_ENTRY_MARKERS) expect(html, marker).not.toContain(marker);
    expect(html).not.toContain('href="/careers"');
    expect(html).not.toContain('href="/teachers');
  });

  it("renders the registration hub without staff or teacher login links", () => {
    const html = renderToStaticMarkup(createElement(RegisterHubPage));
    for (const marker of STAFF_ENTRY_MARKERS) expect(html, marker).not.toContain(marker);
    expect(html).not.toContain('href="/careers"');
  });

  it.each(["app/page.tsx", "components/landing/HomeLanding.tsx"])("keeps the landing source %s free of staff entry links", (file) => {
    const source = readSource(file);
    for (const marker of STAFF_ENTRY_MARKERS) expect(source, marker).not.toContain(marker);
    expect(source).not.toContain("/careers");
    expect(source).not.toContain("/teachers");
  });

  it("keeps the footer recruitment link as the only teacher-facing entry", () => {
    const html = renderToStaticMarkup(createElement(Footer));
    expect(html.match(/href="\/careers"/g)).toHaveLength(1);
    expect(html).toContain("הצטרפות לנבחרת ההוראה");
    expect(html).not.toContain("/portal");
  });
});

/** Walk the relative import graph of a module and collect local files plus bare package specifiers. */
function collectImportGraph(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [path.join(ROOT, entry)];
  const importRe = /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\sfrom\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(importRe)) {
      const spec = match[1] ?? match[2];
      if (!spec) continue;
      if (/^import\s+type\s/.test(match[0])) continue;
      if (!spec.startsWith(".")) {
        packages.add(spec);
        continue;
      }
      const base = path.resolve(path.dirname(file), spec);
      const resolved = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")].find(
        (candidate) => existsSync(candidate) && /\.(ts|tsx)$/.test(candidate)
      );
      if (resolved) queue.push(resolved);
    }
  }
  return { files, packages };
}

describe("bundle isolation of the public landing page", () => {
  const { files, packages } = collectImportGraph("app/page.tsx");
  const localFiles = [...files].map((file) => path.relative(ROOT, file));

  it("does not pull in video, payment, chat or database packages", () => {
    const forbidden = [/^@daily-co\//, /^stripe$/, /^stream-chat/, /^@prisma\//, /^openai$/, /^pdf-lib$/, /^katex$/];
    for (const pkg of packages) {
      for (const pattern of forbidden) expect(pkg, pkg).not.toMatch(pattern);
    }
  });

  it("does not import portal, ledger, billing or classroom modules", () => {
    const forbidden = [
      /^components\/portal\//,
      /^components\/(VideoRoom|BookingModal|ClassroomWhiteboard|ClassroomChat)\.tsx$/,
      /^lib\/(prisma|daily|stream|student-billing|teacher-payouts|teacher-dashboard|student-portal|session)(-shared)?\.ts$/,
      /^app\/portal\//,
      /^app\/lessons\//,
    ];
    for (const file of localFiles) {
      for (const pattern of forbidden) expect(file, file).not.toMatch(pattern);
    }
  });

  it("only reaches landing components from the home page", () => {
    expect(localFiles).toContain("app/page.tsx");
    expect(localFiles.some((file) => file.startsWith("components/landing/"))).toBe(true);
  });
});

describe("relative imports", () => {
  it("never uses the @/ alias in the sprint 22 files", () => {
    const sprintFiles = [
      "proxy.ts",
      "lib/auth.ts",
      "lib/routing/teacher-subdomain.ts",
      "tests/portal-subdomain-routing.test.ts",
    ];
    for (const file of sprintFiles) {
      expect(readSource(file), file).not.toMatch(/from\s+["']@\//);
    }
  });
});
