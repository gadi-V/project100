"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "react-hot-toast";
import BrandWordmark from "../BrandWordmark";
import {
  frostCard,
  frostCardSelected,
  primaryCta,
  secondaryCta,
} from "../../lib/ui";

type PricingPackage = {
  id: string;
  name: string;
  price: number;
  perLesson: number;
  description: string;
  features: string[];
  popular: boolean;
};

export const PACKAGES: readonly PricingPackage[] = [
  {
    id: "SINGLE",
    name: "שיעור בודד",
    price: 200,
    perLesson: 200,
    description: "פתרון ממוקד לפני מבחן, הגשת עבודה או לחיזוק נושא ספציפי בכל מקצוע",
    features: [
      "שיעור מלא של 50 דקות",
      "מורה מותאם אישית (לפי מקצוע/קורס)",
      "חומרי לימוד וסיכומים מותאמים",
      "ביטול חינם עד 24 שעות לפני",
    ],
    popular: false,
  },
  {
    id: "TRIO",
    name: "חבילת שלישייה",
    price: 540,
    perLesson: 180,
    description: "המסלול המומלץ לסגירת פערים, הכנה לבגרויות או למבחני סמסטר באקדמיה",
    features: [
      "3 שיעורים במערכת",
      "עזרה אונליין בין המפגשים",
      "מעקב התקדמות אישי",
      "חיסכון של ₪60",
    ],
    popular: true,
  },
  {
    id: "MULTI",
    name: "נבחרת חמישייה",
    price: 850,
    perLesson: 170,
    description: "ליווי רציף להצלחה מוכחת לאורך הסמסטר או שנת הלימודים בכל חומרי הלימוד",
    features: [
      "5 שיעורים (לשימוש בכל המקצועות)",
      "תעדוף בבחירת השעות והמורים",
      "הכנה מקיפה למרתונים ומבחנים",
      "חיסכון של ₪150",
    ],
    popular: false,
  },
  {
    id: "TEN",
    name: "חבילת עשירייה",
    price: 1600,
    perLesson: 160,
    description: "מסלול מורחב לליווי רציף לאורך תקופת מבחנים או סמסטר מלא",
    features: [
      "10 שיעורים (לשימוש בכל המקצועות)",
      "גמישות מקסימלית בשיבוץ",
      "ליווי צמוד לאורך כל התקופה",
      "חיסכון של ₪400",
    ],
    popular: false,
  },
];

export const PENDING_DIAGNOSTIC_QUIZ_KEY = "pending_diagnostic_quiz_id";

type PricingPlansProps = {
  highlightedPackageId?: string | null;
  quizId?: string | null;
  returnUrl?: string | null;
  /** Same-origin path to come back to after login or a cancelled checkout. */
  resumePath: (packageId: string) => string;
  className?: string;
};

