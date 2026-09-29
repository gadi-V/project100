"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import Navbar from "./Navbar";
import Footer from "./Footer";
import InternalAppHeader from "./InternalAppHeader";

const INTERNAL_PREFIXES = ["/dashboard", "/admin", "/packages/"] as const;

function isInternalAppPath(pathname: string | null): boolean {
  if (!pathname) return false;
  return INTERNAL_PREFIXES.some(
    (prefix) => pathname === prefix.replace(/\/$/, "") || pathname.startsWith(prefix)
  );
}

/**
 * Site chrome wrapper.
 * - Classroom (/lessons/*): children only (full viewport board + video)
 * - Staff gate (/portal/*): children only, no marketing navigation
 * - Internal authenticated surfaces: frosted app header, no marketing footer
 * - Public marketing: Navbar + Footer
 */
export default function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isClassroom = Boolean(pathname?.startsWith("/lessons/"));
  const isStaffPortal = pathname === "/portal" || Boolean(pathname?.startsWith("/portal/"));
  const isInternal = isInternalAppPath(pathname);

  if (isClassroom || isStaffPortal) {
    return <>{children}</>;
  }

  if (isInternal) {
    return (
      <>
        <InternalAppHeader />
        <main className="flex-grow">{children}</main>
      </>
    );
  }

  return (
    <div className="relative z-10 flex flex-col flex-grow">
      <Navbar />
      <main className="flex-grow relative">{children}</main>
      <Footer />
    </div>
  );
}
