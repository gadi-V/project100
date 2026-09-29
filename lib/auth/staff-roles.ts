import type { Role } from "@prisma/client";

/** Roles allowed through the isolated staff gate at `/portal/login`. */
export const STAFF_PORTAL_ROLES = [
  "TEACHER",
  "REPRESENTATIVE",
  "ADMIN",
  "MANAGER",
] as const satisfies readonly Role[];

/** Roles allowed to record and read mapping-call intake assessments. */
export const INTAKE_RECORDER_ROLES: Role[] = ["REPRESENTATIVE", "ADMIN", "MANAGER"];

export function isStaffPortalRole(role: string | null | undefined): boolean {
  return (STAFF_PORTAL_ROLES as readonly string[]).includes(role ?? "");
}

/** Landing page after a successful staff sign-in. `/admin` only admits ADMIN / MANAGER. */
export function staffPortalHome(role: string): string {
  return role === "ADMIN" || role === "MANAGER" ? "/admin" : "/dashboard";
}
