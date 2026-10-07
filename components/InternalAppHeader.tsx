"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { frostHeader } from "../lib/ui";
import BrandWordmark from "./BrandWordmark";

type Crumb = { label: string; href?: string };

function crumbsForPath(pathname: string): Crumb[] {
  if (pathname.startsWith("/admin/teachers/") && pathname.includes("/vetting")) {
    return [
      { label: "לוח ניהול", href: "/admin" },
      { label: "מורים", href: "/admin/teachers" },
      { label: "וטינג" },
    ];
  }
  if (pathname.startsWith("/admin/teachers")) {
    return [
      { label: "לוח ניהול", href: "/admin" },
      { label: "מורים" },
    ];
  }
  if (pathname.startsWith("/admin/lessons")) {
    return [
      { label: "לוח ניהול", href: "/admin" },
      { label: "שיעורים · Override" },
    ];
  }
  if (pathname.startsWith("/admin/payouts")) {
    return [
      { label: "לוח ניהול", href: "/admin" },
      { label: "תשלומים" },
    ];
  }
  if (pathname.startsWith("/admin/curriculum")) {
    return [
      { label: "לוח ניהול", href: "/admin" },
      { label: "תכנית לימודים" },
    ];
  }
  if (pathname.startsWith("/admin")) {
    return [{ label: "לוח ניהול" }];
  }
  if (pathname.includes("/recording")) {
    return [
      { label: "אזור אישי", href: "/dashboard" },
      { label: "הקלטה" },
    ];
  }
  if (pathname.startsWith("/packages/") && pathname.includes("/quiz")) {
    return [
      { label: "אזור אישי", href: "/dashboard" },
      { label: "בוחן חבילה" },
    ];
  }
  if (pathname.startsWith("/packages/") && pathname.includes("/report")) {
    return [
      { label: "אזור אישי", href: "/dashboard" },
      { label: "דוח חבילה" },
    ];
  }
  if (pathname.startsWith("/dashboard")) {
    return [{ label: "אזור אישי" }];
  }
  return [{ label: "אזור אישי", href: "/dashboard" }];
}

/**
 * Frosted internal app header — breadcrumbs + profile affordance.
 * Used on authenticated surfaces instead of the marketing Navbar.
 */
export default function InternalAppHeader() {
  const pathname = usePathname() ?? "";
  const crumbs = crumbsForPath(pathname);
  const isAdmin = pathname.startsWith("/admin");

  return (
    <header className={`sticky top-0 z-50 ${frostHeader}`} dir="rtl">
      <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            href="/"
            className="text-lg shrink-0"
            aria-label="PROJECT100 – דף הבית"
          >
            <BrandWordmark withMark />
          </Link>
          <nav
            aria-label="פירורי לחם"
            className="hidden sm:flex items-center gap-1.5 text-sm text-neutral-500 truncate"
          >
            {crumbs.map((crumb, i) => (
              <span key={`${crumb.label}-${i}`} className="flex items-center gap-1.5 min-w-0">
                {i > 0 && <span className="text-neutral-300" aria-hidden>／</span>}
                {crumb.href ? (
                  <Link
                    href={crumb.href}
                    className="hover:text-neutral-900 transition-colors truncate"
                  >
                    {crumb.label}
                  </Link>
                ) : (
                  <span className="text-neutral-900 font-medium truncate">
                    {crumb.label}
                  </span>
                )}
              </span>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {isAdmin && (
            <Link
              href="/dashboard"
              className="text-xs font-medium text-neutral-600 hover:text-neutral-900 border border-neutral-200 bg-white hover:bg-neutral-50 rounded-full px-4 py-1.5 transition-colors"
            >
              אזור אישי
            </Link>
          )}
          <Link
            href="/dashboard"
            className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-neutral-900 text-white text-xs font-semibold"
            title="פרופיל"
            aria-label="פרופיל משתמש"
          >
            אני
          </Link>
        </div>
      </div>
    </header>
  );
}
