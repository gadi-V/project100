"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { toast } from "react-hot-toast";
import BrandWordmark from "../BrandWordmark";
import { frostHeader } from "../../lib/ui";
import {
  isPortalTabActive,
  portalExtraLinks,
  portalHomeHref,
  portalNavTabs,
  STAFF_ROLE_LABELS,
} from "../../lib/portal-nav";
import type { StudentDirectoryPage, StudentDirectoryRow } from "../../lib/student-directory-shared";
import { useDebouncedValue } from "./useDebouncedValue";

type PortalHeaderProps = {
  userName: string;
  role: string;
};

const QUICK_SEARCH_MIN_CHARS = 2;
const QUICK_SEARCH_LIMIT = 6;

type QuickSearchState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "done"; results: StudentDirectoryRow[] }
  | { phase: "error" };

function tabClass(active: boolean): string {
  return active
    ? "bg-neutral-900 text-white rounded-full px-4 py-1.5 text-xs font-medium"
    : "text-neutral-600 hover:text-neutral-900 px-4 py-1.5 text-xs font-medium transition-colors";
}

function studentHref(id: string): string {
  return `/portal/students/${encodeURIComponent(id)}`;
}

function QuickStudentSearch() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [state, setState] = useState<QuickSearchState>({ phase: "idle" });
  const debounced = useDebouncedValue(query.trim());
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (debounced.length < QUICK_SEARCH_MIN_CHARS) {
      setState({ phase: "idle" });
      return;
    }
    const controller = new AbortController();
    setState({ phase: "loading" });
    const params = new URLSearchParams({ search: debounced, limit: String(QUICK_SEARCH_LIMIT) });
    fetch(`/api/portal/students?${params.toString()}`, { signal: controller.signal })
      .then(async (response) => {
        const body = (await response.json()) as { success?: boolean; data?: StudentDirectoryPage };
        if (!response.ok || !body.success || !body.data) throw new Error("search failed");
        setState({ phase: "done", results: body.data.students });
        setHighlighted(0);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState({ phase: "error" });
      });
    return () => controller.abort();
  }, [debounced]);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const results = state.phase === "done" ? state.results : [];

  const goTo = (href: string) => {
    setOpen(false);
    setQuery("");
    router.push(href);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" && results.length > 0) {
      event.preventDefault();
      setOpen(true);
      setHighlighted((index) => (index + 1) % results.length);
      return;
    }
    if (event.key === "ArrowUp" && results.length > 0) {
      event.preventDefault();
      setHighlighted((index) => (index - 1 + results.length) % results.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const term = query.trim();
      if (!term) return;
      const picked = results[highlighted];
      if (picked && debounced === term) goTo(studentHref(picked.id));
      else goTo(`/portal/students?search=${encodeURIComponent(term)}`);
    }
  };

  const showPanel = open && query.trim().length >= QUICK_SEARCH_MIN_CHARS;

  return (
    <div ref={containerRef} className="relative w-full max-w-xs">
      <input
        type="search"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder="חיפוש תלמיד לפי שם או טלפון"
        aria-label="חיפוש תלמיד לפי שם או טלפון"
        role="combobox"
        aria-expanded={showPanel}
        aria-controls="portal-quick-search-results"
        className="w-full bg-white/70 border border-neutral-200 rounded-full ps-4 pe-4 py-1.5 text-xs text-neutral-900 placeholder:text-neutral-400 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-neutral-900/[0.08] focus-visible:border-neutral-800"
      />
      {showPanel && (
        <div
          id="portal-quick-search-results"
          role="listbox"
          className="absolute top-full mt-2 start-0 end-0 z-50 bg-white border border-neutral-200 rounded-xl shadow-lg overflow-hidden"
        >
          {state.phase === "loading" || state.phase === "idle" ? (
            <p className="px-4 py-3 text-xs text-neutral-500">מחפשים...</p>
          ) : state.phase === "error" ? (
            <p className="px-4 py-3 text-xs text-red-700">החיפוש נכשל. נסו שוב.</p>
          ) : results.length === 0 ? (
            <p className="px-4 py-3 text-xs text-neutral-500">לא נמצאו תלמידים.</p>
          ) : (
            <ul>
              {results.map((student, index) => (
                <li key={student.id} role="option" aria-selected={index === highlighted}>
                  <button
                    type="button"
                    onMouseEnter={() => setHighlighted(index)}
                    onClick={() => goTo(studentHref(student.id))}
                    className={`w-full text-start px-4 py-2.5 flex items-center justify-between gap-3 ${
                      index === highlighted ? "bg-neutral-100" : "bg-white"
                    }`}
                  >
                    <span className="text-xs font-medium text-neutral-900 truncate">{student.fullName}</span>
                    <span className="text-[14px] text-neutral-500 shrink-0" dir="ltr">
                      {student.phone}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Link
            href={`/portal/students?search=${encodeURIComponent(query.trim())}`}
            onClick={() => setOpen(false)}
            className="block border-t border-neutral-100 px-4 py-2 text-[14px] font-medium text-neutral-600 hover:bg-neutral-50"
          >
            לכל התוצאות ברשימת הלקוחות
          </Link>
        </div>
      )}
    </div>
  );
}

export default function PortalHeader({ userName, role }: PortalHeaderProps) {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);
  const tabs = portalNavTabs(role);
  const extraLinks = portalExtraLinks(role);

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await fetch("/api/logout", { method: "POST" });
      router.replace("/portal/login");
    } catch {
      toast.error("ההתנתקות נכשלה. נסו שוב.");
      setLoggingOut(false);
    }
  };

  return (
    <header className={`sticky top-0 z-50 ${frostHeader}`} dir="rtl">
      <div className="max-w-6xl mx-auto px-6 py-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex items-center gap-6 min-w-0">
          <Link href={portalHomeHref(role)} className="text-lg shrink-0" aria-label="דף הבית של הצוות">
            <BrandWordmark />
          </Link>
          <nav className="flex items-center gap-1" aria-label="ניווט צוות">
            {tabs.map((tab) => (
              <Link
                key={tab.key}
                href={tab.href}
                className={tabClass(isPortalTabActive(tab, pathname))}
                aria-current={isPortalTabActive(tab, pathname) ? "page" : undefined}
              >
                {tab.label}
              </Link>
            ))}
            {extraLinks.map((link) => (
              <Link key={link.href} href={link.href} className={tabClass(pathname.startsWith(link.href))}>
                {link.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3 flex-1 justify-end min-w-[16rem]">
          <QuickStudentSearch />
          <span className="hidden md:flex flex-col items-end leading-tight shrink-0">
            <span className="text-xs font-medium text-neutral-800">{userName}</span>
            <span className="text-[14px] text-neutral-500">{STAFF_ROLE_LABELS[role] ?? ""}</span>
          </span>
          <button
            type="button"
            onClick={handleLogout}
            disabled={loggingOut}
            className="shrink-0 text-xs font-medium text-neutral-600 hover:text-neutral-900 border border-neutral-200 bg-white/70 rounded-full px-4 py-1.5 transition-colors disabled:opacity-50"
          >
            התנתקות
          </button>
        </div>
      </div>
    </header>
  );
}
