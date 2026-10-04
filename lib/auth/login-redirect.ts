import { staffPortalHome } from "./staff-roles";

/** Where `/login` sends a signed-in user. Client-safe. */

const AUTH_PAGES = ["/login", "/register", "/forgot-password"];

/** A same-site path from `?from=`, or null when it is missing, external or points back to an auth page. */
export function safeRedirectTarget(from: string | null): string | null {
  if (!from || !from.startsWith("/") || from.startsWith("//")) return null;
  if (AUTH_PAGES.some((page) => from === page || from.startsWith(`${page}?`))) return null;
  return from;
}

/**
 * An explicit deep link wins. Without one, approved teachers and representatives go to `/portal/dashboard`
 * (a teacher's cockpit); `?from=/dashboard` is the generic fallback the app adds everywhere, so it does not
 * keep an approved teacher on the old board. Everyone else lands on `/dashboard`.
 */
export function loginLandingPath(user: { role: string; isApproved?: boolean } | null | undefined, from: string | null): string {
  const target = safeRedirectTarget(from);
  const portalHome =
    user && (user.role === "TEACHER" || user.role === "REPRESENTATIVE")
      ? staffPortalHome(user.role, user.isApproved ?? false)
      : null;
  if (target && !(portalHome === "/portal/dashboard" && target === "/dashboard")) return target;
  return portalHome ?? "/dashboard";
}
