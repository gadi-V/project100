import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, verifySession } from "./lib/auth";
import { isHiveMonitorBearer } from "./lib/hive-m2m-auth";
import {
  isSubdomainBypassPath,
  readRequestHost,
  resolveTeachersAliasRewrite,
  subdomainContext,
  PATHNAME_HEADER,
  SUBDOMAIN_HEADER,
  type SubdomainContext,
} from "./lib/routing/subdomain";
import {
  isPublicLandingPath,
  isTeachersHost,
  mainSiteOrigin,
  resolveTeachersHostRoute,
} from "./lib/routing/teacher-subdomain";
import {
  checkRateLimit,
  isRateLimitExempt,
  type RateLimitType,
} from "./lib/security/rate-limit";

const AUTH_RATE_LIMITED_ROUTES = new Set(["/api/login", "/api/register", "/api/register/student"]);
const API_RATE_LIMITED_ROUTES = new Set(["/api/leads", "/api/careers/apply"]);

/** Student booking and reschedule. GET list/detail stays unlimited (a static read). */
function isBookingRequest(pathname: string, method: string): boolean {
  if (method !== "POST") return false;
  if (pathname === "/api/lessons") return true;
  return /^\/api\/lessons\/[^/]+\/reschedule$/.test(pathname);
}

function rateLimitTypeForPath(pathname: string, method: string): RateLimitType | null {
  if (isRateLimitExempt(pathname)) return null;
  if (AUTH_RATE_LIMITED_ROUTES.has(pathname) || pathname.startsWith("/api/auth/")) {
    return "auth";
  }
  if (isBookingRequest(pathname, method)) return "booking";
  if (API_RATE_LIMITED_ROUTES.has(pathname)) return "api";
  return null;
}

const PUBLIC_API_ROUTES = new Set([
  "/api/login",
  "/api/register",
  "/api/register/student",
  "/api/leads",
  "/api/careers/apply",
  "/api/logout",
  "/api/health",
  "/api/auth/forgot-password",
  "/api/auth/reset-password",
  "/api/auth/google",
  "/api/auth/google/callback",
  "/api/auth/google/complete",
  "/api/webhooks/daily",
  "/api/webhooks/stripe",
  "/api/admin/audit/risk-events",
  // Cron/QStash-driven; the handler enforces verifyCronRequest itself.
  "/api/agents/dispatch",
]);

/**
 * Prefixes open to unauthenticated guests (route handlers may still enforce auth).
 * Every /api/cron/* handler MUST call verifyCronRequest (lib/auth/cron.ts) itself.
 */
const PUBLIC_API_PREFIXES = ["/api/diagnostic", "/api/cron"] as const;

const AUTH_PAGES = new Set(["/login", "/register", "/forgot-password"]);

/**
 * Identity header consumed by downstream route handlers. Client-supplied values
 * are always dropped; it is only ever set from a verified session JWT.
 */
const TRUSTED_USER_ID_HEADER = "x-user-id";

function trustedHeaders(
  request: NextRequest,
  verifiedUserId: string | null,
  context?: SubdomainContext
): Headers {
  const headers = new Headers(request.headers);
  headers.delete(TRUSTED_USER_ID_HEADER);
  headers.delete(SUBDOMAIN_HEADER);
  headers.delete(PATHNAME_HEADER);
  if (verifiedUserId) {
    headers.set(TRUSTED_USER_ID_HEADER, verifiedUserId);
  }
  if (context) {
    headers.set(SUBDOMAIN_HEADER, context.subdomain);
    headers.set(PATHNAME_HEADER, context.pathname);
  }
  return headers;
}

function forward(
  request: NextRequest,
  verifiedUserId: string | null = null,
  context?: SubdomainContext
) {
  return NextResponse.next({ request: { headers: trustedHeaders(request, verifiedUserId, context) } });
}

function rewriteTo(request: NextRequest, pathname: string, verifiedUserId: string | null, context?: SubdomainContext) {
  return NextResponse.rewrite(new URL(pathname, request.url), {
    request: { headers: trustedHeaders(request, verifiedUserId, context) },
  });
}

function requestHost(request: NextRequest): string {
  return readRequestHost(
    request.headers.get("x-forwarded-host"),
    request.headers.get("host"),
    request.nextUrl.host
  );
}

