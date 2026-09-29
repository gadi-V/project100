import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, verifySession } from "./lib/auth";
import { isHiveMonitorBearer } from "./lib/hive-m2m-auth";
import {
  checkRateLimit,
  isRateLimitExempt,
  type RateLimitType,
} from "./lib/security/rate-limit";

const AUTH_RATE_LIMITED_ROUTES = new Set(["/api/login", "/api/register"]);
const API_RATE_LIMITED_ROUTES = new Set(["/api/leads"]);

function rateLimitTypeForPath(pathname: string): RateLimitType | null {
  if (isRateLimitExempt(pathname)) return null;
  if (AUTH_RATE_LIMITED_ROUTES.has(pathname) || pathname.startsWith("/api/auth/")) {
    return "auth";
  }
  if (API_RATE_LIMITED_ROUTES.has(pathname)) return "api";
  return null;
}

const PUBLIC_API_ROUTES = new Set([
  "/api/login",
  "/api/register",
  "/api/leads",
  "/api/logout",
  "/api/auth/forgot-password",
  "/api/auth/reset-password",
  "/api/webhooks/daily",
  "/api/webhooks/stripe",
  "/api/admin/audit/risk-events",
]);

/**
 * Prefixes open to unauthenticated guests (route handlers may still enforce auth).
 * Every /api/cron/* handler MUST call verifyCronRequest (lib/auth/cron.ts) itself.
 */
const PUBLIC_API_PREFIXES = ["/api/diagnostic", "/api/cron"] as const;

const AUTH_PAGES = new Set(["/login", "/register", "/forgot-password"]);

function isPublicApiPath(pathname: string): boolean {
  if (PUBLIC_API_ROUTES.has(pathname)) return true;
  return PUBLIC_API_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Rate limit sensitive public endpoints before anything else (/api/cron/* is exempt).
  const rateLimitType = rateLimitTypeForPath(pathname);
  if (rateLimitType) {
    const limited = await checkRateLimit(request, rateLimitType);
    if (limited.unavailable) {
      return NextResponse.json(
        { error: "Service Unavailable" },
        { status: 503, headers: { "Retry-After": "60" } }
      );
    }
    if (!limited.success) {
      const retryAfter = Math.max(1, Math.ceil((limited.reset - Date.now()) / 1000));
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

  // Never run redirect logic on auth pages themselves (hard stop for loops)
  if (AUTH_PAGES.has(pathname)) {
    return NextResponse.next();
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = token ? await verifySession(token) : null;

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
      return NextResponse.next();
    }

    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("from", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (pathname.startsWith("/api/")) {
    if (isPublicApiPath(pathname)) {
      return NextResponse.next();
    }
    // FastMCP / cron M2M: valid Bearer HIVE_MONITOR_SECRET bypasses cookie auth.
    // Route handlers still re-verify via requireAuthOrMonitor.
    if (isHiveMonitorBearer(request)) {
      return NextResponse.next();
    }
    if (!session) {
      return NextResponse.json({ error: "נדרשת התחברות למערכת" }, { status: 401 });
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/dashboard",
    "/dashboard/:path*",
    "/lessons",
    "/lessons/:path*",
    "/admin",
    "/admin/:path*",
    "/login",
    "/register",
    "/forgot-password",
    "/api/:path*",
  ],
};
