"use client";
import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "react-hot-toast";
import { fieldClass, frostCard, pageCanvas } from "../../../lib/ui";
import {
  INVALID_PHONE_ERROR,
  ONBOARDING_STORAGE_KEY,
  normalizeIsraeliMobile,
} from "../../../lib/student-onboarding";

type CompletionStatus =
  | { status: "loading" }
  | { status: "signed_in" }
  | { status: "needs_details"; email: string; firstName: string; lastName: string }
  | { status: "expired" };

type CompleteResponse = { success: boolean; error?: string; data?: { redirectTo: string } };

const orangeField = `${fieldClass} focus-visible:ring-orange-500/15 focus-visible:border-orange-500`;

function readStoredAnswers(): unknown {
  try {
    return JSON.parse(sessionStorage.getItem(ONBOARDING_STORAGE_KEY) ?? "null");
  } catch {
    return null;
  }
}

async function postCompletion(body: Record<string, unknown>): Promise<CompleteResponse & { ok: boolean }> {
  const response = await fetch("/api/auth/google/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as CompleteResponse;
  return { ...result, ok: response.ok && result.success };
}

export default function GoogleCallbackPage() {
  const router = useRouter();
  const [state, setState] = useState<CompletionStatus>({ status: "loading" });
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [whatsappUpdates, setWhatsappUpdates] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    const finishSignedIn = async () => {
      const result = await postCompletion({ answers: readStoredAnswers() });
      if (cancelled) return;
      if (!result.ok) {
        toast.error(result.error || "שמירת פרטי הלימודים נכשלה. אפשר להשלים אותם בדאשבורד.");
      }
      sessionStorage.removeItem(ONBOARDING_STORAGE_KEY);
      router.replace(result.data?.redirectTo ?? "/dashboard");
    };

    (async () => {
      try {
        const response = await fetch("/api/auth/google/complete");
        const result = (await response.json()) as { data?: CompletionStatus };
        if (cancelled) return;
        const next = result.data ?? { status: "expired" };
        if (next.status === "signed_in") {
          setState(next);
          await finishSignedIn();
          return;
        }
        if (next.status === "needs_details") {
          setFirstName(next.firstName);
          setLastName(next.lastName);
        }
        setState(next);
      } catch {
        if (!cancelled) setState({ status: "expired" });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [router]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    if (!firstName.trim() || !lastName.trim()) {
      setError("יש למלא שם פרטי ושם משפחה");
      return;
    }
    if (!normalizeIsraeliMobile(phone)) {
      setError(INVALID_PHONE_ERROR);
      return;
    }
    if (!acceptTerms) {
      setError("יש לאשר את תנאי השימוש ומדיניות הפרטיות");
      return;
    }

    setLoading(true);
    try {
      const result = await postCompletion({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        phone: phone.trim(),
        acceptTerms,
        whatsappUpdates,
        answers: readStoredAnswers(),
      });
      if (!result.ok) throw new Error(result.error || "לא הצלחנו לסיים את ההרשמה");
      sessionStorage.removeItem(ONBOARDING_STORAGE_KEY);
      toast.success(`ברוך הבא, ${firstName.trim()}!`);
      router.replace(result.data?.redirectTo ?? "/dashboard");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "לא הצלחנו לסיים את ההרשמה");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={`${pageCanvas} font-sans antialiased py-16 px-6`} dir="rtl">
      <div className={`${frostCard} max-w-md mx-auto p-8 space-y-6`}>
        {(state.status === "loading" || state.status === "signed_in") && (
          <p className="text-center text-sm text-neutral-500">מסיימים את ההתחברות...</p>
        )}

        {state.status === "expired" && (
          <div className="space-y-4 text-center">
            <h1 className="text-xl font-black text-[#1d1d1f]">ההתחברות עם Google לא הושלמה</h1>
            <p className="text-sm text-[#6e6e73]">אפשר לנסות שוב או להירשם עם הטופס.</p>
            <Link href="/register/student" className="inline-block text-sm font-semibold text-orange-600 hover:underline">
              חזרה להרשמה
            </Link>
          </div>
        )}

        {state.status === "needs_details" && (
          <form onSubmit={handleSubmit} noValidate className="space-y-4 text-start">
            <div className="space-y-1 text-center">
              <h1 className="text-xl font-black text-[#1d1d1f]">עוד צעד אחד</h1>
              <p className="text-sm text-[#6e6e73]">
                נשאר רק מספר טלפון לסיום ההרשמה
              </p>
              <p className="text-xs text-neutral-400" dir="ltr">{state.email}</p>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <label htmlFor="firstName" className="text-xs font-black text-[#6e6e73]">שם פרטי</label>
                <input
                  id="firstName"
                  type="text"
                  autoComplete="given-name"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  className={orangeField}
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="lastName" className="text-xs font-black text-[#6e6e73]">שם משפחה</label>
                <input
                  id="lastName"
                  type="text"
                  autoComplete="family-name"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  className={orangeField}
                />
              </div>
            </div>

            <div className="space-y-1">
              <label htmlFor="phone" className="text-xs font-black text-[#6e6e73]">מספר טלפון</label>
              <input
                id="phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                dir="ltr"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="050-1234567"
                className={`${orangeField} text-start`}
              />
            </div>

            <div className="space-y-3 pt-1">
              <label className="flex items-start gap-3 text-sm text-neutral-700">
                <input
                  type="checkbox"
                  checked={acceptTerms}
                  onChange={(e) => setAcceptTerms(e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-orange-500"
                />
                אני מסכים/ה לתנאי השימוש ולמדיניות הפרטיות
              </label>
              <label className="flex items-start gap-3 text-sm text-neutral-700">
                <input
                  type="checkbox"
                  checked={whatsappUpdates}
                  onChange={(e) => setWhatsappUpdates(e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-orange-500"
                />
                אני מסכים/ה לקבל עדכונים בוואטסאפ
              </label>
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 text-xs font-bold p-3 rounded-xl">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-orange-500 hover:bg-orange-600 text-white font-bold py-3.5 px-6 rounded-xl shadow-lg shadow-orange-500/25 transition-all text-center disabled:opacity-60"
            >
              {loading ? "פותחים את החשבון..." : "סיום הרשמה וכניסה לחשבון ←"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
