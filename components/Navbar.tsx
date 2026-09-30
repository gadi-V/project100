"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import BrandWordmark from "./BrandWordmark";

type NavItem = {
  label: string;
  href: string;
  /** Dedicated full-page routes that mark this item active */
  routes?: string[];
  /** In-page section id observed via IntersectionObserver */
  sectionId?: string;
};

/** Group A — in-page scroll anchors (mirrors landing vertical order) */
const SCROLL_NAV_ITEMS: NavItem[] = [
  { label: "דף הבית", href: "/#challenge", sectionId: "challenge" },
  { label: "השיטה", href: "/#method", sectionId: "method" },
  {
    label: "מחירון",
    href: "/#pricing",
    sectionId: "pricing",
    routes: ["/pricing"],
  },
  { label: "אודות", href: "/#about", sectionId: "about" },
  { label: "שאלות ותשובות", href: "/#faq", sectionId: "faq" },
];

/** Group B — standalone route (sits with system actions on the left) */
const DIAGNOSTIC_ITEM: NavItem = {
  label: "אבחון",
  href: "/onboarding/diagnostic",
  routes: ["/onboarding/diagnostic"],
};

const PERSONAL_AREA_ROUTES = ["/dashboard", "/login"];

const SCROLL_SECTION_IDS = ["challenge", "method", "pricing", "about", "faq"] as const;

function pathMatchesRoute(pathname: string, route: string): boolean {
  return pathname === route || pathname.startsWith(`${route}/`);
}

function navLinkClass(active: boolean): string {
  if (active) {
    return "bg-neutral-900 text-white font-medium px-4 py-1.5 rounded-full text-xs tracking-wide transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] shadow-sm";
  }
  return "text-neutral-600 hover:text-neutral-900 px-4 py-1.5 text-xs tracking-wide font-medium transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]";
}

export default function Navbar() {
  const pathname = usePathname() ?? "";
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const isDiagnosticActive = DIAGNOSTIC_ITEM.routes!.some((route) =>
    pathMatchesRoute(pathname, route)
  );
  const isPersonalAreaActive = PERSONAL_AREA_ROUTES.some((route) =>
    pathMatchesRoute(pathname, route)
  );
  const isOnStandaloneRoute =
    isDiagnosticActive ||
    isPersonalAreaActive ||
    SCROLL_NAV_ITEMS.some((item) =>
      item.routes?.some((route) => pathMatchesRoute(pathname, route))
    );

  useEffect(() => {
    // Scroll-spy only applies on pages that host the landing sections
    const elements = SCROLL_SECTION_IDS.map((id) => document.getElementById(id)).filter(
      (el): el is HTMLElement => el !== null
    );

    if (elements.length === 0) {
      setActiveSection(null);
      return;
    }

    const hashId = typeof window !== "undefined" ? window.location.hash.replace(/^#/, "") : "";
    if (hashId && SCROLL_SECTION_IDS.includes(hashId as (typeof SCROLL_SECTION_IDS)[number])) {
      setActiveSection(hashId);
    }

    const visibility = new Map<string, number>();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.id;
          visibility.set(id, entry.isIntersecting ? entry.intersectionRatio : 0);
        }

        let bestId: string | null = null;
        let bestRatio = 0;
        // Strict sequential order — never consider standalone routes
        for (const id of SCROLL_SECTION_IDS) {
          const ratio = visibility.get(id) ?? 0;
          if (ratio > bestRatio) {
            bestRatio = ratio;
            bestId = id;
          }
        }

        if (bestId && bestRatio > 0) {
          setActiveSection(bestId);
        }
      },
      {
        rootMargin: "-25% 0px -55% 0px",
        threshold: [0, 0.1, 0.25, 0.5, 0.75, 1],
      }
    );

    for (const el of elements) {
      observer.observe(el);
    }

    return () => {
      observer.disconnect();
    };
  }, [pathname]);

  const isScrollItemActive = (item: NavItem): boolean => {
    if (item.routes?.some((route) => pathMatchesRoute(pathname, route))) {
      return true;
    }
    // Standalone routes own the sole active pill — suppress section highlights
    if (isOnStandaloneRoute) {
      return false;
    }
    return Boolean(item.sectionId && activeSection === item.sectionId);
  };

  const renderNavLink = (item: NavItem, active: boolean) => {
    const className = navLinkClass(active);

    if (item.href.startsWith("/#") || item.href.startsWith("#")) {
      return (
        <a key={item.label} href={item.href} className={className}>
          {item.label}
        </a>
      );
    }

    return (
      <Link key={item.label} href={item.href} className={className}>
        {item.label}
      </Link>
    );
  };

  return (
    <header
      className={`sticky top-0 z-50 border-b transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] ${
        scrolled
          ? "bg-white/55 backdrop-blur-2xl saturate-[190%] shadow-sm border-white/70"
          : "bg-white/35 backdrop-blur-xl saturate-[180%] border-white/50"
      }`}
      dir="rtl"
    >
      <div className={`w-full px-4 sm:px-6 lg:px-10 flex items-center justify-between gap-4 transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] ${
        scrolled ? "py-2.5" : "py-4"
      }`}>
        {/* Right cluster: logo + Group A scroll anchors */}
        <div className="flex items-center gap-8">
          <Link href="/" className="text-lg" aria-label="PROJECT100 – דף הבית">
            <BrandWordmark />
          </Link>
          <nav className="hidden md:flex items-center gap-1" aria-label="ניווט עמוד">
            {SCROLL_NAV_ITEMS.map((item) =>
              renderNavLink(item, isScrollItemActive(item))
            )}
          </nav>
        </div>

        {/* Left cluster: Group B standalone routes + system actions */}
        <div className="flex items-center gap-2">
          <nav className="hidden md:flex items-center gap-1" aria-label="פעולות מערכת">
            {renderNavLink(DIAGNOSTIC_ITEM, isDiagnosticActive)}
            <Link href="/login" className={navLinkClass(isPersonalAreaActive)}>
              אזור אישי
            </Link>
          </nav>
          <Link
            href="/register"
            className="bg-[#0071e3] hover:bg-[#0077ed] text-white text-xs font-bold py-1.5 px-4 rounded-full transition-all"
          >
            הצטרפות
          </Link>
        </div>
      </div>
    </header>
  );
}
