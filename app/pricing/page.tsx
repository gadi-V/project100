"use client";
import { Suspense, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "react-hot-toast";
import Testimonials from "../../components/Testimonials";
import BenefitsBar from "../../components/landing/BenefitsBar";
import BrandWordmark from "../../components/BrandWordmark";
import {
  frostCard,
  frostCardSelected,
  pageCanvas,
  primaryCta,
  secondaryCta,
} from "../../lib/ui";

const PACKAGES = [
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

const FAQS = [
  {
    question: "לאיזה מקצועות ורמות השיעורים מתאימים?",
    answer:
      "לכל המקצועות והחומרים! אנחנו מכסים את כל חומרי הלימוד: ממקצועות בית הספר ועד לקורסים אקדמיים מורכבים.",
  },
  {
    question: "האם צריך להתחייב למסלול ארוך?",
    answer:
      "ממש לא. אין אצלנו התחייבויות לטווח ארוך או דמי מנוי. אתם רוכשים חבילת קרדיטים גמישה שמתאימה בדיוק לצרכים שלכם.",
  },
  {
    question: "איך עובדת מעטפת התמיכה בין השיעורים?",
    answer:
      "אם נתקעתם עם תרגיל או מטלה – אתם לא לבד. המערכת כוללת מענה בוואטסאפ לקבלת הכוונה מהירה מהצוות.",
  },
  {
    question: "איך מתבצעת התאמת המורה או המרצה?",
    answer:
      "לפני שמתחילים, אנחנו עושים מיפוי קצר של הצרכים שלכם. המערכת מתאימה את איש המקצוע המדויק ביותר מתוך הנבחרת.",
  },
];

const PENDING_DIAGNOSTIC_QUIZ_KEY = "pending_diagnostic_quiz_id";

/** Only allow same-origin relative paths (open-redirect safe). */
function sanitizeReturnUrl(raw: string | null): string | null {
  if (!raw) return null;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  if (!decoded.startsWith("/") || decoded.startsWith("//")) return null;
  if (decoded.startsWith("/login") || decoded.startsWith("/register")) return null;
  return decoded;
}

function PricingPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [loading, setLoading] = useState<string | null>(null);
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  const packageFromUrl = searchParams.get("package");
  const quizIdFromUrl = searchParams.get("quizId");
  const returnUrl = useMemo(
    () => sanitizeReturnUrl(searchParams.get("returnUrl")),
    [searchParams]
  );

  const highlightedPackageId = useMemo(() => {
    if (packageFromUrl && PACKAGES.some((p) => p.id === packageFromUrl)) {
      return packageFromUrl;
    }
    return null;
  }, [packageFromUrl]);

  const resolvePostPurchaseUrl = (): string => {
    if (returnUrl) return returnUrl;

    let quizId = quizIdFromUrl;
    if (!quizId) {
      try {
        quizId = localStorage.getItem(PENDING_DIAGNOSTIC_QUIZ_KEY);
      } catch {
        quizId = null;
      }
    }

    if (quizId) {
      return `/onboarding/diagnostic?quizId=${encodeURIComponent(quizId)}&unlocked=true`;
    }
    return "/dashboard";
  };

  const handlePurchase = async (packageId: string) => {
    setLoading(packageId);
    const purchaseToast = toast.loading("בודק הרשאות ומעביר לתשלום מאובטח...");

    const postPurchaseUrl = resolvePostPurchaseUrl();
    const pricingResumePath = (() => {
      const params = new URLSearchParams();
      params.set("package", packageId);
      if (quizIdFromUrl) params.set("quizId", quizIdFromUrl);
      if (returnUrl) params.set("returnUrl", returnUrl);
      return `/pricing?${params.toString()}`;
    })();

    if (quizIdFromUrl) {
      try {
        localStorage.setItem(PENDING_DIAGNOSTIC_QUIZ_KEY, quizIdFromUrl);
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
    <div className={`${pageCanvas} py-16 px-4 sm:px-6`} dir="rtl">
      <div className="max-w-7xl mx-auto">
        <div className="text-center max-w-3xl mx-auto mb-16 space-y-4">
          <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight text-neutral-900 [text-wrap:balance]">
            כל המקצועות. כל החומרים. הבנה מלאה.
          </h1>
          <p className="text-lg text-neutral-500">
            מתלמידי חטיבה ותיכון ועד לסטודנטים באקדמיה. חבילות קרדיטים גמישות ללא התחייבות.
          </p>
          {quizIdFromUrl && (
            <p className="text-sm font-medium text-neutral-700 bg-white/70 border border-neutral-200 rounded-xl inline-block px-4 py-2">
              לאחר הרכישה תחזרו אוטומטית לדו״ח האבחון המלא
            </p>
          )}
        </div>

        <BenefitsBar className="mb-12" />

        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-8 items-stretch mb-28 pt-4 overflow-visible">
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

        <div className="mb-28 border-t border-neutral-200/80 pt-16">
          <div className="text-center mb-12 space-y-3">
            <h2 className="text-3xl font-semibold tracking-tight text-neutral-900">
              למידה חכמה. תוצאות מוכחות.
            </h2>
            <p className="text-neutral-500 text-sm max-w-xl mx-auto">
              בין אם אתם מתכוננים לבגרות ובין אם אתם סטודנטים שנאבקים עם קורס אקדמי – הנה ההבדל:
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-4xl mx-auto" dir="rtl">
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

        <Testimonials />

        <div className="max-w-3xl mx-auto border-t border-neutral-200/80 pt-16" id="faq">
          <div className="text-center mb-10 space-y-2">
            <h2 className="text-3xl font-semibold tracking-tight text-neutral-900">שאלות נפוצות</h2>
            <p className="text-neutral-500 text-sm">כל מה שחשוב לדעת על החבילות והמעטפת</p>
          </div>

          <div className="space-y-4">
            {FAQS.map((faq, index) => {
              const isOpen = openFaq === index;
              return (
                <div key={index} className={`${frostCard} overflow-hidden`}>
                  <button
                    onClick={() => setOpenFaq(isOpen ? null : index)}
                    className="w-full flex items-center justify-between p-5 text-start font-medium text-neutral-800 hover:text-neutral-900 transition-colors"
                  >
                    <span>{faq.question}</span>
                    <span
                      className={`text-xl text-neutral-500 transition-transform duration-200 ${
                        isOpen ? "rotate-45" : ""
                      }`}
                    >
                      ＋
                    </span>
                  </button>

                  <div
                    className={`transition-all duration-300 ease-in-out ${
                      isOpen
                        ? "max-h-48 border-t border-neutral-200/60 p-5 text-neutral-600 bg-white/30"
                        : "max-h-0 overflow-hidden"
                    }`}
                  >
                    <p className="text-sm leading-relaxed text-start">{faq.answer}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function PricingPage() {
  return (
    <Suspense
      fallback={
        <div className={`${pageCanvas} py-16 px-4`} dir="rtl">
          <div className="max-w-3xl mx-auto text-center text-neutral-500 text-sm font-medium">
            טוען חבילות...
          </div>
        </div>
      }
    >
      <PricingPageInner />
    </Suspense>
  );
}
