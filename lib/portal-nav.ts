import { isIntakeRecorderRole } from "./auth/staff-roles";

/** Top navigation of the staff portal (`components/portal/PortalHeader.tsx`). */

export const STAFF_ROLE_LABELS: Record<string, string> = {
  REPRESENTATIVE: "נציג/ה",
  ADMIN: "מנהל/ת מערכת",
  MANAGER: "מנהל/ת פדגוגי/ת",
  TEACHER: "מורה",
};

export type PortalNavTab = {
  key: "today" | "courses" | "students";
  label: string;
  href: string;
};

export type PortalNavLink = { href: string; label: string };

/**
 * "היום" opens the role's daily workspace (`/portal/dashboard`: the teacher cockpit for teachers),
 * "קורסים" the lessons view the role may open (`/admin/lessons` is ADMIN / MANAGER only, teachers get
 * their lesson list), and the directory ("התלמידים שלי" for a teacher, "לקוחות" for staff).
 * Representatives have no lessons view yet, so they get no "קורסים" tab.
 */
export function portalNavTabs(role: string): PortalNavTab[] {
  const isAdmin = role === "ADMIN" || role === "MANAGER";
  const tabs: PortalNavTab[] = [{ key: "today", label: "היום", href: "/portal/dashboard" }];
  if (isAdmin) tabs.push({ key: "courses", label: "קורסים", href: "/admin/lessons" });
  else if (role === "TEACHER") tabs.push({ key: "courses", label: "קורסים", href: "/dashboard#teacher-lessons" });
  tabs.push({ key: "students", label: role === "TEACHER" ? "התלמידים שלי" : "לקוחות", href: "/portal/students" });
  return tabs;
}

/** Secondary links shown after the tabs. */
export function portalExtraLinks(role: string): PortalNavLink[] {
  const links: PortalNavLink[] = [];
  if (isIntakeRecorderRole(role)) links.push({ href: "/portal/intake", label: "שיחת מיפוי" });
  if (role === "ADMIN" || role === "MANAGER") links.push({ href: "/admin", label: "לוח ניהול" });
  return links;
}

export function isPortalTabActive(tab: PortalNavTab, pathname: string): boolean {
  const path = tab.href.split("#")[0];
  return pathname === path || pathname.startsWith(`${path}/`);
}

export function portalHomeHref(_role: string): string {
  return "/portal/dashboard";
}
