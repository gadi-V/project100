import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { proxy, config } from "../proxy";
import { SESSION_COOKIE, clearSessionCookieOptions, sessionCookieOptions, signSession } from "../lib/auth";
import {
  isSubdomainBypassPath,
  readRequestHost,
  resolveTeachersAliasRewrite,
  subdomainForHost,
} from "../lib/routing/subdomain";
import { isAppHost, normalizeHostname } from "../lib/routing/teacher-subdomain";

const ROOT = process.cwd();
const readSource = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const TEACHER = { userId: "teacher-1", role: "TEACHER" };
const STUDENT = { userId: "student-1", role: "STUDENT" };

async function requestFor(
  url: string,
  init: { session?: { userId: string; role?: string }; headers?: Record<string, string> } = {}
) {
  const headers = new Headers({ host: new URL(url).host, ...init.headers });
  if (init.session) {
    headers.set("cookie", `${SESSION_COOKIE}=${await signSession(init.session.userId, init.session.role)}`);
  }
  return new NextRequest(url, { headers });
}

function forwarded(res: Response, name: string): string | null {
  return res.headers.get(`x-middleware-request-${name}`);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("hostname extraction", () => {
  it("prefers x-forwarded-host, then host, and strips the port when classifying", () => {
    expect(readRequestHost("teachers.localhost:3000, edge.internal", "localhost:3000", "internal")).toBe(
      "teachers.localhost:3000"
    );
    expect(readRequestHost("  ", "app.project100.co.il", "localhost:3000")).toBe("app.project100.co.il");
    expect(readRequestHost(null, null, "localhost:3000")).toBe("localhost:3000");
    expect(normalizeHostname("Teachers.Localhost:3000")).toBe("teachers.localhost");
  });

  it("distinguishes teachers, app, and the bare local host", () => {
    expect(subdomainForHost("teachers.project100.co.il")).toBe("teachers");
    expect(subdomainForHost("teachers.localhost:3000")).toBe("teachers");
    expect(subdomainForHost("app.project100.co.il")).toBe("app");
    expect(subdomainForHost("app.localhost:3000")).toBe("app");
    expect(subdomainForHost("localhost:3000")).toBeNull();
    expect(subdomainForHost("project100.co.il")).toBeNull();
    expect(isAppHost("myapp.project100.co.il")).toBe(false);
    expect(isAppHost("appointments.project100.co.il")).toBe(false);
  });
});

describe("bypass and alias decisions", () => {
  it("bypasses static assets, the favicon, public media, and webhooks", () => {
    for (const pathname of [
      "/_next/static/css/app.css",
      "/_next/image",
      "/favicon.ico",
      "/videos/student-scheduling.webm",
      "/uploads/board/photo.png",
      "/images/reviews/noa.jpg",
      "/logo.svg",
      "/api/webhooks/daily",
      "/api/webhooks/stripe",
      "/api/health",
    ]) {
      expect(isSubdomainBypassPath(pathname), pathname).toBe(true);
    }
  });

  it("does not bypass ordinary API routes or nested app paths that merely end in a file extension", () => {
    expect(isSubdomainBypassPath("/api/me")).toBe(false);
    expect(isSubdomainBypassPath("/api/portal/students")).toBe(false);
    expect(isSubdomainBypassPath("/lessons/notes.pdf")).toBe(false);
    expect(isSubdomainBypassPath("/dashboard")).toBe(false);
  });

  it("rewrites the teachers roster alias onto the physical portal page and leaves /dashboard in place", () => {
    expect(resolveTeachersAliasRewrite("/classes")).toBe("/portal/students");
    expect(resolveTeachersAliasRewrite("/classes/student-1")).toBe("/portal/students/student-1");
    expect(resolveTeachersAliasRewrite("/dashboard")).toBeNull();
    expect(resolveTeachersAliasRewrite("/portal/dashboard")).toBeNull();
    expect(resolveTeachersAliasRewrite("/lessons/123")).toBeNull();
    expect(resolveTeachersAliasRewrite("/api/me")).toBeNull();
  });
});

describe("proxy: teachers host internal rewrites", () => {
  it("keeps teachers.project100.co.il/dashboard on the physical dashboard and stamps the teachers context", async () => {
    const res = await proxy(await requestFor("https://teachers.project100.co.il/dashboard", { session: TEACHER }));

    expect(res.headers.get("location")).toBeNull();
    expect(res.status).not.toBe(307);
    expect(res.status).not.toBe(308);
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(forwarded(res, "x-subdomain")).toBe("teachers");
    expect(forwarded(res, "x-pathname")).toBe("/dashboard");
    expect(forwarded(res, "x-user-id")).toBe(TEACHER.userId);
  });

  it("rewrites teachers.localhost:3000/classes internally to the portal roster", async () => {
    const res = await proxy(await requestFor("http://teachers.localhost:3000/classes", { session: TEACHER }));

    const rewrite = new URL(res.headers.get("x-middleware-rewrite") ?? "");
    expect(rewrite.pathname).toBe("/portal/students");
    expect(rewrite.host).toBe("teachers.localhost:3000");
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).not.toBe(307);
    expect(res.status).not.toBe(308);
    expect(forwarded(res, "x-subdomain")).toBe("teachers");
    expect(forwarded(res, "x-pathname")).toBe("/classes");
    expect(forwarded(res, "x-user-id")).toBe(TEACHER.userId);
  });

  it("rewrites a class id onto the physical student file and trusts x-forwarded-host over the internal host", async () => {
    const res = await proxy(
      await requestFor("http://localhost:3000/classes/student-9", {
        session: TEACHER,
        headers: { "x-forwarded-host": "teachers.project100.co.il:443, edge.internal" },
      })
    );

    expect(new URL(res.headers.get("x-middleware-rewrite") ?? "").pathname).toBe("/portal/students/student-9");
    expect(forwarded(res, "x-subdomain")).toBe("teachers");
    expect(forwarded(res, "x-pathname")).toBe("/classes/student-9");
    expect(res.headers.get("location")).toBeNull();
  });

  it("still sends a student away from the teachers host instead of rewriting them into the portal", async () => {
    const res = await proxy(await requestFor("http://teachers.localhost:3000/classes", { session: STUDENT }));

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/dashboard");
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("does not rewrite ordinary API routes on the teachers host", async () => {
    const res = await proxy(await requestFor("https://teachers.project100.co.il/api/me", { session: TEACHER }));

    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    expect(forwarded(res, "x-subdomain")).toBe("teachers");
    expect(forwarded(res, "x-pathname")).toBe("/api/me");
  });

  it("registers the classes alias in the matcher", () => {
    expect(config.matcher).toContain("/classes");
    expect(config.matcher).toContain("/classes/:path*");
  });
});

describe("proxy: app host and local app are not the teachers tree", () => {
  it("does not rewrite app.project100.co.il/lessons/123 onto a teachers path", async () => {
    const res = await proxy(
      await requestFor("https://app.project100.co.il/lessons/123", {
        session: STUDENT,
        headers: { "x-subdomain": "teachers", "x-pathname": "/portal/dashboard" },
      })
    );

    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    expect(res.headers.get("location")).toBeNull();
    expect(forwarded(res, "x-subdomain")).toBe("app");
    expect(forwarded(res, "x-pathname")).toBe("/lessons/123");
    expect(forwarded(res, "x-user-id")).toBe(STUDENT.userId);
  });

  it("treats app.localhost as the app and bare localhost as neither subdomain", async () => {
    const appLocal = await proxy(
      await requestFor("http://app.localhost:3000/lessons/123", { session: STUDENT })
    );
    expect(appLocal.headers.get("x-middleware-rewrite")).toBeNull();
    expect(forwarded(appLocal, "x-subdomain")).toBe("app");

    const bare = await proxy(await requestFor("http://localhost:3000/lessons/123", { session: STUDENT }));
    expect(bare.headers.get("x-middleware-rewrite")).toBeNull();
    expect(forwarded(bare, "x-subdomain")).toBeNull();
    expect(bare.headers.get("x-middleware-next")).toBe("1");
  });
});

describe("proxy: static assets and webhooks bypass the rewrite", () => {
  it("lets /_next/static through on the teachers host without a rewrite or subdomain header", async () => {
    const res = await proxy(
      await requestFor("https://teachers.project100.co.il/_next/static/css/app.css", {
        headers: { "x-subdomain": "teachers", "x-user-id": "attacker" },
      })
    );

    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    expect(res.headers.get("location")).toBeNull();
    expect(forwarded(res, "x-subdomain")).toBeNull();
    expect(forwarded(res, "x-user-id")).toBeNull();
  });

  it("lets /api/webhooks/daily through unchanged, including when a student cookie is present", async () => {
    const res = await proxy(
      await requestFor("https://teachers.project100.co.il/api/webhooks/daily", {
        session: STUDENT,
        headers: { "x-user-id": "attacker", "x-subdomain": "teachers" },
      })
    );

    expect(res.status).not.toBe(403);
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    expect(res.headers.get("location")).toBeNull();
    expect(forwarded(res, "x-subdomain")).toBeNull();
    expect(forwarded(res, "x-user-id")).toBeNull();
  });

  it("lets a public media file through without a rewrite", async () => {
    const res = await proxy(
      await requestFor("http://teachers.localhost:3000/videos/student-scheduling.webm")
    );
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });
});

describe("cross-subdomain session cookie", () => {
  it("sets the shared parent domain from SESSION_COOKIE_DOMAIN", () => {
    vi.stubEnv("SESSION_COOKIE_DOMAIN", ".project100.co.il");
    const set = sessionCookieOptions("token");
    const clear = clearSessionCookieOptions();
    expect(set.domain).toBe(".project100.co.il");
    expect(clear.domain).toBe(".project100.co.il");
    expect(set.httpOnly).toBe(true);
    expect(set.sameSite).toBe("lax");
    expect(set.path).toBe("/");
    expect(clear.path).toBe("/");
  });

  it("stays host-only for local development and preview when the domain is unset", () => {
    vi.stubEnv("SESSION_COOKIE_DOMAIN", "   ");
    expect("domain" in sessionCookieOptions("token")).toBe(false);
    expect("domain" in clearSessionCookieOptions()).toBe(false);
  });
});

describe("relative imports and the Next.js 16 interceptor", () => {
  const files = [
    "proxy.ts",
    "lib/routing/subdomain.ts",
    "lib/routing/teacher-subdomain.ts",
    "lib/auth.ts",
    "lib/platform-env.ts",
    "tests/middleware.test.ts",
  ];

  it("never uses the @/ alias in the routing files", () => {
    for (const file of files) {
      expect(readSource(file), file).not.toMatch(/from\s+["']@\//);
    }
  });

  it("does not import a third-party domain parser into the interceptor", () => {
    const source = readSource("proxy.ts") + readSource("lib/routing/subdomain.ts");
    expect(source).not.toMatch(/from\s+["'](?:psl|tldts|tldjs|parse-domain)/);
  });

  it("keeps the interceptor at proxy.ts — Next.js 16 rejects a sibling middleware.ts", () => {
    expect(existsSync(path.join(ROOT, "proxy.ts"))).toBe(true);
    expect(existsSync(path.join(ROOT, "middleware.ts"))).toBe(false);
    expect(existsSync(path.join(ROOT, "src/middleware.ts"))).toBe(false);
  });
});
