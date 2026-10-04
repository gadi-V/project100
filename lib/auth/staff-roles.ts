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

/** Pedagogic decision (subscription) and direct package assignment. MANAGER is the pedagogic manager. */
export const ENROLLMENT_DECISION_ROLES: Role[] = ["MANAGER", "ADMIN", "REPRESENTATIVE"];

export function isStaffPortalRole(role: string | null | undefined): boolean {
  return (STAFF_PORTAL_ROLES as readonly string[]).includes(role ?? "");
}

export function isIntakeRecorderRole(role: string | null | undefined): boolean {
  return (INTAKE_RECORDER_ROLES as readonly string[]).includes(role ?? "");
}

/**
 * Landing page after a successful staff sign-in. `/admin` only admits ADMIN / MANAGER; approved teachers
 * land on their cockpit, teachers still in onboarding on `/dashboard`.
 */
export function staffPortalHome(role: string, isApproved = true): string {
  if (role === "ADMIN" || role === "MANAGER") return "/admin";
  if (role === "REPRESENTATIVE") return "/portal/dashboard";
  if (role === "TEACHER" && isApproved) return "/portal/dashboard";
  return "/dashboard";
}