/** Package cards with secure checkout, followed by the old-vs-new comparison. */
export default function PricingPlans({
  highlightedPackageId = null,
  quizId = null,
  returnUrl = null,
  resumePath,
  className = "",
}: PricingPlansProps) {
  const router = useRouter();
  const [loading, setLoading] = useState<string | null>(null);

  const resolvePostPurchaseUrl = (): string => {
    if (returnUrl) return returnUrl;

    let pendingQuizId = quizId;
    if (!pendingQuizId) {
      try {
        pendingQuizId = localStorage.getItem(PENDING_DIAGNOSTIC_QUIZ_KEY);
      } catch {
        pendingQuizId = null;
      }
    }

    if (pendingQuizId) {
      return `/onboarding/diagnostic?quizId=${encodeURIComponent(pendingQuizId)}&unlocked=true`;
    }
    return "/dashboard";
  };

  const handlePurchase = async (packageId: string) => {
    setLoading(packageId);
    const purchaseToast = toast.loading("בודק הרשאות ומעביר לתשלום מאובטח...");

    const postPurchaseUrl = resolvePostPurchaseUrl();
    const pricingResumePath = resumePath(packageId);

    if (quizId) {
      try {
        localStorage.setItem(PENDING_DIAGNOSTIC_QUIZ_KEY, quizId);
      } catch {
        // ignore
      }
    }

    try {
      const meResponse = await fetch("/api/me");
      if (!meResponse.ok) {
        toast.error("יש להתחבר לפני רכישת חבילה", { id: purchaseToast });
        router.replace(`/login?from=${encodeURIComponent(pricingResumePath)}`);
        return;
      }

      const meData = (await meResponse.json()) as {
        user: { role: string };
      };
      if (meData.user.role !== "STUDENT") {
        toast.error("רכישת חבילות זמינה לתלמידים בלבד", { id: purchaseToast });
        setLoading(null);
        return;
      }

      const response = await fetch("/api/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          packageType: packageId,
          successUrl: postPurchaseUrl,
          cancelUrl: pricingResumePath,
        }),
      });

      const data = (await response.json()) as {
        error?: string;
        checkoutUrl?: string;
        success?: boolean;
        isMock?: boolean;
        newCredits?: number;
        message?: string;
      };
      if (!response.ok) throw new Error(data.error || "הרכישה נכשלה");

      // Local Dev mock: credits already granted server-side — return to diagnostic unlock.
      if (data.isMock) {
        toast.success("קרדיטים נוספו בהצלחה במצב פיתוח", {
          id: purchaseToast,
          style: {
            background: "#166534",
            color: "#fff",
          },
          iconTheme: {
            primary: "#fff",
            secondary: "#166534",
          },
        });
        window.location.assign(postPurchaseUrl);
        return;
      }

      if (!data.checkoutUrl) {
        throw new Error("לא התקבל קישור לתשלום");
      }

      // Credits are granted only via Stripe webhook after payment succeeds.
      toast.success("מעבירים לתשלום מאובטח...", { id: purchaseToast });
      window.location.href = data.checkoutUrl;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "שגיאה ברכישה";
      toast.error(message, { id: purchaseToast });
      setLoading(null);
    }
  };

  return (
    <div className={`space-y-28 ${className}`} dir="rtl">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-8 items-stretch pt-4 overflow-visible">
        {PACKAGES.map((pkg) => {
          const isHighlighted = highlightedPackageId
            ? highlightedPackageId === pkg.id
            : pkg.popular;
          return (
            <div
              key={pkg.id}
              className={`p-8 flex flex-col justify-between relative overflow-visible ${
                isHighlighted ? frostCardSelected : frostCard
              }`}
            >
              {(pkg.popular || highlightedPackageId === pkg.id) && (
                <span className="absolute top-0 left-1/2 z-20 -translate-x-1/2 -translate-y-1/2 bg-neutral-900 text-white text-xs font-semibold px-3 py-1 rounded-full shadow-sm">
                  {highlightedPackageId === pkg.id ? "מומלץ עבורך" : "מומלץ"}
                </span>
              )}

              <div>
                <h3 className="text-2xl font-semibold text-neutral-900 mb-2 text-start">{pkg.name}</h3>
                <p className="text-neutral-500 text-sm mb-6 min-h-[40px] text-start">{pkg.description}</p>

                <div className="mb-6 border-b border-neutral-200/80 pb-6 text-center space-y-2">
                  <div className="flex items-baseline gap-1.5 justify-center" dir="ltr">
                    <span className="text-4xl font-extrabold text-neutral-900 tracking-tight tabular-nums">
                      ₪{pkg.price}
                    </span>
                    <span className="text-sm font-medium text-neutral-500">/ חבילה</span>
                  </div>
                  <div className="text-neutral-600 text-sm font-medium tabular-nums text-center">
                    ({pkg.perLesson} ₪ בלבד למפגש)
                  </div>
                </div>

                <p className="text-[14px] font-semibold tracking-wide text-neutral-500 mb-3 text-start">
                  סל החבילה
                </p>
                <ul className="space-y-4 mb-8 text-start">
                  {pkg.features.map((feature, index) => (
                    <li key={index} className="flex items-center gap-3 text-neutral-700">
                      <span className="text-neutral-900 font-semibold">✓</span>
                      <span className="text-sm">{feature}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <button
                onClick={() => handlePurchase(pkg.id)}
                disabled={loading !== null}
                className={`w-full ${isHighlighted ? primaryCta : secondaryCta}`}
              >
                {loading === pkg.id ? "מעבד..." : "רכישה מאובטחת"}
              </button>
            </div>
          );
        })}
      </div>

      <div className="border-t border-neutral-200/80 pt-16">
        <div className="text-center mb-12 space-y-3">
          <h2 className="text-3xl font-semibold tracking-tight text-neutral-900">
            למידה חכמה. תוצאות מוכחות.
          </h2>
          <p className="text-neutral-500 text-sm max-w-xl mx-auto">
            בין אם אתם מתכוננים לבגרות ובין אם אתם סטודנטים שנאבקים עם קורס אקדמי – הנה ההבדל:
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-4xl mx-auto">
          <div className={`${frostCard} p-6`}>
            <h3 className="text-lg font-semibold text-neutral-700 mb-4 flex items-center gap-2 text-start">
              <span className="text-neutral-400">✕</span>
              הלמידה הישנה והמסורבלת
            </h3>
            <ul className="space-y-4 text-neutral-500 text-sm text-start">
              <li className="flex gap-2">
                <span>•</span>
                <span>ללכת לאיבוד בכיתה או בהרצאה המונית.</span>
              </li>
              <li className="flex gap-2">
                <span>•</span>
                <span>מורים פרטיים שמרגישים כמו פלסטר זמני.</span>
              </li>
              <li className="flex gap-2">
                <span>•</span>
                <span>תסכול ולחץ מול חומר לא ברור.</span>
              </li>
            </ul>
          </div>

          <div className={`${frostCardSelected} p-6`}>
            <h3 className="text-lg font-semibold text-neutral-900 mb-4 flex items-center gap-2 text-start">
              <span>✓</span>
              <span>
                המעטפת החכמה של <BrandWordmark />
              </span>
            </h3>
            <ul className="space-y-4 text-neutral-700 text-sm text-start">
              <li className="flex gap-2">
                <span className="text-neutral-900 font-semibold">✓</span>
                <span>
                  <strong>מיפוי מדויק</strong> לפני המפגש הראשון.
                </span>
              </li>
              <li className="flex gap-2">
                <span className="text-neutral-900 font-semibold">✓</span>
                <span>
                  <strong>תוכנית דינמית</strong> בקצב האישי שלכם.
                </span>
              </li>
              <li className="flex gap-2">
                <span className="text-neutral-900 font-semibold">✓</span>
                <span>
                  <strong>תמיכה בוואטסאפ</strong> בין השיעורים.
                </span>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
