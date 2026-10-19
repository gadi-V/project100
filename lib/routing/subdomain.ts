/**
 * Hostname classification and internal rewrites for the teachers / app split.
 * Pure functions, Web APIs only. The Next.js 16 interceptor is `proxy.ts`
 * (a root `middleware.ts` cannot coexist with it).
 */

import { isAppHost, isTeachersHost } from "./teacher-subdomain";

export const SUBDOMAIN_HEADER = "x-subdomain";
export const PATHNAME_HEADER = "x-pathname";

const STATIC_PREFIXES = ["/_next/static", "/_next/image"] as const;

/** Directories under `public/` that are files, not App Router pages. */
const PUBLIC_MEDIA_PREFIXES = ["/images/", "/videos/", "/uploads/", "/fonts/"] as const;

const PUBLIC_MEDIA_EXT = /\.(?:png|jpe?g|gif|webp|svg|ico|avif|mp4|webm|mp3|pdf|woff2?|ttf)$/i;

export type SubdomainName = "teachers" | "app";

export type SubdomainContext = {
  subdomain: SubdomainName;
  pathname: string;
};

/**
 * Public host: `x-forwarded-host` (first hop), then `host`, then the URL host.
 * The port is kept here; callers strip it when classifying the hostname.
 */
export function readRequestHost(
  forwardedHost: string | null | undefined,
  host: string | null | undefined,
  fallbackHost: string | null | undefined
): string {
  const forwarded = forwardedHost?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  const direct = host?.trim();
  if (direct) return direct;
  return fallbackHost?.trim() ?? "";
}

export function subdomainForHost(host: string | null | undefined): SubdomainName | null {
  if (!host) return null;
  if (isTeachersHost(host)) return "teachers";
  if (isAppHost(host)) return "app";
  return null;
}

export function subdomainContext(host: string, pathname: string): SubdomainContext | undefined {
  const subdomain = subdomainForHost(host);
  if (!subdomain) return undefined;
  return { subdomain, pathname };
}

/**
 * Paths the subdomain layer must not rewrite: Next static assets, the image
 * optimizer, the favicon, public media files, `/api/health`, and inbound webhooks.
 * Ordinary `/api/*` routes are not in this list — they keep their pathname
 * and still pass through the session gate in the proxy.
 */
export function isSubdomainBypassPath(pathname: string): boolean {
  if (pathname === "/favicon.ico") return true;
  if (STATIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return true;
  }
  if (pathname === "/api/webhooks" || pathname.startsWith("/api/webhooks/")) return true;
  if (pathname === "/api/health" || pathname.startsWith("/api/health/")) return true;
  if (PUBLIC_MEDIA_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true;
  // A single public file at the site root (`/logo.svg`). Nested app routes keep their gate.
  const slash = pathname.indexOf("/", 1);
  if (slash === -1 && PUBLIC_MEDIA_EXT.test(pathname)) return true;
  return false;
}

/**
 * Teachers-host URLs that are not already a physical route.
 *
 * `/classes` is the roster. The page that renders it is `/portal/students`
 * (`app/portal/students`). `/dashboard` is intentionally not rewritten: it is
 * already `app/dashboard/page.tsx`, and `/portal/dashboard` sends teachers who
 * are still in onboarding back to `/dashboard` — rewriting it would loop.
 */
export function resolveTeachersAliasRewrite(pathname: string): string | null {
  if (pathname === "/classes") return "/portal/students";
  if (pathname.startsWith("/classes/")) {
    return `/portal/students${pathname.slice("/classes".length)}`;
  }
  return null;
}
