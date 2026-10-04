"use client";
import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "react-hot-toast";
import { fieldClass, frostCard, pageCanvas, primaryCta } from "../../lib/ui";
import { loginLandingPath } from "../../lib/auth/login-redirect";

type SessionUser = { name?: string; role: string; isApproved?: boolean };

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
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
        const me = (await res.json().catch(() => null)) as { user?: SessionUser } | null;
        if (cancelled) return;
        router.replace(loginLandingPath(me?.user, searchParams.get("from")));
      } catch {
        // stay on login
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [router, searchParams]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    const loginToast = toast.loading("מתחבר לסביבת העבודה המאובטחת...");

    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "פרטי ההתחברות שגויים");
      }

      toast.success(`ברוך הבא, ${data.user.name}!`, { id: loginToast });
      router.replace(loginLandingPath(data.user as SessionUser, searchParams.get("from")));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "שגיאה בהתחברות";
      toast.error(message, { id: loginToast });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={`${pageCanvas} flex items-center justify-center py-12 px-4 sm:px-6 lg:px-8`} dir="rtl">
      <div className={`max-w-md w-full space-y-8 ${frostCard} p-8`}>
        <div className="text-center space-y-2">
          <h2 className="text-3xl font-semibold tracking-tight text-neutral-900">
            כניסה למנויים
          </h2>
          <p className="text-sm text-neutral-500">
            עדיין אין לך חשבון?{" "}
            <Link
              href="/register"
              className="font-medium text-neutral-900 hover:text-neutral-700 underline-offset-2 hover:underline transition-colors"
            >
              להרשמה בחינם
            </Link>
          </p>
        </div>

        <form className="space-y-5" onSubmit={handleSubmit}>
          <div>
            <label className="text-xs font-semibold text-neutral-600 block mb-1.5 text-start">
              אימייל או מספר טלפון
            </label>
            <input
              type="text"
              required
              disabled={loading}
              dir="rtl"
              className={fieldClass}
              placeholder="0501234567 או email@example.com"
              value={formData.identifier || ""}
              onChange={(e) => setFormData({ ...formData, identifier: e.target.value })}
            />
          </div>

          <div>
            <div className="flex justify-between items-center mb-1.5 gap-3">
              <label className="text-xs font-semibold text-neutral-600 text-start">סיסמה</label>
              <Link
                href="/forgot-password"
                className="text-xs text-neutral-500 hover:text-neutral-800 transition-colors"
              >
                שכחת סיסמה?
              </Link>
            </div>
            <input
              type="password"
              required
              disabled={loading}
              dir="rtl"
              className={fieldClass}
              placeholder="••••••••"
              value={formData.password || ""}
              onChange={(e) => setFormData({ ...formData, password: e.target.value })}
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className={`w-full ${primaryCta} mt-6 flex items-center justify-center`}
          >
            {loading ? "מבצע אימות מאובטח..." : "התחברות לפלטפורמה"}
          </button>
        </form>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className={`${pageCanvas} flex items-center justify-center`} dir="rtl">
          טוען...
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
