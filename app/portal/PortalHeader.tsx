"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "react-hot-toast";
import BrandWordmark from "../../components/BrandWordmark";
import { frostHeader } from "../../lib/ui";

type PortalHeaderProps = {
  userName: string;
  isAdmin: boolean;
};

const NAV_ITEMS = [
  { href: "/portal/dashboard", label: "לוח הצוות" },
  { href: "/portal/intake", label: "שיחת מיפוי" },
] as const;

function navClass(active: boolean): string {
  return active
    ? "bg-neutral-900 text-white rounded-full px-4 py-1.5 text-xs font-medium"
    : "text-neutral-600 hover:text-neutral-900 px-4 py-1.5 text-xs font-medium transition-colors";
}

export default function PortalHeader({ userName, isAdmin }: PortalHeaderProps) {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);

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
      <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between gap-4">
        <div className="flex items-center gap-6 min-w-0">
          <Link href="/portal/dashboard" className="text-lg shrink-0" aria-label="לוח הצוות">
            <BrandWordmark />
          </Link>
          <nav className="flex items-center gap-1" aria-label="ניווט צוות">
            {NAV_ITEMS.map((item) => (
              <Link key={item.href} href={item.href} className={navClass(pathname.startsWith(item.href))}>
                {item.label}
              </Link>
            ))}
            {isAdmin && (
              <Link href="/admin" className={navClass(false)}>
                לוח ניהול
              </Link>
            )}
          </nav>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="hidden sm:inline text-xs text-neutral-500">{userName}</span>
          <button
            type="button"
            onClick={handleLogout}
            disabled={loggingOut}
            className="text-xs font-medium text-neutral-600 hover:text-neutral-900 border border-neutral-200 bg-white/70 rounded-full px-4 py-1.5 transition-colors disabled:opacity-50"
          >
            התנתקות
          </button>
        </div>
      </div>
    </header>
  );
}
