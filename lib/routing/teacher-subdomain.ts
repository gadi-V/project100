/**
 * Host-based routing for the isolated teacher cockpit (e.g. teachers.project100.co.il,
 * teachers.localhost:3000). Pure functions only, so the proxy and tests share one source of truth.
 */

export const TEACHERS_SUBDOMAIN = "teachers";

/** Cockpit served at `/` on the teachers host. */
export const TEACHERS_HOME_PATH = "/portal/dashboard";

/** Public login URL on the teachers host; rendered by the staff gate. */
export const TEACHERS_LOGIN_PATH = "/login";
export const STAFF_LOGIN_PAGE = "/portal/login";

/** Where a signed-in student lands when they reach the teachers host. */
export const STUDENT_HOME_PATH = "/dashboard";

/** Public marketing surfaces that never render on the teachers host. */
export const MARKETING_PATH_PREFIXES = [
  "/pricing",
  "/diagnostic",
  "/onboarding",
  "/register",
  "/careers",
  "/packages",
] as const;

/** Session endpoints a student may still call on the teachers host. */
const STUDENT_ALLOWED_API_ROUTES = new Set(["/api/login", "/api/logout"]);

export type TeachersHostDecision =
  | { action: "pass" }
  | { action: "rewrite"; pathname: string }
  | { action: "redirect"; pathname: string }
  | { action: "redirect-main-site"; pathname: string }
  | { action: "forbidden" };

function hostnameOf(host: string): string {
  return host.trim().toLowerCase().replace(/:\d+$/, "");
}

export function isTeachersHost(host: string | null | undefined): boolean {
  if (!host) return false;
  return hostnameOf(host).startsWith(`${TEACHERS_SUBDOMAIN}.`);
}

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isMarketingPath(pathname: string): boolean {
  return MARKETING_PATH_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix));
}

/** Landing and marketing pages: no session work is needed for them on the main host. */
export function isPublicLandingPath(pathname: string): boolean {
  return pathname === "/" || isMarketingPath(pathname);
}

/**
 * Origin of the public site for a teachers-host request:
 * teachers.project100.co.il → project100.co.il, teachers.localhost:3000 → localhost:3000.
 */
export function mainSiteOrigin(host: string, protocol: string): string {
  const scheme = protocol.endsWith(":") ? protocol : `${protocol}:`;
  const mainHost = host.trim().replace(new RegExp(`^${TEACHERS_SUBDOMAIN}\\.`, "i"), "");
  return `${scheme}//${mainHost}`;
}

export function resolveTeachersHostRoute(input: {
  pathname: string;
  hasSession: boolean;
  role?: string | null;
}): TeachersHostDecision {
  const { pathname, hasSession, role } = input;
  const isApi = pathname === "/api" || pathname.startsWith("/api/");

  if (hasSession && role === "STUDENT") {
    if (!isApi) return { action: "redirect-main-site", pathname: STUDENT_HOME_PATH };
    return STUDENT_ALLOWED_API_ROUTES.has(pathname) ? { action: "pass" } : { action: "forbidden" };
  }

  if (isApi) return { action: "pass" };

  if (pathname === "/") {
    return hasSession
      ? { action: "rewrite", pathname: TEACHERS_HOME_PATH }
      : { action: "redirect", pathname: TEACHERS_LOGIN_PATH };
  }

  if (pathname === TEACHERS_LOGIN_PATH) {
    return { action: "rewrite", pathname: STAFF_LOGIN_PAGE };
  }

  if (isMarketingPath(pathname)) {
    return { action: "redirect", pathname: "/" };
  }

  return { action: "pass" };
}
