"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "react-hot-toast";
import BrandWordmark from "../../../components/BrandWordmark";
import { fieldClass, frostCard, pageCanvas, primaryCta } from "../../../lib/ui";
import { isStaffPortalRole, staffPortalHome } from "../../../lib/auth/staff-roles";

type LoginResponse = {
  error?: string;
  user?: { name: string; role: string; isApproved?: boolean };
};

type MeResponse = {
  user?: { role: string; isApproved?: boolean };
};

export default function StaffPortalLoginPage() {
  const router = useRouter();
  const [formData, setFormData] = useState({ identifier: "", password: "" });
  const [loading, setLoading] = useState(false);
  const checkedSession = useRef(false);

  useEffect(() => {
    if (checkedSession.current) return;
    checkedSession.current = true;

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/me");
        if (!res.ok || cancelled) return;
        const me = (await res.json()) as MeResponse;
        if (me.user && isStaffPortalRole(me.user.role)) {
          router.replace(staffPortalHome(me.user.role, me.user.isApproved ?? false));
        }
      } catch {
        // stay on the staff gate
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...formData, portal: "staff" }),
      });
      const data = (await response.json()) as LoginResponse;

      if (!response.ok || !data.user) {
        throw new Error(data.error || "פרטי ההתחברות שגויים");
      }
      if (!isStaffPortalRole(data.user.role)) {
        throw new Error("הכניסה כאן מיועדת לצוות בלבד");
      }

      toast.success(`שלום, ${data.user.name}`);
      router.replace(staffPortalHome(data.user.role, data.user.isApproved ?? false));
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "שגיאה בהתחברות");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main
      className={`${pageCanvas} relative z-10 flex items-center justify-center py-12 px-4 sm:px-6 lg:px-8`}
      dir="rtl"
    >
      <div className={`max-w-md w-full space-y-8 ${frostCard} p-8`}>
        <div className="text-center space-y-2">
          <div className="text-lg">
            <BrandWordmark />
          </div>
          <h1 className="text-3xl font-semibold tracking-tight text-neutral-900">כניסת צוות</h1>
          <p className="text-sm text-neutral-500">למורים, נציגים ומנהלים.</p>
        </div>

        <form className="space-y-5" onSubmit={handleSubmit}>
          <div>
            <label
              htmlFor="staff-identifier"
              className="text-xs font-semibold text-neutral-600 block mb-1.5 text-start"
            >
              אימייל או מספר טלפון
            </label>
            <input
              id="staff-identifier"
              type="text"
              required
              autoComplete="username"
              disabled={loading}
              dir="rtl"
              className={fieldClass}
              value={formData.identifier}
              onChange={(e) => setFormData({ ...formData, identifier: e.target.value })}
            />
          </div>

          <div>
            <div className="flex justify-between items-center mb-1.5 gap-3">
              <label
                htmlFor="staff-password"
                className="text-xs font-semibold text-neutral-600 text-start"
              >
                סיסמה
              </label>
              <Link
                href="/forgot-password"
                className="text-xs text-neutral-500 hover:text-neutral-800 transition-colors"
              >
                שכחת סיסמה?
              </Link>
            </div>
            <input
              id="staff-password"
              type="password"
              required
              autoComplete="current-password"
              disabled={loading}
              dir="rtl"
              className={fieldClass}
              value={formData.password}
              onChange={(e) => setFormData({ ...formData, password: e.target.value })}
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className={`w-full ${primaryCta} mt-6 flex items-center justify-center`}
          >
            {loading ? "מתחברים..." : "כניסה"}
          </button>
        </form>

        <p className="text-center text-xs text-neutral-500">
          תלמיד או הורה?{" "}
          <Link href="/login" className="font-medium text-neutral-900 hover:underline">
            לכניסה לאזור האישי
          </Link>
        </p>
      </div>
    </main>
  );
}