function isPublicApiPath(pathname: string): boolean {
  if (PUBLIC_API_ROUTES.has(pathname)) return true;
  return PUBLIC_API_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Rate limit sensitive endpoints before anything else (/api/cron/* is exempt).
  // Auth and booking fail closed when Redis is down (503). Public form posts fail open.
  const rateLimitType = rateLimitTypeForPath(pathname, request.method);
  if (rateLimitType) {
    const limited = await checkRateLimit(request, rateLimitType);
    if (!limited.success) {
      const retryAfter = Math.max(1, Math.ceil((limited.reset - Date.now()) / 1000));
      if (limited.degraded) {
        return NextResponse.json(
          { error: "לא הצלחנו להשלים את הבקשה כרגע. נסו שוב בעוד דקה." },
          { status: 503, headers: { "Retry-After": String(retryAfter) } }
        );
      }
      return NextResponse.json(
        { error: "Too Many Requests" },
        {
          status: 429,
          headers: {
            "Retry-After": String(retryAfter),
            "X-RateLimit-Limit": String(limited.limit),
            "X-RateLimit-Remaining": "0",
          },
        }
      );
    }
  }

  // Static assets, public media, and webhooks never change path. Identity
  // headers are still stripped so a client cannot spoof x-user-id.
  if (isSubdomainBypassPath(pathname)) {
    return forward(request);
  }

  const host = requestHost(request);
  const onTeachersHost = isTeachersHost(host);
  const routeContext = subdomainContext(host, pathname);

  if (!onTeachersHost) {
    // Never run redirect logic on auth pages themselves (hard stop for loops)
    if (AUTH_PAGES.has(pathname) || isPublicLandingPath(pathname)) {
      return forward(request, null, routeContext);
    }
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = token ? await verifySession(token) : null;
  const verifiedUserId = session?.userId ?? null;

  if (onTeachersHost) {
    const decision = resolveTeachersHostRoute({
      pathname,
      hasSession: Boolean(session),
      role: session?.role,
    });
    switch (decision.action) {
      case "rewrite":
        return rewriteTo(request, decision.pathname, verifiedUserId, routeContext);
      case "redirect":
        return NextResponse.redirect(new URL(decision.pathname, request.url));
      case "redirect-main-site":
        return NextResponse.redirect(
          new URL(decision.pathname, mainSiteOrigin(host, request.nextUrl.protocol))
        );
      case "forbidden":
        return NextResponse.json(
          { success: false, error: "אזור זה מיועד לצוות ההוראה בלבד" },
          { status: 403 }
        );
      case "pass": {
        if (AUTH_PAGES.has(pathname)) return forward(request, null, routeContext);
        const alias = resolveTeachersAliasRewrite(pathname);
        if (alias) return rewriteTo(request, alias, verifiedUserId, routeContext);
        break;
      }
    }
  }

  const isProtectedPage =
    pathname === "/dashboard" ||
    pathname.startsWith("/dashboard/") ||
    pathname === "/lessons" ||
    pathname.startsWith("/lessons/") ||
    pathname === "/admin" ||
    pathname.startsWith("/admin/");

  if (isProtectedPage && !session) {
    // Guard: never redirect to the same path
    if (pathname === "/login") {
      return forward(request);
    }

    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("from", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (pathname.startsWith("/api/")) {
    if (isPublicApiPath(pathname)) {
      return forward(request, verifiedUserId, routeContext);
    }
    // FastMCP / cron M2M: valid Bearer HIVE_MONITOR_SECRET bypasses cookie auth.
    // Route handlers still re-verify via requireAuthOrMonitor.
    if (isHiveMonitorBearer(request)) {
      return forward(request, verifiedUserId, routeContext);
    }
    if (!session) {
      return NextResponse.json({ error: "נדרשת התחברות למערכת" }, { status: 401 });
    }
  }

  return forward(request, verifiedUserId, routeContext);
}

export const config = {
  matcher: [
    "/",
    "/portal",
    "/portal/:path*",
    "/pricing",
    "/pricing/:path*",
    "/diagnostic",
    "/diagnostic/:path*",
    "/onboarding/:path*",
    "/register/:path*",
    "/careers",
    "/careers/:path*",
    "/packages",
    "/packages/:path*",
    "/dashboard",
    "/dashboard/:path*",
    "/lessons",
    "/lessons/:path*",
    "/admin",
    "/admin/:path*",
    "/login",
    "/register",
    "/forgot-password",
    "/classes",
    "/classes/:path*",
    "/api/:path*",
  ],
};
